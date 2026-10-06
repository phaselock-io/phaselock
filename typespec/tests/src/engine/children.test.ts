// TESTS.md: Children

import { describe, expect, test } from 'vitest';

import {
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
  r.data()[`/backfill.${ref}`] as Record_ | undefined;

/** the family's blob: p1 and p7 at their cuts */
const family: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2, 'patron.p7': 1 },
  values: [
    ['patron.p1/state', { count: 2, fields: {} }],
    ['patron.p7/state', { count: 1, fields: { stale: true } }],
  ],
};

/** the child's blob: p7 cut at the gap */
const p7Blob: Blob = {
  position: 11,
  seqs: { 'patron.p7': 5 },
  values: [['patron.p7/state', { count: 5, fields: {} }]],
};

/** bootstrap `patron.*` with a gap on p7 parked under it, so its land spawns `patron.p7`, which
    is held; returns the child's hold */
async function spawned(): Promise<{ r: Rig; child: { go: () => void } }> {
  const server = new FakeServer();
  server.blobs.set('patron.*', family);
  const r = rig({ server });
  const parent = r.server.hold('patron.*');
  await settle();
  r.server.open();
  r.server.view('t1', 10, ['patron.*']);
  r.server.live(10);
  r.server.events(ev('patron.p7', 5, 11));
  await settle();
  expect(keys(r.data(), '/park.ev.')).toEqual([parkedEvent('patron.p7', 5)]);
  const child = r.server.hold('patron.p7');
  parent.go();
  await settle();
  expect(record(r, 'patron.*')?.children).toEqual(['patron.p7']);
  return { r, child };
}

describe('children', () => {
  test('a child inherits replacing, takes the checkpoint as until, and the waiting parent lists it', async () => {
    const { r } = await spawned();
    expect(record(r, 'patron.p7')).toMatchObject({
      replacing: true,
      until: 11,
      children: [],
      resume: null,
    });
    expect(record(r, 'patron.*')).toMatchObject({ replacing: true, children: ['patron.p7'] });
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p7']);
    // the parent is done downloading and waits: nothing of it landed
    expect(record(r, 'patron.*')?.resume).toMatchObject({ snapshotDone: true, tailDone: true });
    expect(state(r.data(), 'patron.p1')).toBeUndefined();
    expect(keys(r.data(), '/park.kv.patron.*/')).toEqual([
      '/park.kv.patron.*/patron.p1/state',
      '/park.kv.patron.*/patron.p7/state',
    ]);
    expect(checkpoint(r.data())?.reduced).toBe(-1);
  });

  test("a child's events share the stream's range, where a re-parked event overwrites itself", async () => {
    const { r } = await spawned();
    r.server.events(ev('patron.p7', 6, 12));
    r.server.events(ev('patron.p7', 6, 12));
    await settle();
    expect(keys(r.data(), '/park.ev.')).toEqual([
      parkedEvent('patron.p7', 5),
      parkedEvent('patron.p7', 6),
    ]);
    expect(seq(r.data(), 'patron.p7')).toBe('backfill');
  });

  test('the subtree lands as one: the child over the parent for its stream, covered events skipped, every record gone', async () => {
    const { r, child } = await spawned();
    r.server.events(ev('patron.p7', 6, 12));
    await settle();
    r.server.blobs.set('patron.p7', p7Blob);
    child.go();
    await settle();
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 2, fields: {} });
    // the child's values, and only the event past its cut reduced over them
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 6, fields: {} });
    expect(log(r.data(), 'patron.p7')).toEqual(['bump']);
    expect(seq(r.data(), 'patron.p1')).toBe(2);
    expect(seq(r.data(), 'patron.p7')).toBe(6);
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(keys(r.data(), '/park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 12, reduced: 12 });
  });

  test('a ready child is checked on its own and restarts when broken, without waiting for its parent', async () => {
    const { r, child } = await spawned();
    // a cut below the parked gap event
    r.server.blobs.set('patron.p7', {
      position: 11,
      seqs: { 'patron.p7': 3 },
      values: [['patron.p7/state', { count: 3, fields: {} }]],
    });
    child.go();
    const again = r.server.hold('patron.p7');
    await settle();
    expect(record(r, 'patron.p7')).toMatchObject({ resume: null, children: [] });
    expect(keys(r.data(), '/park.kv.patron.p7/')).toEqual([]);
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p7', 'patron.p7']);
    expect(record(r, 'patron.*')?.children).toEqual(['patron.p7']);
    expect(state(r.data(), 'patron.p1')).toBeUndefined();
    r.server.blobs.set('patron.p7', p7Blob);
    again.go();
    await settle();
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 5, fields: {} });
    expect(keys(r.data(), '/backfill')).toEqual([]);
  });

  test('the parent lands over the base for its own streams, a live event on one of them chaining from the merged cut', async () => {
    const { r, child } = await spawned();
    r.server.events(ev('patron.p1', 3, 12));
    await settle();
    expect(keys(r.data(), '/park.ev.patron.p1/')).toEqual([parkedEvent('patron.p1', 3)]);
    r.server.blobs.set('patron.p7', p7Blob);
    child.go();
    await settle();
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron.p1')).toBe(3);
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 5, fields: {} });
  });

  test('parent revoked, child kept: the child lands top-level and the parent’s other ranges go', async () => {
    const { r, child } = await spawned();
    r.server.view('t2', 12, ['patron.p7']);
    await settle();
    expect(record(r, 'patron.*')).toBeUndefined();
    expect(keys(r.data(), '/park.kv.patron.*/')).toEqual([]);
    expect(seq(r.data(), 'patron.p1')).toBeUndefined();
    expect(record(r, 'patron.p7')).toBeDefined();
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p7']);
    r.server.blobs.set('patron.p7', p7Blob);
    child.go();
    await settle();
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron.p7')).toBe(5);
    expect(state(r.data(), 'patron.p1')).toBeUndefined();
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(keys(r.data(), '/park')).toEqual([]);
  });

  test('headers merge at land: an adopted child that finished first sets the cut for its stream', async () => {
    const r = rig();
    await bootstrap(r, ['patron.p1'], {
      'patron.p1': {
        position: 10,
        seqs: { 'patron.p1': 2 },
        values: [['patron.p1/state', { count: 2, fields: {} }]],
      },
    });
    const child = r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 7, 11));
    await settle();
    const parent = r.server.hold('patron.*');
    r.server.view('t2', 12, ['patron.*']);
    await settle();
    expect(record(r, 'patron.*')?.children).toEqual(['patron.p1']);
    // the child completes while the parent is still downloading
    r.server.blobs.set('patron.p1', {
      position: 11,
      seqs: { 'patron.p1': 7 },
      values: [['patron.p1/state', { count: 7, fields: {} }]],
    });
    child.go();
    await settle();
    expect(r.data()['/backfill-seqs.patron.p1']).toEqual({ 'patron.p1': 7 });
    expect(record(r, 'patron.p1')?.resume).toMatchObject({ snapshotDone: true, tailDone: true });
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 2, fields: {} });
    // the parent's blob knows p1 at an older cut and has a member of its own
    r.server.blobs.set('patron.*', {
      position: 12,
      seqs: { 'patron.p1': 2, 'patron.p2': 1 },
      values: [
        ['patron.p1/state', { count: 2, fields: { old: true } }],
        ['patron.p2/state', { count: 1, fields: {} }],
      ],
    });
    parent.go();
    await settle();
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron.p1')).toBe(7);
    expect(state(r.data(), 'patron.p2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '/backfill')).toEqual([]);
  });

  test("a child's values under its own range win over the parent's for its stream after a restart", async () => {
    // the store as left mid-way: the parent done and waiting, the child's snapshot in, its tail open
    const server = new FakeServer();
    server.blobs.set('patron.p7', p7Blob);
    const r = rig({
      server,
      seed: {
        '/view': { token: 't1', position: 10, refs: ['patron.*'] },
        '/checkpoint': { epoch: 'e1', position: 11, reduced: -1 },
        '/backfill.patron.*': {
          until: 10,
          resume: {
            position: 10,
            skipBytes: 2,
            fromPosition: 10,
            snapshotDone: true,
            tailDone: true,
          },
          replacing: true,
          children: ['patron.p7'],
        },
        '/backfill-seqs.patron.*': { 'patron.p1': 2, 'patron.p7': 1 },
        '/park.kv.patron.*/patron.p1/state': { count: 2, fields: {} },
        '/park.kv.patron.*/patron.p7/state': { count: 1, fields: { stale: true } },
        '/backfill.patron.p7': {
          until: 11,
          resume: {
            position: 11,
            skipBytes: 1,
            fromPosition: 11,
            snapshotDone: true,
            tailDone: false,
          },
          replacing: true,
          children: [],
        },
        '/backfill-seqs.patron.p7': { 'patron.p7': 5 },
        '/park.kv.patron.p7/patron.p7/state': { count: 5, fields: {} },
        [parkedEvent('patron.p7', 5)]: {
          id: 'x',
          data: { id: 'p7', type: 'bump' },
          position: 11,
          stream: 'patron.p7',
          seq: 5,
          servertime: 0,
        },
        '/seq.patron.p1': 'backfill',
        '/seq.patron.p7': 'backfill',
      },
    });
    await settle();
    r.server.open();
    r.server.live(11);
    await settle();
    // only the child's tail was asked for, from its persisted resume
    expect(r.server.backfills.length).toBe(1);
    expect(r.server.backfills[0]).toMatchObject({ ref: 'patron.p7', until: 11 });
    expect(r.server.backfills[0].resume).toMatchObject({
      position: 11,
      skipBytes: 1,
      fromPosition: 11,
      snapshotDone: true,
    });
    expect(state(r.data(), 'patron.p1')).toEqual({ count: 2, fields: {} });
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron.p7')).toBe(5);
    expect(keys(r.data(), '/backfill')).toEqual([]);
    expect(keys(r.data(), '/park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 11, reduced: 11 });
  });

  test('children are one layer deep: an exact ref is never given a child', async () => {
    const { r, child } = await spawned();
    // a second gap on the child's stream parks; the child's break restarts it rather than nesting
    r.server.events(ev('patron.p7', 9, 12));
    await settle();
    r.server.blobs.set('patron.p7', p7Blob);
    child.go();
    const again = r.server.hold('patron.p7');
    await settle();
    expect(record(r, 'patron.p7')).toMatchObject({ resume: null, children: [] });
    expect(keys(r.data(), '/backfill.')).toEqual(['/backfill.patron.*', '/backfill.patron.p7']);
    r.server.blobs.set('patron.p7', {
      position: 12,
      seqs: { 'patron.p7': 8 },
      values: [['patron.p7/state', { count: 8, fields: {} }]],
    });
    again.go();
    await settle();
    expect(state(r.data(), 'patron.p7')).toEqual({ count: 9, fields: {} });
    expect(keys(r.data(), '/backfill')).toEqual([]);
  });
});
