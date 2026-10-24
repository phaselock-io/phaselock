// Conformance, convergence: P18 and P19 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  bootstrap,
  checkpoint,
  death,
  ev,
  keys,
  logKey,
  rig,
  seq,
  settle,
  state,
  type State,
  watch,
} from '../harness.ts';

import { held, named, one, resumed, set } from './common.ts';

/** every value a query delivered is one of the server's states of the slice, or none */
function allServerStates(values: (State | undefined)[], states: (State | undefined)[]): void {
  for (const v of values) expect(states).toContainEqual(v);
}

// also: chaining.test.ts's 'P5: a slice deleted at the cut is not held...'
describe('P18: every state shown of a held slice is one the server had', () => {
  test('P18: through a gap, its freeze, and its land, every state shown of the slice is one the server had', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');

    // the server's p1: seq 2 at 10, seq 3 at 11 (lost to the client), seq 4 at 12, seq 5 at 13
    const states: State[] = [
      { count: 2, fields: {} },
      { count: 3, fields: {} },
      { count: 3, fields: { a: 4 } },
      { count: 4, fields: { a: 4 } },
    ];
    const gap = r.server.hold('patron:p1');
    r.server.edits(set('patron:p1', 4, 12, 'a', 4));
    r.server.edits(ev('patron:p1', 5, 13));
    await settle();
    r.server.blobs.set('patron:p1', one('patron:p1', 12, 4, 3, { a: 4 }));
    gap.go();
    await settle();
    allServerStates(p1.values, states);
    expect(p1.values.at(-1)).toEqual(states[3]);
  });

  test("P18: a held slice under a widening family moves from its own state to the blob's, never a mix", async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1'], { 'patron:p1': one('patron:p1', 10, 2) });
    const p1 = watch(r, 'patron:p1');

    // the server's p1: seq 2 at 10, a bump at 11, and a set at 12
    const states: State[] = [
      { count: 2, fields: {} },
      { count: 3, fields: {} },
      { count: 3, fields: { a: 1 } },
    ];
    const family = r.server.hold('patron:*');
    r.server.view('t2', 12, ['patron:*']);
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    r.server.blobs.set('patron:*', one('patron:p1', 12, 4, 3, { a: 1 }));
    family.go();
    await settle();
    r.server.edits(set('patron:p1', 4, 12, 'a', 1));
    await settle();
    allServerStates(p1.values, states);
    expect(p1.values.at(-1)).toEqual(states[2]);
    expect(seq(r.data(), 'patron:p1')).toBe(4);
  });
});

describe("P19: at quiescence, the client holds the view's slices at the server's state", () => {
  test('P19: a resync through a retention gap, a death, a missed birth, and a new grant ends at the server state', async () => {
    const r = rig({ seed: resumed });
    await settle();

    /* While the client was away: p1 bumped at 11 and set a at 12, of which retention kept 12;
       p3 was born at 11 and bumped at 14, of which it kept 14; p2 died at 13; the grant took in
       the books at 15; and b1 was born at 16. */
    r.server.blobs.set('patron:p1', one('patron:p1', 16, 4, 3, { a: 1 }));
    r.server.blobs.set('patron:p3', one('patron:p3', 16, 2, 1, { name: 'Cy' }));
    r.server.blobs.set('book:*', {
      position: 16,
      seqs: { 'book:b1': 1 },
      values: [[logKey('book:b1', 1), { id: 'b1', type: 'set', field: 'name', value: 'Dune' }]],
    });
    r.server.open('e1', 16);
    r.server.view('t2', 16, ['patron:*', 'book:*']);
    r.server.edits(set('patron:p1', 4, 12, 'a', 1));
    r.server.edits(death('patron:p2', 2, 13));
    r.server.edits(ev('patron:p3', 2, 14));
    r.server.edits(named('book:b1', 1, 16, 'Dune'));
    r.server.live(16);
    await settle();

    // the grant, the gap, and the missed birth each backfilled their own selector
    expect(r.server.backfills.map((b) => [b.selector, b.until])).toEqual([
      ['book:*', 17],
      ['patron:p1', 12],
      ['patron:p3', 14],
    ]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: { a: 1 } });
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
    expect(state(r.data(), 'patron:p3')).toEqual({ count: 1, fields: { name: 'Cy' } });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 0, fields: { name: 'Dune' } });
    expect(keys(r.data(), '!seq:')).toEqual(['!seq:book:b1', '!seq:patron:p1', '!seq:patron:p3']);
    expect([seq(r.data(), 'patron:p1'), seq(r.data(), 'patron:p3')]).toEqual([4, 2]);
    expect(seq(r.data(), 'book:b1')).toBe(1);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 16, applied: 16 });
  });

  test('P19: a revoke and a regrant during a freeze still end at the server state, holding nothing outside the view', async () => {
    const r = await held();

    // a gap on p2 freezes the base; p1 is revoked, then the family is regranted
    const gap = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();
    r.server.view('t2', 12, ['patron:p2']);
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    const family = r.server.hold('patron:*');
    r.server.view('t3', 13, ['patron:*']);
    r.server.edits(ev('patron:p1', 3, 13));
    r.server.vouch(14);
    await settle();

    // the server's p1 is at seq 3 and p2 at 9 by 13
    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    r.server.blobs.set('patron:*', {
      position: 12,
      seqs: { 'patron:p1': 2, 'patron:p2': 9 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 9, fields: {} }],
      ],
    });
    gap.go();
    family.go();
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data(), '!seq:')).toEqual(['!seq:patron:p1', '!seq:patron:p2']);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, applied: 14 });
  });
});
