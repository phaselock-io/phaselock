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

/* Also: view.test.ts 'removing a selector drops per slice...'; backfill.test.ts 'a revoke of an
   in-flight selector aborts it...'; freeze.test.ts 'a revoke while frozen leaves queries at
   once...'.  The database's half is server_test.go's
   TestAViewFrameLeadsTheEditsItGrantsIntoStreaming. */
describe('P8: after a view frame, nothing of a slice outside the view remains', () => {
  test('P8: a birth parked during a freeze goes with the revoke of its slice, and never shows', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], { 'patron:*': one('patron:p1', 10, 2) });
    const p2 = watch(r, 'patron:p2');

    // a gap on p1 freezes the base, and p2 is born in the same frame, parked under no backfill
    const gap = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 5, 11), named('patron:p2', 1, 11, 'Bo'));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe('backfill');
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([parkedEdit('patron:p2', 1)]);

    // the view narrows to p1, which takes p2's parked birth with it
    r.server.view('t2', 12, ['patron:p1']);
    await settle();
    expect(keys(r.data(), '!park-ed:patron:p2!')).toEqual([]);
    expect(seq(r.data(), 'patron:p2')).toBeUndefined();

    // p1's backfill lands and unfreezes the base, and p2 never appears
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
    expect(keys(r.data(), '!park-ed:book:b9!')).toEqual([parkedEdit('book:b9', 1)]);

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

  test("P8: a revoke mid-download drops the backfill's header, pages, and parked edits, and refuses its late pushes", async () => {
    const r = await held();
    const calls = r.server.drive('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();

    // the header and a page arrive, and a live edit of b1 parks under the family
    const call = calls[0].backfill;
    await call.push({ header: { position: 11, seqs: { 'book:b1': 1 } } });
    await call.push({
      page: page([['book:b1!state', { count: 1, fields: {} }]]),
      skip: 1,
      checksum: 'c',
    });
    r.server.edits(ev('book:b1', 2, 12));
    await settle();
    expect(keys(r.data(), '!park-snap:book:*!').length).toBe(1);
    expect(keys(r.data(), '!park-ed:book:b1!')).toEqual([parkedEdit('book:b1', 2)]);

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

/* also: view.test.ts 'a grant covered by another selector in the same set...', 'a grant of a
   selector that already has an in-flight entry is a no-op', 'a held family covered by a wider
   in-flight selector and narrowed back to...'; backfill.test.ts 'a grant writes its record...' and
   "the first view's grants are replacing..." */
describe('P9: a view frame backfills exactly what it newly grants', () => {
  test('P9: a view frame in a resync backfills only its new grant, additively and through its position, while the replay goes on', async () => {
    const r = rig({ seed: resumed });
    await settle();
    const books = r.server.hold('book:*');
    r.server.open('e1', 30);
    r.server.view('t2', 30, ['patron:*', 'book:*']);
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.live(30);
    await settle();
    expect(r.server.backfills).toEqual([{ selector: 'book:*', until: 31, resume: null }]);
    expect(record(r, 'book:*')?.replacing).toBe(false);
    expect(view(r)).toEqual({ token: 't2', position: 30, selectors: ['patron:*', 'book:*'] });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    books.go();
  });

  test('P9: a widening frame adopts the exact backfill it covers, and the next connect presents its token', async () => {
    const r = await held();
    r.server.hold('book:b1');
    r.server.edits(ev('book:b1', 3, 11));
    await settle();
    r.server.hold('book:*');
    r.server.view('t2', 12, ['patron:*', 'book:*']);
    await settle();
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'book:b1', 'book:*']);
    expect(record(r, 'book:*')).toMatchObject({
      until: 13,
      replacing: false,
      children: ['book:b1'],
    });

    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.view).toBe('t2');
    expect(r.server.conn.since).toBe(11);
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
