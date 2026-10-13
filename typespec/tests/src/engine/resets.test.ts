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
  parkedEvent,
  type Rig,
  rig,
  seq,
  settle,
  state,
} from './harness.ts';

type Record_ = { children: string[] };
const record = (r: Rig, ref: string): Record_ | undefined =>
  r.data()[`!backfill:${ref}`] as Record_ | undefined;

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

describe('resets on the live stream', () => {
  test('a death above the held seq is accepted over the gap: the keys go, the seq holds, no backfill', async () => {
    const r = await held();
    r.server.events(death('patron:p1', 9, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toBeUndefined();
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });

  test('a birth above the held seq wipes the stale state and the stream chains from it', async () => {
    const r = await held();
    r.server.events(birth('patron:p1', 9, 11), ev('patron:p1', 10, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p1')).toBe(10);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test("an unknown stream's death under no ref is held at its seq, and a rebirth chains from it", async () => {
    const r = await held();
    r.server.events(death('patron:p7', 5, 11));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBe(5);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    r.server.events(birth('patron:p7', 6, 12), ev('patron:p7', 7, 12));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBe(7);
    expect(log(r.data(), 'patron:p7')).toEqual(['bump']);
  });

  test("an unknown stream's birth above seq 1 is held at its seq", async () => {
    const r = await held();
    r.server.events(birth('patron:p7', 6, 11), ev('patron:p7', 7, 11));
    await settle();
    expect(seq(r.data(), 'patron:p7')).toBe(7);
    expect(state(r.data(), 'patron:p7')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a gap an ordinary event leaves is mended by a reset later in the atom: nothing of the gap reduces, no backfill', async () => {
    const r = await held();
    r.server.events(
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
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });

  test('a gap with no reset in its atom still replaces the stream, and the reset in a later atom lands it', async () => {
    const r = await held();
    const hold = r.server.hold('patron:p1');
    r.server.events(ev('patron:p1', 7, 11));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(r.server.backfills.at(-1)).toMatchObject({ ref: 'patron:p1', until: 11 });
    r.server.events(death('patron:p1', 9, 12));
    await settle();
    // the fresh blob finds the stream dead, so it names nothing; the parked death mends the run
    r.server.blobs.set('patron:p1', { position: 12, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(9);
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);
    expect(log(r.data(), 'patron:p1')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });

  test("a run's events before its last reset never reach the reducer", async () => {
    const r = await held();
    r.server.events(
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
  test('a parked gap with a reset after it lands: the run from the reset reduces, the rest never does', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.events(
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
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });

  test('a parked gap with a reset after it, whose later events break, is still a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.events(ev('book:b1', 5, 12), death('book:b1', 6, 13), ev('book:b1', 9, 14));
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

  test('a stream the blob does not name has its parked events at or below the cut covered: held at the last, nothing reduced, no child', async () => {
    const r = await held();
    const hold = await withBooks(r);
    // b3 was alive when these were read, and dead by the time the blob was cut
    r.server.events(ev('book:b3', 7, 12, { type: 'boom' }), ev('book:b3', 8, 13, { type: 'boom' }));
    await settle();
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'book:b3')).toBe(8);
    expect(keys(r.data(), 'book:b3!')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
    // the death the blob reflected arrives from the replay and chains
    r.server.events(death('book:b3', 9, 21));
    await settle();
    expect(seq(r.data(), 'book:b3')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a stream the blob does not name, with events above the cut that start at no reset, is a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.events(ev('book:b3', 7, 12), ev('book:b3', 8, 25));
    await settle();
    r.server.hold('book:b3');
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(record(r, 'book:*')?.children).toEqual(['book:b3']);
    expect(keys(r.data(), '!park-ev:book:b3!')).toEqual([
      parkedEvent('book:b3', 7),
      parkedEvent('book:b3', 8),
    ]);
  });

  test("a stream the blob does not name, with a lone death above the cut, lands dead at the death's seq", async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.events(death('book:b3', 9, 25));
    await settle();
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(seq(r.data(), 'book:b3')).toBe(9);
    expect(keys(r.data(), 'book:b3!')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a stream the blob names is covered by seq alone: an event above its seq and below the cut is a break', async () => {
    const r = await held();
    const hold = await withBooks(r);
    r.server.events(ev('book:b1', 5, 12));
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

  test('frozen events: a death over a gap on a held stream lands with the group and wipes it', async () => {
    const r = await held();
    const gap = r.server.hold('patron:p2');
    r.server.events(ev('patron:p2', 9, 11));
    await settle();
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    // frozen now; p1's death over a gap parks with the frozen events
    r.server.events(death('patron:p1', 7, 12));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park-ev:patron:p1!')).toEqual([parkedEvent('patron:p1', 7)]);
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(seq(r.data(), 'patron:p2')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });
});
