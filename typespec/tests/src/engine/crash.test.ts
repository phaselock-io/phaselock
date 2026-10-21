// TESTS.md: Crash and resume

import { describe, expect, test } from 'vitest';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  FakeServer,
  keys,
  log,
  page,
  parkedEdit,
  parkedKeys,
  parkedPage,
  type Rig,
  rig,
  seq,
  settle,
  state,
} from './harness.ts';

type Resume = {
  position: number;
  skipBytes: number;
  checksum: string;
  fromPosition: number;
  snapshotDone: boolean;
  tailDone: boolean;
};
type Record_ = { until: number; resume: Resume | null; replacing: boolean; children: string[] };
const record = (r: Rig, selector: string): Record_ | undefined =>
  r.data()[`!backfill:${selector}`] as Record_ | undefined;

type View = { token: string; position: number; selectors: string[] };
const view = (r: Rig): View | undefined => r.data()['!view'] as View | undefined;

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};
const books: Blob = {
  position: 10,
  seqs: { 'book:b1': 1 },
  values: [['book:b1!state', { count: 1, fields: {} }]],
};

/** a deep copy of the store, for comparing two runs */
const snapshot = (data: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(data));

/** the crash: the Engine ends, and a new one boots over the same store against a fresh server */
async function restart(r: Rig, blobs: Record<string, Blob>): Promise<Rig> {
  r.abort.abort();
  await settle();
  const server = new FakeServer();
  for (const [selector, blob] of Object.entries(blobs)) server.blobs.set(selector, blob);
  const r2 = rig({ store: r.store, server });
  await settle();
  return r2;
}

describe('crash and resume', () => {
  test('a store left mid-backfill boots with the record, values, and parked edits, resumes at skipBytes and fromPosition, and lands', async () => {
    const resume: Resume = {
      position: 10,
      skipBytes: 1,
      checksum: 'check-1',
      fromPosition: 10,
      snapshotDone: true,
      tailDone: false,
    };
    const server = new FakeServer();
    server.blobs.set('book:b1', {
      position: 10,
      seqs: { 'book:b1': 3 },
      values: [['book:b1!state', { count: 3, fields: {} }]],
      tail: [ev('book:b1', 4, 11)],
    });
    const r = rig({
      server,
      seed: {
        '!view': { token: 't1', position: 11, selectors: ['book:b1'] },
        '!checkpoint': { epoch: 'e1', position: 12, applied: 12 },
        '!backfill:book:b1': { until: 11, resume: { ...resume }, replacing: false, children: [] },
        '!backfill-seqs:book:b1': { 'book:b1': 3 },
        [parkedPage('book:b1', 0)]: page([['book:b1!state', { count: 3, fields: {} }]]),
        [parkedEdit('book:b1', 5)]: ev('book:b1', 5, 12, { type: 'bump' }, 'x'),
        '!seq:book:b1': 'backfill',
      },
    });
    await settle();
    expect(server.conn.since).toBe(12);
    expect(server.conn.view).toBe('t1');
    expect(server.backfills).toEqual([{ selector: 'book:b1', until: 11, resume }]);
    server.open();
    server.live(12);
    await settle();
    // the tail page filled the gap between the cut and the parked live edit, and everything chained
    expect(state(r.data(), 'book:b1')).toEqual({ count: 5, fields: {} });
    expect(log(r.data(), 'book:b1')).toEqual(['bump', 'bump']);
    expect(seq(r.data(), 'book:b1')).toBe(5);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('a crash between the values and the end of the snapshot resumes the download and lands like a clean run', async () => {
    const blobs: Record<string, Blob> = {
      'patron:*': patrons,
      'book:*': { ...books, tail: [ev('book:b1', 2, 11)] },
    };
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    r.server.blobs.set('book:*', blobs['book:*']);
    const hold = r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    await settle();
    // release, and stop at the first round that has the values committed; the rest is not
    hold.go();
    for (let i = 0; i < 10 && (record(r, 'book:*')?.resume?.skipBytes ?? 0) === 0; i++) {
      await settle(1);
    }
    // the record is the Engine's own object: what it says now is what the restart must present
    const mid = { ...record(r, 'book:*')!.resume! };
    expect(mid).toMatchObject({ position: 10, snapshotDone: false, tailDone: false });
    expect(mid.skipBytes).toBeGreaterThan(0);
    expect(mid.checksum).toBe('check-1');
    expect(parkedKeys(r.data(), 'book:*')).toEqual(['book:b1!state']);
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    const r2 = await restart(r, blobs);
    expect(r2.server.backfills).toEqual([{ selector: 'book:*', until: 12, resume: mid }]);
    r2.server.open();
    r2.server.live(12);
    await settle();
    expect(state(r2.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(log(r2.data(), 'book:b1')).toEqual(['bump']);
    expect(seq(r2.data(), 'book:b1')).toBe(2);
    expect(keys(r2.data(), '!backfill')).toEqual([]);
    expect(keys(r2.data(), '!park')).toEqual([]);
    // the clean run over the same blobs ends in the same store
    const clean = rig();
    await bootstrap(clean, ['patron:*'], { 'patron:*': patrons });
    clean.server.blobs.set('book:*', blobs['book:*']);
    clean.server.view('t2', 12, ['patron:*', 'book:*']);
    clean.server.vouch(12);
    await settle();
    expect(snapshot(r2.data())).toEqual(snapshot(clean.data()));
  });

  test('a crash after a land duplicates nothing: the restarted Engine matches the run before it', async () => {
    const blobs = { 'patron:*': patrons };
    const r = rig();
    await bootstrap(r, ['patron:*'], blobs);
    r.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'a', value: 1 }));
    await settle();
    const before = snapshot(r.data());
    const r2 = await restart(r, blobs);
    expect(r2.server.conn.since).toBe(11);
    expect(r2.server.conn.view).toBe('t1');
    expect(r2.server.backfills).toEqual([]);
    r2.server.open();
    // a replay that repeats the last frame is a duplicate and changes nothing
    r2.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'a', value: 1 }));
    r2.server.live(11);
    await settle();
    expect(log(r2.data(), 'patron:p1')).toEqual(['set a=1']);
    expect(checkpoint(r2.data())).toEqual({ epoch: 'e1', position: 11, applied: 11 });
    expect(snapshot(r2.data())).toEqual(before);
  });

  test('a crash before a reconciliation commits presents the old token; the frame again yields a clean reconciliation', async () => {
    const blobs = { 'patron:*': patrons, 'book:*': books };
    const clean = rig();
    await bootstrap(clean, ['patron:*'], { 'patron:*': patrons });
    clean.server.blobs.set('book:*', books);
    clean.server.view('t2', 12, ['patron:*', 'book:*']);
    clean.server.vouch(12);
    await settle();
    expect(view(clean)).toEqual({ token: 't2', position: 12, selectors: ['patron:*', 'book:*'] });
    // the same frame is queued when the Engine ends, so it never commits
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    const r2 = await restart(r, blobs);
    expect(view(r2)).toEqual({ token: 't1', position: 10, selectors: ['patron:*'] });
    expect(r2.server.conn.view).toBe('t1');
    expect(r2.server.conn.since).toBe(10);
    r2.server.open();
    r2.server.view('t2', 12, ['patron:*', 'book:*']);
    r2.server.live(12);
    await settle();
    expect(view(r2)).toEqual({ token: 't2', position: 12, selectors: ['patron:*', 'book:*'] });
    expect(state(r2.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(snapshot(r2.data())).toEqual(snapshot(clean.data()));
  });
});
