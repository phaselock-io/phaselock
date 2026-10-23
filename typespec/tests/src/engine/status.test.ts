// The Engine's status as queries read it, and when queries wait for a first sync

import { describe, expect, test, vi } from 'vitest';

import { type Blob, ev, last, rig, settle, watch, watchStatus } from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2 },
  values: [['patron:p1!state', { count: 2, fields: {} }]],
};

/** a store a resumed app left: patron:p1 and patron:p2 held, applied through position 40 */
const resumed = {
  '!view': { token: 't1', position: 40, selectors: ['patron:*'] },
  '!checkpoint': { epoch: 'e1', position: 40, applied: 40 },
  '!seq:patron:p1': 2,
  'patron:p1!state': { count: 2, fields: {} },
  '!seq:patron:p2': 1,
  'patron:p2!state': { count: 1, fields: {} },
};

describe('first boot', () => {
  test('a query reading state waits until the first sync lands, while a status query answers at once', async () => {
    const r = rig();
    const p1 = watch(r, 'patron:p1');
    const status = watchStatus(r);
    await settle();
    expect(p1.values).toEqual([]);
    expect(last(status.connection)).toMatchObject({ state: 'connecting', hasBase: false });

    // the view's backfill is in flight, and the base frozen behind it
    r.server.blobs.set('patron:*', patrons);
    const hold = r.server.hold('patron:*');
    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(p1.values).toEqual([]);
    expect(last(status.connection)).toMatchObject({
      state: 'syncing',
      hasBase: false,
      frozen: true,
    });

    // the land is the first answer
    hold.go();
    await settle();
    expect(p1.values).toEqual([{ count: 2, fields: {} }]);
    expect(last(status.connection)).toMatchObject({ state: 'live', hasBase: true, frozen: false });
  });

  test('a query that catches the held read still waits', async () => {
    const r = rig();
    const values: unknown[] = [];
    const q = r.engine.newQuery((qx) => {
      try {
        return qx.get('patron:p1!state', 'state');
      } catch {
        return 'caught';
      }
    });
    q.subscribe((v) => values.push(v));
    r.server.blobs.set('patron:*', patrons);
    await settle();
    expect(values).toEqual([]);

    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(values).toEqual([{ count: 2, fields: {} }]);
  });

  test('a query that reads the status first can show loading, then the state', async () => {
    const r = rig();
    const values: unknown[] = [];
    const q = r.engine.newQuery((qx) =>
      qx.status.connection().hasBase ? qx.get('patron:p1!state', 'state') : 'loading',
    );
    q.subscribe((v) => values.push(v));
    r.server.blobs.set('patron:*', patrons);
    await settle();
    expect(values).toEqual(['loading']);

    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(values).toEqual(['loading', { count: 2, fields: {} }]);
  });

  test('the backfill shows in the progress, and the estimate ends with the work', async () => {
    const r = rig();
    const status = watchStatus(r);
    r.server.blobs.set('patron:*', patrons);
    const hold = r.server.hold('patron:*');
    await settle();
    expect(last(status.progress).estimate).toBe(0);

    r.server.open();
    r.server.view('t1', 10, ['patron:*']);
    r.server.live(10);
    await settle();
    expect(last(status.progress).backfills).toEqual([
      {
        selector: 'patron:*',
        replacing: true,
        snapshot: { bytes: 0, length: null, done: false },
        tail: null,
        retryAt: null,
      },
    ]);

    hold.go();
    await settle();
    expect(last(status.progress)).toMatchObject({ estimate: null, backfills: [] });

    // every estimate shown along the way only went up
    const shown = status.progress.map((p) => p.estimate).filter((e) => e !== null);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
  });
});

describe('a resumed app', () => {
  test('answers from its stored state before the connection opens', async () => {
    const r = rig({ seed: resumed });
    const p1 = watch(r, 'patron:p1');
    const status = watchStatus(r);
    await settle();
    expect(p1.values).toEqual([{ count: 2, fields: {} }]);
    expect(last(status.connection)).toMatchObject({ state: 'connecting', hasBase: true });
  });

  test('shows the replay as it lands, before live', async () => {
    const r = rig({ seed: resumed });
    const p1 = watch(r, 'patron:p1');
    await settle();
    r.server.open('e1', 50);
    r.server.edits(ev('patron:p1', 3, 45));
    await settle();
    expect(p1.values).toEqual([
      { count: 2, fields: {} },
      { count: 3, fields: {} },
    ]);
  });

  test('estimates the resync from the selector list, the slices resolved, and the replay to head', async () => {
    const r = rig({ seed: resumed });
    const status = watchStatus(r);
    await settle();

    // open: nothing confirmed or resolved, nothing to download, no replay yet
    r.server.open('e1', 50);
    await settle();
    expect(last(status.connection).state).toBe('syncing');
    expect(last(status.progress).log).toEqual({ since: 40, head: 50, committed: 40, applied: 40 });
    expect(last(status.progress).estimate).toBeCloseTo(0.2 * 0.5);

    // an edit chains onto patron:p1: the selector list is confirmed, one of two slices resolved, and
    // the replay is halfway to head
    r.server.edits(ev('patron:p1', 3, 45));
    await settle();
    expect(last(status.progress).estimate).toBeCloseTo(0.05 + 0.2 * 0.75 + 0.75 * 0.5);

    // live: the resync is done
    r.server.live(50);
    await settle();
    expect(last(status.connection).state).toBe('live');
    expect(last(status.progress).estimate).toBeNull();
  });
});

describe('the connection', () => {
  test('goes offline between attempts with the next one due, and connects again on demand', async () => {
    const r = rig({ seed: resumed });
    const status = watchStatus(r);
    await settle();
    r.server.open('e1', 40);
    r.server.live(40);
    await settle();
    expect(last(status.connection)).toMatchObject({ state: 'live', nextAttemptAt: null });

    const before = Date.now();
    r.server.end();
    await settle();
    const offline = last(status.connection);
    expect(offline.state).toBe('offline');
    expect(offline.nextAttemptAt!.getTime()).toBeGreaterThan(before);

    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(last(status.connection)).toMatchObject({ state: 'connecting', nextAttemptAt: null });
  });

  test('stays offline while a retry after backoff tries, until it opens', async () => {
    vi.useFakeTimers();
    try {
      const r = rig({ seed: resumed });
      const status = watchStatus(r);
      await settle();
      r.server.open('e1', 40);
      r.server.live(40);
      await settle();
      r.server.end();
      await settle();
      const ended = status.connection.length;

      // the retry's timer fires, and its connection is trying, with no next attempt due
      await vi.advanceTimersByTimeAsync(60_000);
      expect(r.server.conns.length).toBe(2);
      expect(last(status.connection)).toMatchObject({ state: 'offline', nextAttemptAt: null });

      // it opens and replays, and nothing since the end said connecting
      r.server.open('e1', 40);
      await settle();
      expect(last(status.connection).state).toBe('syncing');
      expect(status.connection.slice(ended).map((c) => c.state)).not.toContain('connecting');
    } finally {
      vi.useRealTimers();
    }
  });

  test('says connecting once reconnectNow is called during a retry, until a connection opens', async () => {
    vi.useFakeTimers();
    try {
      const r = rig({ seed: resumed });
      const status = watchStatus(r);
      await settle();
      r.server.open('e1', 40);
      r.server.live(40);
      await settle();
      r.server.end();
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(last(status.connection).state).toBe('offline');

      // asked for while the retry is still trying, which goes on
      r.engine.reconnectNow();
      await settle();
      expect(r.server.conns.length).toBe(2);
      expect(last(status.connection).state).toBe('connecting');

      // the retry fails, and the attempt asked for starts at once
      r.server.end();
      await settle();
      expect(r.server.conns.length).toBe(3);
      expect(last(status.connection).state).toBe('connecting');

      r.server.open('e1', 40);
      await settle();
      expect(last(status.connection).state).toBe('syncing');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the outbox', () => {
  test('counts the mutations the database has not acknowledged', async () => {
    const r = rig({ seed: resumed });
    const status = watchStatus(r);
    let answer!: (results: { kind: 'ok'; position: number }[]) => void;
    r.server.onSend = () => new Promise((resolve) => (answer = resolve));
    await settle();
    r.server.open('e1', 40);
    r.server.live(40);
    await settle();
    expect(last(status.outbox)).toEqual({ unacknowledged: 0 });

    r.engine.sendMutation({ field: 'a', value: 1 });
    await settle();
    expect(last(status.outbox)).toEqual({ unacknowledged: 1 });

    // acknowledged, though not yet applied
    answer([{ kind: 'ok', position: 41 }]);
    await settle();
    expect(last(status.outbox)).toEqual({ unacknowledged: 0 });
  });
});
