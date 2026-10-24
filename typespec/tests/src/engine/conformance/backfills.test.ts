// Conformance, backfills: P16 and P17 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import { bootstrap, ev, keys, page, rig, seq, settle, state, watch } from '../harness.ts';

import { one, patrons, record } from './common.ts';

/* also: landing.test.ts, children.test.ts, and grants.test.ts; chaining.test.ts's 'P4: a member
   whose parked run gaps...' lands a family with the child it spawned */
describe('P16: a backfill lands whole, once both halves of its subtree are done', () => {
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
    await call.push({ header: { position: 8, seqs: patrons.seqs } });
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

  test("P16: a held slice at or past its blob's seq keeps its state, and one behind takes the blob's", async () => {
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

    // the family's blob is cut at 13, past the connection, where p2 has moved and p1 has not
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
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(p1.values).toEqual([{ count: 4, fields: {} }]);
    expect(p2.values).toEqual([
      { count: 1, fields: {} },
      { count: 2, fields: {} },
    ]);

    // p2's edit at 13 arrives after the blob that holds it
    r.server.edits(ev('patron:p2', 2, 13));
    await settle();
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron:p2')).toBe(2);
  });
});

/* also: backfill.test.ts "'stale' clears the selector's values..." and 'a failing backfill is
   retried with its resume intact after backoff'; crash.test.ts 'a store left mid-backfill
   boots...' */
describe('P17: a backfill whose snapshot starts over reads its tail again', () => {
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

  test('P17: a retry after a lost connection skips the finished tail and resumes the blob where it stopped', async () => {
    const r = rig();
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    const first = calls[0].backfill;
    await first.push({ header: { position: 10, seqs: patrons.seqs } });
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
    await first.push({ header: { position: 11, seqs: { 'patron:p1': 5 } } });
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
    await second.push({ header: { position: 13, seqs: { 'patron:p1': 9 } } });
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
