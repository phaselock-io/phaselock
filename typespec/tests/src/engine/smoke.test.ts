// the harness against the Engine: a bootstrap lands, a live edit applies

import { describe, expect, test } from 'vitest';

import { bootstrap, checkpoint, ev, keys, log, rig, seq, settle, state } from './harness.ts';

describe('smoke', () => {
  test('bootstrap lands a family blob and live edits apply', async () => {
    const r = rig();
    await settle();
    // the first connection presents nothing
    expect(r.server.conns.length).toBe(1);
    expect(r.server.conn.since).toBe(-1);
    expect(r.server.conn.view).toBeNull();

    await bootstrap(r, ['patron:*'], {
      'patron:*': {
        position: 10,
        seqs: { 'patron:p1': 2, 'patron:p2': 1 },
        values: [
          ['patron:p1!state', { count: 2, fields: {} }],
          ['patron:p2!state', { count: 1, fields: {} }],
        ],
      },
    });
    expect(r.server.backfills.map((b) => [b.selector, b.until])).toEqual([['patron:*', 11]]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: {} });
    expect(seq(r.data(), 'patron:p1')).toBe(2);
    expect(seq(r.data(), 'patron:p2')).toBe(1);
    expect(keys(r.data(), '!backfill')).toEqual([]);
    expect(keys(r.data(), '!park')).toEqual([]);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 10, applied: 10 });

    r.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'name', value: 'Ann' }));
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: { name: 'Ann' } });
    expect(log(r.data(), 'patron:p1')).toEqual(['set name=Ann']);
    expect(seq(r.data(), 'patron:p1')).toBe(3);
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 11, applied: 11 });
  });
});
