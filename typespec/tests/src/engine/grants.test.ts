// TESTS.md: Widening grants, Stacked grants

import { describe, expect, test } from 'vitest';

import {
  birth,
  type Blob,
  bootstrap,
  death,
  ev,
  keys,
  log,
  parkedEdit,
  parkedKeys,
  type Rig,
  rig,
  seq,
  settle,
  state,
} from './harness.ts';

type Record_ = { until: number; replacing: boolean; children: string[] };
const record = (r: Rig, selector: string): Record_ | undefined =>
  r.data()[`!backfill:${selector}`] as Record_ | undefined;

/** a store holding exactly `patron:p1` at seq 2 */
const p1Blob: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2 },
  values: [['patron:p1!state', { count: 2, fields: {} }]],
};

async function heldP1(): Promise<Rig> {
  const r = rig();
  await bootstrap(r, ['patron:p1'], { 'patron:p1': p1Blob });
  return r;
}

describe('widening grants', () => {
  test('a held slice under a new additive selector stays held, and the land keeps its state over the blob', async () => {
    const r = await heldP1();
    const hold = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    expect(record(r, 'patron:*')).toMatchObject({ until: 12, replacing: false });
    // live edits keep applying; the marker never appears
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 99, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '/park.kv')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a dead slice the blob shows reborn loses to the blob', async () => {
    const r = await heldP1();
    r.server.edits(death('patron:p1', 3, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    const hold = r.server.hold('patron:*');
    r.server.view('t2', 12, ['patron:*']);
    await settle();
    r.server.blobs.set('patron:*', {
      position: 12,
      seqs: { 'patron:p1': 5 },
      values: [['patron:p1!state', { count: 5, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
  });

  test('the chain base is the newest state in place: a tail edit the held slice already has is covered', async () => {
    const r = await heldP1();
    const hold = r.server.hold('patron:*');
    r.server.view('t2', 12, ['patron:*']);
    await settle();
    // delivered live and held
    const e3 = ev('patron:p1', 3, 11);
    r.server.edits(e3);
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    // the blob is cut before it and its tail carries the same edit
    r.server.blobs.set('patron:*', {
      position: 10,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
      tail: [e3, ev('patron:p2', 2, 12)],
    });
    hold.go();
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(log(r.data(), 'patron:p2')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p2')).toBe(2);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('an in-flight selector covered by a new selector becomes its child and lands over the new blob for its slices', async () => {
    const r = rig();
    await bootstrap(r, ['book:*'], {
      'book:*': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    const inner = r.server.hold('patron:*');
    r.server.view('t2', 11, ['book:*', 'patron:*']);
    await settle();
    const outer = r.server.hold('*');
    r.server.view('t3', 12, ['*']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:*', '*']);
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    expect(record(r, 'patron:*')).toBeDefined();
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p2': 1 },
      values: [['patron:p2!state', { count: 1, fields: {} }]],
    });
    inner.go();
    await settle();
    // the child is ready but the subtree is not
    expect(record(r, 'patron:*')).toBeDefined();
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
    r.server.blobs.set('*', {
      position: 12,
      seqs: { 'patron:p2': 1, 'book:b1': 1, 'book:b2': 1 },
      values: [
        ['patron:p2!state', { count: 42, fields: {} }],
        ['book:b1!state', { count: 42, fields: {} }],
        ['book:b2!state', { count: 7, fields: {} }],
      ],
    });
    outer.go();
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:*', '*']);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b2')).toEqual({ count: 7, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '/park.kv')).toEqual([]);
  });

  test('a gap on a held slice under an in-flight additive selector spawns a replacing child at once, and the freeze holds until the subtree lands', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1', 'book:b1'], {
      'patron:p1': p1Blob,
      'book:b1': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    const family = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*', 'book:b1']);
    await settle();
    const child = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 12));
    await settle();
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 12 });
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    // frozen: another held slice's edit parks
    r.server.edits(ev('book:b1', 2, 13));
    await settle();
    expect(keys(r.data(), '!park-ed:book:')).toEqual([parkedEdit('book:b1', 2)]);
    expect(log(r.data(), 'book:b1')).toEqual([]);
    r.server.blobs.set('patron:p1', {
      position: 12,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    child.go();
    await settle();
    // the child is ready; its parent is not, so nothing lands
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ed:book:')).toEqual([parkedEdit('book:b1', 2)]);
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    family.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('creating a replacing selector marks every held slice under it before its download starts', async () => {
    // a store from an earlier life holds two patrons and no view: the first view's grant replaces them
    const r = rig({
      seed: {
        '!seq:patron:p1': 2,
        '!seq:patron:p2': 1,
        'patron:p1!state': { count: 2, fields: {} },
        'patron:p2!state': { count: 1, fields: {} },
      },
    });
    await settle();
    const hold = r.server.hold('patron:*');
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(record(r, 'patron:*')?.replacing).toBe(true);
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    r.server.blobs.set('patron:*', {
      position: 10,
      seqs: { 'patron:p1': 5 },
      values: [['patron:p1!state', { count: 5, fields: {} }]],
    });
    hold.go();
    await settle();
    // replaced, not kept: the blob wins for p1 and p2 is gone with the prefix
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
  });

  test('a birth under an in-flight selector parks; under no in-flight selector it is held at seq 1', async () => {
    const r = await heldP1();
    r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    r.server.edits(birth('patron:p5', 1, 12), birth('book:b9', 1, 12));
    await settle();
    expect(seq(r.data(), 'patron:p5')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p5!')).toEqual([parkedEdit('patron:p5', 1)]);
    expect(seq(r.data(), 'book:b9')).toBe(1);
    expect(keys(r.data(), '!park-ed:book:')).toEqual([]);
  });

  test('a child lands over its parent per slice of its own blob: a kept member survives and a parent-only slice keeps the parent values', async () => {
    const r = await heldP1();
    const inner = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    const outer = r.server.hold('*');
    r.server.view('t3', 12, ['*']);
    await settle();
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    r.server.edits(ev('patron:p1', 3, 13));
    await settle();
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 50, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    r.server.blobs.set('*', {
      position: 12,
      seqs: { 'patron:p1': 2, 'patron:p2': 1, 'patron:p3': 1 },
      values: [
        ['patron:p1!state', { count: 60, fields: {} }],
        ['patron:p2!state', { count: 60, fields: {} }],
        ['patron:p3!state', { count: 1, fields: {} }],
      ],
    });
    inner.go();
    outer.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'patron:p3')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'patron:p3')).toBe(1);
    expect(keys(r.data(), '/park.kv')).toEqual([]);
  });
});

describe('stacked grants', () => {
  test('wider while widening: * adopts patron:*, p1 stays held, p2 takes the child cut, p3 keeps * values', async () => {
    const r = await heldP1();
    const inner = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    const outer = r.server.hold('*');
    r.server.view('t3', 12, ['*']);
    await settle();
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:p1', 'patron:*', '*']);
    // p1 applies live under both; p2 is unknown and parks under the most specific selector
    r.server.edits(ev('patron:p1', 3, 13), ev('patron:p2', 2, 14));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    inner.go();
    await settle();
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
    r.server.blobs.set('*', {
      position: 12,
      seqs: { 'patron:p1': 2, 'patron:p2': 1, 'patron:p3': 1, 'book:b1': 1 },
      values: [
        ['patron:p1!state', { count: 50, fields: {} }],
        ['patron:p2!state', { count: 50, fields: {} }],
        ['patron:p3!state', { count: 1, fields: {} }],
        ['book:b1!state', { count: 1, fields: {} }],
      ],
    });
    outer.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(log(r.data(), 'patron:p2')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p2')).toBe(2);
    expect(state(r.data(), 'patron:p3')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '/park.kv')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('narrower after wider: * dropped, slices it marked under patron. keep their markers, patron:* lands them from its cut', async () => {
    const r = rig();
    await bootstrap(r, ['book:*'], {
      'book:*': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    r.server.hold('*');
    r.server.view('t2', 11, ['*']);
    await settle();
    r.server.edits(birth('patron:p2', 1, 12), ev('patron:p2', 2, 13), ev('book:b1', 2, 14));
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    const family = r.server.hold('patron:*');
    r.server.view('t3', 15, ['patron:*']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(parkedKeys(r.data(), '*')).toEqual([]);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', '*', 'patron:*']);
    // the book slice is out of the view: gone
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(seq(r.data(), 'book:b1')).toBeUndefined();
    // p2 stays marked with its parked edits for the new selector to land
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([
      parkedEdit('patron:p2', 1),
      parkedEdit('patron:p2', 2),
    ]);
    r.server.blobs.set('patron:*', {
      position: 15,
      seqs: { 'patron:p2': 2 },
      values: [['patron:p2!state', { count: 2, fields: {} }]],
    });
    family.go();
    await settle();
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(log(r.data(), 'patron:p2')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBe(2);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });

  test('narrower after wider with patron:* already a child of *: it becomes top-level and carries on', async () => {
    const r = rig();
    await bootstrap(r, ['book:*'], {
      'book:*': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    const family = r.server.hold('patron:*');
    r.server.view('t2', 11, ['book:*', 'patron:*']);
    await settle();
    r.server.hold('*');
    r.server.view('t3', 12, ['*']);
    await settle();
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    r.server.view('t4', 13, ['patron:*']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(record(r, 'patron:*')).toBeDefined();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:*', '*']);
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p2': 1 },
      values: [['patron:p2!state', { count: 1, fields: {} }]],
    });
    family.go();
    await settle();
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('gap child then widening: p1 is adopted, the freeze holds until the subtree lands, and the land takes p1 from the child', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1', 'book:b1'], {
      'patron:p1': p1Blob,
      'book:b1': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    const child = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 11));
    await settle();
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 11 });
    const family = r.server.hold('patron:*');
    r.server.view('t2', 12, ['patron:*', 'book:b1']);
    await settle();
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    // grants start broadest first: the shorter prefix before the longer
    expect(r.server.backfills.map((b) => b.selector)).toEqual([
      'book:b1',
      'patron:p1',
      'patron:p1',
      'patron:*',
    ]);
    r.server.edits(ev('book:b1', 2, 13));
    await settle();
    expect(keys(r.data(), '!park-ed:book:')).toEqual([parkedEdit('book:b1', 2)]);
    r.server.blobs.set('patron:p1', {
      position: 11,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    child.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ed:book:')).toEqual([parkedEdit('book:b1', 2)]);
    r.server.blobs.set('patron:*', {
      position: 12,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    family.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('three deep: the deepest blob wins for p1, patron:* for the rest of the family, * for the rest', async () => {
    const r = await heldP1();
    const family = r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    const child = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 12));
    await settle();
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    const outer = r.server.hold('*');
    r.server.view('t3', 13, ['*']);
    await settle();
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    r.server.blobs.set('patron:p1', {
      position: 12,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    r.server.blobs.set('*', {
      position: 13,
      seqs: { 'patron:p1': 2, 'patron:p2': 1, 'book:b2': 1 },
      values: [
        ['patron:p1!state', { count: 0, fields: {} }],
        ['patron:p2!state', { count: 0, fields: {} }],
        ['book:b2!state', { count: 1, fields: {} }],
      ],
    });
    child.go();
    family.go();
    outer.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'book:b2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '/park.kv')).toEqual([]);
  });

  test('grants before revokes: a fully covered in-flight selector is adopted, a partially covered one is aborted with its uncovered slices dropped', async () => {
    const r = rig();
    await bootstrap(r, ['book:*'], {
      'book:*': {
        position: 10,
        seqs: { 'book:b1': 1 },
        values: [['book:b1!state', { count: 1, fields: {} }]],
      },
    });
    // fully covered: patron:* under *
    r.server.hold('patron:*');
    r.server.view('t2', 11, ['book:*', 'patron:*']);
    await settle();
    r.server.hold('*');
    r.server.view('t3', 12, ['*']);
    await settle();
    expect(record(r, 'patron:*')).toBeDefined();
    expect(record(r, '*')?.children).toEqual(['patron:*']);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:*', '*']);
    // partially covered: * against a set of two narrower selectors
    r.server.edits(ev('patron:p1', 5, 13), ev('patron:p2', 3, 13), birth('book:b7', 1, 14));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(seq(r.data(), 'book:b7')).toBe('backfill');
    r.server.hold('patron:p1');
    r.server.view('t4', 15, ['book:*', 'patron:p1']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(parkedKeys(r.data(), '*')).toEqual([]);
    // patron:* is partially covered too: aborted
    expect(record(r, 'patron:*')).toBeUndefined();
    // p2 is uncovered and gone; p1 keeps its marker and edit and gets its own backfill
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 5)]);
    // book:* was covered by the in-flight *, so it does not count as held and is downloaded again
    expect(r.server.backfills.map((b) => b.selector)).toEqual([
      'book:*',
      'patron:*',
      '*',
      'book:*',
      'patron:p1',
    ]);
    expect(record(r, 'patron:p1')).toMatchObject({ until: 16, replacing: false });
    // the redo landed at once: b1 stayed held and kept its state, and b7, born after the blob's
    // cut, landed from its parked birth at seq 1
    expect(record(r, 'book:*')).toBeUndefined();
    expect(seq(r.data(), 'book:b1')).toBe(1);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'book:b7')).toBe(1);
    expect(keys(r.data(), '!park-ed:book:')).toEqual([]);
  });

  test('the per-slice drop of a revoke skips any slice the new set covers, whatever its marker', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], {
      'patron:*': {
        position: 10,
        seqs: { 'patron:p1': 2, 'patron:p2': 1 },
        values: [
          ['patron:p1!state', { count: 2, fields: {} }],
          ['patron:p2!state', { count: 1, fields: {} }],
        ],
      },
    });
    // p3 marked under an in-flight exact selector, p1 and p2 held
    r.server.hold('patron:p3');
    r.server.edits(ev('patron:p3', 4, 11));
    await settle();
    expect(seq(r.data(), 'patron:p3')).toBe('backfill');
    r.server.view('t2', 12, ['patron:p1', 'patron:p3']);
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p3')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p3!')).toEqual([parkedEdit('patron:p3', 4)]);
    expect(record(r, 'patron:p3')).toBeDefined();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'patron:p3']);
  });
});
