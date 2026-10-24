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

/** a gap on patron:p2 at 11 freezes the base until its backfill is released */
async function freeze(r: Rig): Promise<() => void> {
  const hold = r.server.hold('patron:p2');
  r.server.edits(ev('patron:p2', 9, 11));
  await settle();
  return () => {
    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    hold.go();
  };
}

describe('P15: while a backfill is in flight the base is frozen, and the land ends the freeze in one step', () => {
  test('P15: a freeze parks every edit, moves only the cursor, and its land shows everything at once', async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2', 'patron:p9']);
    const release = await freeze(r);

    // a frozen edit of p1, and p9's first edit, a missed birth the land will find
    r.server.blobs.set('patron:p9', one('patron:p9', 13, 3));
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.edits(ev('patron:p9', 3, 13));
    r.server.vouch(14);
    await settle();
    expect(record(r, 'patron:p9')).toBeUndefined();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, applied: 10 });
    expect(seen).toEqual([[2, 1, null]]);

    release();
    await settle();
    expect(seen).toEqual([
      [2, 1, null],
      [3, 9, 3],
    ]);
    expect(r.server.backfills.map((b) => b.selector)).toEqual([
      'patron:*',
      'patron:p2',
      'patron:p9',
    ]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, applied: 14 });
  });

  test('P15: a view frame that cancels the last backfill ends the freeze in one land, the revoke with it', async () => {
    const r = await held();
    const seen = counts(r, ['patron:p1', 'patron:p2', 'patron:p9']);
    await freeze(r);
    r.server.blobs.set('patron:p9', one('patron:p9', 13, 3));
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.edits(ev('patron:p9', 3, 13));
    await settle();
    expect(seen).toEqual([[2, 1, null]]);

    // p2 is revoked, and with it its backfill and the freeze
    r.server.view('t2', 14, ['patron:p1', 'patron:p9']);
    await settle();
    expect(seen).toEqual([
      [2, 1, null],
      [3, null, 3],
    ]);
    expect(r.server.backfills.map((b) => b.selector)).toEqual([
      'patron:*',
      'patron:p2',
      'patron:p9',
    ]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 13 });
  });
});
