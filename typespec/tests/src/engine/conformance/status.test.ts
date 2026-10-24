// Conformance, the status: P20 and P21 of db/README.md's protocol rules

import { describe, expect, test } from 'vitest';

import { ev, last, rig, settle, watch, watchStatus } from '../harness.ts';

import { held, one, patrons, restart, resumed } from './common.ts';

// also: status.test.ts's group 'the connection'; freeze.test.ts 'the status shows the freeze...'
describe('P20: the Engine is live only past its live frame with nothing replacing the base', () => {
  test("P20: a resync is syncing until its live frame, and a gap's freeze is syncing until the land", async () => {
    const r = rig({ seed: resumed });
    const status = watchStatus(r);
    await settle();
    r.server.open('e1', 12);
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'syncing', frozen: false });
    r.server.live(12);
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });

    const gap = r.server.hold('patron:p1');
    r.server.edits(ev('patron:p1', 9, 13));
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'syncing', frozen: true });
    r.server.blobs.set('patron:p1', one('patron:p1', 13, 9));
    gap.go();
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });
  });

  test('P20: an additive backfill leaves the Engine live and unfrozen', async () => {
    const r = await held();
    const status = watchStatus(r);
    const books = r.server.hold('book:*');
    r.server.view('t2', 11, ['patron:*', 'book:*']);
    await settle();
    expect(last(status.progress).backfills.map((b) => [b.selector, b.replacing])).toEqual([
      ['book:*', false],
    ]);
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });
    r.server.blobs.set('book:*', one('book:b1', 11, 1));
    books.go();
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });
    expect(status.connection.map((c) => c.state)).not.toContain('syncing');
  });

  test('P20: a live frame during the first boot is syncing until the land, and a new connection is live only after its own', async () => {
    const r = rig();
    const status = watchStatus(r);
    r.server.blobs.set('patron:*', patrons);
    const boot = r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'syncing', frozen: true });
    boot.go();
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', frozen: false });

    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(last(status.connection).state).toBe('connecting');
    r.server.open();
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    expect(last(status.connection).state).toBe('syncing');
    r.server.live(11);
    await settle();
    expect(last(status.connection).state).toBe('live');
  });
});

// also: status.test.ts's group 'first boot'
describe('P21: hasBase is false only while the first view replaces an empty base', () => {
  test('P21: hasBase stays false through a restart mid-bootstrap, and turns true at the land', async () => {
    const r = rig();
    r.server.hold('patron:*');
    await settle();
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();

    let boot!: { go: () => void };
    const r2 = await restart(r, { 'patron:*': patrons }, (server) => {
      boot = server.hold('patron:*');
    });
    const p1 = watch(r2, 'patron:p1');
    const status = watchStatus(r2);
    r2.server.open();
    r2.server.live(10);
    await settle();
    expect(p1.values).toEqual([]);
    expect(last(status.connection)).toMatchObject({ hasBase: false, frozen: true });

    boot.go();
    await settle();
    expect(p1.values).toEqual([{ count: 2, fields: {} }]);
    expect(last(status.connection).hasBase).toBe(true);
  });

  test('P21: once true, hasBase stays true through a freeze, a reconnect, and a restart', async () => {
    const r = await held();
    const status = watchStatus(r);
    r.server.hold('patron:p2');
    r.server.edits(ev('patron:p2', 9, 11));
    await settle();
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(status.connection.every((c) => c.hasBase)).toBe(true);

    // a restart answers from the stored base before any connection opens
    const r2 = await restart(r);
    const p1 = watch(r2, 'patron:p1');
    const status2 = watchStatus(r2);
    await settle();
    expect(p1.values).toEqual([{ count: 2, fields: {} }]);
    expect(last(status2.connection)).toMatchObject({ state: 'connecting', hasBase: true });
  });
});
