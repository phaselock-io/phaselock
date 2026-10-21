// Live edits applied to the base, predictions on the overlay, and synchronous queries

import { describe, expect, test } from 'vitest';

import {
  type Blob,
  bootstrap,
  ev,
  predict,
  type Predictor,
  rig,
  settle,
  state,
  type TestEdit,
  watch,
} from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};

describe('live edits', () => {
  test("an edit's writes land on the base under its slice, as its payload names them", async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    expect(Object.keys(r.data()).filter((k) => k.startsWith('patron:p1!'))).toEqual([
      'patron:p1!log:000003',
      'patron:p1!state',
    ]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
  });
});

describe('predictions', () => {
  // each mutation names the slices it writes to and what it logs there
  const predictor: Predictor = (txn, mutation, pending) => {
    expect(pending).toBe(true);
    const m = mutation as { writes: [string, TestEdit][]; deletes?: string[] };
    for (const [slice, data] of m.writes) predict(txn, slice, data);
    for (const slice of m.deletes ?? []) txn.deleteSlice(slice, false);
  };
  const set = (slice: string, field: string): [string, TestEdit] => [
    slice,
    { id: slice.slice(slice.indexOf(':') + 1), type: 'set', field, value: 1 },
  ];

  test('a prediction lands on the overlay, and stays off the base', async () => {
    const r = rig({ predictor });
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const p2 = watch(r, 'patron:p2');
    r.engine.sendMutation({ writes: [set('patron:p2', 'a')] });
    await settle();
    expect(p2.values.at(-1)).toEqual({ count: 1, fields: { a: 1 } });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
  });

  test("a predictor that throws cancels that mutation's whole prediction, and the others stand", async () => {
    const r = rig({ predictor });
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const p1 = watch(r, 'patron:p1');
    const p2 = watch(r, 'patron:p2');
    r.engine.sendMutation({ writes: [set('patron:p1', 'a')] });
    // its write to patron:p2 is rolled back with the throw on patron:p1
    r.engine.sendMutation({
      writes: [set('patron:p2', 'b'), ['patron:p1', { id: 'p1', type: 'boom' }]],
    });
    r.engine.sendMutation({ writes: [set('patron:p1', 'c')] });
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { a: 1, c: 1 } });
    expect(p2.values.at(-1)).toEqual({ count: 1, fields: {} });
  });

  test("a predicted deletion drops the slice's keys from the overlay only", async () => {
    const r = rig({ predictor });
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const p1 = watch(r, 'patron:p1');
    r.engine.sendMutation({ writes: [], deletes: ['patron:p1'] });
    await settle();
    expect(p1.values.at(-1)).toBeUndefined();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
  });

  test("a predictor's reads are its own, to change and set back", async () => {
    const r = rig({
      predictor: (txn) => {
        const s = txn.get('patron:p1!state', 'state') as { count: number };
        s.count += 10;
        txn.set('patron:p1!state', 'state', s);
      },
    });
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const p1 = watch(r, 'patron:p1');
    r.engine.sendMutation({});
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 12, fields: {} });
  });
});

describe('queries', () => {
  test('a query runs again only when a key it read changes', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
    const p1 = watch(r, 'patron:p1');
    await settle();
    const before = p1.runs();
    expect(before).toBeGreaterThan(0);

    // an edit of another slice leaves the query alone
    r.server.edits(ev('patron:p2', 2, 11));
    await settle();
    expect(p1.runs()).toBe(before);

    // an edit of its own slice runs it again
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(p1.runs()).toBe(before + 1);
    expect(p1.values.at(-1)).toEqual({ count: 3, fields: {} });
  });
});
