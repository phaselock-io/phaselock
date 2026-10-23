// TESTS.md: Freeze and group land

import { describe, expect, test } from 'vitest';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  keys,
  last,
  log,
  parkedEdit,
  parkedKeys,
  predict,
  type Predictor,
  type Rig,
  rig,
  seq,
  settle,
  state,
  watch,
  watchStatus,
} from './harness.ts';

type Record_ = { until: number; replacing: boolean; children: string[] };
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
const b1Blob: Blob = {
  position: 10,
  seqs: { 'book:b1': 1 },
  values: [['book:b1!state', { count: 1, fields: {} }]],
};
const p1Blob: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2 },
  values: [['patron:p1!state', { count: 2, fields: {} }]],
};

/** predicts a `set` on patron:p1, reading nothing */
const predictor: Predictor = (txn, mutation) => {
  const m = mutation as { field: string; value: unknown };
  predict(txn, 'patron:p1', { id: 'p1', type: 'set', field: m.field, value: m.value });
};

/** a live Engine holding patron:p1, patron:p2, and book:b1 at position 10 */
async function held(withPredictor = false): Promise<Rig> {
  const r = rig(withPredictor ? { predictor } : {});
  await bootstrap(r, ['patron:*', 'book:b1'], { 'patron:*': patrons, 'book:b1': b1Blob });
  return r;
}

/** freeze the base: a gap on patron:p2 at the position, its replacing backfill held */
async function freeze(r: Rig, position = 11): Promise<{ release: () => void }> {
  const hold = r.server.hold('patron:p2');
  r.server.edits(ev('patron:p2', 9, position));
  await settle();
  expect(seq(r.data(), 'patron:p2')).toBe('backfill');
  return {
    release: () => {
      r.server.blobs.set('patron:p2', {
        position,
        seqs: { 'patron:p2': 9 },
        values: [['patron:p2!state', { count: 9, fields: {} }]],
      });
      hold.go();
    },
  };
}

describe('freeze and group land', () => {
  test('the first replacing backfill freezes the base: live edits park while !checkpoint advances', async () => {
    const r = await held();
    const { release } = await freeze(r);
    expect(record(r, 'patron:p2')).toMatchObject({ replacing: true, until: 11 });
    r.server.edits(ev('patron:p1', 3, 12), ev('book:b1', 2, 13));
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(seq(r.data(), 'book:b1')).toBe(1);
    expect(keys(r.data(), '!park-ed:')).toEqual([
      parkedEdit('book:b1', 2),
      parkedEdit('patron:p1', 3),
      parkedEdit('patron:p2', 9),
    ]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 10 });
    release();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 13 });
  });

  test('an additive backfill completing during a freeze lands only with the group', async () => {
    const r = await held();
    const { release } = await freeze(r);
    r.server.blobs.set('book:b2', {
      position: 12,
      seqs: { 'book:b2': 1 },
      values: [['book:b2!state', { count: 1, fields: {} }]],
    });
    r.server.view('t2', 12, ['patron:*', 'book:b1', 'book:b2']);
    await settle();
    // downloaded and ready, but the base is frozen
    expect(record(r, 'book:b2')).toMatchObject({ replacing: false, until: 13 });
    expect(state(r.data(), 'book:b2')).toBeUndefined();
    expect(seq(r.data(), 'book:b2')).toBe('backfill');
    expect(parkedKeys(r.data(), 'book:b2')).toEqual(['book:b2!state']);
    release();
    await settle();
    expect(state(r.data(), 'book:b2')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'book:b2')).toBe(1);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('a replacing child under a still-downloading additive parent holds the freeze until the subtree lands', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1', 'book:b1'], { 'patron:p1': p1Blob, 'book:b1': b1Blob });
    const fam = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*', 'book:b1']);
    await settle();
    // a gap on held p1 under the in-flight family: a replacing child at once
    const child = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 12));
    await settle();
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 12 });
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    r.server.edits(ev('book:b1', 2, 13));
    await settle();
    expect(keys(r.data(), '!park-ed:book:b1!')).toEqual([parkedEdit('book:b1', 2)]);
    // the child completes; its parent is still downloading, so nothing lands
    r.server.blobs.set('patron:p1', {
      position: 12,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    child.go();
    await settle();
    expect(record(r, 'patron:p1')).toBeDefined();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    // the parent completes: the subtree lands as one, and the frozen edits with it
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 99, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    fam.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 13 });
  });

  test('a revoke that drops the last replacing selector lands the frozen edits in the same transaction', async () => {
    const r = await held();
    await freeze(r);
    r.server.edits(ev('book:b1', 2, 12), ev('patron:p1', 3, 12));
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    r.server.view('t2', 13, ['book:b1']);
    await settle();
    expect(record(r, 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'book:b1')).toBe(2);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 12, applied: 12 });
  });

  test('a widening grant over the last replacing selector adopts it, and the freeze holds until the subtree lands', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1', 'book:b1'], { 'patron:p1': p1Blob, 'book:b1': b1Blob });
    const child = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 11));
    await settle();
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 11 });
    r.server.edits(ev('book:b1', 2, 12));
    await settle();
    const fam = r.server.hold('patron:*');
    r.server.view('t2', 13, ['patron:*', 'book:b1']);
    await settle();
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 11 });
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    expect(keys(r.data(), '!park-ed:book:b1!')).toEqual([parkedEdit('book:b1', 2)]);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    r.server.blobs.set('patron:p1', {
      position: 11,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    r.server.blobs.set('patron:*', {
      position: 13,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 99, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    child.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    fam.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('frozen edits on a slice a landing selector covers land once, through the selector', async () => {
    const r = await held();
    const { release } = await freeze(r);
    r.server.edits(ev('patron:p2', 10, 12), ev('patron:p1', 3, 13));
    await settle();
    release();
    await settle();
    expect(log(r.data(), 'patron:p2')).toEqual(['bump']);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 10, fields: {} });
    expect(seq(r.data(), 'patron:p2')).toBe(10);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('a frozen edit on a slice under an in-flight additive backfill stays parked through the group land', async () => {
    const r = await held();
    const { release } = await freeze(r);
    const b2 = r.server.hold('book:b2');
    r.server.view('t2', 12, ['patron:*', 'book:b1', 'book:b2']);
    await settle();
    r.server.edits(ev('book:b2', 5, 13), ev('book:b1', 2, 13));
    await settle();
    release();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(record(r, 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'book:b2')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:')).toEqual([parkedEdit('book:b2', 5)]);
    expect(record(r, 'book:b2')).toBeDefined();
    r.server.blobs.set('book:b2', {
      position: 12,
      seqs: { 'book:b2': 4 },
      values: [['book:b2!state', { count: 4, fields: {} }]],
    });
    b2.go();
    await settle();
    expect(state(r.data(), 'book:b2')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'book:b2')).toBe(5);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('the status shows the freeze: syncing and frozen while a replacing backfill is in flight, live and unfrozen after the group land, and syncing and frozen again on a gap', async () => {
    const r = await held();
    const status = watchStatus(r);
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', hasBase: true, frozen: false });

    const { release } = await freeze(r);
    expect(last(status.connection)).toMatchObject({
      state: 'syncing',
      hasBase: true,
      frozen: true,
    });
    release();
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });

    r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 9, 20));
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'syncing', frozen: true });
  });

  test('optimistic updates keep flowing during a freeze: a new mutation is predicted against the frozen base and the graph runs', async () => {
    const r = await held(true);
    const w = watch(r, 'patron:p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    const { release } = await freeze(r);
    r.engine.sendMutation({ field: 'x', value: 1 });
    await settle();
    expect(w.values).toEqual([
      { count: 2, fields: {} },
      { count: 2, fields: { x: 1 } },
    ]);
    // the base under it is untouched
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    release();
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { x: 1 } });
  });

  test('the query graph does not run for data changes while frozen', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    const { release } = await freeze(r);
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.vouch(20);
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    release();
    await settle();
    expect(w.values).toEqual([
      { count: 2, fields: {} },
      { count: 3, fields: {} },
    ]);
  });

  test('a revoke while frozen leaves queries at once, though the freeze holds', async () => {
    const r = await held();
    const w = watch(r, 'book:b1');
    await settle();
    expect(w.values).toEqual([{ count: 1, fields: {} }]);
    const { release } = await freeze(r);

    // book:b1 is revoked while patron:p2's replacing backfill is still in flight
    r.server.view('t2', 12, ['patron:*']);
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(w.values).toEqual([{ count: 1, fields: {} }, undefined]);

    // the unfreeze delivers nothing more for it
    release();
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBe(9);
    expect(w.values).toEqual([{ count: 1, fields: {} }, undefined]);
  });

  test('an additive backfill that finished during a freeze lands when a revoke unfreezes', async () => {
    const r = await held();
    await freeze(r);

    // book:b2 is granted and downloads during the freeze; done, ready, not landed
    r.server.blobs.set('book:b2', {
      position: 12,
      seqs: { 'book:b2': 1 },
      values: [['book:b2!state', { count: 1, fields: {} }]],
    });
    r.server.view('t2', 12, ['patron:*', 'book:b1', 'book:b2']);
    await settle();
    expect(record(r, 'book:b2')).toBeDefined();
    expect(state(r.data(), 'book:b2')).toBeUndefined();

    // revoking the patrons drops the replacing backfill on patron:p2, and that unfreezes; the
    // frame that unfroze lands book:b2 without waiting for any outcome
    r.server.view('t3', 13, ['book:b1', 'book:b2']);
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(record(r, 'book:b2')).toBeUndefined();
    expect(state(r.data(), 'book:b2')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'book:b2')).toBe(1);
  });

  test('a status-only query runs while frozen, and sees the replacing backfill until it lands', async () => {
    const r = await held();
    const { release } = await freeze(r);
    const status = watchStatus(r);
    await settle();
    const { backfills, estimate } = last(status.progress);
    expect(backfills.map((b) => [b.selector, b.replacing])).toEqual([['patron:p2', true]]);
    expect(estimate).not.toBeNull();

    release();
    await settle();
    expect(last(status.progress)).toMatchObject({ estimate: null, backfills: [] });
  });
});
