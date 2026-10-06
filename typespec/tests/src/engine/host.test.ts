// What the Engine needs from its host: it names whatever is missing when built, mints command ids
// with the host's own generateUuid when there is one, and runs on a host's own AbortController

import { describe, expect, test } from 'vitest';

import type { Signal, SignalController } from '../../../ts/assets/skeleton.ts';

import { type Blob, bootstrap, ev, rig, settle, state } from './harness.ts';

/** run fn with globals replaced, restoring them when it settles */
async function withGlobals<T>(values: Record<string, unknown>, fn: () => T | Promise<T>) {
  const saved = Object.keys(values).map((name) => {
    return [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const;
  });
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const [name, d] of saved) {
      if (d === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(globalThis, name, d);
      }
    }
  }
}

/** a host's own signal: no EventTarget, only what the Signal contract names */
class HostSignal implements Signal {
  aborted = false;
  reason: unknown = undefined;
  #listeners: (() => void)[] = [];

  addEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners.push(listener);
  }

  removeEventListener(_type: 'abort', listener: () => void): void {
    this.#listeners = this.#listeners.filter((l) => l !== listener);
  }

  fire(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const l of listeners) l();
  }
}

class HostController implements SignalController {
  readonly signal = new HostSignal();

  abort(reason: unknown = 'aborted'): void {
    this.signal.fire(reason);
  }
}

// the host's AbortSignal.any, combining its own signals into another of its own
const HostAbortSignal = {
  any(signals: Signal[]): Signal {
    const c = new HostController();
    for (const s of signals) {
      if (s.aborted) c.abort(s.reason);
      s.addEventListener('abort', () => c.abort(s.reason), { once: true });
    }
    return c.signal;
  },
};

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 1 },
  values: [['patron:p1!state', { count: 1, fields: {} }]],
};

describe('the host', () => {
  test('an Engine built without what it needs names everything missing', async () => {
    const lacking = { setTimeout: undefined, AbortSignal: {}, crypto: undefined };
    await withGlobals(lacking, () => {
      expect(() => rig()).toThrow(
        'the host lacks what the Engine needs: setTimeout, AbortSignal.any, ' +
          'crypto.getRandomValues or generateUuid',
      );
    });
  });

  test("command ids come from the host's generateUuid when it has one", async () => {
    let n = 0;
    const sent = await withGlobals({ generateUuid: () => `host-${++n}` }, async () => {
      const r = rig();
      await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
      r.engine.sendCommand({});
      r.engine.sendCommand({});
      await settle();
      return r.server.sends.flat().map((c) => c.id);
    });
    expect(sent).toEqual(['host-1', 'host-2']);
  });

  test("an Engine runs on the host's own AbortController, which reaches its connector", async () => {
    const hostAbort = { AbortController: HostController, AbortSignal: HostAbortSignal };
    await withGlobals(hostAbort, async () => {
      const r = rig();
      await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
      expect(r.server.conn.signal).toBeInstanceOf(HostSignal);
      r.server.events(ev('patron:p1', 2, 11, { type: 'set', field: 'name', value: 'Ann' }));
      await settle();
      expect(state(r.data(), 'patron:p1')).toEqual({ count: 1, fields: { name: 'Ann' } });

      // ending the Engine through the host's signal ends its connection
      r.abort.abort();
      await settle();
      expect(r.server.conn.ended).toBe(true);
    });
  });
});
