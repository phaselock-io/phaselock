// Conformance, backfills: P16 and P17 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  bootstrap,
  checkpoint,
  ev,
  keys,
  page,
  readState,
  rig,
  seq,
  settle,
  state,
  watch,
} from '../harness.ts';

import { held, one, patrons, record } from './common.ts';

describe("P16: the land waits for every backfill and for the cursor to reach each one's visible", () => {
  test('P16: a backfill lands only once both halves are done, and leaves nothing behind', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();

    // the blob, cut at 8, is done, and its tail is not
    const call = calls[0].backfill;
    await call.push({ header: { position: 8, seqs: patrons.seqs, visible: 8 } });
    await call.push({ page: page(patrons.values), skip: 2, checksum: 'c' });
    await call.push({ pagesDone: true });
    await call.push({ edits: [ev('patron:p1', 3, 9)], scanned: 9 });
    await settle();
    expect(p1.values).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual(['!backfill-seqs:patron:*', '!backfill:patron:*']);

    await call.push({ editsDone: true });
    calls[0].done('done');
    await settle();
    expect(p1.values).toEqual([{ count: 3, fields: {} }]);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('P16: a blob whose slices changed past the cursor waits for the connection to reach the change, then lands with it', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1', 'patron:p2'], {
      'patron:p1': one('patron:p1', 10, 2),
      'patron:p2': one('patron:p2', 10, 1),
    });
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.edits(ev('patron:p1', 4, 12));
    await settle();
    const p1 = watch(r, 'patron:p1');
    const p2 = watch(r, 'patron:p2');
    await settle();

    // the family's blob is cut at 13, past the connection, where p2 has just moved and p1 has not
    r.server.blobs.set('patron:*', {
      position: 13,
      seqs: { 'patron:p1': 4, 'patron:p2': 2 },
      values: [
        ['patron:p1!state', { count: 4, fields: {} }],
        ['patron:p2!state', { count: 2, fields: {} }],
      ],
    });
    r.server.view('t2', 13, ['patron:*']);
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual(['!backfill-seqs:patron:*', '!backfill:patron:*']);
    expect(p2.values).toEqual([{ count: 1, fields: {} }]);

    // p2's edit at 13 brings the cursor to the cut, and the land shows the blob's p2 with it
    r.server.edits(ev('patron:p2', 2, 13));
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(p1.values).toEqual([{ count: 4, fields: {} }]);
    expect(p2.values).toEqual([
      { count: 1, fields: {} },
      { count: 2, fields: {} },
    ]);
    expect(seq(r.data(), 'patron:p2')).toBe(2);
  });

  test('P16: a blob whose slices last changed at or below the cursor lands as soon as it downloads, though cut past it', async () => {
    const r = await held();
    const b1 = watch(r, 'book:b1');
    const books = r.server.hold('book:*');
    r.server.blobs.set('book:*', { ...one('book:b1', 20, 3), visible: 9 });
    r.server.view('t2', 10, ['patron:*', 'book:*']);
    await settle();
    expect(b1.values.filter((v) => v !== undefined)).toEqual([]);

    // no vouch reaches 20, and none needs to
    books.go();
    await settle();
    expect(b1.values.filter((v) => v !== undefined)).toEqual([{ count: 3, fields: {} }]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test("P16: a tail edit past the cursor, from a blob cut below the view's position, waits for the connection to reach it", async () => {
    const r = await held();
    const b1 = watch(r, 'book:b1');
    r.server.blobs.set('book:*', {
      ...one('book:b1', 8, 2),
      tail: [ev('book:b1', 3, 12)],
    });
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    await settle();
    expect(r.server.tails.at(-1)).toEqual({ selector: 'book:*', after: 8, before: 13 });
    expect(b1.values.filter((v) => v !== undefined)).toEqual([]);

    r.server.vouch(12);
    await settle();
    expect(b1.values.filter((v) => v !== undefined)).toEqual([{ count: 3, fields: {} }]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('P16: a grant that arrives before the land joins it, and everything granted lands together', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1'], { 'patron:p1': one('patron:p1', 10, 2) });
    const seen: (number | null)[][] = [];
    r.engine
      .newQuery((qx) => ['patron:p2', 'book:b1'].map((s) => readState(qx, s)?.count ?? null))
      .subscribe((v) => seen.push(v));
    const p2 = r.server.hold('patron:p2');
    const b1 = r.server.hold('book:b1');
    r.server.blobs.set('patron:p2', one('patron:p2', 11, 1));
    r.server.blobs.set('book:b1', one('book:b1', 12, 5));
    r.server.view('t2', 11, ['patron:p1', 'patron:p2']);
    r.server.view('t3', 12, ['patron:p1', 'patron:p2', 'book:b1']);
    r.server.vouch(12);
    await settle();

    // p2's download finishes first, and waits for b1's
    p2.go();
    await settle();
    expect(seen).toEqual([[null, null]]);
    b1.go();
    await settle();
    expect(seen).toEqual([
      [null, null],
      [1, 5],
    ]);
  });
});

// also: crash.test.ts 'a store left mid-backfill boots...'
describe('P17: a backfill whose snapshot starts over reads its tail again, and a retry resumes', () => {
  test('P17: a backfill whose snapshot is restarted reads the tail behind its new snapshot', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();

    // the first attempt delivers the header and an empty tail, and starts the pages
    const first = calls[0].backfill;
    void first.push({ header: { position: 10, seqs: patrons.seqs, visible: 10 } });
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
    r.server.vouch(12);
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

  test('P17: a retry after a lost connection skips the finished tail and resumes the blob where it stopped', async () => {
    const r = rig();
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    const first = calls[0].backfill;
    await first.push({ header: { position: 10, seqs: patrons.seqs, visible: 10 } });
    await first.push({ editsDone: true });
    await first.push({ page: page(patrons.values), skip: 2, checksum: 'check-2' });
    await settle();

    // the connection drops before the pages are done, and the blob is still the one at 10
    r.server.end();
    await settle();
    r.server.driven.delete('patron:*');
    r.server.blobs.set('patron:*', patrons);
    r.engine.reconnectNow();
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({
      selector: 'patron:*',
      until: 11,
      resume: {
        position: 10,
        visible: 10,
        skipBytes: 2,
        checksum: 'check-2',
        fromPosition: 10,
        snapshotDone: false,
        tailDone: true,
      },
    });
    expect(r.server.tails).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
  });

  test('P17: a failure after both halves are in leaves the backfill ready, and it lands with no retry', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();

    // the blob is cut at 12, past the cursor, so the finished download waits; then the call fails
    const call = calls[0].backfill;
    await call.push({ header: { position: 12, seqs: patrons.seqs, visible: 12 } });
    await call.push({ page: page(patrons.values), skip: 2, checksum: 'c' });
    await call.push({ pagesDone: true });
    await call.push({ editsDone: true });
    calls[0].fail(new Error('reset by peer'));
    await settle();
    expect(record(r, 'patron:*')?.resume).toMatchObject({ snapshotDone: true, tailDone: true });

    // the cursor reaches the cut, and it lands with no second call
    r.server.vouch(12);
    await settle();
    expect(calls.length).toBe(1);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: {} });
  });

  test('P17: a repair restarts an exact backfill from a fresh snapshot, tail included, under the same until', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const calls = r.server.drive('patron:p1');

    // a gap on p1, and a second gap in what parks behind it
    r.server.edits(ev('patron:p1', 5, 11));
    r.server.edits(ev('patron:p1', 9, 13));
    await settle();

    // the first blob gives seq 5, from which the parked seq 9 does not chain
    const first = calls[0].backfill;
    await first.push({
      header: { position: 11, seqs: { 'patron:p1': 5, 'visible': 11 }, visible: 11 },
    });
    await first.push({
      page: page([['patron:p1!state', { count: 5, fields: {} }]]),
      skip: 1,
      checksum: 'c',
    });
    await first.push({ pagesDone: true });
    await first.push({ editsDone: true });
    calls[0].done('done');
    await settle();
    expect(calls.length).toBe(2);
    expect(calls[1].backfill.until).toBe(11);
    expect(calls[1].backfill.resume).toBeNull();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });

    // the fresh blob is cut at 13, past the second gap
    const second = calls[1].backfill;
    await second.push({
      header: { position: 13, seqs: { 'patron:p1': 9, 'visible': 13 }, visible: 13 },
    });
    await second.push({
      page: page([['patron:p1!state', { count: 9, fields: {} }]]),
      skip: 1,
      checksum: 'c',
    });
    await second.push({ pagesDone: true });
    await second.push({ editsDone: true });
    calls[1].done('done');
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 9, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });
});
