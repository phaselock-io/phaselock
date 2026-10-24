// Conformance, the bootstrap contract: P10 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import { checkpoint, ev, keys, log, rig, seq, settle, state, watch } from '../harness.ts';

import { patrons, record, restart, set } from './common.ts';

/* Also: landing.test.ts "a bootstrap's land shows the base at the view position..."; boot.test.ts
   'a missing !view means bootstrap: since -1, view null'.  The database's half is server_test.go's
   TestBootstrapDeliversEverythingAboveTheViewPosition. */
describe("P10: a bootstrap's backfills cover the view's position and below, its connection above", () => {
  test("P10: once a bootstrap's view frame at V is processed, the cursor is V, and a reconnect resumes from it", async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    r.server.blobs.set('patron:*', patrons);
    await settle();
    expect(r.server.conn.since).toBe(-1);
    expect(r.server.conn.view).toBeNull();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });

    // the connection drops before any edits, vouch, or live, and the log moves on to 12
    r.server.end();
    await settle();
    const history = [set('patron:p1', 3, 11, 'name', 'Ann'), ev('patron:p2', 2, 12)];
    r.engine.reconnectNow();
    await settle();

    // the server replays from since, and a bootstrap's connection starts at its head
    const since = r.server.conn.since;
    expect(since).toBe(10);
    r.server.open('e1', 12);
    const replay = history.filter((e) => e.position > (since === -1 ? 12 : since));
    if (replay.length > 0) r.server.edits(...replay);
    r.server.live(12);
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(state(r.data(), 'patron:p2')).toEqual({ count: 2, fields: {} });
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 12, applied: 12 });
  });

  test("P10: a view frame's backfills cover every position at or below the frame's", async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    r.server.blobs.set('patron:*', {
      ...patrons,
      position: 8,
      tail: [set('patron:p1', 3, 10, 'name', 'Ann')],
    });
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();
    expect(record(r, 'patron:*')?.until).toBeGreaterThan(10);

    // the tail reads through 10, which the bootstrap's connection never delivers
    boot.go();
    r.server.live(10);
    await settle();
    expect(r.server.tails).toEqual([{ selector: 'patron:*', after: 8, before: 11 }]);
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
  });

  test('P10: an edit at V that both the tail and the connection deliver applies once', async () => {
    const r = rig();
    const atV = set('patron:p1', 3, 10, 'name', 'Ann');
    r.server.blobs.set('patron:*', { ...patrons, position: 8, tail: [atV] });
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.edits(atV);
    await settle();
    boot.go();
    r.server.live(10);
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['set name=Ann']);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(keys(r.data(), '!park')).toEqual([]);
  });

  test("P10: a restart before the bootstrap's backfill starts reconnects from V, and the backfill still tails through V", async () => {
    const r = rig();
    r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    await settle();

    const r2 = await restart(r, {
      'patron:*': { ...patrons, position: 8, tail: [set('patron:p1', 3, 10, 'name', 'Ann')] },
    });
    expect(r2.server.conn.since).toBe(10);
    expect(r2.server.conn.view).toBe('t1');
    expect(r2.server.backfills).toEqual([{ selector: 'patron:*', until: 11, resume: null }]);
    r2.server.open();
    r2.server.live(10);
    await settle();
    expect(state(r2.data(), 'patron:p1')).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(state(r2.data(), 'patron:p2')).toEqual({ count: 1, fields: {} });
    expect(checkpoint(r2.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });
  });
});
