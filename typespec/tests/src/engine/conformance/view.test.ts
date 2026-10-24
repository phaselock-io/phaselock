// Conformance, the view: P8 and P9 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  bootstrap,
  ev,
  FakeServer,
  keys,
  page,
  parkedEdit,
  rig,
  seq,
  settle,
  state,
  watch,
} from '../harness.ts';

import { held, named, one, patrons, record, resumed, view } from './common.ts';

// the database's half is server_test.go's TestAViewFrameLeadsTheEditsItGrantsIntoStreaming
describe('P8: a view cancels what it does not cover at once, and drops it from the base unfrozen or at the land', () => {
  test('P8: unfrozen, a revoke drops the slices it no longer covers at once', async () => {
    const r = await held();
    const p2 = watch(r, 'patron:p2');
    r.server.view('t2', 11, ['patron:p1']);
    await settle();
    expect(p2.values.at(-1)).toBeUndefined();
    expect(keys(r.data(), 'patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*']);
  });

  test('P8: frozen, a revoked slice stays in the frozen base until the land drops it', async () => {
    const r = await held();
    const p2 = watch(r, 'patron:p2');
    const gap = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11));
    await settle();

    // the view narrows to p1 while frozen, and queries still show p2
    r.server.view('t2', 12, ['patron:p1']);
    await settle();
    expect(p2.values.at(-1)).toEqual({ count: 1, fields: {} });
    expect(seq(r.data(), 'patron:p2')).toBe(1);

    // the land takes p2 with it
    r.server.blobs.set('patron:p1', one('patron:p1', 11, 5));
    gap.go();
    await settle();
    expect(p2.values.at(-1)).toBeUndefined();
    expect(keys(r.data(), 'patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
  });

  test('P8: a birth parked during a freeze goes with a revoke of its slice at the land, and never shows', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': one('patron:p1', 10, 2) });
    const p2 = watch(r, 'patron:p2');

    // a gap on p1 freezes the base, and p2 is born in the same frame, parked under no backfill
    const gap = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11), named('patron:p2', 1, 11, 'Bo'));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park-edit:patron:p2!')).toEqual([parkedEdit('patron:p2', 1)]);

    // the view narrows to p1 while frozen, so p2's parked birth waits for the land
    r.server.view('t2', 12, ['patron:p1']);
    await settle();
    expect(keys(r.data(), '!park-edit:patron:p2!')).toEqual([parkedEdit('patron:p2', 1)]);

    // p1's backfill lands, the land drops p2, and p2 never appears
    r.server.blobs.set('patron:p1', one('patron:p1', 11, 5));
    gap.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), 'patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(p2.values.every((v) => v === undefined)).toBe(true);
  });

  test('P8: after the boot purge, nothing of a slice the build does not want remains, parked or applied', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*', 'book:*'], {
      'patron:*': patrons,
      'book:*': { position: 10, seqs: {}, values: [] },
    });

    // a gap on p1 freezes the base, and b9 is born in the same frame, parked under no backfill
    r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11), named('book:b9', 1, 11, 'Dune'));
    await settle();
    expect(seq(r.data(), 'book:b9')).toBeUndefined();
    expect(keys(r.data(), '!park-edit:book:b9!')).toEqual([parkedEdit('book:b9', 1)]);

    // a build that wants patrons alone boots over the store, and lands p1's backfill
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron:p1', one('patron:p1', 11, 5));
    const r2 = rig({ store: r.store, server, wants: ['patron:*'] });
    await settle();
    expect(state(r2.data(), 'patron:p1')).toEqual({ count: 5, fields: {} });
    expect(keys(r2.data(), '!backfill')).toEqual([]);
    expect(keys(r2.data(), '!park')).toEqual([]);
    expect(keys(r2.data(), 'book:b9!')).toEqual([]);
    expect(seq(r2.data(), 'book:b9')).toBeUndefined();
    expect(view(r2)?.selectors).toEqual(['patron:*']);
  });

  test("P8: a revoke and a regrant of one selector refuse the old download's late pushes and outcome", async () => {
    const r = await held();
    const calls = r.server.drive('book:b1');
    r.server.view('t2', 11, ['patron:*', 'book:b1']);
    await settle();
    const old = calls[0];
    await old.backfill.push({
      header: { position: 11, seqs: { 'book:b1': 1, 'visible': 11 }, visible: 11 },
    });

    // the old call's next push is queued as the revoke and the regrant arrive, then it fails
    let refused: unknown = null;
    const late = old.backfill.push({ pagesDone: true }).catch((e: unknown) => {
      refused = e;
    });
    r.server.view('t3', 12, ['patron:*']);
    r.server.view('t4', 13, ['patron:*', 'book:b1']);
    await settle();
    await late;
    expect(refused).toBeInstanceOf(Error);
    old.fail(new Error('aborted'));
    await settle();
    expect(calls.length).toBe(2);
    expect(record(r, 'book:b1')).toEqual({ until: 14, resume: null });

    // the new download alone lands, after no retry of the old one
    const fresh = calls[1].backfill;
    await fresh.push({
      header: { position: 13, seqs: { 'book:b1': 2, 'visible': 13 }, visible: 13 },
    });
    await fresh.push({
      page: page([['book:b1!state', { count: 2, fields: {} }]]),
      skip: 1,
      checksum: 'c',
    });
    await fresh.push({ pagesDone: true });
    await fresh.push({ editsDone: true });
    calls[1].done('done');
    r.server.vouch(13);
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 2, fields: {} });
    expect(calls.length).toBe(2);
  });

  test("P8: a revoke mid-download drops the backfill's header, pages, and parked edits, and refuses its late pushes", async () => {
    const r = await held();
    const calls = r.server.drive('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();

    // the header and a page arrive, and a live edit of b1 parks under the family
    const call = calls[0].backfill;
    await call.push({
      header: { position: 11, seqs: { 'book:b1': 1, 'visible': 11 }, visible: 11 },
    });
    await call.push({
      page: page([['book:b1!state', { count: 1, fields: {} }]]),
      skip: 1,
      checksum: 'c',
    });
    r.server.edits(ev('book:b1', 2, 12));
    await settle();
    expect(keys(r.data(), '!park-snap:book:*!').length).toBe(1);
    expect(keys(r.data(), '!park-edit:book:b1!')).toEqual([parkedEdit('book:b1', 2)]);

    // the books are revoked
    r.server.view('t3', 13, ['patron:*']);
    await settle();
    expect(call.signal.aborted).toBe(true);
    await expect(call.push({ pagesDone: true })).rejects.toThrow();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), 'book:')).toEqual([]);
    expect(seq(r.data(), 'book:b1')).toBeUndefined();
  });
});

describe('P9: a view frame backfills exactly what it newly grants', () => {
  test('P9: frozen, a slice revoked and then granted again by its exact selector is backfilled afresh', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');
    const gap = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();

    // p1 is revoked, its drop waiting for the land, and granted again; meanwhile it moved to seq 3
    r.server.blobs.set('patron:p1', one('patron:p1', 13, 3));
    r.server.view('t2', 12, ['patron:p2']);
    r.server.view('t3', 13, ['patron:p2', 'patron:p1']);
    r.server.vouch(13);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual([
      'patron:*',
      'patron:p2',
      'patron:p1',
    ]);

    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    gap.go();
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
  });

  test('P9: a view frame in a resync backfills only its new grant, through its position, and the replay waits for it', async () => {
    const r = rig({ seed: resumed });
    await settle();
    const books = r.server.hold('book:*');
    r.server.open('e1', 30);
    r.server.view('t2', 30, ['patron:*', 'book:*']);
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.live(30);
    await settle();
    expect(r.server.backfills).toEqual([{ selector: 'book:*', until: 31, resume: null }]);
    expect(view(r)).toEqual({ token: 't2', position: 30, selectors: ['patron:*', 'book:*'] });
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(keys(r.data(), '!park-edit:')).toEqual([parkedEdit('patron:p1', 3)]);

    r.server.blobs.set('book:*', one('book:b1', 30, 4));
    books.go();
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 4, fields: {} });
  });

  test('P9: a grant covering an in-flight exact backfill starts its own beside it, and the next connect presents its token', async () => {
    const r = rig();
    r.server.hold('book:b1');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['book:b1']);
    await settle();
    r.server.hold('book:*');
    r.server.view('t2', 12, ['book:*']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['book:b1', 'book:*']);
    expect(record(r, 'book:b1')).toEqual({ until: 11, resume: null });
    expect(record(r, 'book:*')).toEqual({ until: 13, resume: null });

    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.view).toBe('t2');
    expect(r.server.conn.since).toBe(10);
  });

  test('P9: a selector the same frame covers twice, or an in-flight backfill already covers, gets no backfill of its own', async () => {
    const r = rig();
    r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:p1', 'patron:*']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*']);
    r.server.view('t2', 11, ['patron:*', 'patron:p2']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*']);
  });

  test('P9: narrowing to a held member backfills nothing, and regranting the family downloads it again with the member kept', async () => {
    const r = await held();
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.view('t2', 12, ['patron:p1']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*']);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(seq(r.data(), 'patron:p1')).toBe(3);

    // the blob is cut below p1's held seq, so p1 keeps its state
    r.server.blobs.set('patron:*', patrons);
    r.server.view('t3', 13, ['patron:*']);
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'patron:*', until: 14, resume: null });
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });
});
