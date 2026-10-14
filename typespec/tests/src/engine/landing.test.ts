// TESTS.md: Landing

import { describe, expect, test } from 'vitest';

import {
  birth,
  type Blob,
  bootstrap,
  checkpoint,
  death,
  ev,
  FakeServer,
  keys,
  log,
  parkedEvent,
  type Rig,
  rig,
  seq,
  settle,
  state,
  watch,
} from './harness.ts';

type Record_ = {
  until: number;
  resume: null | Record<string, unknown>;
  replacing: boolean;
  children: string[];
};
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

async function held(server = new FakeServer()): Promise<Rig> {
  const r = rig({ server });
  await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
  return r;
}

/** freeze the base: a gap on patron:p2 whose replacing backfill is held; returns the release */
async function freeze(r: Rig): Promise<{ go: () => void }> {
  const hold = r.server.hold('patron:p2');
  r.server.events(ev('patron:p2', 9, 11));
  await settle();
  expect(seq(r.data(), 'patron:p2')).toBe('backfill');
  return hold;
}

describe('landing', () => {
  test('an additive backfill lands alone: values in, parked events reduced over them, seqs, ranges and records gone, one frame', async () => {
    const r = await held();
    const { values } = watch(r, 'book:b1');
    await settle();
    expect(values).toEqual([undefined]);
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 3, 12));
    await settle();
    expect(keys(r.data(), '!park-ev:')).toEqual([parkedEvent('book:b1', 3)]);
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2, 'book:b2': 1 },
      values: [
        ['book:b1!state', { count: 2, fields: {} }],
        ['book:b2!state', { count: 1, fields: {} }],
      ],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 3, fields: {} });
    expect(log(r.data(), 'book:b1')).toEqual(['bump']);
    expect(state(r.data(), 'book:b2')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'book:b1')).toBe(3);
    expect(seq(r.data(), 'book:b2')).toBe(1);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    // the query saw nothing of the blob before the parked event was reduced over it
    expect(values).toEqual([undefined, { count: 3, fields: {} }]);
  });

  test('a broken ref spawns its child before any write: no event reaches a reducer, nothing lands', async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 5, 12));
    await settle();
    r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2, 'book:b2': 1 },
      values: [
        ['book:b1!state', { count: 2, fields: {} }],
        ['book:b2!state', { count: 1, fields: {} }],
      ],
    });
    hold.go();
    await settle();
    expect(log(r.data(), 'book:b1')).toEqual([]);
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(state(r.data(), 'book:b2')).toBeUndefined();
    expect(seq(r.data(), 'book:b1')).toBe('backfill');
    expect(keys(r.data(), '!park-kv:book:*!')).toEqual([
      '!park-kv:book:*!book:b1!state',
      '!park-kv:book:*!book:b2!state',
    ]);
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    expect(record(r, 'book:b1')).toMatchObject({ until: 12, replacing: false, children: [] });
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron:*', 'book:*', 'book:b1']);
  });

  test('a parked event at or below the header seq is covered: neither a break nor reduced, and gone with the range', async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 1, 12), ev('book:b1', 2, 13));
    await settle();
    expect(keys(r.data(), '!park-ev:book:b1!')).toEqual([
      parkedEvent('book:b1', 1),
      parkedEvent('book:b1', 2),
    ]);
    r.server.blobs.set('book:*', {
      position: 13,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(log(r.data(), 'book:b1')).toEqual([]);
    expect(seq(r.data(), 'book:b1')).toBe(2);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('one pass handles every ready ref: a broken exact ref restarts beside a clean one that lands', async () => {
    const r = await held();
    const h1 = r.server.hold('book:b1');
    const h2 = r.server.hold('book:b2');
    r.server.view('t2', 11, ['patron:*', 'book:b1', 'book:b2']);
    await settle();
    r.server.events(ev('book:b1', 5, 12), ev('book:b2', 3, 12));
    await settle();
    r.server.blobs.set('book:b1', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    r.server.blobs.set('book:b2', {
      position: 11,
      seqs: { 'book:b2': 2 },
      values: [['book:b2!state', { count: 2, fields: {} }]],
    });
    h1.go();
    const h1again = r.server.hold('book:b1');
    h2.go();
    await settle();
    // b2 landed
    expect(state(r.data(), 'book:b2')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'book:b2')).toBe(3);
    expect(record(r, 'book:b2')).toBeUndefined();
    // b1 restarted: its values went, its record has no resume, its parked event stays
    expect(record(r, 'book:b1')).toMatchObject({ resume: null, children: [] });
    expect(keys(r.data(), '!park-kv:book:b1!')).toEqual([]);
    expect(keys(r.data(), '!park-ev:book:b1!')).toEqual([parkedEvent('book:b1', 5)]);
    expect(r.server.backfills.filter((b) => b.ref === 'book:b1').map((b) => b.resume)).toEqual([
      null,
      null,
    ]);
    h1again.go();
  });

  test("an exact ref's own break restarts it, and the fresh snapshot lands over the kept parked events", async () => {
    const r = await held();
    const h1 = r.server.hold('book:b1');
    r.server.view('t2', 11, ['patron:*', 'book:b1']);
    await settle();
    r.server.events(ev('book:b1', 5, 12));
    await settle();
    r.server.blobs.set('book:b1', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    h1.go();
    const h2 = r.server.hold('book:b1');
    await settle();
    expect(record(r, 'book:b1')).toMatchObject({ resume: null, children: [] });
    expect(keys(r.data(), '!park-kv:book:b1!')).toEqual([]);
    expect(keys(r.data(), '!park-ev:book:b1!')).toEqual([parkedEvent('book:b1', 5)]);
    expect(r.server.backfills.filter((b) => b.ref === 'book:b1').length).toBe(2);
    // a cut past the gap
    r.server.blobs.set('book:b1', {
      position: 12,
      seqs: { 'book:b1': 4 },
      values: [['book:b1!state', { count: 4, fields: {} }]],
    });
    h2.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 5, fields: {} });
    expect(log(r.data(), 'book:b1')).toEqual(['bump']);
    expect(seq(r.data(), 'book:b1')).toBe(5);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a broken additive ref never blocks the group land', async () => {
    const r = await held();
    const gap = await freeze(r);
    const hold = r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 5, 13), ev('patron:p1', 3, 14));
    await settle();
    // frozen: p1's event parked
    expect(keys(r.data(), '!park-ev:patron:p1!')).toEqual([parkedEvent('patron:p1', 3)]);
    r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 12,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    // the group landed without book:*
    expect(seq(r.data(), 'patron:p2')).toBe(9);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 14, reduced: 14 });
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    expect(state(r.data(), 'book:b1')).toBeUndefined();
  });

  test('a broken replacing ref blocks the group land and restarts at once', async () => {
    const r = await held();
    const h1 = await freeze(r);
    r.server.events(ev('patron:p1', 3, 12));
    await settle();
    // a cut below the gap
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 5 },
      values: [['patron:p2!state', { count: 5, fields: {} }]],
    });
    h1.go();
    const h2 = r.server.hold('patron:p2');
    await settle();
    expect(record(r, 'patron:p2')).toMatchObject({ resume: null, replacing: true });
    expect(keys(r.data(), '!park-kv:patron:p2!')).toEqual([]);
    expect(r.server.backfills.filter((b) => b.ref === 'patron:p2').map((b) => b.resume)).toEqual([
      null,
      null,
    ]);
    // still frozen: p1's event stays parked, p2 shows its old state
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(keys(r.data(), '!park-ev:patron:p1!')).toEqual([parkedEvent('patron:p1', 3)]);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(checkpoint(r.data())?.reduced).toBe(10);
    r.server.blobs.set('patron:p2', {
      position: 12,
      seqs: { 'patron:p2': 8 },
      values: [['patron:p2!state', { count: 8, fields: {} }]],
    });
    h2.go();
    await settle();
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())?.reduced).toBe(12);
  });

  test('a break among the frozen events blocks the group land and spawns a replacing backfill at once', async () => {
    const r = await held();
    const gap = await freeze(r);
    r.server.hold('patron:p1');
    // a jump on another held stream while frozen parks without a check
    r.server.events(ev('patron:p1', 7, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    // the frozen check found p1 broken: replacing, marked, and the group did not land
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: true, until: 12 });
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(seq(r.data(), 'patron:p2')).toBe('backfill');
    expect(r.server.backfills.filter((b) => b.ref === 'patron:p1').length).toBe(1);
  });

  test('a clean additive ref that became ready during a freeze stays ready and lands with the group', async () => {
    const r = await held();
    const gap = await freeze(r);
    const hold = r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    await settle();
    r.server.blobs.set('book:*', {
      position: 12,
      seqs: { 'book:b1': 1 },
      values: [['book:b1!state', { count: 1, fields: {} }]],
    });
    hold.go();
    await settle();
    // done, ready, not landed
    expect(record(r, 'book:*')?.resume).toMatchObject({ snapshotDone: true, tailDone: true });
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(keys(r.data(), '!park-kv:book:*!')).toEqual(['!park-kv:book:*!book:b1!state']);
    r.server.blobs.set('patron:p2', {
      position: 11,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'patron:p2')).toBe(9);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('the land is scoped: an additive backfill still in flight keeps its ranges untouched', async () => {
    const r = await held();
    const h1 = r.server.hold('book:b1');
    r.server.hold('book:b2');
    r.server.view('t2', 11, ['patron:*', 'book:b1', 'book:b2']);
    await settle();
    r.server.events(ev('book:b1', 3, 12), ev('book:b2', 3, 12));
    await settle();
    r.server.blobs.set('book:b1', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    h1.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 3, fields: {} });
    expect(record(r, 'book:b1')).toBeUndefined();
    expect(record(r, 'book:b2')).toBeDefined();
    expect(seq(r.data(), 'book:b2')).toBe('backfill');
    expect(keys(r.data(), '!park-ev:')).toEqual([parkedEvent('book:b2', 3)]);
    expect(state(r.data(), 'book:b2')).toBeUndefined();
  });

  test('per-stream reduction of events spanning slices yields the store global order would', async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    // live events on held patrons interleave with parked books; each stream sees its own run
    r.server.events(
      ev('book:b1', 1, 12, { type: 'set', field: 'a', value: 1 }),
      ev('patron:p1', 3, 12),
      ev('book:b2', 1, 12, { type: 'set', field: 'b', value: 2 }),
      ev('book:b1', 2, 13),
      ev('patron:p1', 4, 13),
    );
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['bump', 'bump']);
    r.server.blobs.set('book:*', { position: 11, seqs: {}, values: [] });
    hold.go();
    await settle();
    expect(log(r.data(), 'book:b1')).toEqual(['set a=1', 'bump']);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: { a: 1 } });
    expect(log(r.data(), 'book:b2')).toEqual(['set b=2']);
    expect(seq(r.data(), 'book:b1')).toBe(2);
    expect(seq(r.data(), 'book:b2')).toBe(1);
    expect(seq(r.data(), 'patron:p1')).toBe(4);
  });

  test("a replacing land deletes the stream's old keys, those the blob lacks included", async () => {
    const r = await held();
    r.server.events(ev('patron:p2', 2, 11, { type: 'set', field: 'old', value: true }));
    await settle();
    expect(log(r.data(), 'patron:p2')).toEqual(['set old=true']);
    const gap = r.server.hold('patron:p2');
    r.server.events(ev('patron:p2', 9, 12));
    await settle();
    // the blob carries state only: the log is not in it
    r.server.blobs.set('patron:p2', {
      position: 12,
      seqs: { 'patron:p2': 8 },
      values: [['patron:p2!state', { count: 8, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(log(r.data(), 'patron:p2')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p2')).toBe(9);
  });

  test("a death among a ref's parked events drops the stream's keys and advances its seq", async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 3, 12), death('book:b1', 4, 13));
    await settle();
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(keys(r.data(), 'book:b1!')).toEqual([]);
    expect(seq(r.data(), 'book:b1')).toBe(4);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('a stream born after the cut chains from seq 1', async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(birth('book:b2', 1, 12), ev('book:b2', 2, 13));
    await settle();
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'book:b2')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'book:b2')).toEqual(['bump']);
    expect(seq(r.data(), 'book:b2')).toBe(2);
    expect(seq(r.data(), 'book:b1')).toBe(2);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a stream its blob does not name is unknown after the land, so its birth chains', async () => {
    const r = rig();
    await bootstrap(r, ['patron:p1'], { 'patron:p1': { position: 10, seqs: {}, values: [] } });
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    r.server.events(birth('patron:p1', 1, 11), ev('patron:p1', 2, 11));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(keys(r.data(), '!park-ev:')).toEqual([]);
  });

  test('a parked run that breaks mid-way is a break, and nothing of it reaches a reducer', async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 3, 12), ev('book:b1', 5, 13));
    await settle();
    r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2 },
      values: [['book:b1!state', { count: 2, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(log(r.data(), 'book:b1')).toEqual([]);
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    expect(keys(r.data(), '!park-ev:book:b1!')).toEqual([
      parkedEvent('book:b1', 3),
      parkedEvent('book:b1', 5),
    ]);
  });

  test("every landed stream's seq: the last walked with parked events, the header's without; a held stream outside untouched", async () => {
    const r = await held();
    const hold = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.events(ev('book:b1', 3, 12), ev('book:b1', 4, 13));
    await settle();
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2, 'book:b2': 7 },
      values: [
        ['book:b1!state', { count: 2, fields: {} }],
        ['book:b2!state', { count: 7, fields: {} }],
      ],
    });
    hold.go();
    await settle();
    expect(seq(r.data(), 'book:b1')).toBe(4);
    expect(seq(r.data(), 'book:b2')).toBe(7);
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(seq(r.data(), 'patron:p2')).toBe(1);
  });

  test('a land runs the graph only while live', async () => {
    const server = new FakeServer();
    server.blobs.set('patron:*', patrons);
    const r = rig({ server });
    const { values } = watch(r, 'patron:p1');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    // landed, but no frame was delivered
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(values).toEqual([]);
    r.server.live(10);
    await settle();
    expect(values).toEqual([{ count: 2, fields: {} }]);
  });
});
