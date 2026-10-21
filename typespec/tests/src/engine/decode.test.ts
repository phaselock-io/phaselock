// An applied value the registry cannot decode is an error, in dev mode, where a query reads it

import { describe, expect, test } from 'vitest';

import { JS } from '../../../ts/assets/skeleton.ts';

import { bootstrap, engineError, ev, INVALID, readState, rig, settle } from './harness.ts';

describe('a value that fails its schema', () => {
  test('applies as bytes, and ends the Engine, naming its key, when a query reads it', async () => {
    const r = rig();
    await bootstrap(r, ['patron:*'], {
      'patron:*': { position: 10, seqs: { 'patron:p1': 1 }, values: [] },
    });

    // the edit applies, since the Engine never decodes a payload
    r.server.edits(ev('patron:p1', 2, 11), ev('patron:p1', 3, 12, { type: INVALID }));
    await settle();
    expect(r.store.read((txn) => txn.get('!seq:patron:p1', '.json', JS))).toBe(3);

    // a query that reads it ends the Engine with the read's error
    r.engine.newQuery((qx) => readState(qx, 'patron:p1'));
    let error: unknown = null;
    try {
      await settle();
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(engineError()).toBeUndefined();
    const message = (error as Error).message;
    expect(message).toMatch(/patron:p1!log:000003/);
    expect(message).toMatch(/\$\.type: invalid/);
  });
});
