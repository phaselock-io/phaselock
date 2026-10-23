// TESTS.md: Gap detection, Resets

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
  type Rig,
  rig,
  seq,
  settle,
  state,
} from './harness.ts';

type Record_ = { children: string[] };
const record = (r: Rig, selector: string): Record_ | undefined =>
  r.data()[`!backfill:${selector}`] as Record_ | undefined;

/** a held family with two members at position 10 */
const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};

async function held(): Promise<Rig> {
  const r = rig();
  await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
  return r;
}

/** a held family, plus an additive backfill of book:* in flight whose blob is held */
async function withBooks(r: Rig): Promise<{ go: () => void }> {
  const hold = r.server.hold('book:*');
  r.server.view('t2', 11, ['patron:*', 'book:*']);
  await settle();
  return hold;
}

describe('resets on the live slice', () => {
  test('a death above the held seq is accepted over the gap: the keys go, the slice is forgotten, no backfill', async () => {
    const r = await held();
    r.server.edits(death('patron:p1', 9, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toBeUndefined();
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });

  test('a birth above the held seq wipes the stale state and the slice chains from it', async () => {
    const r = await held();
    r.server.edits(birth('patron:p1', 9, 11), ev('patron:p1', 10, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p1')).toBe(10);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test("an unknown slice's death under no selector is forgotten, and a rebirth chains from empty", async () => {
    const r = await held();
    r.server.edits(death('patron:p7', 5, 11));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBeUndefined();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    r.server.edits(birth('patron:p7', 6, 12), ev('patron:p7', 7, 12));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBe(7);
    expect(log(r.data(), 'patron:p7')).toEqual(['bump']);
  });

  test("an unknown slice's birth above seq 1 is held at its seq", async () => {
    const r = await held();
    r.server.edits(birth('patron:p7', 6, 11), ev('patron:p7', 7, 11));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBe(7);
    expect(state(r.data(), 'patron:p7')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a gap an ordinary edit leaves is mended by a reset later in the frame: nothing of the gap applies, no backfill', async () => {
    const r = await held();
    r.server.edits(
      ev('patron:p1', 7, 11, { type: 'set', field: 'a', value: 1 }),
      ev('patron:p2', 2, 11),
      death('patron:p1', 8, 11),
      birth('patron:p1', 9, 11),
      ev('patron:p1', 10, 11, { type: 'set', field: 'b', value: 2 }),
    );
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['set b=2']);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 0, fields: { b: 2 } });
    expect(seq(r.data(), 'patron:p1')).toBe(10);
    expect(log(r.data(), 'patron:p2')).toEqual(['bump']);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });

  test('a gap with no reset in its frame still replaces the slice, and the reset in a later frame lands it', async () => {
    const r = await held();
    const hold = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 7, 11));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(r.server.backfills.at(-1)).toMatchObject({ selector: 'patron:p1', until: 11 });
    r.server.edits(death('patron:p1', 9, 12));
    await settle();
    // the fresh blob finds the slice dead, so it names nothing; the parked death mends the run
    r.server.blobs.set('patron:p1', { position: 12, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);
    expect(log(r.data(), 'patron:p1')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });

  test("a run's edits before its last reset never apply", async () => {
    const r = await held();
    r.server.edits(
      ev('patron:p1', 3, 11, { type: 'boom' }),
      death('patron:p1', 4, 11),
      birth('patron:p1', 5, 11),
      ev('patron:p1', 6, 11),
    );
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p1')).toBe(6);
  });
});

describe('resets at a land', () => {
  test('a parked gap with a reset after it lands: the run from the reset applies, the rest never does', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.edits(
      ev('book:b1', 5, 12, { type: 'boom' }),
      death('book:b1', 6, 13),
      birth('book:b1', 7, 14),
      ev('book:b1', 8, 15),
    );
    await settle();
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'book:b1')).toEqual(['bump']);
    expect(seq(r.data(), 'book:b1')).toBe(8);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });

  test('a parked gap with a reset after it, whose later edits break, is still a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.edits(ev('book:b1', 5, 12), death('book:b1', 6, 13), ev('book:b1', 9, 14));
    await settle();
    r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    expect(log(r.data(), 'book:b1')).toEqual([]);
  });

  test('a slice the blob does not name has its parked edits at or below the cut covered: forgotten, nothing applied, no child', async () => {
    const r = await held();
    const hold = await withBooks(r);
    // b3 was alive when these were read, and dead by the time the blob was cut
    r.server.edits(ev('book:b3', 7, 12, { type: 'boom' }), ev('book:b3', 8, 13, { type: 'boom' }));
    await settle();
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'book:b3')).toBeUndefined();
    expect(keys(r.data(), 'book:b3!')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
    // the death the blob reflected arrives from the replay, and the slice stays forgotten
    r.server.edits(death('book:b3', 9, 21));
    await settle();
    expect(seq(r.data(), 'book:b3')).toBeUndefined();
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a slice the blob does not name, with edits above the cut that start at no reset, is a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.edits(ev('book:b3', 7, 12), ev('book:b3', 8, 25));
    await settle();
    r.server.hold('book:b3');
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(record(r, 'book:*')?.children).toEqual(['book:b3']);
    expect(keys(r.data(), '!park-ed:book:b3!')).toEqual([
      parkedEdit('book:b3', 7),
      parkedEdit('book:b3', 8),
    ]);
  });

  test('a slice the blob does not name, with a lone death above the cut, lands dead and is forgotten', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.edits(death('book:b3', 9, 25));
    await settle();
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'book:b3')).toBeUndefined();
    expect(keys(r.data(), 'book:b3!')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a slice the blob names is covered by seq alone: an edit above its seq and below the cut is a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.edits(ev('book:b1', 5, 12));
    await settle();
    r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 20,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
  });

  test('frozen edits: a death over a gap on a held slice lands with the group and wipes it', async () => {
    const r = await held();
    const gap = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    // frozen now; p1's death over a gap parks with the frozen edits
    r.server.edits(death('patron:p1', 7, 12));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 7)]);
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(seq(r.data(), 'patron:p2')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ed:')).toEqual([]);
  });
});
