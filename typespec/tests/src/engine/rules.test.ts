// Sync protocol rules, each scripted through the fake server in the order that breaks it

import { describe, expect, test } from 'vitest';

import {
  type Blob,
  bootstrap,
  checkpoint,
  death,
  ev,
  FakeServer,
  keys,
  page,
  parkedEdit,
  type Rig,
  rig,
  seq,
  settle,
  state,
  watch,
} from './harness.ts';

type Record_ = { until: number; resume: null | Record<string, unknown> };
const record = (r: Rig, selector: string): Record_ | undefined =>
  r.data()[`!backfill:${selector}`] as Record_ | undefined;

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};

/** a birth that sets a field, so a state built without it shows */
const named = (slice: string, seq: number, position: number, name: string) =>
  ev(slice, seq, position, { type: 'set', field: 'name', value: name }, undefined, 'birth');

describe('sync protocol rules', () => {
  test('a backfill whose snapshot is restarted reads the tail behind its new snapshot', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();

    // the first attempt delivers the header and an empty tail, and starts the pages
    const first = calls[0].backfill;
    void first.push({ header: { position: 10, seqs: patrons.seqs } });
    void first.push({ editsDone: true });
    void first.push({ page: page(patrons.values.slice(0, 1)), skip: 1, checksum: 'check-1' });
    await settle();
    expect(record(r, 'patron:*')?.resume).toMatchObject({
      skipBytes: 1,
      snapshotDone: false,
      tailDone: true,
    });

    // the connection drops; the blob moves on, so the resumed download is stale
    r.server.end();
    await settle();
    r.server.driven.delete('patron:*');
    r.server.blobs.set('patron:*', { ...patrons, position: 12 });
    r.engine.reconnectNow();
    await settle();
    r.server.open();
    r.server.live(10);
    await settle();

    // the resumed call answered stale, and the restart reads both halves again
    expect(r.server.backfills.map((b) => b.resume)).toEqual([
      null,
      expect.objectContaining({ skipBytes: 1, snapshotDone: false, tailDone: true }),
      expect.objectContaining({ skipBytes: 0, snapshotDone: false, tailDone: false }),
    ]);
    expect(r.server.tails).toEqual([expect.objectContaining({ selector: 'patron:*', after: 12 })]);

    // so it lands, and queries show the slices
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: {} });
  });

  test('after a view frame, the client holds nothing, parked or applied, of a slice the view no longer covers', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], {
      'patron:*': { ...patrons, seqs: { 'patron:p1': 2 }, values: patrons.values.slice(0, 1) },
    });
    const p2 = watch(r, 'patron:p2');

    // a gap on p1 freezes the base, and p2 is born in the same frame, parked under no backfill
    const gap = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11), named('patron:p2', 1, 11, 'Bo'));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([parkedEdit('patron:p2', 1)]);

    // the view narrows to p1, which takes p2's parked birth with it
    r.server.view('t2', 12, ['patron:p1']);
    await settle();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();

    // p1's backfill lands and unfreezes the base, and p2 never appears
    r.server.blobs.set('patron:p1', {
      position: 11,
      seqs: { 'patron:p1': 5 },
      values: [['patron:p1!state', { count: 5, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), 'patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(p2.values.every((v) => v === undefined)).toBe(true);
  });

  test('after the boot purge, the client holds nothing, parked or applied, of a slice the build does not want', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*', 'book:*'], {
      'patron:*': patrons,
      'book:*': { position: 10, seqs: {}, values: [] },
    });

    // a gap on p1 freezes the base, and b9 is born in the same frame, parked under no backfill
    r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11), named('book:b9', 1, 11, 'Dune'));
    await settle();
    expect(seq(r.data(), 'book:b9')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:book:b9!')).toEqual([parkedEdit('book:b9', 1)]);

    // a build that wants patrons alone boots over the store, and lands p1's backfill
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron:p1', {
      position: 11,
      seqs: { 'patron:p1': 5 },
      values: [['patron:p1!state', { count: 5, fields: {} }]],
    });
    const r2 = rig({ store: r.store, server, wants: ['patron:*'] });
    await settle();
    expect(state(r2.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(keys(r2.data(), '!backfill')).toEqual([]);
    expect(keys(r2.data(), '!park')).toEqual([]);
    expect(keys(r2.data(), 'book:b9!')).toEqual([]);
    expect(seq(r2.data(), 'book:b9')).toBeUndefined();
  });

  test('a slice deleted at the cut is not held, so no state the client shows is one the server never had', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();

    // p1 is born live while the bootstrap downloads, and parks under it
    r.server.edits(named('patron:p1', 1, 11, 'Ann'));
    await settle();
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 1)]);

    // the blob is cut after p1's death at 13, so its header does not name p1
    r.server.blobs.set('patron:*', { position: 13, seqs: {}, values: [] });
    boot.go();
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();

    // p1's next edit, in flight on the connection, finds p1 unknown and backfills it
    const missed = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 2, 12));
    await settle();
    expect(r.server.backfills.at(-1)).toMatchObject({ selector: 'patron:p1', until: 12 });
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);

    // the death arrives, and the backfill's blob agrees that p1 is gone
    r.server.edits(death('patron:p1', 3, 13));
    r.server.blobs.set('patron:p1', { position: 13, seqs: {}, values: [] });
    missed.go();
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(p1.values.length).toBeGreaterThan(0);
    expect(p1.values.every((v) => v === undefined)).toBe(true);
  });

  test("once a bootstrap's view frame at V is processed, the cursor is V, and a reconnect resumes from it", async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    r.server.blobs.set('patron:*', patrons);
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });

    // the connection drops before any edits, vouch, or live, and the log moves on to 12
    r.server.end();
    await settle();
    const log = [
      ev('patron:p1', 3, 11, { type: 'set', field: 'name', value: 'Ann' }),
      ev('patron:p2', 2, 12),
    ];
    r.engine.reconnectNow();
    await settle();

    // the server replays from since, and a bootstrap's connection starts at its head
    const since = r.server.conn.since;
    expect(since).toBe(10);
    r.server.open('e1', 12);
    const replay = log.filter((e) => e.position > (since === -1 ? 12 : since));
    if (replay.length > 0) r.server.edits(...replay);
    r.server.live(12);
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 12, applied: 12 });
  });

  test("a view frame's backfills cover every position at or below the frame's", async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    r.server.blobs.set('patron:*', {
      ...patrons,
      position: 8,
      tail: [ev('patron:p1', 3, 10, { type: 'set', field: 'name', value: 'Ann' })],
    });
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    expect(record(r, 'patron:*')?.until).toBeGreaterThan(10);

    // the tail reads through 10, which the bootstrap's connection never delivers
    boot.go();
    r.server.live(10);
    await settle();
    expect(r.server.tails).toEqual([{ selector: 'patron:*', after: 8, before: 11 }]);
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
  });
});
