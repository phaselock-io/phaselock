// TESTS.md: Boot

import { afterEach, describe, expect, test, vi } from 'vitest';

import { commandKey } from '../../../ts/assets/skeleton.ts';

import {
  bytes,
  checkpoint,
  ev,
  keys,
  log,
  parkedEvent,
  parse,
  rig,
  seq,
  settle,
  state,
} from './harness.ts';

/** a store as a crash left it: a held stream, a marked stream, a view, and a checkpoint */
function persisted(): Record<string, unknown> {
  return {
    '/view': { token: 't7', position: 40, refs: ['patron.*', 'book.*'] },
    '/checkpoint': { epoch: 'e1', position: 42, reduced: 42 },
    '/seq.patron.p1': 2,
    'patron.p1/state': { count: 2, fields: {} },
    'patron.p1/log': ['bump', 'bump'],
    '/seq.book.b1': 'backfill',
  };
}

describe('boot', () => {
  test('the factory is called with the stored checkpoint and view token', async () => {
    const r = rig({ seed: persisted() });
    await settle();
    expect(r.server.conns.length).toBe(1);
    expect(r.server.conn.since).toBe(42);
    expect(r.server.conn.view).toBe('t7');
    expect(r.server.conn.wants).toEqual(['*']);
  });

  test('a missing /view means bootstrap: since -1, view null', async () => {
    const r = rig();
    await settle();
    expect(r.server.conn.since).toBe(-1);
    expect(r.server.conn.view).toBeNull();
  });

  test('the streams table is rebuilt from /seq.: a held stream reduces, a marked one parks', async () => {
    const r = rig({ seed: persisted() });
    await settle();
    r.server.open();
    r.server.events(
      ev('patron.p1', 3, 43, { type: 'set', field: 'a', value: 1 }),
      ev('book.b1', 9, 43),
    );
    await settle();
    expect(log(r.data(), 'patron.p1')).toEqual(['bump', 'bump', 'set a=1']);
    expect(seq(r.data(), 'patron.p1')).toBe(3);
    expect(state(r.data(), 'book.b1')).toBeUndefined();
    expect(keys(r.data(), '/park.ev.')).toEqual([parkedEvent('book.b1', 9)]);
    expect(seq(r.data(), 'book.b1')).toBe('backfill');
  });

  test('in-flight backfills are rebuilt from /backfill. and resumed from their resume', async () => {
    const resume = {
      position: 38,
      skipBytes: 3,
      fromPosition: 39,
      snapshotDone: false,
      tailDone: false,
    };
    const data = {
      ...persisted(),
      '/backfill.book.*': { until: 40, resume, replacing: false, children: [] },
      '/backfill-seqs.book.*': { 'book.b1': 5 },
      '/park.kv.book.*/book.b1/state': { count: 5, fields: {} },
    };
    const r = rig({ seed: data });
    r.server.hold('book.*');
    await settle();
    expect(r.server.backfills).toEqual([{ ref: 'book.*', until: 40, resume }]);
    // nothing parked was touched by the boot
    expect(r.data()['/park.kv.book.*/book.b1/state']).toEqual({ count: 5, fields: {} });
    expect(r.data()['/backfill-seqs.book.*']).toEqual({ 'book.b1': 5 });
  });

  test('a finished download boots ready and lands at boot, before any connection', async () => {
    const resume = {
      position: 40,
      skipBytes: 3,
      fromPosition: 40,
      snapshotDone: true,
      tailDone: true,
    };
    const data = {
      ...persisted(),
      '/backfill.book.*': { until: 40, resume, replacing: false, children: [] },
      '/backfill-seqs.book.*': { 'book.b1': 5 },
      '/park.kv.book.*/book.b1/state': { count: 5, fields: {} },
    };
    const r = rig({ seed: data });
    await settle();
    expect(r.server.backfills).toEqual([]);
    expect(seq(r.data(), 'book.b1')).toBe(5);
    expect(state(r.data(), 'book.b1')).toEqual({ count: 5, fields: {} });
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(keys(r.data(), '/park.kv.')).toEqual([]);
  });

  test('a stream outside the wants is purged at boot, and its view ref with it', async () => {
    const data = {
      ...persisted(),
      '/seq.book.b2': 3,
      'book.b2/state': { count: 3, fields: {} },
      'book.b2/log': ['bump', 'bump', 'bump'],
      [parkedEvent('book.b1', 9)]: {
        id: 'x',
        data: { id: 'b1', type: 'bump' },
        position: 41,
        stream: 'book.b1',
        seq: 9,
        servertime: 0,
      },
    };
    const r = rig({ seed: data, wants: ['patron.*'] });
    await settle();
    expect(keys(r.data(), 'book.')).toEqual([]);
    expect(seq(r.data(), 'book.b1')).toBeUndefined();
    expect(seq(r.data(), 'book.b2')).toBeUndefined();
    expect(keys(r.data(), '/park.ev.')).toEqual([]);
    expect(r.data()['/view']).toEqual({ token: 't7', position: 40, refs: ['patron.*'] });
    // the wanted stream is untouched, and the connection presents the stored token
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron.p1')).toBe(2);
    expect(r.server.conn.view).toBe('t7');
    expect(r.server.conn.wants).toEqual(['patron.*']);
  });

  test('a backfill outside the wants is purged at boot, values and records too', async () => {
    const resume = {
      position: 38,
      skipBytes: 3,
      fromPosition: 39,
      snapshotDone: false,
      tailDone: false,
    };
    const data = {
      ...persisted(),
      '/backfill.book.*': { until: 40, resume, replacing: false, children: [] },
      '/backfill-seqs.book.*': { 'book.b1': 5 },
      '/park.kv.book.*/book.b1/state': { count: 5, fields: {} },
    };
    const r = rig({ seed: data, wants: ['patron.*'] });
    await settle();
    expect(r.server.backfills).toEqual([]);
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(keys(r.data(), '/park.kv.')).toEqual([]);
    expect(seq(r.data(), 'book.b1')).toBeUndefined();
  });

  test('a backfill of * stays under wants of *, and goes under narrower wants', async () => {
    const data = () => ({
      ...persisted(),
      '/view': { token: 't7', position: 40, refs: ['*'] },
      '/backfill.*': {
        until: 40,
        resume: {
          position: 38,
          skipBytes: 0,
          fromPosition: 39,
          snapshotDone: false,
          tailDone: false,
        },
        replacing: false,
        children: [],
      },
      '/backfill-seqs.*': {},
    });
    const kept = rig({ seed: data() });
    await settle();
    expect(kept.server.backfills.map((b) => b.ref)).toEqual(['*']);
    kept.abort.abort();
    await settle();

    const purged = rig({ seed: data(), wants: ['patron.*', 'book.*'] });
    await settle();
    expect(purged.server.backfills).toEqual([]);
    expect(keys(purged.data(), '/backfill')).toEqual([]);
    expect(purged.data()['/view']).toEqual({ token: 't7', position: 40, refs: [] });
  });

  test('purging the last replacing backfill unfreezes and lands the frozen events', async () => {
    // book.* is replacing, so the base is frozen; patron.p1's seq 3 arrived frozen and parked
    const data = {
      ...persisted(),
      '/checkpoint': { epoch: 'e1', position: 43, reduced: 42 },
      '/backfill.book.*': {
        until: 40,
        resume: {
          position: 38,
          skipBytes: 0,
          fromPosition: 39,
          snapshotDone: false,
          tailDone: false,
        },
        replacing: true,
        children: [],
      },
      '/backfill-seqs.book.*': {},
      [parkedEvent('patron.p1', 3)]: {
        id: 'x',
        data: { id: 'p1', type: 'set', field: 'a', value: 1 },
        position: 43,
        stream: 'patron.p1',
        seq: 3,
        servertime: 0,
      },
    };
    const r = rig({ seed: data, wants: ['patron.*'] });
    await settle();
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(log(r.data(), 'patron.p1')).toEqual(['bump', 'bump', 'set a=1']);
    expect(seq(r.data(), 'patron.p1')).toBe(3);
    expect(keys(r.data(), '/park.ev.')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 43, reduced: 43 });
  });

  test('the outbox is rebuilt in ordinal order, flushed on connect, and the next ordinal continues', async () => {
    const data = {
      ...persisted(),
      [commandKey(3)]: { id: 'c3', data: bytes({ type: 'bump', id: 'p1' }) },
      [commandKey(5)]: { id: 'c5', data: bytes({ type: 'bump', id: 'p1' }) },
      [commandKey(10)]: { id: 'c10', data: bytes({ type: 'bump', id: 'p1' }) },
    };
    const r = rig({ seed: data });
    await settle();
    expect(r.server.sends.length).toBe(1);
    expect(r.server.sends[0].map((c) => c.id)).toEqual(['c3', 'c5', 'c10']);
    r.engine.sendCommand({ type: 'bump', id: 'p2' });
    await settle();
    expect(keys(r.data(), '/command.')).toEqual([
      commandKey(3),
      commandKey(5),
      commandKey(10),
      commandKey(11),
    ]);
    expect(parse((r.data()[commandKey(11)] as { data: Uint8Array }).data)).toEqual({
      type: 'bump',
      id: 'p2',
    });
    expect(r.server.sends.length).toBe(2);
    expect(r.server.sends[1].length).toBe(1);
  });

  test('/checkpoint loads: the reduced position is restored and gates ack releases', async () => {
    const data = { ...persisted(), '/checkpoint': { epoch: 'e1', position: 42, reduced: 30 } };
    const r = rig({ seed: data });
    await settle();
    r.server.open();
    // an ack above the restored reduced position waits
    r.server.onSend = (cmds) =>
      Promise.resolve(cmds.map(() => ({ kind: 'ack' as const, position: 35 })));
    r.engine.sendCommand({ type: 'bump', id: 'p1' });
    await settle();
    expect(keys(r.data(), '/command.').length).toBe(1);
    // one at it releases at once
    r.server.onSend = (cmds) =>
      Promise.resolve(cmds.map(() => ({ kind: 'ack' as const, position: 30 })));
    r.engine.sendCommand({ type: 'noop', id: 'p1' });
    await settle();
    expect(r.server.sends.length).toBe(2);
    expect(keys(r.data(), '/command.').length).toBe(1);
  });

  test('a connection from another epoch ends the Engine', async () => {
    const r = rig({ seed: persisted() });
    await settle();
    r.server.open('e2');
    await expect(settle()).rejects.toThrow(/epoch e2, checkpoint from e1/);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
