// Conformance, the cursor: P11 to P14 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import {
  checkpoint,
  ev,
  keys,
  predict,
  type Predictor,
  type Rig,
  rig,
  seq,
  settle,
  state,
  watch,
} from '../harness.ts';

import { held, one, patrons, restart, resumed, set } from './common.ts';

/** predicts a mutation's set of a field on its slice */
const predictor: Predictor = (txn, mutation) => {
  const m = mutation as { slice: string; field: string; value: unknown };
  const id = m.slice.slice(m.slice.indexOf(':') + 1);
  predict(txn, m.slice, { id, type: 'set', field: m.field, value: m.value });
};

/** the database answers every mutation ok at position */
function okAt(r: Rig, position: number): void {
  r.server.onSend = (mutations) =>
    Promise.resolve(mutations.map(() => ({ kind: 'ok' as const, position })));
}

/** the id of the last mutation sent */
const lastId = (r: Rig): string => r.server.sends.at(-1)![0].id;

// the database's half is server_test.go's TestAVouchNeverOvertakesAnEditItCovers
describe('P11: the cursor is the highest position received, and every connect presents it', () => {
  test('P11: edits, vouches, and live frames move the cursor forward only, and the next connect presents it', async () => {
    const r = await held();
    r.server.edits(ev('patron:p1', 3, 12));
    await settle();
    expect(checkpoint(r.data())?.position).toBe(12);
    r.server.vouch(15);
    r.server.vouch(13);
    await settle();
    expect(checkpoint(r.data())?.position).toBe(15);

    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.since).toBe(15);
    r.server.open();
    r.server.live(14);
    await settle();
    expect(checkpoint(r.data())?.position).toBe(15);
  });

  test('P11: a restart reconnects from the cursor the last committed frame left', async () => {
    const r = await held();
    r.server.edits(ev('patron:p1', 3, 12));
    r.server.vouch(14);
    await settle();
    const r2 = await restart(r);
    expect(r2.server.conn.since).toBe(14);
    expect(r2.server.conn.view).toBe('t1');
    expect(seq(r2.data(), 'patron:p1')).toBe(3);
  });
});

// also: outbox.test.ts 'the applied position is persisted and restored on boot mid-freeze'
describe('P12: the cursor never skips an edit', () => {
  test('P12: edits parked by a freeze survive a restart, and the reconnect past them loses none', async () => {
    const r = await held();
    r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    r.server.edits(set('patron:p1', 3, 12, 'a', 1));
    r.server.vouch(13);
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 13, applied: 10 });

    const r2 = await restart(r, { 'patron:p2': one('patron:p2', 11, 9) });
    expect(r2.server.conn.since).toBe(13);
    r2.server.open();
    r2.server.live(13);
    await settle();
    expect(state(r2.data(), 'patron:p1')).toEqual({ count: 2, fields: { a: 1 } });
    expect(state(r2.data(), 'patron:p2')).toEqual({ count: 9, fields: {} });
    expect(checkpoint(r2.data())).toEqual({ epoch: 'e1', position: 13, applied: 13 });
  });

  test("P12: a reconnect while a missed birth's backfill downloads loses none of the slice's edits", async () => {
    const r = await held();
    const missed = r.server.hold('patron:p9');
    r.server.edits(ev('patron:p9', 3, 11));
    r.server.edits(ev('patron:p9', 4, 12));
    r.server.vouch(12);
    await settle();

    // the connection drops; the next one replays from 12 and restarts the backfill
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conn.since).toBe(12);
    expect(r.server.backfills.at(-1)).toEqual({ selector: 'patron:p9', until: 11, resume: null });
    r.server.open();
    r.server.edits(ev('patron:p9', 5, 13));
    r.server.live(13);
    r.server.blobs.set('patron:p9', one('patron:p9', 10, 2));
    missed.go();
    await settle();
    expect(state(r.data(), 'patron:p9')).toEqual({ count: 5, fields: {} });
    expect(seq(r.data(), 'patron:p9')).toBe(5);
    expect(keys(r.data(), '!park')).toEqual([]);
  });
});

/* also: outbox.test.ts 'an ok releases once the applied position reaches it...', 'an edit carrying
   the mutation id releases it when applied...', and the group 'the applied position' */
describe('P13: an acked mutation leaves the outbox only once queries can show its outcome', () => {
  test('P13: an ok for a mutation whose edits the client cannot see keeps its prediction until a vouch reaches it', async () => {
    const r = await held({ predictor });
    const p1 = watch(r, 'patron:p1');
    okAt(r, 15);
    r.engine.sendMutation({ slice: 'patron:p1', field: 'x', value: 1 });
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { x: 1 } });
    r.server.vouch(14);
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { x: 1 } });
    expect(keys(r.data(), '!mutation:').length).toBe(1);

    r.server.vouch(15);
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), '!mutation:')).toEqual([]);
  });

  test('P13: an ok whose edit parks in a freeze keeps its prediction through vouches until the land shows the edit', async () => {
    const r = await held({ predictor });
    const p1 = watch(r, 'patron:p1');
    const freeze = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();
    okAt(r, 12);
    r.engine.sendMutation({ slice: 'patron:p1', field: 'x', value: 1 });
    await settle();
    r.server.edits(set('patron:p1', 3, 12, 'x', 1, lastId(r)));
    r.server.vouch(13);
    await settle();
    expect(keys(r.data(), '!mutation:').length).toBe(1);

    r.server.blobs.set('patron:p2', one('patron:p2', 11, 9));
    freeze.go();
    await settle();
    expect(keys(r.data(), '!mutation:')).toEqual([]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: { x: 1 } });
    const shown = p1.values.findIndex((v) => v?.fields.x === 1);
    expect(shown).toBeGreaterThan(0);
    expect(p1.values.slice(shown).every((v) => v?.fields.x === 1)).toBe(true);
  });

  test("P13: an ok whose edit parks under a grant's backfill keeps its prediction through a vouch until the edit lands", async () => {
    const r = await held({ predictor });
    const b9 = watch(r, 'book:b9');
    const books = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    okAt(r, 12);
    r.engine.sendMutation({ slice: 'book:b9', field: 'name', value: 'Dune' });
    await settle();
    r.server.edits(
      ev('book:b9', 1, 12, { type: 'set', field: 'name', value: 'Dune' }, lastId(r), 'birth'),
    );
    r.server.vouch(12);
    await settle();
    r.server.blobs.set('book:*', { position: 11, seqs: {}, values: [] });
    books.go();
    await settle();
    expect(state(r.data(), 'book:b9')).toEqual({ count: 0, fields: { name: 'Dune' } });
    const shown = b9.values.findIndex((v) => v !== undefined);
    expect(shown).toBeGreaterThan(0);
    expect(b9.values.slice(shown).every((v) => v?.fields.name === 'Dune')).toBe(true);
  });
});

// also: boot.test.ts 'a connection from another epoch ends the Engine'
describe("P14: a cursor belongs to its log's epoch", () => {
  test("P14: a fresh store's first connection gives the cursor its epoch", async () => {
    const r = rig();
    r.server.blobs.set('patron:*', patrons);
    await settle();
    r.server.open('e7');
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e7', position: 10, applied: 10 });
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    r.server.open('e7');
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e7', position: 11, applied: 11 });
  });

  test('P14: a connection to another log applies none of its frames', async () => {
    const r = rig({ seed: resumed });
    await settle();
    r.server.open('e2', 11);
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.live(11);
    await expect(settle()).rejects.toThrow(/epoch e2, checkpoint from e1/);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });
    expect(seq(r.data(), 'patron:p1')).toBe(2);
  });
});
