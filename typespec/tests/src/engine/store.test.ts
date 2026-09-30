// TESTS.md: Store primitives (every implementation), against InMemStore, OverlayStore, and
// ExternalStore

import { describe, expect, test } from 'vitest';

import {
  deepCopy,
  ExternalStore,
  type ExternalStoreTxn,
  InMemStore,
  JS,
  OverlayStore,
  prefixRange,
  resumeRange,
  type Store,
  type StoreRange,
  type StoreValue,
  txnGet,
  txnScanAll,
} from '../../../ts/assets/skeleton.ts';

import { registry } from './harness.ts';

const T = '.json';
const js = (v: unknown): StoreValue => ({ [JS]: v });
const asJs = (v: StoreValue | undefined): unknown =>
  (v as Record<number, unknown> | undefined)?.[JS];

/** a store seeded with these keys, each holding its own name */
function seeded(data: Record<string, unknown>, ...keys: string[]): InMemStore {
  const store = new InMemStore(registry, data);
  store.write((txn) => {
    for (const k of keys) txn.set(k, T, js(k));
  });
  return store;
}

function scanKeys(store: Store, range: StoreRange): string[] {
  return store.read((txn) => {
    return txnScanAll(txn, range).map(([k]) => k);
  });
}

describe('scan', () => {
  const five = ['k1', 'k2', 'k3', 'k4', 'k5'];

  test('closed and open bounds on each side', () => {
    const store = seeded({}, ...five);
    expect(scanKeys(store, { gte: 'k2', lt: 'k4', limit: 10, values: false })).toEqual([
      'k2',
      'k3',
    ]);
    expect(scanKeys(store, { gt: 'k2', lte: 'k4', limit: 10, values: false })).toEqual([
      'k3',
      'k4',
    ]);
    expect(scanKeys(store, { gte: 'k4', limit: 10, values: false })).toEqual(['k4', 'k5']);
    expect(scanKeys(store, { lt: 'k3', limit: 10, values: false })).toEqual(['k1', 'k2']);
    expect(scanKeys(store, { gt: 'k1', lt: 'k2', limit: 10, values: false })).toEqual([]);
  });

  test('reverse walks descending and resumes with lt', () => {
    const store = seeded({}, ...five);
    expect(
      scanKeys(store, { gte: 'k2', lte: 'k4', reverse: true, limit: 10, values: false }),
    ).toEqual(['k4', 'k3', 'k2']);
    const batches = store.read((txn) => {
      const out: [string[], string | null][] = [];
      let range: StoreRange = { reverse: true, limit: 2, values: false };
      for (;;) {
        const { entries, next } = txn.scan(range);
        out.push([entries.map(([k]) => k), next]);
        if (next === null) return out;
        range = resumeRange(range, next);
      }
    });
    expect(batches).toEqual([
      [['k5', 'k4'], 'k4'],
      [['k3', 'k2'], 'k2'],
      [['k1'], null],
    ]);
  });

  test('limit batching with next', () => {
    const store = seeded({}, ...five);
    const batches = store.read((txn) => {
      const out: [string[], string | null][] = [];
      let range: StoreRange = prefixRange('k', 2, false);
      for (;;) {
        const { entries, next } = txn.scan(range);
        out.push([entries.map(([k]) => k), next]);
        if (next === null) return out;
        range = resumeRange(range, next);
      }
    });
    expect(batches).toEqual([
      [['k1', 'k2'], 'k2'],
      [['k3', 'k4'], 'k4'],
      [['k5'], null],
    ]);
  });

  test('keys only versus values with a want', () => {
    const store = seeded({}, 'k1', 'k2');
    const keysOnly = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, false));
    });
    expect(keysOnly).toEqual([
      ['k1', undefined],
      ['k2', undefined],
    ]);
    const withValues = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, { type: T, want: JS }));
    });
    expect(withValues.map(([k, v]) => [k, asJs(v)])).toEqual([
      ['k1', 'k1'],
      ['k2', 'k2'],
    ]);
  });

  test('an empty range, and a range covering the whole store', () => {
    const store = seeded({}, ...five);
    const empty = store.read((txn) => {
      return txn.scan({ gte: 'z', limit: 10, values: false });
    });
    expect(empty).toEqual({ entries: [], next: null });
    expect(scanKeys(store, prefixRange('', 10, false))).toEqual(five);
  });

  test('while writing: a key written above the cursor is visited, one below is not, a deleted key ahead is skipped', () => {
    const store = seeded({}, ...five);
    const seen = store.write((txn) => {
      const first = txn.scan(prefixRange('k', 1, false));
      expect(first.entries.map(([k]) => k)).toEqual(['k1']);
      txn.set('k1a', T, js('k1a'));
      txn.set('k0', T, js('k0'));
      txn.del('k3');
      const rest = txnScanAll(txn, resumeRange(prefixRange('k', 10, false), first.next!));
      return rest.map(([k]) => k);
    });
    expect(seen).toEqual(['k1a', 'k2', 'k4', 'k5']);
  });
});

describe('delPrefix and move', () => {
  test('delPrefix reports exactly the keys deleted and nothing outside the prefix moves', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'p/2', 'pq/1', 'q/1');
    const deleted = store.write((txn) => {
      return txn.delPrefix('p/');
    });
    expect(deleted).toEqual(['p/1', 'p/2']);
    expect(Object.keys(data).sort()).toEqual(['pq/1', 'q/1']);
    expect(data['q/1']).toBe('q/1');
  });

  test('move rekeys every key under the prefix, reports the keys as they now exist, and leaves the source empty', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'p/2', 'q/1');
    const moved = store.write((txn) => {
      return txn.move('p/', 'r/');
    });
    expect(moved).toEqual(['r/1', 'r/2']);
    expect(Object.keys(data).sort()).toEqual(['q/1', 'r/1', 'r/2']);
    expect(data['r/1']).toBe('p/1');
    expect(data['r/2']).toBe('p/2');
  });

  test('move into an occupied destination overwrites key by key', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'r/1', 'r/3');
    store.write((txn) => {
      txn.move('p/', 'r/');
    });
    expect(Object.keys(data).sort()).toEqual(['r/1', 'r/3']);
    expect(data['r/1']).toBe('p/1');
    expect(data['r/3']).toBe('r/3');
  });

  test('move to the empty prefix lands keys at their remainder', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, '/park.kv.x/a/1', '/park.kv.x/b/1');
    const moved = store.write((txn) => {
      return txn.move('/park.kv.x/', '');
    });
    expect(moved).toEqual(['a/1', 'b/1']);
    expect(Object.keys(data).sort()).toEqual(['a/1', 'b/1']);
    expect(data['a/1']).toBe('/park.kv.x/a/1');
  });
});

describe('overlay', () => {
  test('scan answers with pending writes merged in and pending deletes removed', () => {
    const base = seeded({}, 'k1', 'k2', 'k3');
    const overlay = new OverlayStore(base, registry);
    const inside = overlay.write((txn) => {
      txn.set('k4', T, js('k4'));
      txn.del('k2');
      return txnScanAll(txn, prefixRange('k', 10, { type: T, want: JS })).map(([k, v]) => [
        k,
        asJs(v),
      ]);
    });
    expect(inside).toEqual([
      ['k1', 'k1'],
      ['k3', 'k3'],
      ['k4', 'k4'],
    ]);
    const after = overlay.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, false)).map(([k]) => k);
    });
    expect(after).toEqual(['k1', 'k3', 'k4']);
    expect(scanKeys(base, prefixRange('k', 10, false))).toEqual(['k1', 'k2', 'k3']);
    const gone = overlay.read((txn) => {
      return txnGet(txn, 'k2', T);
    });
    expect(gone).toBeUndefined();
  });
});

describe('ownership', () => {
  test('a get hands out a copy: mutating it changes neither the store nor a second get', () => {
    const data: Record<string, unknown> = {};
    const store = new InMemStore(registry, data);
    store.write((txn) => {
      txn.set('k', T, js({ n: 1, list: [1] }));
    });
    const read = () =>
      store.read((txn) => {
        return txnGet(txn, 'k', T) as { n: number; list: number[] };
      });
    const first = read();
    first.n = 2;
    first.list.push(2);
    expect(data['k']).toEqual({ n: 1, list: [1] });
    const second = read();
    expect(second).toEqual({ n: 1, list: [1] });
    expect(second).not.toBe(first);
  });

  test('a set keeps a copy: mutating the object afterwards leaves the store as it was', () => {
    const data: Record<string, unknown> = {};
    const store = new InMemStore(registry, data);
    const obj = { n: 1 };
    store.write((txn) => {
      txn.set('k', T, js(obj));
    });
    obj.n = 2;
    expect(data['k']).toEqual({ n: 1 });
  });

  test('scan values are copies', () => {
    const data = { k1: { n: 1 } };
    const store = new InMemStore(registry, data);
    const entries = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, { type: T, want: JS }));
    });
    (asJs(entries[0][1]) as { n: number }).n = 2;
    expect(data.k1).toEqual({ n: 1 });
  });

  test('the overlay copies its layer both ways, in gets and in scans', () => {
    const base = seeded({}, 'k1');
    const overlay = new OverlayStore(base, registry);
    const obj = { n: 1 };
    overlay.write((txn) => {
      txn.set('k2', T, js(obj));
    });
    obj.n = 2;
    const read = () =>
      overlay.read((txn) => {
        const got = txnGet(txn, 'k2', T) as { n: number };
        const all = txnScanAll(txn, prefixRange('k', 10, { type: T, want: JS }));
        return { got, scanned: asJs(all[1][1]) as { n: number }, base: asJs(all[0][1]) };
      });
    const first = read();
    expect(first).toEqual({ got: { n: 1 }, scanned: { n: 1 }, base: 'k1' });
    first.got.n = 3;
    first.scanned.n = 4;
    expect(read()).toEqual({ got: { n: 1 }, scanned: { n: 1 }, base: 'k1' });
  });
});

describe('transactions', () => {
  test('a write commits when fn returns and hands back its result', () => {
    const data: Record<string, unknown> = {};
    const store = new InMemStore(registry, data);
    const out = store.write((txn) => {
      txn.set('k', T, js('v'));
      return 'done';
    });
    expect(out).toBe('done');
    expect(data['k']).toBe('v');
  });

  test('a throw rolls the transaction back, in the store and in the overlay', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'k1');
    expect(() =>
      store.write((txn) => {
        txn.set('k2', T, js('k2'));
        txn.del('k1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(data).toEqual({ k1: 'k1' });

    const overlay = new OverlayStore(store, registry);
    expect(() =>
      overlay.write((txn) => {
        txn.set('k2', T, js('k2'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(overlay.keys()).toEqual([]);
  });

  test('a read transaction has no write methods', () => {
    const store = seeded({}, 'k1');
    store.read((txn) => {
      expect('set' in txn).toBe(false);
      expect('delPrefix' in txn).toBe(false);
    });
  });
});

describe('external store', () => {
  /** an ExternalStore over a host transaction that records its calls, failing where told */
  function external(fail: { in?: boolean; commit?: boolean } = {}) {
    const calls: string[] = [];
    const store = new ExternalStore((writable) => {
      calls.push(writable ? 'open write' : 'open read');
      const txn: ExternalStoreTxn = {
        get: (key) => {
          calls.push(`get ${key}`);
          if (fail.in) throw new Error('get failed');
          return js(key);
        },
        scan: () => ({ entries: [], next: null }),
        set: (key) => void calls.push(`set ${key}`),
        del: (key) => void calls.push(`del ${key}`),
        delPrefix: () => [],
        move: () => [],
        commit: () => {
          calls.push('commit');
          if (fail.commit) throw new Error('commit failed');
        },
        abort: () => void calls.push('abort'),
      };
      return txn;
    });
    return { store, calls };
  }

  test('a transaction that returns commits, and its answers come from the host', () => {
    const { store, calls } = external();
    const got = store.write((txn) => {
      txn.set('k', T, js(1));
      return txnGet(txn, 'k', T);
    });
    expect(got).toBe('k');
    expect(calls).toEqual(['open write', 'set k', 'get k', 'commit']);
  });

  test('a failure inside the transaction or in commit aborts and rethrows', () => {
    const inside = external({ in: true });
    expect(() => inside.store.read((txn) => txn.get('k', T, JS))).toThrow('get failed');
    expect(inside.calls).toEqual(['open read', 'get k', 'abort']);

    const atCommit = external({ commit: true });
    expect(() => atCommit.store.write((txn) => txn.del('k'))).toThrow('commit failed');
    expect(atCommit.calls).toEqual(['open write', 'del k', 'commit', 'abort']);
  });

  test('a read transaction hands out only the read half of the host transaction', () => {
    const { store } = external();
    store.read((txn) => {
      expect('set' in txn).toBe(false);
      expect('commit' in txn).toBe(false);
    });
  });
});

describe('deepCopy', () => {
  test('copies the JS value universe and shares nothing with the original', () => {
    const src = {
      a: [1, { b: 2 }],
      m: new Map([['k', { c: 3 }]]),
      s: new Set([1, 2]),
      d: new Date(5),
      u: new Uint8Array([1, 2, 3]),
    };
    const out = deepCopy(src);
    expect(out).toEqual(src);
    expect(out.a[1]).not.toBe(src.a[1]);
    expect(out.m.get('k')).not.toBe(src.m.get('k'));
    expect(out.s).not.toBe(src.s);
    expect(out.d).not.toBe(src.d);
    expect(out.u.buffer).not.toBe(src.u.buffer);
  });

  test('shared substructure is copied once per reference, and a cycle throws', () => {
    const shared = { x: 1 };
    const out = deepCopy({ p: shared, q: shared });
    expect(out.p).toEqual(shared);
    expect(out.p).not.toBe(out.q);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => deepCopy(cyclic)).toThrow(/too deep/);
  });
});
