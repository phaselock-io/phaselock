// Conformance, lifecycle: P6 and P7 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import { death, ev, keys, log, rig, seq, settle, state, watch } from '../harness.ts';

import { held, named, one, resumed } from './common.ts';

describe('P6: a birth clears its slice, then applies its writes', () => {
  test('P6: a birth shows only its own writes, on a slice nothing holds and over a held one, with no backfill', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');
    const p3 = watch(r, 'patron:p3');
    r.server.edits(named('patron:p3', 1, 11, 'Cy'));
    await settle();
    expect(p3.values.at(-1)).toEqual({ count: 0, fields: { name: 'Cy' } });
    expect(seq(r.data(), 'patron:p3')).toBe(1);

    // a birth over p1, held at 2, missing its seqs 3 and 4
    r.server.edits(named('patron:p1', 5, 12, 'Al'));
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 0, fields: { name: 'Al' } });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*']);
  });

  test('P6: a birth in a resync replay introduces a slice the client never saw, with no backfill', async () => {
    const r = rig({ seed: resumed });
    const p3 = watch(r, 'patron:p3');
    await settle();
    r.server.open('e1', 12);
    r.server.edits(named('patron:p3', 1, 11, 'Cy'));
    r.server.edits(ev('patron:p3', 2, 12));
    r.server.live(12);
    await settle();
    expect(p3.values.at(-1)).toEqual({ count: 1, fields: { name: 'Cy' } });
    expect(seq(r.data(), 'patron:p3')).toBe(2);
    expect(r.server.backfills).toEqual([]);
  });
});

// the database's half is server_test.go's TestDeletingANonLiveSliceIsNoEdit
describe('P7: a death clears its slice, and the client forgets it', () => {
  test('P7: after a death, a normal edit of the slice is a missed birth, and a rebirth starts it from empty', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');
    r.server.edits(death('patron:p1', 3, 11));
    await settle();
    expect(p1.values.at(-1)).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();

    // p1's birth at 12 is missed, and its seq 5 at 13 arrives
    const missed = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 13));
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'patron:p1', until: 13, resume: null });
    expect(p1.values.at(-1)).toBeUndefined();
    r.server.blobs.set('patron:p1', one('patron:p1', 12, 4, 0, { name: 'Al' }));
    missed.go();
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 1, fields: { name: 'Al' } });

    // a death and a rebirth in one mutation
    r.server.edits(death('patron:p1', 6, 14), named('patron:p1', 7, 14, 'Bo'));
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 0, fields: { name: 'Bo' } });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
  });

  test('P7: a replay that brings only the death of a slice never held costs no backfill and holds nothing', async () => {
    const r = rig({ seed: resumed });
    await settle();

    // p9 was born and died while the client was away, and retention kept only its death
    r.server.open('e1', 13);
    r.server.edits(death('patron:p9', 4, 12));
    r.server.edits(ev('patron:p1', 3, 13));
    r.server.live(13);
    await settle();
    expect(seq(r.data(), 'patron:p9')).toBeUndefined();
    expect(keys(r.data(), 'patron:p9!')).toEqual([]);
    expect(r.server.backfills).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe(3);
  });

  test("P7: a death parked under a missed birth's backfill forgets the slice when it lands", async () => {
    const r = await held();
    const b1 = watch(r, 'book:b1');
    const missed = r.server.hold('book:b1');
    r.server.edits(ev('book:b1', 3, 11));
    r.server.edits(death('book:b1', 4, 12));
    await settle();

    // the blob, cut before the death, names b1, and the parked death ends it
    r.server.blobs.set('book:b1', one('book:b1', 10, 2));
    missed.go();
    await settle();
    expect(b1.values.every((v) => v === undefined)).toBe(true);
    expect(seq(r.data(), 'book:b1')).toBeUndefined();
    expect(keys(r.data(), 'book:b1!')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(log(r.data(), 'book:b1')).toEqual([]);

    // so b1's next normal edit is a missed birth again
    r.server.hold('book:b1');
    r.server.edits(ev('book:b1', 6, 14));
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'book:b1', until: 14, resume: null });
    expect(state(r.data(), 'book:b1')).toBeUndefined();
  });
});
