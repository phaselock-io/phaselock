// An event the registry rejects ends the Engine, with an error that names where it came from

import { describe, expect, test } from 'vitest';

import { bootstrap, engineError, ev, INVALID, rig, settle, state } from './harness.ts';

describe('an event that fails its schema', () => {
  test('ends the Engine, naming the stream and position, and folds nothing of its atom', async () => {
    const r = rig();
    await bootstrap(r, ['patron.*'], {
      'patron.*': { position: 10, seqs: { 'patron.p1': 1 }, values: [] },
    });

    // a valid event followed by an invalid one, in one atom
    r.server.events(ev('patron.p1', 2, 11), ev('patron.p1', 3, 12, { type: INVALID }));
    let error: unknown = null;
    try {
      await settle();
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(engineError()).toBeUndefined();
    const message = (error as Error).message;
    expect(message).toMatch(/patron\.p1/);
    expect(message).toMatch(/12/);
    expect(message).toMatch(/\$\.type: invalid/);
    // the transaction rolled back: the valid event is not in the base either
    expect(state(r.data(), 'patron.p1')).toBeUndefined();
  });
});
