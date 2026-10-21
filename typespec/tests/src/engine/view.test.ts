// TESTS.md: View reconciliation

import { describe, expect, test } from 'vitest';

import {
  parkedEditKey,
  parsePark,
  selectorCovers,
  selectorPrefix,
  sliceOf,
} from '../../../ts/assets/skeleton.ts';

import {
  birth,
  type Blob,
  bootstrap,
  ev,
  FakeServer,
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

type View = { token: string; position: number; selectors: string[] };
const view = (r: Rig): View | undefined => r.data()['!view'] as View | undefined;

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};
const books: Blob = {
  position: 10,
  seqs: { 'book:b1': 1 },
  values: [['book:b1!state', { count: 1, fields: {} }]],
};
const p1Blob: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2 },
  values: [['patron:p1!state', { count: 2, fields: {} }]],
};

/** a live Engine holding the given selectors at position 10 */
async function held(
  selectors = ['patron:*'],
  blobs: Record<string, Blob> = { 'patron:*': patrons },
): Promise<Rig> {
  const r = rig();
  await bootstrap(r, selectors, blobs);
  return r;
}

describe('view reconciliation', () => {
  test('a frame with the current token and set writes only !view', async () => {
    const r = await held();
    const before = { ...r.data() };
    delete before['!view'];
    r.server.view('t1', 12, ['patron:*']);
    await settle();
    expect(view(r)).toEqual({ token: 't1', position: 12, selectors: ['patron:*'] });
    const after = { ...r.data() };
    delete after['!view'];
    expect(after).toEqual(before);
    expect(r.server.backfills.length).toBe(1);
  });

  test('a grant covered by another selector in the same set is never backfilled separately', async () => {
    const r = await held();
    r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*', 'book:b1']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'book:*']);
    expect(record(r, 'book:*')).toMatchObject({ until: 11, replacing: false });
    expect(record(r, 'book:b1')).toBeUndefined();
  });

  test('a grant of a selector that already has an in-flight entry is a no-op', async () => {
    const r = await held(['book:*'], { 'book:*': books });
    r.server.hold('patron:p9');
    r.server.edits(ev('patron:p9', 7, 11));
    await settle();
    expect(record(r, 'patron:p9')).toMatchObject({ until: 11, replacing: false });
    r.server.view('t2', 12, ['book:*', 'patron:p9']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:p9']);
    expect(record(r, 'patron:p9')).toMatchObject({ until: 11, replacing: false });
    expect(view(r)).toEqual({ token: 't2', position: 12, selectors: ['book:*', 'patron:p9'] });
  });

  test("reconciliation is against state: '*' revoked while in flight leaves 'patron:*' to backfill itself", async () => {
    const r = await held(['book:*'], { 'book:*': books });
    r.server.hold('*');
    r.server.view('t2', 11, ['*']);
    await settle();
    // a patron slice first seen under the in-flight *: marked and parked
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    // patron:* granted beside *: covered by the entry, so nothing starts
    r.server.view('t3', 13, ['*', 'patron:*']);
    await settle();
    expect(record(r, 'patron:*')).toBeUndefined();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', '*']);
    // * revoked: patron:* is not held (an entry covered it) and downloads itself
    const fam = r.server.hold('patron:*');
    r.server.view('t4', 14, ['patron:*']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(parkedKeys(r.data(), '*')).toEqual([]);
    expect(seq(r.data(), 'book:b1')).toBeUndefined();
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(record(r, 'patron:*')).toMatchObject({ until: 14, replacing: false });
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', '*', 'patron:*']);
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 3)]);
    r.server.blobs.set('patron:*', {
      position: 14,
      seqs: { 'patron:p1': 2 },
      values: [['patron:p1!state', { count: 2, fields: {} }]],
    });
    fam.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a held family covered by a wider in-flight selector and narrowed back to is downloaded again, members kept', async () => {
    const r = await held();
    r.server.hold('*');
    r.server.view('t2', 11, ['*']);
    await settle();
    // held members stay held under the additive *
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    const fam = r.server.hold('patron:*');
    r.server.view('t3', 13, ['patron:*']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', '*', 'patron:*']);
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    r.server.blobs.set('patron:*', {
      position: 13,
      seqs: { 'patron:p1': 2, 'patron:p2': 1, 'patron:p3': 1 },
      values: [
        ['patron:p1!state', { count: 99, fields: {} }],
        ['patron:p2!state', { count: 99, fields: {} }],
        ['patron:p3!state', { count: 1, fields: {} }],
      ],
    });
    fam.go();
    await settle();
    // held members at or past the cut keep their state; the new member comes from the blob
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(state(r.data(), 'patron:p3')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'patron:p3')).toBe(1);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('a slice born under a wider in-flight selector is rediscovered when that selector is revoked before landing', async () => {
    const r = await held();
    r.server.hold('*');
    r.server.view('t2', 11, ['*']);
    await settle();
    r.server.edits(birth('patron:p9', 1, 12));
    r.server.edits(ev('patron:p9', 2, 13));
    await settle();
    expect(seq(r.data(), 'patron:p9')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p9!')).toEqual([
      parkedEdit('patron:p9', 1),
      parkedEdit('patron:p9', 2),
    ]);
    const fam = r.server.hold('patron:*');
    r.server.view('t3', 14, ['patron:*']);
    await settle();
    expect(record(r, '*')).toBeUndefined();
    expect(seq(r.data(), 'patron:p9')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p9!').length).toBe(2);
    // the renewed family blob, cut between p9's birth and its first edit
    r.server.blobs.set('patron:*', {
      position: 12,
      seqs: { 'patron:p1': 2, 'patron:p2': 1, 'patron:p9': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
        ['patron:p9!state', { count: 0, fields: {} }],
      ],
    });
    fam.go();
    await settle();
    expect(seq(r.data(), 'patron:p9')).toBe(2);
    expect(state(r.data(), 'patron:p9')).toEqual({ count: 1, fields: {} });
    expect(log(r.data(), 'patron:p9')).toEqual(['bump']);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('removing a selector drops per slice, skipping slices the new set covers; a partially uncovered in-flight selector is aborted', async () => {
    const r = await held(['patron:*', 'book:*'], { 'patron:*': patrons, 'book:*': books });
    r.server.hold('*');
    r.server.view('t2', 11, ['*']);
    await settle();
    r.server.edits(birth('book:b7', 1, 12));
    await settle();
    expect(seq(r.data(), 'book:b7')).toBe('backfill');
    r.server.hold('patron:*');
    r.server.view('t3', 13, ['patron:*']);
    await settle();
    // * is partially uncovered: its entry and values range go
    expect(record(r, '*')).toBeUndefined();
    expect(parkedKeys(r.data(), '*')).toEqual([]);
    // book slices, held or marked, are uncovered and go with everything they had
    expect(seq(r.data(), 'book:b1')).toBeUndefined();
    expect(state(r.data(), 'book:b1')).toBeUndefined();
    expect(seq(r.data(), 'book:b7')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:book:')).toEqual([]);
    // patron slices are covered and untouched
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron:p2')).toBe(1);
  });

  test('an in-flight selector fully covered by the new set is kept and adopted, not aborted', async () => {
    const r = await held(['book:b1'], { 'book:b1': books });
    const b2 = r.server.hold('book:b2');
    r.server.view('t2', 11, ['book:b1', 'book:b2']);
    await settle();
    expect(record(r, 'book:b2')).toMatchObject({ until: 11 });
    r.server.hold('book:*');
    r.server.view('t3', 12, ['book:*']);
    await settle();
    expect(record(r, 'book:b2')).toMatchObject({ until: 11 });
    expect(record(r, 'book:*')?.children).toEqual(['book:b2']);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:b1', 'book:b2', 'book:*']);
    expect(seq(r.data(), 'book:b1')).toBe(1);
    b2.go();
  });

  test('narrowing from a held parent drops the other members, keeps p1, and refetches nothing', async () => {
    const r = await held();
    r.server.view('t2', 11, ['patron:p1']);
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(state(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(r.server.backfills.length).toBe(1);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
  });

  test('narrowing from an in-flight parent, p1 held: the parent is aborted and p1 stays held', async () => {
    const r = await held(['patron:p1'], { 'patron:p1': p1Blob });
    r.server.hold('patron:*');
    r.server.view('t2', 11, ['patron:*']);
    await settle();
    expect(record(r, 'patron:*')).toMatchObject({ until: 11 });
    r.server.view('t3', 12, ['patron:p1']);
    await settle();
    expect(record(r, 'patron:*')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:p1', 'patron:*']);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('narrowing from an in-flight parent, p1 marked under it: p1 gets its own backfill and its parked edits chain from the new cut', async () => {
    const r = await held(['book:*'], { 'book:*': books });
    r.server.hold('patron:*');
    r.server.view('t2', 11, ['book:*', 'patron:*']);
    await settle();
    r.server.edits(ev('patron:p1', 5, 12), ev('patron:p2', 3, 12));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    const p1 = r.server.hold('patron:p1');
    r.server.view('t3', 13, ['book:*', 'patron:p1']);
    await settle();
    expect(record(r, 'patron:*')).toBeUndefined();
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 5)]);
    expect(record(r, 'patron:p1')).toMatchObject({ until: 13, replacing: false });
    r.server.blobs.set('patron:p1', {
      position: 13,
      seqs: { 'patron:p1': 4 },
      values: [['patron:p1!state', { count: 4, fields: {} }]],
    });
    p1.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
    expect(log(r.data(), 'patron:p1')).toEqual(['bump']);
  });

  test('narrowing from an in-flight parent, p1 already its child: the child keeps its entry as top-level', async () => {
    const r = await held(['book:*'], { 'book:*': books });
    const fam = r.server.hold('patron:*');
    r.server.view('t2', 11, ['book:*', 'patron:*']);
    await settle();
    r.server.edits(ev('patron:p1', 7, 12));
    await settle();
    r.server.blobs.set('patron:*', {
      position: 11,
      seqs: { 'patron:p1': 2, 'patron:p2': 1 },
      values: [
        ['patron:p1!state', { count: 2, fields: {} }],
        ['patron:p2!state', { count: 1, fields: {} }],
      ],
    });
    const p1 = r.server.hold('patron:p1');
    fam.go();
    await settle();
    // the land found p1's break and spawned the child; the parent waits on it
    expect(record(r, 'patron:*')?.children).toEqual(['patron:p1']);
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: false, until: 12 });
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:*', 'patron:*', 'patron:p1']);
    r.server.view('t3', 13, ['book:*', 'patron:p1']);
    await settle();
    expect(record(r, 'patron:*')).toBeUndefined();
    expect(parkedKeys(r.data(), 'patron:*')).toEqual([]);
    expect(record(r, 'patron:p1')).toMatchObject({ replacing: false, until: 12 });
    expect(r.server.backfills.length).toBe(3);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    r.server.blobs.set('patron:p1', {
      position: 12,
      seqs: { 'patron:p1': 7 },
      values: [['patron:p1!state', { count: 7, fields: {} }]],
    });
    p1.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 7, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(7);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('on reconnect a current token gets no view frame and nothing is reconciled; a stale token gets the view first', async () => {
    const r = await held();
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.since).toBe(10);
    expect(r.server.conn.view).toBe('t1');
    r.server.open();
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.live(11);
    await settle();
    expect(view(r)).toEqual({ token: 't1', position: 10, selectors: ['patron:*'] });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(r.server.backfills.length).toBe(1);
    // the view changed while away: the frame comes first and the history behind it parks under its grant
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.since).toBe(11);
    expect(r.server.conn.view).toBe('t1');
    r.server.open();
    r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    r.server.edits(ev('book:b1', 4, 12));
    r.server.live(12);
    await settle();
    expect(view(r)).toEqual({ token: 't2', position: 12, selectors: ['patron:*', 'book:*'] });
    expect(record(r, 'book:*')).toMatchObject({ until: 12, replacing: false });
    expect(seq(r.data(), 'book:b1')).toBe('backfill');
    expect(keys(r.data(), '!park-ed:book:b1!')).toEqual([parkedEdit('book:b1', 4)]);
  });

  test('!view is written with the reconciliation; a crash before it presents the old token again', async () => {
    const r = await held();
    r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    // the frame is queued when the Engine ends, so it never commits
    r.abort.abort();
    await settle();
    expect(view(r)).toEqual({ token: 't1', position: 10, selectors: ['patron:*'] });
    expect(record(r, 'book:*')).toBeUndefined();
    const server = new FakeServer();
    server.blobs.set('patron:*', patrons);
    rig({ store: r.store, server });
    await settle();
    expect(server.conn.view).toBe('t1');
    expect(server.conn.since).toBe(10);
  });

  test('a family revoked and regranted while disconnected, with a member born in between, is complete after replay', async () => {
    const r = await held();
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.view).toBe('t1');
    r.server.open();
    // the set is what it was, so the token is current and no frame comes; the replay carries the birth
    r.server.edits(birth('patron:p3', 1, 11), ev('patron:p3', 2, 11));
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.live(12);
    await settle();
    expect(seq(r.data(), 'patron:p3')).toBe(2);
    expect(state(r.data(), 'patron:p3')).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(r.server.backfills.length).toBe(1);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });
});

describe('selectors and keys', () => {
  test('a wildcard covers the names under its prefix, and a name only itself', () => {
    expect(selectorCovers('*', 'patron:p1')).toBe(true);
    expect(selectorCovers('patron:*', 'patron:p1')).toBe(true);
    expect(selectorCovers('patron:*', 'book:b1')).toBe(false);
    expect(selectorCovers('chat:acme,*', 'chat:acme,gen')).toBe(true);
    expect(selectorCovers('chat:acme,*', 'chat:acme-2,gen')).toBe(false);
    expect(selectorCovers('chat:*', 'chat:acme,*')).toBe(true);
    expect(selectorCovers('chat:acme,gen', 'chat:acme,gen')).toBe(true);
    expect(selectorCovers('chat:acme,gen', 'chat:acme,gen-2')).toBe(false);
  });

  test("a selector's key prefix holds its slices' keys and no other slice's", () => {
    expect(selectorPrefix('*')).toBe('');
    expect(selectorPrefix('patron:*')).toBe('patron:');
    expect(selectorPrefix('chat:acme,*')).toBe('chat:acme,');
    expect(selectorPrefix('chat:acme,gen')).toBe('chat:acme,gen!');
    expect('chat:acme,gen-2!post:m1'.startsWith(selectorPrefix('chat:acme,gen'))).toBe(false);
    expect('login!user:a'.startsWith(selectorPrefix('login'))).toBe(true);
  });

  test("a key's slice is everything before its first '!'", () => {
    expect(sliceOf('patron:p1!state')).toBe('patron:p1');
    expect(sliceOf('chat:acme,gen!reply:t1,m:5!x')).toBe('chat:acme,gen');
    expect(sliceOf('login!user:a')).toBe('login');
    expect(sliceOf('!view')).toBe('');
    expect(() => sliceOf('patron:p1')).toThrow(`key "patron:p1" has no '!'`);
  });

  test('a parked edit key names its slice and seq, under its slice selector prefix', () => {
    const key = parkedEditKey('chat:acme,gen', 7);
    expect(key).toBe('!park-ed:chat:acme,gen!00000000000000000007');
    expect(key.startsWith(`!park-ed:${selectorPrefix('chat:acme,*')}`)).toBe(true);
    expect(key.startsWith(`!park-ed:${selectorPrefix('chat:acme,gen')}`)).toBe(true);
    expect(parsePark(key)).toEqual({ slice: 'chat:acme,gen', seq: 7 });
  });
});
