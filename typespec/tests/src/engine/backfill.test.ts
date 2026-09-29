// TESTS.md: Backfill lifecycle

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  birth,
  type Blob,
  bootstrap,
  checkpoint,
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
} from './harness.ts';

type Record_ = {
  until: number;
  resume: null | Record<string, unknown>;
  replacing: boolean;
  children: string[];
};

const record = (r: Rig, ref: string): Record_ | undefined =>
  r.data[`/backfill.${ref}`] as Record_ | undefined;

/** a held family with two members at position 10 */
const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2, 'patron.p2': 1 },
  values: [
    ['patron.p1/state', { count: 2, fields: {} }],
    ['patron.p2/state', { count: 1, fields: {} }],
  ],
};

async function held(): Promise<Rig> {
  const r = rig();
  await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
  return r;
}

/** settle one round at a time until the ref has been asked for n times */
async function untilCalls(r: Rig, ref: string, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (r.server.backfills.filter((b) => b.ref === ref).length >= n) return;
    await settle(1);
  }
  throw new Error(`no ${n}th backfill of ${ref}`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('backfill lifecycle', () => {
  test('a grant writes its record with the view, until = the frame position', async () => {
    const r = await held();
    r.server.hold('book.*');
    r.server.view('t2', 11, ['patron.*', 'book.*']);
    await settle();
    expect(r.data['/view']).toEqual({ token: 't2', position: 11, refs: ['patron.*', 'book.*'] });
    expect(record(r, 'book.*')).toEqual({
      until: 11,
      resume: null,
      replacing: false,
      children: [],
    });
    expect(r.server.backfills.at(-1)).toMatchObject({ ref: 'book.*', until: 11, resume: null });
  });

  test("the first view's grants are replacing and freeze the base until they land as a group; later grants are additive", async () => {
    const r = rig();
    await settle();
    const hold = r.server.hold('patron.*');
    r.server.blobs.set('patron.*', patrons);
    r.server.open();
    r.server.view('t1', 10, ['patron.*']);
    r.server.live(10);
    r.server.vouch(15);
    await settle();
    expect(record(r, 'patron.*')?.replacing).toBe(true);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 15, reduced: -1 });
    expect(state(r.data, 'patron.p1')).toBeUndefined();
    hold.go();
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 15, reduced: 15 });
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
    r.server.hold('book.*');
    r.server.view('t2', 16, ['patron.*', 'book.*']);
    await settle();
    expect(record(r, 'book.*')?.replacing).toBe(false);
  });

  test('creating a replacing ref marks every held stream under it: a stream on a gap, a family at bootstrap over held data', async () => {
    // a gap on a held stream
    const r = await held();
    r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 5, 11));
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe('backfill');
    expect(seq(r.data, 'patron.p2')).toBe(1);

    // a first view over held state (no /view stored): the family grant is replacing and marks
    // every member before its download starts
    const r2 = rig({
      data: {
        '/seq.patron.p1': 2,
        '/seq.patron.p2': 1,
        'patron.p1/state': { count: 2, fields: {} },
        'patron.p2/state': { count: 1, fields: {} },
      },
    });
    await settle();
    r2.server.hold('patron.*');
    r2.server.open();
    r2.server.view('t1', 10, ['patron.*']);
    await settle();
    expect(record(r2, 'patron.*')?.replacing).toBe(true);
    expect(seq(r2.data, 'patron.p1')).toBe('backfill');
    expect(seq(r2.data, 'patron.p2')).toBe('backfill');
    expect(state(r2.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
  });

  test('the header writes /backfill-seqs and resume.position; values write /park.kv.{ref}/ and skipBytes; events write parked events and fromPosition', async () => {
    // the family's land waits on a child, so its record and ranges stay observable after the
    // whole download
    const r = await held();
    r.server.hold('book.b7');
    r.server.blobs.set('book.*', {
      position: 10,
      seqs: { 'book.b1': 3, 'book.b7': 2 },
      values: [
        ['book.b1/state', { count: 3, fields: {} }],
        ['book.b7/state', { count: 2, fields: {} }],
        ['book.b1/other', { dropped: true }],
      ],
      tail: [ev('book.b1', 4, 11), ev('book.b7', 4, 12)],
    });
    r.server.view('t2', 12, ['patron.*', 'book.*']);
    await settle();
    expect(r.data['/backfill-seqs.book.*']).toEqual({ 'book.b1': 3, 'book.b7': 2 });
    expect(record(r, 'book.*')?.resume).toEqual({
      position: 10,
      skipBytes: 3,
      fromPosition: 12,
      snapshotDone: true,
      tailDone: true,
    });
    // a key no slice declares is dropped
    expect(keys(r.data, '/park.kv.book.*/')).toEqual([
      '/park.kv.book.*/book.b1/state',
      '/park.kv.book.*/book.b7/state',
    ]);
    expect(keys(r.data, '/park.ev.book.')).toEqual([
      parkedEvent('book.b1', 4),
      parkedEvent('book.b7', 4),
    ]);
    expect(seq(r.data, 'book.b1')).toBe('backfill');
    expect(record(r, 'book.*')?.children).toEqual(['book.b7']);
  });

  test('a failing backfill is retried with its resume intact after backoff', async () => {
    vi.useFakeTimers();
    const resume = {
      position: 10,
      skipBytes: 1,
      fromPosition: 10,
      snapshotDone: true,
      tailDone: false,
    };
    // the rig connects and starts the download at once, so the server is set up first
    const server = new FakeServer();
    server.failOnce.set('book.b1', new Error('boom'));
    server.blobs.set('book.b1', {
      position: 10,
      seqs: { 'book.b1': 3 },
      values: [],
      tail: [ev('book.b1', 4, 11)],
    });
    const r = rig({
      server,
      data: {
        '/view': { token: 't1', position: 11, refs: ['book.b1'] },
        '/checkpoint': { epoch: 'e1', position: 11, reduced: 11 },
        '/backfill.book.b1': { until: 11, resume: { ...resume }, replacing: false, children: [] },
        '/backfill-seqs.book.b1': { 'book.b1': 3 },
        '/park.kv.book.b1/book.b1/state': { count: 3, fields: {} },
        '/seq.book.b1': 'backfill',
      },
    });
    await settle();
    r.server.open();
    r.server.live(11);
    await settle();
    expect(r.server.backfills).toEqual([{ ref: 'book.b1', until: 11, resume }]);
    expect(record(r, 'book.b1')?.resume).toEqual(resume);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(r.server.backfills.length).toBe(2);
    expect(r.server.backfills[1]).toEqual({ ref: 'book.b1', until: 11, resume });
    expect(state(r.data, 'book.b1')).toEqual({ count: 4, fields: {} });
    expect(log(r.data, 'book.b1')).toEqual(['bump']);
    expect(seq(r.data, 'book.b1')).toBe(4);
  });

  test("'stale' clears the ref's values, keeps its parked events, and retries from the start of the blob", async () => {
    const resume = {
      position: 10,
      skipBytes: 1,
      fromPosition: 10,
      snapshotDone: false,
      tailDone: false,
    };
    // the blob moved on: a resumed fetch of position 10 is stale
    const server = new FakeServer();
    server.blobs.set('book.b1', {
      position: 12,
      seqs: { 'book.b1': 4 },
      values: [['book.b1/state', { count: 4, fields: {} }]],
    });
    const r = rig({
      server,
      data: {
        '/view': { token: 't1', position: 11, refs: ['book.b1'] },
        '/checkpoint': { epoch: 'e1', position: 11, reduced: 11 },
        '/backfill.book.b1': { until: 11, resume, replacing: false, children: [] },
        '/backfill-seqs.book.b1': { 'book.b1': 3 },
        '/park.kv.book.b1/book.b1/state': { count: 99, fields: { stale: true } },
        [parkedEvent('book.b1', 5)]: {
          id: 'x',
          data: { id: 'b1', type: 'bump' },
          position: 11,
          stream: 'book.b1',
          seq: 5,
          servertime: 0,
        },
        '/seq.book.b1': 'backfill',
      },
    });
    await settle();
    r.server.open();
    r.server.live(12);
    await settle();
    expect(r.server.backfills.map((b) => b.resume)).toEqual([
      resume,
      { position: 10, skipBytes: 0, fromPosition: 10, snapshotDone: false, tailDone: false },
    ]);
    // the fresh blob landed and the kept parked event reduced over it
    expect(state(r.data, 'book.b1')).toEqual({ count: 5, fields: {} });
    expect(log(r.data, 'book.b1')).toEqual(['bump']);
    expect(seq(r.data, 'book.b1')).toBe(5);
    expect(keys(r.data, '/park.kv.')).toEqual([]);
  });

  test('a revoke of an in-flight ref aborts it and drops its values, record, and uncovered streams', async () => {
    const r = await held();
    r.server.hold('book.*');
    r.server.blobs.set('book.*', {
      position: 10,
      seqs: { 'book.b1': 3 },
      values: [['book.b1/state', { count: 3, fields: {} }]],
    });
    r.server.view('t2', 11, ['patron.*', 'book.*']);
    await settle();
    r.server.events(ev('book.b1', 4, 12));
    await settle();
    expect(seq(r.data, 'book.b1')).toBe('backfill');
    expect(keys(r.data, '/park.ev.book.')).toEqual([parkedEvent('book.b1', 4)]);
    const signal = r.server.conn.signal;
    expect(signal.aborted).toBe(false);
    r.server.view('t3', 13, ['patron.*']);
    await settle();
    expect(record(r, 'book.*')).toBeUndefined();
    expect(keys(r.data, '/backfill')).toEqual([]);
    expect(keys(r.data, '/park.')).toEqual([]);
    expect(seq(r.data, 'book.b1')).toBeUndefined();
    expect(keys(r.data, 'book.')).toEqual([]);
    // the connection itself is untouched, the held stream too
    expect(signal.aborted).toBe(false);
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
    // the held download was aborted through its own signal: releasing it starts nothing
    r.server.holds.get('book.*');
    await settle();
    expect(r.server.backfills.filter((b) => b.ref === 'book.*').length).toBe(1);
  });

  test('a ref covered by an in-flight ref is not backfilled separately', async () => {
    const r = await held();
    r.server.hold('book.*');
    r.server.view('t2', 11, ['patron.*', 'book.*', 'book.b1', 'patron.p1']);
    await settle();
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'book.*']);
    expect(keys(r.data, '/backfill.')).toEqual(['/backfill.book.*']);
  });

  test('a stream born under an in-flight ref parks; born under no ref it is held at seq 1', async () => {
    const r = await held();
    r.server.hold('book.*');
    r.server.view('t2', 11, ['patron.*', 'book.*']);
    await settle();
    r.server.events(birth('book.b2', 1, 12), birth('patron.p3', 1, 12));
    await settle();
    expect(seq(r.data, 'book.b2')).toBe('backfill');
    expect(keys(r.data, '/park.ev.book.b2/')).toEqual([parkedEvent('book.b2', 1)]);
    expect(seq(r.data, 'patron.p3')).toBe(1);
    expect(keys(r.data, '/park.ev.patron.')).toEqual([]);
    await untilCalls(r, 'book.*', 1);
  });
});
