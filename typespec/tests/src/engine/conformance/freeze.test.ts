// Conformance, the freeze: P15 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import { checkpoint, ev, keys, readState, type Rig, settle } from '../harness.ts';

import { held, one, record } from './common.ts';

/** a query on the counts of slices, null for one the base does not hold, with every answer */
function counts(r: Rig, slices: string[]): (number | null)[][] {
  const values: (number | null)[][] = [];
  r.engine
    .newQuery((qx) => slices.map((s) => readState(qx, s)?.count ?? null))
    .subscribe((v) => values.push(v));
  return values;
}

/** a gap on patron:p2 at 11 freezes the base until its replacing backfill is released */
async function freeze(r: Rig): Promise<() => void> {
  const hold = r.server.hold('patron:p2');
  r.server.edits(ev('patron:p2', 9, 11));
  await settle();
  return () => {
    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    hold.go();
  };
}

/* also: freeze.test.ts, the whole of it; chaining.test.ts's 'P3: a missed birth backfills its slice
   additively, and the base keeps moving meanwhile' shows that an additive backfill never freezes */
describe('P15: a replacing backfill freezes the base, and the freeze ends in one step', () => {
  test('P15: a freeze parks every edit and holds every ready backfill, and its end shows them all at once', async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2', 'book:b1']);
    const release = await freeze(r);

    // a frozen edit of p1, and a missed birth of b1 whose additive backfill finishes at once
    r.server.blobs.set('book:b1', one('book:b1', 10, 2));
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.edits(ev('book:b1', 3, 13));
    r.server.vouch(14);
    await settle();
    expect(record(r, 'book:b1')).toBeDefined();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, applied: 10 });
    expect(seen).toEqual([[2, 1, null]]);

    release();
    await settle();
    expect(seen).toEqual([
      [2, 1, null],
      [3, 9, 3],
    ]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, applied: 14 });
  });

  test('P15: a view frame that drops the last replacing backfill ends the freeze, landing the frozen edits and the ready backfills at once', async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2', 'book:b1']);
    await freeze(r);
    r.server.blobs.set('book:b1', one('book:b1', 10, 2));
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.edits(ev('book:b1', 3, 13));
    await settle();
    expect(seen).toEqual([[2, 1, null]]);

    // p2 is revoked, and with it the freeze
    r.server.view('t2', 14, ['patron:p1', 'book:b1']);
    await settle();
    expect(seen).toEqual([
      [2, 1, null],
      [3, null, 3],
    ]);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'patron:p2', 'book:b1']);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 13 });
  });
});
