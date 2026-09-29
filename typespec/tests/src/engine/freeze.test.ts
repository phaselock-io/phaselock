// TESTS.md: Freeze and group land

import { describe, expect, test } from 'vitest';

import { JS, type LocalQuery, type QueryAnswer } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  type Forecaster,
  keys,
  log,
  parkedEvent,
  type Rig,
  rig,
  seq,
  settle,
  type State,
  state,
} from './harness.ts';

type Record_ = { until: number; replacing: boolean; children: string[] };
const record = (r: Rig, ref: string): Record_ | undefined =>
  r.data[`/backfill.${ref}`] as Record_ | undefined;

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2, 'patron.p2': 1 },
  values: [
    ['patron.p1/state', { count: 2, fields: {} }],
    ['patron.p2/state', { count: 1, fields: {} }],
  ],
};
const b1Blob: Blob = {
  position: 10,
  seqs: { 'book.b1': 1 },
  values: [['book.b1/state', { count: 1, fields: {} }]],
};
const p1Blob: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2 },
  values: [['patron.p1/state', { count: 2, fields: {} }]],
};

/** forecasts a `set` on patron.p1, reading nothing */
// eslint-disable-next-line require-yield -- a forecast that reads nothing never yields
const forecaster: Forecaster = function* (_qx, command) {
  const cmd = command as { field: string; value: unknown };
  return [
    { stream: 'patron.p1', event: { id: 'p1', type: 'set', field: cmd.field, value: cmd.value } },
  ];
};

/** a live Engine holding patron.p1, patron.p2, and book.b1 at position 10 */
async function held(withForecaster = false): Promise<Rig> {
  const r = rig(withForecaster ? { forecaster } : {});
  await bootstrap(r, ['patron.*', 'book.b1'], { 'patron.*': patrons, 'book.b1': b1Blob });
  return r;
}

/** freeze the base: a gap on patron.p2 at the position, its replacing backfill held */
async function freeze(r: Rig, position = 11): Promise<{ release: () => void }> {
  const hold = r.server.hold('patron.p2');
  r.server.events(ev('patron.p2', 9, position));
  await settle();
  expect(seq(r.data, 'patron.p2')).toBe('backfill');
  return {
    release: () => {
      r.server.blobs.set('patron.p2', {
        position,
        seqs: { 'patron.p2': 9 },
        values: [['patron.p2/state', { count: 9, fields: {} }]],
      });
      hold.go();
    },
  };
}

/** a query on a stream's state, collecting every value delivered */
function watch(
  r: Rig,
  stream: string,
): { values: (State | undefined)[]; q: LocalQuery<State | undefined> } {
  const values: (State | undefined)[] = [];
  const key = `${stream}/state`;
  const q = r.engine.newQuery(function* () {
    const a = (yield { store: { [key]: { type: 'state', want: JS } } }) as QueryAnswer;
    const res = a.store[key];
    return 'value' in res
      ? ((res.value as Record<number, unknown> | undefined)?.[JS] as State | undefined)
      : undefined;
  });
  q.subscribe((v) => values.push(v));
  return { values, q };
}

describe('freeze and group land', () => {
  test('the first replacing backfill freezes the base: live events park while /checkpoint advances', async () => {
    const r = await held();
    const { release } = await freeze(r);
    expect(record(r, 'patron.p2')).toMatchObject({ replacing: true, until: 11 });
    r.server.events(ev('patron.p1', 3, 12), ev('book.b1', 2, 13));
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual([]);
    expect(seq(r.data, 'patron.p1')).toBe(2);
    expect(seq(r.data, 'book.b1')).toBe(1);
    expect(keys(r.data, '/park.ev.')).toEqual([
      parkedEvent('book.b1', 2),
      parkedEvent('patron.p1', 3),
      parkedEvent('patron.p2', 9),
    ]);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 13, reduced: 10 });
    release();
    await settle();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data, 'book.b1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data, 'patron.p2')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data, '/park')).toEqual([]);
    expect(keys(r.data, '/backfill')).toEqual([]);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 13, reduced: 13 });
  });

  test('an additive backfill completing during a freeze lands only with the group', async () => {
    const r = await held();
    const { release } = await freeze(r);
    r.server.blobs.set('book.b2', {
      position: 12,
      seqs: { 'book.b2': 1 },
      values: [['book.b2/state', { count: 1, fields: {} }]],
    });
    r.server.view('t2', 12, ['patron.*', 'book.b1', 'book.b2']);
    await settle();
    // downloaded and ready, but the base is frozen
    expect(record(r, 'book.b2')).toMatchObject({ replacing: false, until: 12 });
    expect(state(r.data, 'book.b2')).toBeUndefined();
    expect(seq(r.data, 'book.b2')).toBe('backfill');
    expect(keys(r.data, '/park.kv.book.b2/')).toEqual(['/park.kv.book.b2/book.b2/state']);
    release();
    await settle();
    expect(state(r.data, 'book.b2')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data, 'book.b2')).toBe(1);
    expect(state(r.data, 'patron.p2')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data, '/backfill')).toEqual([]);
    expect(keys(r.data, '/park')).toEqual([]);
  });

  test('a replacing child under a still-downloading additive parent holds the freeze until the subtree lands', async () => {
    const r = rig();
    await bootstrap(r, ['patron.p1', 'book.b1'], { 'patron.p1': p1Blob, 'book.b1': b1Blob });
    const fam = r.server.hold('patron.*');
    r.server.view('t2', 11, ['patron.*', 'book.b1']);
    await settle();
    // a gap on held p1 under the in-flight family: a replacing child at once
    const child = r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 7, 12));
    await settle();
    expect(record(r, 'patron.p1')).toMatchObject({ replacing: true, until: 12 });
    expect(record(r, 'patron.*')?.children).toEqual(['patron.p1']);
    r.server.events(ev('book.b1', 2, 13));
    await settle();
    expect(keys(r.data, '/park.ev.book.b1/')).toEqual([parkedEvent('book.b1', 2)]);
    // the child completes; its parent is still downloading, so nothing lands
    r.server.blobs.set('patron.p1', {
      position: 12,
      seqs: { 'patron.p1': 7 },
      values: [['patron.p1/state', { count: 7, fields: {} }]],
    });
    child.go();
    await settle();
    expect(record(r, 'patron.p1')).toBeDefined();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data, 'book.b1')).toEqual({ count: 1, fields: {} });
    // the parent completes: the subtree lands as one, and the frozen events with it
    r.server.blobs.set('patron.*', {
      position: 11,
      seqs: { 'patron.p1': 2, 'patron.p2': 1 },
      values: [
        ['patron.p1/state', { count: 99, fields: {} }],
        ['patron.p2/state', { count: 1, fields: {} }],
      ],
    });
    fam.go();
    await settle();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data, 'patron.p1')).toBe(7);
    expect(state(r.data, 'patron.p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data, 'book.b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data, '/backfill')).toEqual([]);
    expect(keys(r.data, '/park')).toEqual([]);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 13, reduced: 13 });
  });

  test('a revoke that drops the last replacing ref lands the frozen events in the same transaction', async () => {
    const r = await held();
    await freeze(r);
    r.server.events(ev('book.b1', 2, 12), ev('patron.p1', 3, 12));
    await settle();
    expect(state(r.data, 'book.b1')).toEqual({ count: 1, fields: {} });
    r.server.view('t2', 13, ['book.b1']);
    await settle();
    expect(record(r, 'patron.p2')).toBeUndefined();
    expect(seq(r.data, 'patron.p1')).toBeUndefined();
    expect(seq(r.data, 'patron.p2')).toBeUndefined();
    expect(keys(r.data, '/park')).toEqual([]);
    expect(state(r.data, 'book.b1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data, 'book.b1')).toBe(2);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 12, reduced: 12 });
  });

  test('a widening grant over the last replacing ref adopts it, and the freeze holds until the subtree lands', async () => {
    const r = rig();
    await bootstrap(r, ['patron.p1', 'book.b1'], { 'patron.p1': p1Blob, 'book.b1': b1Blob });
    const child = r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 7, 11));
    await settle();
    expect(record(r, 'patron.p1')).toMatchObject({ replacing: true, until: 11 });
    r.server.events(ev('book.b1', 2, 12));
    await settle();
    const fam = r.server.hold('patron.*');
    r.server.view('t2', 13, ['patron.*', 'book.b1']);
    await settle();
    expect(record(r, 'patron.p1')).toMatchObject({ replacing: true, until: 11 });
    expect(record(r, 'patron.*')?.children).toEqual(['patron.p1']);
    expect(keys(r.data, '/park.ev.book.b1/')).toEqual([parkedEvent('book.b1', 2)]);
    expect(state(r.data, 'book.b1')).toEqual({ count: 1, fields: {} });
    r.server.blobs.set('patron.p1', {
      position: 11,
      seqs: { 'patron.p1': 7 },
      values: [['patron.p1/state', { count: 7, fields: {} }]],
    });
    r.server.blobs.set('patron.*', {
      position: 13,
      seqs: { 'patron.p1': 2, 'patron.p2': 1 },
      values: [
        ['patron.p1/state', { count: 99, fields: {} }],
        ['patron.p2/state', { count: 1, fields: {} }],
      ],
    });
    child.go();
    await settle();
    expect(state(r.data, 'book.b1')).toEqual({ count: 1, fields: {} });
    fam.go();
    await settle();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 7, fields: {} });
    expect(state(r.data, 'patron.p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data, 'book.b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data, '/backfill')).toEqual([]);
  });

  test('frozen events on a stream a landing ref covers land once, through the ref', async () => {
    const r = await held();
    const { release } = await freeze(r);
    r.server.events(ev('patron.p2', 10, 12), ev('patron.p1', 3, 13));
    await settle();
    release();
    await settle();
    expect(log(r.data, 'patron.p2')).toEqual(['bump']);
    expect(state(r.data, 'patron.p2')).toEqual({ count: 10, fields: {} });
    expect(seq(r.data, 'patron.p2')).toBe(10);
    expect(state(r.data, 'patron.p1')).toEqual({ count: 3, fields: {} });
    expect(keys(r.data, '/park')).toEqual([]);
  });

  test('a frozen event on a stream under an in-flight additive backfill stays parked through the group land', async () => {
    const r = await held();
    const { release } = await freeze(r);
    const b2 = r.server.hold('book.b2');
    r.server.view('t2', 12, ['patron.*', 'book.b1', 'book.b2']);
    await settle();
    r.server.events(ev('book.b2', 5, 13), ev('book.b1', 2, 13));
    await settle();
    release();
    await settle();
    expect(state(r.data, 'book.b1')).toEqual({ count: 2, fields: {} });
    expect(record(r, 'patron.p2')).toBeUndefined();
    expect(seq(r.data, 'book.b2')).toBe('backfill');
    expect(keys(r.data, '/park.ev.')).toEqual([parkedEvent('book.b2', 5)]);
    expect(record(r, 'book.b2')).toBeDefined();
    r.server.blobs.set('book.b2', {
      position: 12,
      seqs: { 'book.b2': 4 },
      values: [['book.b2/state', { count: 4, fields: {} }]],
    });
    b2.go();
    await settle();
    expect(state(r.data, 'book.b2')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data, 'book.b2')).toBe(5);
    expect(keys(r.data, '/park')).toEqual([]);
  });

  test.todo(
    'caughtUp is false while frozen, true after the group land and onLive, false again on a gap: no status key yet',
  );

  test('optimistic updates keep flowing during a freeze: a new command forecasts against the frozen base and the graph runs', async () => {
    const r = await held(true);
    const w = watch(r, 'patron.p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    const { release } = await freeze(r);
    r.engine.sendCommands([{ field: 'x', value: 1 }]);
    await settle();
    expect(w.values).toEqual([
      { count: 2, fields: {} },
      { count: 2, fields: { x: 1 } },
    ]);
    // the base under it is untouched
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
    release();
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { x: 1 } });
  });

  test('the query graph does not run for data changes while frozen', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    const { release } = await freeze(r);
    r.server.events(ev('patron.p1', 3, 12));
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
    const w = watch(r, 'book.b1');
    await settle();
    expect(w.values).toEqual([{ count: 1, fields: {} }]);
    const { release } = await freeze(r);

    // book.b1 is revoked while patron.p2's replacing backfill is still in flight
    r.server.view('t2', 12, ['patron.*']);
    await settle();
    expect(seq(r.data, 'patron.p2')).toBe('backfill');
    expect(state(r.data, 'book.b1')).toBeUndefined();
    expect(w.values).toEqual([{ count: 1, fields: {} }, undefined]);

    // the unfreeze delivers nothing more for it
    release();
    await settle();
    expect(seq(r.data, 'patron.p2')).toBe(9);
    expect(w.values).toEqual([{ count: 1, fields: {} }, undefined]);
  });

  test.todo('a status-only query runs while frozen: no status key yet');
});
