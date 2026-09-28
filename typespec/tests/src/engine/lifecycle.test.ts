// TESTS.md: Connector lifecycle, plus the `end` and `live` bullets of Event routing

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Backfill, Connector } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  FakeServer,
  keys,
  log,
  type Rig,
  rig,
  seq,
  settle,
} from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2 },
  values: [['patron.p1/state', { count: 2, fields: {} }]],
};

async function held(server?: FakeServer): Promise<Rig> {
  const r = rig({ server });
  await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
  return r;
}

/** a server whose connectors record every Backfill object they are handed */
function recording(): { server: FakeServer; backfills: Backfill[] } {
  const server = new FakeServer();
  const backfills: Backfill[] = [];
  const inner = server.factory;
  server.factory = (since, view, wants, signal, hooks) => {
    const c: Connector = inner(since, view, wants, signal, hooks);
    return {
      backfill: (b) => {
        backfills.push(b);
        return c.backfill(b);
      },
      sendCommand: (cmds) => c.sendCommand(cmds),
    };
  };
  return { server, backfills };
}

// the Engine's own timers are the subject here, so every test runs on fake ones; settle advances
// them a millisecond per round, and a backoff fires under a minute
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('connector lifecycle', () => {
  test('onOpen is first: a cursor before it ends the Engine', async () => {
    const r = rig();
    await settle();
    r.server.events(ev('patron.p1', 1, 5));
    await expect(settle()).rejects.toThrow(/no epoch/);
    expect(checkpoint(r.data)).toBeUndefined();
  });

  test('the epoch is forgotten on end: the next connection must open again', async () => {
    const r = await held();
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    r.server.events(ev('patron.p1', 3, 11));
    await expect(settle()).rejects.toThrow(/no epoch/);
  });

  test('onEnd schedules the next attempt with backoff', async () => {
    const r = await held();
    r.server.end(0, 'closed');
    await settle();
    expect(r.server.conns.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(r.server.conn.since).toBe(10);
    expect(r.server.conn.view).toBe('t1');
  });

  test('reconnectNow cancels the timer and calls the factory at once', async () => {
    const r = await held();
    r.server.end();
    await settle();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.conns.length).toBe(2);
  });

  test("aborting the Engine's signal ends the connector and every in-flight backfill", async () => {
    const { server, backfills } = recording();
    const r = await held(server);
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    expect(backfills.length).toBe(2);
    expect(backfills[1].signal.aborted).toBe(false);
    r.abort.abort();
    await settle();
    expect(r.server.conn.signal.aborted).toBe(true);
    expect(backfills[1].signal.aborted).toBe(true);
    // nothing reconnects after a shutdown
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.conns.length).toBe(1);
  });

  test('exactly one connector is live; a late onEnd from an old connector is ignored', async () => {
    const r = await held();
    const old = r.server.conn;
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    old.hooks.onEnd(0, 'late');
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(r.server.conn.ended).toBe(false);
    r.server.open();
    r.server.events(ev('patron.p1', 3, 11));
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe(3);
  });

  test('a new connection starts every backfill still downloading, except one in backoff', async () => {
    const r = await held();
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    r.server.failOnce.set('book.b1', new Error('boom'));
    r.server.events(ev('book.b1', 4, 12));
    await settle();
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p9', 'book.b1']);
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    // p9 restarts on the new connection; b1 waits for its own timer
    expect(r.server.backfills.map((b) => b.ref)).toEqual([
      'patron.*',
      'patron.p9',
      'book.b1',
      'patron.p9',
    ]);
    r.server.hold('book.b1');
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.backfills.map((b) => b.ref)).toEqual([
      'patron.*',
      'patron.p9',
      'book.b1',
      'patron.p9',
      'book.b1',
    ]);
  });

  test('a backfill failing because the connection ended is not a failure of the backfill', async () => {
    const r = await held();
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    r.server.end();
    await settle();
    // no backoff timer: the restart comes with the connection, at once
    r.server.blobs.set('patron.p9', { position: 11, seqs: { 'patron.p9': 7 }, values: [] });
    r.server.holds.delete('patron.p9');
    r.engine.reconnectNow();
    await settle();
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p9', 'patron.p9']);
    expect(r.server.backfills[2].resume).toBeNull();
    expect(seq(r.data, 'patron.p9')).toBe(7);
    expect(keys(r.data, '/backfill')).toEqual([]);
  });

  test('a hook from a replaced connector is dropped', async () => {
    const r = await held();
    const old = r.server.conn;
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    r.server.open();
    old.hooks.onEvents([ev('patron.p1', 3, 11)]);
    old.hooks.onView('t9', 12, ['book.*']);
    old.hooks.onVouch(50);
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe(2);
    expect(log(r.data, 'patron.p1')).toEqual([]);
    expect(checkpoint(r.data)?.position).toBe(10);
    expect(r.data['/view']).toEqual({ token: 't1', position: 10, refs: ['patron.*'] });
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*']);
  });

  test('end drops the connector and clears live; live on the next connection reduces again', async () => {
    const r = await held();
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    r.server.open();
    r.server.events(ev('patron.p1', 3, 11));
    r.server.live(11);
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe(3);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 11, reduced: 11 });
  });
});
