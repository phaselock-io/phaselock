// TESTS.md: Store primitives (every implementation), against InMemStore, the Overlay, and
// ExternalStore

import { describe, expect, test } from 'vitest';

import {
  compareKeys,
  deepCopy,
  ExternalStore,
  type ExternalStoreTxn,
  InMemStore,
  JS,
  Overlay,
  prefixEnd,
  prefixRange,
  resumeRange,
  type RTxn,
  type Store,
  type StoreRange,
  txnScanAll,
} from '../../../ts/assets/skeleton.ts';

import { registry } from './harness.ts';

const T = '.json';

/** a store seeded with these keys, each holding its own name */
function seeded(...keys: string[]): InMemStore {
  const store = new InMemStore(registry);
  store.write((txn) => {
    for (const k of keys) txn.set(k, T, JS, k);
  });
  return store;
}

/** every key in a store and its value */
function contents(store: Store): Record<string, unknown> {
  return store.read((txn) => {
    return Object.fromEntries(txnScanAll(txn, { limit: 1000, values: { type: T, rep: JS } }));
  });
}

function scanKeys(store: Store, range: StoreRange): string[] {
  return store.read((txn) => {
    return txnScanAll(txn, range).map(([k]) => k);
  });
}

describe('scan', () => {
  const five = ['k1', 'k2', 'k3', 'k4', 'k5'];

  test('closed and open bounds on each side', () => {
    const store = seeded(...five);
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
    const store = seeded(...five);
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
    const store = seeded(...five);
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

  test('keys only versus values in a representation', () => {
    const store = seeded('k1', 'k2');
    const keysOnly = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, false));
    });
    expect(keysOnly).toEqual([
      ['k1', undefined],
      ['k2', undefined],
    ]);
    const withValues = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, { type: T, rep: JS }));
    });
    expect(withValues.map(([k, v]) => [k, v])).toEqual([
      ['k1', 'k1'],
      ['k2', 'k2'],
    ]);
  });

  test('an empty range, and a range covering the whole store', () => {
    const store = seeded(...five);
    const empty = store.read((txn) => {
      return txn.scan({ gte: 'z', limit: 10, values: false });
    });
    expect(empty).toEqual({ entries: [], next: null });
    expect(scanKeys(store, prefixRange('', 10, false))).toEqual(five);
  });

  test('while writing: a key written above the cursor is visited, one below is not, a deleted key ahead is skipped', () => {
    const store = seeded(...five);
    const seen = store.write((txn) => {
      const first = txn.scan(prefixRange('k', 1, false));
      expect(first.entries.map(([k]) => k)).toEqual(['k1']);
      txn.set('k1a', T, JS, 'k1a');
      txn.set('k0', T, JS, 'k0');
      txn.del('k3');
      const rest = txnScanAll(txn, resumeRange(prefixRange('k', 10, false), first.next!));
      return rest.map(([k]) => k);
    });
    expect(seen).toEqual(['k1a', 'k2', 'k4', 'k5']);
  });
});

describe('key order', () => {
  // in code-point order, which UTF-16 code-unit order gets wrong across U+E000-U+FFFF
  const ordered = [
    'A',
    '\uD7FF',
    '\uE000',
    '\uFFFD',
    '\uFFFF',
    '\u{10000}',
    '\u{1F600}',
    '\u{10FFFF}',
  ];

  test('compareKeys agrees with UTF-8 byte order', () => {
    const utf8 = (s: string) => Buffer.from(s, 'utf8');
    const keys = ordered.flatMap((a) => ordered.map((b) => 'k' + a + b));
    const byBytes = [...keys].sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
    expect([...keys].reverse().sort(compareKeys)).toEqual(byBytes);
  });

  test('a scan walks in code-point order, forward and reversed, through the overlay too', () => {
    const keys = ordered.map((c) => 'k' + c);
    const store = seeded(...[...keys].reverse());
    expect(scanKeys(store, prefixRange('k', 3, false))).toEqual(keys);
    expect(scanKeys(store, { ...prefixRange('k', 3, false), reverse: true })).toEqual(
      [...keys].reverse(),
    );
    expect(scanKeys(store, { gt: 'k\uFFFF', limit: 3, values: false })).toEqual(keys.slice(5));

    // pending writes on either side of the surrogates merge into the base's walk
    const overlay = new Overlay(registry);
    const merged = store.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('k\uE001', T, JS, 'k\uE001');
        txn.set('k\u{10001}', T, JS, 'k\u{10001}');
        return txnScanAll(txn, prefixRange('k', 2, false)).map(([k]) => k);
      }),
    );
    expect(merged).toEqual([
      ...keys.slice(0, 3),
      'k\uE001',
      ...keys.slice(3, 6),
      'k\u{10001}',
      ...keys.slice(6),
    ]);
  });

  test('prefixEnd increments the last code point', () => {
    expect(prefixEnd('ab')).toBe('ac');
    expect(prefixEnd('a\uD7FF')).toBe('a\uE000');
    expect(prefixEnd('a\uFFFF')).toBe('a\u{10000}');
    expect(prefixEnd('a\u{1F600}')).toBe('a\u{1F601}');
    expect(prefixEnd('a\u{10FFFF}\u{10FFFF}')).toBe('b');
    expect(prefixEnd('\u{10FFFF}')).toBeUndefined();
    expect(prefixEnd('')).toBeUndefined();
  });

  test("a walk visits a family's keys in the order of their template parameters", () => {
    // the keys of x:{day},{channel} streams at reply:{thread},{id}, in the order of their
    // parameters, where a value may be another followed by '-' or '.'
    const days = ['2026-10', '2026-10-06'];
    const channels = ['gen', 'gen-2', 'gen.x'];
    const threads = ['t1', 't1-2'];
    const ids = ['', 'm1', 'm1-2'];
    const streams = days.flatMap((d) => channels.map((c) => `x:${d},${c}`));
    const keys = streams.flatMap((st) =>
      threads.flatMap((t) => ids.map((id) => `${st}!reply:${t},${id}`)),
    );
    const store = seeded(...[...keys].reverse());

    // the family, one stream, and one stream's thread
    expect(scanKeys(store, prefixRange('x:', 7, false))).toEqual(keys);
    expect(scanKeys(store, prefixRange('x:2026-10,gen!', 7, false))).toEqual(
      keys.filter((k) => k.startsWith('x:2026-10,gen!')),
    );
    expect(scanKeys(store, prefixRange('x:2026-10,gen!reply:t1,', 7, false))).toEqual(
      ids.map((id) => `x:2026-10,gen!reply:t1,${id}`),
    );

    // stream names alone sort the same way
    expect([...streams].reverse().sort(compareKeys)).toEqual(streams);
  });

  test('a prefix range holds exactly the keys under its prefix', () => {
    const prefixes = ['k\uD7FF', 'k\uFFFF', 'k\u{1F600}', 'k\u{10FFFF}'];
    const keys = ordered.flatMap((a) => ordered.map((b) => 'k' + a + b));
    const store = seeded(...keys);
    for (const p of prefixes) {
      const under = keys.filter((k) => k.startsWith(p)).sort(compareKeys);
      expect(scanKeys(store, prefixRange(p, 4, false))).toEqual(under);
    }
  });
});

describe('delPrefix and move', () => {
  test('delPrefix reports exactly the keys deleted and nothing outside the prefix moves', () => {
    const store = seeded('p/1', 'p/2', 'pq/1', 'q/1');
    const deleted = store.write((txn) => {
      return txn.delPrefix('p/');
    });
    expect(deleted).toEqual(['p/1', 'p/2']);
    expect(contents(store)).toEqual({ 'pq/1': 'pq/1', 'q/1': 'q/1' });
  });

  test('move rekeys every key under the prefix, reports the keys as they now exist, and leaves the source empty', () => {
    const store = seeded('p/1', 'p/2', 'q/1');
    const moved = store.write((txn) => {
      return txn.move('p/', 'r/');
    });
    expect(moved).toEqual(['r/1', 'r/2']);
    expect(contents(store)).toEqual({ 'q/1': 'q/1', 'r/1': 'p/1', 'r/2': 'p/2' });
  });

  test('move into an occupied destination overwrites key by key', () => {
    const store = seeded('p/1', 'r/1', 'r/3');
    store.write((txn) => {
      txn.move('p/', 'r/');
    });
    expect(contents(store)).toEqual({ 'r/1': 'p/1', 'r/3': 'r/3' });
  });

  test('move to the empty prefix lands keys at their remainder', () => {
    const store = seeded('!park-kv:x!a/1', '!park-kv:x!b/1');
    const moved = store.write((txn) => {
      return txn.move('!park-kv:x!', '');
    });
    expect(moved).toEqual(['a/1', 'b/1']);
    expect(contents(store)).toEqual({ 'a/1': '!park-kv:x!a/1', 'b/1': '!park-kv:x!b/1' });
  });
});

describe('a store of many keys', () => {
  // a seeded random integer below n
  let seed = 1;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return Math.floor((seed / 4294967296) * n);
  };

  // a fresh key, now and then holding code points the native order gets wrong
  const fresh = () => {
    const tail = ['', '', '', '\u{1F600}', '\uFF0C'][rand(5)];
    return `k/${String(rand(1e9)).padStart(9, '0')}${tail}`;
  };

  // a random range over the reference's keys, with any mix of bounds on either side
  function randomRange(keys: string[]): StoreRange {
    const pick = () => (keys.length > 0 && rand(4) > 0 ? keys[rand(keys.length)] : fresh());
    const r: StoreRange = { limit: 1 + rand(60), values: false, reverse: rand(2) === 0 };
    const lower = rand(4);
    if (lower & 1) r.gte = pick();
    if (lower & 2) r.gt = pick();
    const upper = rand(4);
    if (upper & 1) r.lt = pick();
    if (upper & 2) r.lte = pick();
    return r;
  }

  // the keys of a range, from the reference's keys in walk order
  function expected(sorted: string[], r: StoreRange): string[] {
    const inside = sorted.filter(
      (k) =>
        (r.gte === undefined || compareKeys(k, r.gte) >= 0) &&
        (r.gt === undefined || compareKeys(k, r.gt) > 0) &&
        (r.lt === undefined || compareKeys(k, r.lt) < 0) &&
        (r.lte === undefined || compareKeys(k, r.lte) <= 0),
    );
    return r.reverse ? inside.reverse() : inside;
  }

  // check random ranges of txn against the reference
  function checkRanges(txn: RTxn, keys: Set<string>): void {
    const sorted = [...keys].sort(compareKeys);
    for (let i = 0; i < 4; i++) {
      const r = randomRange(sorted);
      expect(txnScanAll(txn, r).map(([k]) => k)).toEqual(expected(sorted, r));
    }
  }

  // a store and the keys it should hold, changed by commits whose scans are checked inside the
  // write transaction and after it
  function tracked() {
    const store = new InMemStore(registry);
    const keys = new Set<string>();
    const commit = (add: string[], drop: string[]) => {
      store.write((txn) => {
        for (const k of add) txn.set(k, T, JS, k);
        for (const k of drop) txn.del(k);
        const gone = new Set(drop);
        checkRanges(txn, new Set([...keys, ...add].filter((k) => !gone.has(k))));
      });
      for (const k of add) keys.add(k);
      for (const k of drop) keys.delete(k);
      store.read((txn) => checkRanges(txn, keys));
    };
    return { store, keys, commit };
  }

  test('scans agree with a sorted reference while blocks split, join, and rebuild', () => {
    const { store, keys, commit } = tracked();

    // a bulk load, then growth a few hundred keys at a time, which splits blocks
    commit(Array.from({ length: 3000 }, fresh), []);
    for (let i = 0; i < 20; i++) commit(Array.from({ length: 300 }, fresh), []);

    // shrinking by runs of neighbouring keys, which empties blocks so they join, while a few
    // keys still arrive
    while (keys.size > 1500) {
      const sorted = [...keys].sort(compareKeys);
      const at = rand(4) === 0 ? 0 : rand(sorted.length - 150);
      commit([fresh(), fresh()], sorted.slice(at, at + 150));
    }

    // and a mass deletion that rebuilds
    commit([], [...keys].slice(0, 1000));
    const sorted = [...keys].sort(compareKeys);
    expect(Object.keys(contents(store))).toEqual(sorted);
  });

  test('a short block joining a long neighbour splits the pair again', () => {
    const { keys, commit } = tracked();
    const name = (i: number) => `m/${String(i).padStart(4, '0')}`;

    // blocks hold about a thousand keys, so a bulk load of two thousand makes two
    commit(
      Array.from({ length: 2000 }, (_, i) => name(i)),
      [],
    );

    // the first grows to nearly twice that, a few hundred keys at a time
    for (let i = 0; i < 950; i += 190) {
      commit(
        Array.from({ length: 190 }, (_, j) => `${name(500)}/${i + j}`),
        [],
      );
    }

    // the second shrinks until it joins the first, and the pair is too long for one block
    for (let i = 1000; i < 1800; i += 200) {
      commit(
        [],
        Array.from({ length: 200 }, (_, j) => name(i + j)),
      );
    }
    expect(keys.size).toBe(2150);
  });

  test('delPrefix and move cover every key under the prefix across blocks', () => {
    const names = Array.from({ length: 5000 }, (_, i) => String(i).padStart(5, '0'));
    const store = seeded(...names.map((n) => `a/${n}`), ...names.map((n) => `b/${n}`));
    const deleted = store.write((txn) => txn.delPrefix('a/'));
    expect(deleted).toEqual(names.map((n) => `a/${n}`));
    const moved = store.write((txn) => txn.move('b/', 'c/'));
    expect(moved).toEqual(names.map((n) => `c/${n}`));
    const after = contents(store);
    expect(Object.keys(after)).toEqual(names.map((n) => `c/${n}`));
    expect(after['c/04999']).toBe('b/04999');
  });
});

describe('overlay', () => {
  test('refuses to move keys, which no forecast does', () => {
    const base = seeded('k1');
    const overlay = new Overlay(registry);
    expect(() => base.read((b) => overlay.apply(b, (txn) => txn.move('k', 'j')))).toThrow(
      'the overlay does not move keys',
    );
  });

  test('scan answers with pending writes merged in and pending deletes removed', () => {
    const base = seeded('k1', 'k2', 'k3');
    const overlay = new Overlay(registry);
    const inside = base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('k4', T, JS, 'k4');
        txn.del('k2');
        return txnScanAll(txn, prefixRange('k', 10, { type: T, rep: JS })).map(([k, v]) => [k, v]);
      }),
    );
    expect(inside).toEqual([
      ['k1', 'k1'],
      ['k3', 'k3'],
      ['k4', 'k4'],
    ]);
    const after = base.read((b) =>
      txnScanAll(overlay.view(b), prefixRange('k', 10, false)).map(([k]) => k),
    );
    expect(after).toEqual(['k1', 'k3', 'k4']);
    expect(scanKeys(base, prefixRange('k', 10, false))).toEqual(['k1', 'k2', 'k3']);
    const gone = base.read((b) => overlay.view(b).get('k2', T, JS));
    expect(gone).toBeUndefined();
  });
});

describe('the overlay view', () => {
  test('is read-only', () => {
    const base = seeded('k1');
    const overlay = new Overlay(registry);
    base.read((b) => {
      const view = overlay.view(b);
      expect('set' in view).toBe(false);
      expect('delPrefix' in view).toBe(false);
    });
  });
});

describe('ownership', () => {
  test('a get hands out a copy: mutating it changes neither the store nor a second get', () => {
    const store = new InMemStore(registry);
    store.write((txn) => {
      txn.set('k', T, JS, { n: 1, list: [1] });
    });
    const read = () =>
      store.read((txn) => {
        return txn.get('k', T, JS) as { n: number; list: number[] };
      });
    const first = read();
    first.n = 2;
    first.list.push(2);
    expect(contents(store)['k']).toEqual({ n: 1, list: [1] });
    const second = read();
    expect(second).toEqual({ n: 1, list: [1] });
    expect(second).not.toBe(first);
  });

  test('a set keeps a copy: mutating the object afterwards leaves the store as it was', () => {
    const store = new InMemStore(registry);
    const obj = { n: 1 };
    store.write((txn) => {
      txn.set('k', T, JS, obj);
    });
    obj.n = 2;
    expect(contents(store)['k']).toEqual({ n: 1 });
  });

  test('scan values are copies', () => {
    const store = new InMemStore(registry);
    store.write((txn) => {
      txn.set('k1', T, JS, { n: 1 });
    });
    const entries = store.read((txn) => {
      return txnScanAll(txn, prefixRange('k', 10, { type: T, rep: JS }));
    });
    (entries[0][1] as { n: number }).n = 2;
    expect(contents(store)['k1']).toEqual({ n: 1 });
  });

  test('the overlay copies its layer both ways, in gets and in scans', () => {
    const base = seeded('k1');
    const overlay = new Overlay(registry);
    const obj = { n: 1 };
    base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('k2', T, JS, obj);
      }),
    );
    obj.n = 2;
    const read = () =>
      base.read((b) => {
        const txn = overlay.view(b);
        const got = txn.get('k2', T, JS) as { n: number };
        const all = txnScanAll(txn, prefixRange('k', 10, { type: T, rep: JS }));
        return { got, scanned: all[1][1] as { n: number }, base: all[0][1] };
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
    const store = new InMemStore(registry);
    const out = store.write((txn) => {
      txn.set('k', T, JS, 'v');
      return 'done';
    });
    expect(out).toBe('done');
    expect(contents(store)).toEqual({ k: 'v' });
  });

  test('a throw rolls the transaction back, in the store and in the overlay', () => {
    const store = seeded('k1');
    expect(() =>
      store.write((txn) => {
        txn.set('k2', T, JS, 'k2');
        txn.del('k1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(contents(store)).toEqual({ k1: 'k1' });

    const overlay = new Overlay(registry);
    expect(() =>
      store.read((b) =>
        overlay.apply(b, (txn) => {
          txn.set('k2', T, JS, 'k2');
          throw new Error('boom');
        }),
      ),
    ).toThrow('boom');
    expect(overlay.keys()).toEqual([]);
  });

  test('a read transaction has no write methods', () => {
    const store = seeded('k1');
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
          return key;
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
      txn.set('k', T, JS, 1);
      return txn.get('k', T, JS);
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
