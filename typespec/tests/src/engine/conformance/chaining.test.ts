// Conformance, chaining: P1 to P5 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  death,
  ev,
  keys,
  log,
  parkedEdit,
  rig,
  seq,
  settle,
  state,
  watch,
  watchStatus,
} from '../harness.ts';

import { held, named, one, patrons, record, resumed, set } from './common.ts';

// also: routing.test.ts 'a held slice applies the next seq...' and 'a duplicate edit is ignored'
describe('P1: a normal edit applies only at the held seq plus one', () => {
  test('P1: a replay that repeats applied edits changes nothing, and the next seq applies', async () => {
    const r = await held();
    r.server.edits(set('patron:p1', 3, 11, 'a', 1));
    r.server.edits(set('patron:p1', 4, 12, 'b', 2));
    await settle();

    // a reconnect whose replay repeats position 12 with different writes
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    r.server.open();
    r.server.edits(set('patron:p1', 4, 12, 'b', 99));
    r.server.edits(ev('patron:p1', 5, 13));
    r.server.live(13);
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['set a=1', 'set b=2', 'bump']);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: { a: 1, b: 2 } });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
  });

  test('P1: an edit two past the held seq waits for the seq a blob gives, and repeats below it change nothing', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');

    // the server's seq 3 at 11 never reached the client, and seq 4 at 12 does
    const gap = r.server.hold('patron:p1');
    r.server.edits(set('patron:p1', 4, 12, 'a', 4));
    await settle();
    expect(r.server.backfills.at(-1)).toMatchObject({ selector: 'patron:p1', until: 12 });
    expect(keys(r.data(), '!park-ed:')).toEqual([parkedEdit('patron:p1', 4)]);

    // the blob gives seq 3, and the parked seq 4 chains from it
    r.server.blobs.set('patron:p1', one('patron:p1', 11, 3));
    gap.go();
    await settle();
    expect(p1.values).toEqual([
      { count: 2, fields: {} },
      { count: 3, fields: { a: 4 } },
    ]);

    // seqs 3 and 4 again change nothing; seq 5 applies
    r.server.edits(ev('patron:p1', 3, 11), set('patron:p1', 4, 12, 'a', 99));
    r.server.edits(ev('patron:p1', 5, 13));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 4, fields: { a: 4 } });
    expect(seq(r.data(), 'patron:p1')).toBe(5);
  });
});

// also: resets.test.ts 'resets on the live slice' and 'resets at a land'
describe('P2: a reset applies at any seq above the held one, and nothing before it survives', () => {
  test('P2: among frozen edits, a gap that a later birth mends lands from the birth alone, with no backfill of its own', async () => {
    const r = await held();

    // a gap on p2 freezes the base
    const freeze = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();

    // p1's frozen run gaps at 5, dies, and is born again
    r.server.edits(set('patron:p1', 5, 12, 'stale', 1));
    r.server.edits(death('patron:p1', 6, 13));
    r.server.edits(named('patron:p1', 7, 14, 'Al'));
    r.server.edits(ev('patron:p1', 8, 15));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });

    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    freeze.go();
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['set name=Al', 'bump']);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 1, fields: { name: 'Al' } });
    expect(seq(r.data(), 'patron:p1')).toBe(8);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'patron:p2']);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test('P2: a tail whose run gaps and then resets lands from the reset, with no child', async () => {
    const r = await held();
    r.server.blobs.set('book:*', {
      ...one('book:b1', 11, 2),
      tail: [
        ev('book:b1', 5, 12, { type: 'boom' }),
        death('book:b1', 6, 13),
        named('book:b1', 7, 14, 'Dune'),
        ev('book:b1', 8, 15),
      ],
    });
    r.server.view('t2', 20, ['patron:*', 'book:*']);
    await settle();
    expect(r.server.tails.at(-1)).toEqual({ selector: 'book:*', after: 11, before: 21 });
    expect(log(r.data(), 'book:b1')).toEqual(['set name=Dune', 'bump']);
    expect(state(r.data(), 'book:b1')).toEqual({ count: 1, fields: { name: 'Dune' } });
    expect(seq(r.data(), 'book:b1')).toBe(8);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'book:*']);
  });
});

/* also: routing.test.ts 'gap detection'; grants.test.ts 'a gap on a held slice under an in-flight
   additive selector...'; backfill.test.ts 'a slice born under an in-flight selector parks...' */
describe('P3: an edit that does not chain parks, and its slice is backfilled', () => {
  test('P3: a gap in a resync replay parks its slice from the gap on, and the tail fills what retention dropped', async () => {
    const r = rig({ seed: resumed });
    const p1 = watch(r, 'patron:p1');
    await settle();

    // the server pruned p1's seqs 3 and 4, so the replay brings seq 5 first
    const gap = r.server.hold('patron:p1');
    r.server.open('e1', 14);
    r.server.edits(set('patron:p1', 5, 13, 'a', 5));
    r.server.edits(ev('patron:p1', 6, 14), ev('patron:p2', 2, 14));
    r.server.live(14);
    await settle();
    expect(r.server.backfills).toEqual([{ selector: 'patron:p1', until: 13, resume: null }]);
    expect(record(r, 'patron:p1')?.replacing).toBe(true);
    expect(keys(r.data(), '!park-ed:')).toEqual([
      parkedEdit('patron:p1', 5),
      parkedEdit('patron:p1', 6),
      parkedEdit('patron:p2', 2),
    ]);

    // the blob is cut at 11, and its tail brings seq 4
    r.server.blobs.set('patron:p1', {
      ...one('patron:p1', 11, 3),
      tail: [set('patron:p1', 4, 12, 'b', 4)],
    });
    gap.go();
    await settle();
    expect(r.server.tails).toEqual([{ selector: 'patron:p1', after: 11, before: 13 }]);
    expect(p1.values).toEqual([
      { count: 2, fields: {} },
      { count: 4, fields: { b: 4, a: 5 } },
    ]);
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
  });

  test('P3: a missed birth backfills its slice additively, and the base keeps moving meanwhile', async () => {
    const r = await held();
    const p1 = watch(r, 'patron:p1');
    const status = watchStatus(r);
    const missed = r.server.hold('book:b1');
    r.server.edits(ev('book:b1', 3, 11));
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'book:b1', until: 11, resume: null });
    expect(record(r, 'book:b1')?.replacing).toBe(false);
    expect(status.connection.at(-1)?.frozen).toBe(false);

    // p1 applies while book:b1 downloads
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 3, fields: {} });
    expect(state(r.data(), 'book:b1')).toBeUndefined();

    r.server.blobs.set('book:b1', one('book:b1', 10, 2));
    missed.go();
    await settle();
    expect(state(r.data(), 'book:b1')).toEqual({ count: 3, fields: {} });
    expect(seq(r.data(), 'book:b1')).toBe(3);
  });

  test('P3: an edit of a slice an in-flight family covers parks, a birth included, with no backfill of its own', async () => {
    const r = await held();
    const b2 = watch(r, 'book:b2');
    const books = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    r.server.edits(named('book:b2', 1, 12, 'Emma'));
    r.server.edits(ev('book:b2', 2, 13));
    await settle();
    expect(keys(r.data(), '!park-ed:')).toEqual([
      parkedEdit('book:b2', 1),
      parkedEdit('book:b2', 2),
    ]);
    expect(seq(r.data(), 'book:b2')).toBe('backfill');
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'book:*']);

    r.server.blobs.set('book:*', { position: 11, seqs: {}, values: [] });
    books.go();
    await settle();
    expect(b2.values.filter((v) => v !== undefined)).toEqual([
      { count: 1, fields: { name: 'Emma' } },
    ]);
    expect(seq(r.data(), 'book:b2')).toBe(2);
  });
});

/* also: landing.test.ts 'a broken selector spawns its child before any write...', 'a break among
   the frozen edits...', and "an exact selector's own break restarts it..."; grants.test.ts 'the
   chain base is the newest state in place...' */
describe('P4: a parked run applies only if it continues the state put in place', () => {
  test('P4: a member whose parked run gaps applies none of it, and is backfilled alone with until the checkpoint', async () => {
    const r = await held();
    const b1 = watch(r, 'book:b1');
    const books = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();

    // b1's seqs 3 and 4 never reach the client
    r.server.edits(ev('book:b1', 5, 13), ev('book:b2', 2, 13));
    r.server.vouch(14);
    await settle();

    // the family's blob holds b1 at 2, so its run breaks
    const child = r.server.hold('book:b1');
    r.server.blobs.set('book:*', {
      position: 11,
      seqs: { 'book:b1': 2, 'book:b2': 1 },
      values: [
        ['book:b1!state', { count: 2, fields: {} }],
        ['book:b2!state', { count: 1, fields: {} }],
      ],
    });
    books.go();
    await settle();
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'book:b1', until: 14, resume: null });
    expect(record(r, 'book:*')?.children).toEqual(['book:b1']);
    expect(b1.values.every((v) => v === undefined)).toBe(true);
    expect(keys(r.data(), 'book:b1!')).toEqual([]);

    // the child's blob covers seq 5, and the subtree lands
    r.server.blobs.set('book:b1', one('book:b1', 14, 5));
    child.go();
    await settle();
    expect(b1.values.filter((v) => v !== undefined)).toEqual([{ count: 5, fields: {} }]);
    expect(state(r.data(), 'book:b2')).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(keys(r.data(), '!backfill')).toEqual([]);
  });

  test('P4: tail edits a held slice already applied are covered by its newer held seq', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    await settle();
    r.server.blobs.set('patron:p1', one('patron:p1', 10, 2));
    r.server.open();
    r.server.view('t1', 10, ['patron:p1']);
    r.server.live(10);
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.edits(ev('patron:p1', 4, 12));
    await settle();

    // a widening family, cut below what p1 holds, tails p1's seqs 3 and 4 again
    r.server.blobs.set('patron:*', {
      ...patrons,
      tail: [ev('patron:p1', 3, 11), ev('patron:p1', 4, 12), ev('patron:p2', 2, 12)],
    });
    r.server.view('t2', 13, ['patron:*']);
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(log(r.data(), 'patron:p1')).toEqual(['bump', 'bump']);
    expect(p1.values.at(-1)).toEqual({ count: 4, fields: {} });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });

    r.server.edits(ev('patron:p1', 5, 14));
    await settle();
    expect(seq(r.data(), 'patron:p1')).toBe(5);
  });
});

// also: resets.test.ts 'a slice the blob does not name...' tests
describe('P5: a slice no landing blob names was deleted or unborn at the cut', () => {
  test('P5: a slice deleted at the cut is not held, so no state the client shows is one the server never had', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();

    // p1 is born live while the bootstrap downloads, and parks under it
    r.server.edits(named('patron:p1', 1, 11, 'Ann'));
    await settle();
    expect(keys(r.data(), '!park-ed:patron:p1!')).toEqual([parkedEdit('patron:p1', 1)]);

    // the blob is cut after p1's death at 13, so its header does not name p1
    r.server.blobs.set('patron:*', { position: 13, seqs: {}, values: [] });
    boot.go();
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();

    // p1's next edit, in flight on the connection, finds p1 unknown and backfills it
    const missed = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 2, 12));
    await settle();
    expect(r.server.backfills.at(-1)).toMatchObject({ selector: 'patron:p1', until: 12 });
    expect(keys(r.data(), 'patron:p1!')).toEqual([]);

    // the death arrives, and the backfill's blob agrees that p1 is gone
    r.server.edits(death('patron:p1', 3, 13));
    r.server.blobs.set('patron:p1', { position: 13, seqs: {}, values: [] });
    missed.go();
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(seq(r.data(), 'patron:p1')).toBeUndefined();
    expect(p1.values.length).toBeGreaterThan(0);
    expect(p1.values.every((v) => v === undefined)).toBe(true);
  });

  test('P5: a slice no blob names is held from a birth above the cut, and nothing at or below the cut applies', async () => {
    const r = await held();
    const books = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();

    // b3 lives, dies at 15, and is born again at 25; the blob is cut at 20
    r.server.edits(set('book:b3', 7, 12, 'stale', 1));
    r.server.edits(death('book:b3', 8, 15));
    r.server.edits(named('book:b3', 9, 25, 'Emma'));
    r.server.edits(ev('book:b3', 10, 26));
    await settle();
    r.server.blobs.set('book:*', { position: 20, seqs: {}, values: [] });
    books.go();
    await settle();
    expect(log(r.data(), 'book:b3')).toEqual(['set name=Emma', 'bump']);
    expect(state(r.data(), 'book:b3')).toEqual({ count: 1, fields: { name: 'Emma' } });
    expect(seq(r.data(), 'book:b3')).toBe(10);
    expect(r.server.backfills.map((b) => b.selector)).toEqual(['patron:*', 'book:*']);
    expect(keys(r.data(), '!park')).toEqual([]);
  });
});
