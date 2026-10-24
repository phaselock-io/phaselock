// Conformance, atomicity: P22 and P23 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  bootstrap,
  ev,
  keys,
  page,
  readState,
  rig,
  type Rig,
  seq,
  settle,
  state,
} from '../harness.ts';

import { held, one, patrons, record, restart } from './common.ts';

/** a query on the counts of slices, null for one the base does not hold, with every answer */
function counts(r: Rig, slices: string[]): (number | null)[][] {
  const values: (number | null)[][] = [];
  r.engine
    .newQuery((qx) => slices.map((s) => readState(qx, s)?.count ?? null))
    .subscribe((v) => values.push(v));
  return values;
}

describe('P22: queries see a frame whole or not at all', () => {
  test("P22: a query over two held slices sees a mutation's edits to both at once", async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2']);
    r.server.edits(ev('patron:p1', 3, 11), ev('patron:p2', 2, 11));
    r.server.edits(ev('patron:p2', 3, 12), ev('patron:p1', 4, 12));
    await settle();
    expect(seen).toEqual([
      [2, 1],
      [4, 3],
    ]);
  });

  test("P22: a mutation's frozen edits reach queries together, at the land", async () => {
    const r = rig();
    await bootstrap(r, ['patron:*', 'book:b1'], {
      'patron:*': patrons,
      'book:b1': one('book:b1', 10, 1),
    });
    const seen = counts(r, ['patron:p1', 'book:b1']);
    const gap = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    r.server.edits(ev('patron:p1', 3, 12), ev('book:b1', 2, 12));
    await settle();
    expect(seen).toEqual([[2, 1]]);
    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    gap.go();
    await settle();
    expect(seen).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  test('P22: a mutation whose edit of one slice gaps shows none of its edits until the land', async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2']);
    const gap = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p1', 3, 12), ev('patron:p2', 9, 12));
    await settle();
    r.server.blobs.set('patron:p2', one('patron:p2', 12, 9));
    gap.go();
    await settle();
    expect(seen).toEqual([
      [2, 1],
      [3, 9],
    ]);
  });
});

/* Also: crash.test.ts 'a store left mid-backfill boots with the record...'.  The database's half is
   server_test.go's TestAnEditsPageNeverSplitsAMutation. */
describe('P23: a tail is parked and resumed by whole mutations', () => {
  test('P23: a tail in several deliveries parks each, and the land waits for its end', async () => {
    const r = rig();
    const seen = counts(r, ['patron:p1', 'patron:p2']);
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    const call = calls[0].backfill;
    await call.push({ header: { position: 8, seqs: patrons.seqs, visible: 8 } });
    await call.push({ page: page(patrons.values), skip: 2, checksum: 'c' });
    await call.push({ pagesDone: true });
    await call.push({ edits: [ev('patron:p1', 3, 9), ev('patron:p2', 2, 9)], scanned: 9 });
    await settle();
    expect(keys(r.data(), '!park-edit:').length).toBe(2);
    expect(seen).toEqual([]);

    await call.push({ edits: [ev('patron:p1', 4, 10)], scanned: 10 });
    await call.push({ editsDone: true });
    calls[0].done('done');
    await settle();
    expect(seen).toEqual([[4, 2]]);
  });

  test('P23: a restart mid-tail resumes after the highest position parked', async () => {
    const r = rig();
    const calls = r.server.drive('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    const call = calls[0].backfill;
    await call.push({ header: { position: 8, seqs: patrons.seqs, visible: 8 } });
    await call.push({ page: page(patrons.values), skip: 2, checksum: 'c' });
    await call.push({ pagesDone: true });
    await call.push({ edits: [ev('patron:p1', 3, 9), ev('patron:p2', 2, 9)], scanned: 9 });
    await settle();
    expect(record(r, 'patron:*')?.resume?.fromPosition).toBe(9);

    // the new Engine's download skips the blob and reads the tail after 9
    const tail = [ev('patron:p1', 3, 9), ev('patron:p2', 2, 9), ev('patron:p1', 4, 10)];
    const r2 = await restart(r, { 'patron:*': { ...patrons, position: 8, tail } });
    expect(r2.server.backfills).toEqual([
      {
        selector: 'patron:*',
        until: 11,
        resume: expect.objectContaining({ fromPosition: 9, snapshotDone: true, tailDone: false }),
      },
    ]);
    expect(r2.server.tails).toEqual([{ selector: 'patron:*', after: 9, before: 11 }]);
    expect(state(r2.data(), 'patron:p1')).toEqual({ count: 4, fields: {} });
    expect(state(r2.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(seq(r2.data(), 'patron:p1')).toBe(4);
  });
});
