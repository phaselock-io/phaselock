// TESTS.md: Event routing, Gap detection

import { describe, expect, test } from 'vitest';

import {
  birth,
  type Blob,
  bootstrap,
  checkpoint,
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

describe('event routing', () => {
  test('a held stream reduces the next seq and /seq. advances in the same transaction', async () => {
    const r = await held();
    r.server.events(ev('patron.p1', 3, 11, { type: 'set', field: 'a', value: 1 }));
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual(['set a=1']);
    expect(seq(r.data, 'patron.p1')).toBe(3);
    expect(checkpoint(r.data)?.position).toBe(11);
  });

  test('a stream under an in-flight ref parks, and parking the same event twice leaves one key', async () => {
    const r = await held();
    const hold = r.server.hold('book.*');
    r.server.blobs.set('book.*', { position: 10, seqs: {}, values: [] });
    r.server.view('t2', 11, ['patron.*', 'book.*']);
    await settle();
    r.server.events(ev('book.b1', 4, 12));
    r.server.events(ev('book.b1', 4, 12));
    await settle();
    expect(keys(r.data, '/park.ev.')).toEqual([parkedEvent('book.b1', 4)]);
    expect(seq(r.data, 'book.b1')).toBe('backfill');
    expect(state(r.data, 'book.b1')).toBeUndefined();
    hold.go();
  });

  test('a birth on an unknown stream creates its /seq. and reaches no reducer', async () => {
    const r = await held();
    r.server.events(birth('patron.p3', 1, 11));
    await settle();
    expect(seq(r.data, 'patron.p3')).toBe(1);
    expect(log(r.data, 'patron.p3')).toEqual([]);
    expect(keys(r.data, '/backfill')).toEqual([]);
  });

  test('a death drops the prefix and keeps /seq.; a rebirth chains from it', async () => {
    const r = await held();
    r.server.events(death('patron.p1', 3, 11));
    await settle();
    expect(state(r.data, 'patron.p1')).toBeUndefined();
    expect(keys(r.data, 'patron.p1/')).toEqual([]);
    expect(seq(r.data, 'patron.p1')).toBe(3);
    r.server.events(birth('patron.p1', 4, 12), ev('patron.p1', 5, 12));
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe(5);
    expect(log(r.data, 'patron.p1')).toEqual(['bump']);
    expect(keys(r.data, '/backfill')).toEqual([]);
  });

  test('a non-birth on an unknown stream under no ref starts an exact backfill at its position and parks', async () => {
    const r = await held();
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    expect(r.server.backfills.at(-1)).toMatchObject({ ref: 'patron.p9', until: 11, resume: null });
    expect((r.data['/backfill.patron.p9'] as { replacing: boolean }).replacing).toBe(false);
    expect(seq(r.data, 'patron.p9')).toBe('backfill');
    expect(keys(r.data, '/park.ev.')).toEqual([parkedEvent('patron.p9', 7)]);
  });

  test('/checkpoint advances past parked events; a vouch advances it without reducing', async () => {
    const r = await held();
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    expect(checkpoint(r.data)?.position).toBe(11);
    r.server.vouch(20);
    await settle();
    expect(checkpoint(r.data)?.position).toBe(20);
    expect(log(r.data, 'patron.p1')).toEqual([]);
  });

  test('$sys events never reach the reducer', async () => {
    const r = await held();
    r.server.events(birth('patron.p3', 1, 11), ev('patron.p3', 2, 11), death('patron.p3', 3, 12));
    await settle();
    expect(log(r.data, 'patron.p3')).toEqual([]);
    expect(seq(r.data, 'patron.p3')).toBe(3);
  });

  test('one atom is one transaction: a run per stream, one /seq. write, the last position', async () => {
    const r = await held();
    r.server.events(
      ev('patron.p1', 3, 11, { type: 'set', field: 'a', value: 1 }),
      ev('patron.p2', 2, 11),
      ev('patron.p1', 4, 11, { type: 'set', field: 'b', value: 2 }),
    );
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual(['set a=1', 'set b=2']);
    expect(log(r.data, 'patron.p2')).toEqual(['bump']);
    expect(seq(r.data, 'patron.p1')).toBe(4);
    expect(seq(r.data, 'patron.p2')).toBe(2);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 11, reduced: 11 });
  });

  test('a gap mid-atom: events before it reduce, the gap and everything after park, marker written', async () => {
    const r = await held();
    r.server.hold('patron.p1');
    r.server.events(
      ev('patron.p1', 3, 11),
      ev('patron.p2', 2, 11),
      ev('patron.p1', 9, 12),
      ev('patron.p2', 3, 12),
    );
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual(['bump']);
    expect(log(r.data, 'patron.p2')).toEqual(['bump']);
    expect(seq(r.data, 'patron.p1')).toBe('backfill');
    expect(seq(r.data, 'patron.p2')).toBe(2);
    expect(keys(r.data, '/park.ev.')).toEqual([
      parkedEvent('patron.p1', 9),
      parkedEvent('patron.p2', 3),
    ]);
    expect(r.server.backfills.at(-1)).toMatchObject({ ref: 'patron.p1', until: 12 });
    expect((r.data['/backfill.patron.p1'] as { replacing: boolean }).replacing).toBe(true);
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 12, reduced: 11 });
  });

  test('while frozen an unknown birth parks and lands with the frozen events; an unknown non-birth starts an additive backfill', async () => {
    const r = await held();
    const gap = r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 9, 11));
    await settle();
    r.server.hold('book.b1');
    r.server.events(birth('patron.p3', 1, 12), ev('patron.p3', 2, 12), ev('book.b1', 5, 13));
    await settle();
    expect(seq(r.data, 'patron.p3')).toBeUndefined();
    expect(keys(r.data, '/park.ev.patron.p3/')).toEqual([
      parkedEvent('patron.p3', 1),
      parkedEvent('patron.p3', 2),
    ]);
    expect((r.data['/backfill.book.b1'] as { replacing: boolean }).replacing).toBe(false);
    expect(seq(r.data, 'book.b1')).toBe('backfill');
    // the gap's backfill lands and unfreezes; p3 lands from its parked birth
    r.server.blobs.set('patron.p1', {
      position: 11,
      seqs: { 'patron.p1': 9 },
      values: [['patron.p1/state', { count: 9, fields: {} }]],
    });
    gap.go();
    await settle();
    expect(seq(r.data, 'patron.p1')).toBe(9);
    expect(seq(r.data, 'patron.p3')).toBe(2);
    expect(log(r.data, 'patron.p3')).toEqual(['bump']);
    expect(keys(r.data, '/park.ev.patron.')).toEqual([]);
    expect(seq(r.data, 'book.b1')).toBe('backfill');
    expect(keys(r.data, '/park.ev.book.')).toEqual([parkedEvent('book.b1', 5)]);
  });

  test('end drops the connector, fails in-flight backfills through their outcome, and the next connection restarts them', async () => {
    const r = await held();
    r.server.hold('patron.p9');
    r.server.events(ev('patron.p9', 7, 11));
    await settle();
    expect(r.server.backfills.length).toBe(2);
    r.server.end(0, 'closed');
    await settle();
    expect(r.server.conns.length).toBe(1);
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(r.server.conn.since).toBe(11);
    expect(r.server.conn.view).toBe('t1');
    // restarted on the new connection with its resume intact, no backoff
    expect(r.server.backfills.length).toBe(3);
    expect(r.server.backfills.at(-1)?.ref).toBe('patron.p9');
  });
});

describe('gap detection', () => {
  test('a seq jump on a held stream starts a replacing backfill at the event position and parks it', async () => {
    const r = await held();
    r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 5, 11));
    await settle();
    expect(r.server.backfills.at(-1)).toMatchObject({ ref: 'patron.p1', until: 11, resume: null });
    expect((r.data['/backfill.patron.p1'] as { replacing: boolean }).replacing).toBe(true);
    expect(keys(r.data, '/park.ev.')).toEqual([parkedEvent('patron.p1', 5)]);
    expect(log(r.data, 'patron.p1')).toEqual([]);
  });

  test('a seq jump on a stream inside an in-flight family parks, and the family spawns the child at land', async () => {
    const r = rig();
    await settle();
    r.server.open();
    const hold = r.server.hold('patron.*');
    r.server.blobs.set('patron.*', {
      position: 10,
      seqs: { 'patron.p1': 2 },
      values: [['patron.p1/state', { count: 2, fields: {} }]],
    });
    r.server.view('t1', 10, ['patron.*']);
    r.server.live(10);
    await settle();
    // a jump on a member while the family downloads: parked, no sibling
    r.server.events(ev('patron.p1', 7, 11));
    await settle();
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*']);
    expect(keys(r.data, '/park.ev.')).toEqual([parkedEvent('patron.p1', 7)]);
    r.server.hold('patron.p1');
    hold.go();
    await settle();
    // the land finds the break and spawns the child, replacing like its parent
    expect(r.server.backfills.map((b) => b.ref)).toEqual(['patron.*', 'patron.p1']);
    expect(r.data['/backfill.patron.p1']).toMatchObject({ replacing: true, until: 11 });
    expect((r.data['/backfill.patron.*'] as { children: string[] }).children).toEqual([
      'patron.p1',
    ]);
  });

  test('a seq jump on a stream under an in-flight exact ref does not spawn a second backfill', async () => {
    const r = await held();
    r.server.hold('patron.p1');
    r.server.events(ev('patron.p1', 5, 11));
    r.server.events(ev('patron.p1', 9, 12));
    await settle();
    expect(r.server.backfills.filter((b) => b.ref === 'patron.p1').length).toBe(1);
    expect(keys(r.data, '/park.ev.')).toEqual([
      parkedEvent('patron.p1', 5),
      parkedEvent('patron.p1', 9),
    ]);
  });

  test('a duplicate event is ignored', async () => {
    const r = await held();
    r.server.events(ev('patron.p1', 2, 11), ev('patron.p1', 1, 11));
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual([]);
    expect(seq(r.data, 'patron.p1')).toBe(2);
    expect(keys(r.data, '/backfill')).toEqual([]);
  });
});
