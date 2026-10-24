// TESTS.md: Store primitives (every implementation), against InMemStore, the Overlay, and
// ExternalStore

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  compareKeys,
  deepCopy,
  type EditEnvelope,
  ExternalStore,
  type ExternalStoreTxn,
  InMemStore,
  JS,
  type KeyPattern,
  type Lifecycle,
  MSGPACK,
  Overlay,
  type ParamMatch,
  prefixEnd,
  type RTxn,
  scanAll,
  type ScanRequest,
  type Store,
  type WTxn,
} from '../../../ts/assets/skeleton.ts';

import { bytes, ev, INVALID, page, parkedEdit, parkedPage, rawEdit, registry } from './harness.ts';

const T = '.json';

/** a store seeded with these keys, each holding its own name */
function seeded(...keys: string[]): InMemStore {
  const store = new InMemStore(registry);
  store.write((txn) => {
    for (const k of keys) txn.set(k, T, JS, k);
  });
  return store;
}

// every key
const EVERY: KeyPattern = { slice: null, name: null, local: [] };

/** every key in a store and its value */
function contents(store: Store): Record<string, unknown> {
  return store.read((txn) => {
    const keys = scanAll(txn, { pattern: EVERY, limit: 1000, values: false }).map(([k]) => k);
    return Object.fromEntries(keys.map((k) => [k, txn.get(k, T, JS)]));
  });
}

/** the keys of slice s at template k:{id}, by a match on the id */
const ks = (m: ParamMatch = null, slice = 's'): KeyPattern => ({ slice, name: 'k', local: [m] });

/** the keys a scan walks */
function scanKeys(txn: RTxn, req: Omit<ScanRequest, 'limit' | 'values'> & { limit?: number }) {
  return scanAll(txn, { limit: 10, values: false, ...req }).map(([k]) => k);
}

/** the keys a scan of a store walks */
function storeKeys(store: Store, req: Omit<ScanRequest, 'limit' | 'values'> & { limit?: number }) {
  return store.read((txn) => scanKeys(txn, req));
}

// the batches of a walk, each its keys and its next
function batchesOf(txn: RTxn, req: ScanRequest): [string[], string | null][] {
  const out: [string[], string | null][] = [];
  let after = req.after;
  for (;;) {
    const { entries, next } = txn.scan({ ...req, after });
    out.push([entries.map(([k]) => k), next]);
    if (next === null) return out;
    after = next;
  }
}

describe('scan', () => {
  const five = ['s!k:1', 's!k:2', 's!k:3', 's!k:4', 's!k:5'];

  test('closed and open bounds on each side', () => {
    const store = seeded(...five);
    expect(storeKeys(store, { pattern: ks({ gte: '2', lt: '4' }) })).toEqual(['s!k:2', 's!k:3']);
    expect(storeKeys(store, { pattern: ks({ gt: '2', lte: '4' }) })).toEqual(['s!k:3', 's!k:4']);
    expect(storeKeys(store, { pattern: ks({ gte: '4' }) })).toEqual(['s!k:4', 's!k:5']);
    expect(storeKeys(store, { pattern: ks({ lt: '3' }) })).toEqual(['s!k:1', 's!k:2']);
    expect(storeKeys(store, { pattern: ks({ gt: '1', lt: '2' }) })).toEqual([]);
    expect(storeKeys(store, { pattern: ks({ eq: '3' }) })).toEqual(['s!k:3']);
  });

  test("reverse walks descending and resumes before the batch's last key", () => {
    const store = seeded(...five);
    const pattern = ks({ gte: '2', lte: '4' });
    expect(storeKeys(store, { pattern, reverse: true })).toEqual(['s!k:4', 's!k:3', 's!k:2']);
    const batches = store.read((txn) => {
      return batchesOf(txn, { pattern: ks(), reverse: true, limit: 2, values: false });
    });
    expect(batches).toEqual([
      [['s!k:5', 's!k:4'], 's!k:4'],
      [['s!k:3', 's!k:2'], 's!k:2'],
      [['s!k:1'], null],
    ]);
  });

  test('batches of the limit, each naming the key to resume after while more follow', () => {
    const store = seeded(...five);
    const batches = store.read((txn) => batchesOf(txn, { pattern: ks(), limit: 2, values: false }));
    expect(batches).toEqual([
      [['s!k:1', 's!k:2'], 's!k:2'],
      [['s!k:3', 's!k:4'], 's!k:4'],
      [['s!k:5'], null],
    ]);
  });

  test('keys only versus values in a representation', () => {
    const store = seeded('s!k:1', 's!k:2');
    const keysOnly = store.read((txn) => scanAll(txn, { pattern: ks(), limit: 10, values: false }));
    expect(keysOnly).toEqual([
      ['s!k:1', undefined],
      ['s!k:2', undefined],
    ]);
    const withValues = store.read((txn) => {
      return scanAll(txn, { pattern: ks(), limit: 10, values: { type: T, rep: JS } });
    });
    expect(withValues).toEqual([
      ['s!k:1', 's!k:1'],
      ['s!k:2', 's!k:2'],
    ]);
  });

  test('an empty walk, and a walk of every key', () => {
    const store = seeded(...five, 't!k:1');
    const empty = store.read((txn) =>
      txn.scan({ pattern: ks({ gte: '6' }), limit: 10, values: false }),
    );
    expect(empty).toEqual({ entries: [], next: null });
    expect(storeKeys(store, { pattern: EVERY })).toEqual([...five, 't!k:1']);
  });

  test('a batch holds at least one entry', () => {
    const store = seeded(...five);
    for (const limit of [0, NaN]) {
      expect(() => store.read((txn) => txn.scan({ pattern: ks(), limit, values: false }))).toThrow(
        "a scan's limit is at least 1",
      );
    }
  });

  test('a walk of every local key reads keys only', () => {
    const store = seeded(...five);
    const every: KeyPattern = { slice: 's', name: null, local: [] };
    expect(() =>
      store.read((txn) => txn.scan({ pattern: every, limit: 10, values: { type: T, rep: JS } })),
    ).toThrow('a scan of every local key reads keys only');
  });

  test('while writing: a key written ahead of the walk is visited, one behind is not, a key deleted ahead is skipped', () => {
    const store = seeded(...five);
    const seen = store.write((txn) => {
      const first = txn.scan({ pattern: ks(), limit: 1, values: false });
      expect(first.entries.map(([k]) => k)).toEqual(['s!k:1']);
      txn.set('s!k:1a', T, JS, 's!k:1a');
      txn.set('s!k:0', T, JS, 's!k:0');
      txn.del('s!k:3');
      return scanKeys(txn, { pattern: ks(), after: first.next! });
    });
    expect(seen).toEqual(['s!k:1a', 's!k:2', 's!k:4', 's!k:5']);
  });
});

describe('the scan conformance cases', () => {
  type Case = { name: string; pattern: KeyPattern; expect: string[] };
  const fixture = JSON.parse(
    readFileSync(new URL('../../fixtures/scan-conformance.json', import.meta.url), 'utf8'),
  ) as { keys: string[]; cases: Case[] };
  const { keys } = fixture;

  // every walk of a case, whole and resumed at every batch boundary, forward and reversed
  function check(txn: RTxn, c: Case): void {
    const values: ScanRequest['values'] = c.pattern.name === null ? false : { type: T, rep: JS };
    for (const reverse of [false, true]) {
      const want = reverse ? [...c.expect].reverse() : c.expect;
      for (const limit of [1, 2, 3, 1000]) {
        const got = scanAll(txn, { pattern: c.pattern, reverse, limit, values });
        expect(got.map(([k]) => k)).toEqual(want);
        if (values) expect(got.every(([k, v]) => k === v)).toBe(true);
      }
    }
  }

  // the keys at odd places, then the rest
  const half = (odd: boolean) => keys.filter((_, i) => i % 2 === (odd ? 1 : 0));

  test.each(fixture.cases)('$name', (c) => {
    expect.hasAssertions();

    // a store holding them all
    const store = seeded(...[...keys].reverse());
    store.read((txn) => check(txn, c));

    // half of them pending in a write over the other half, which also deletes two stored keys
    const part = seeded(...half(false), 'zz!gone:1', 'chat:acme,gen!post:gone');
    part.write((txn) => {
      for (const k of half(true)) txn.set(k, T, JS, k);
      txn.del('zz!gone:1');
      txn.del('chat:acme,gen!post:gone');
      check(txn, c);
    });

    // half of them in the overlay over the other half, which also deletes two base keys
    const base = seeded(...half(false), 'chat:acme,gen!post:gone', 'chat:ac,gen!meta-gone');
    const overlay = new Overlay(registry);
    base.read((b) =>
      overlay.apply(b, (txn) => {
        for (const k of half(true)) txn.set(k, T, JS, k);
        txn.del('chat:acme,gen!post:gone');
        txn.del('chat:ac,gen!meta-gone');
      }),
    );
    base.read((b) => check(overlay.view(b), c));
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
    const keys = ordered.map((c) => 's!k:' + c);
    const store = seeded(...[...keys].reverse());
    expect(storeKeys(store, { pattern: ks(), limit: 3 })).toEqual(keys);
    expect(storeKeys(store, { pattern: ks(), limit: 3, reverse: true })).toEqual(
      [...keys].reverse(),
    );
    expect(storeKeys(store, { pattern: ks({ gt: '\uFFFF' }), limit: 3 })).toEqual(keys.slice(5));

    // pending writes on either side of the surrogates merge into the base's walk
    const overlay = new Overlay(registry);
    let merged: string[] = [];
    store.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('s!k:\uE001', T, JS, 's!k:\uE001');
        txn.set('s!k:\u{10001}', T, JS, 's!k:\u{10001}');
        merged = scanKeys(txn, { pattern: ks(), limit: 2 });
      }),
    );
    expect(merged).toEqual([
      ...keys.slice(0, 3),
      's!k:\uE001',
      ...keys.slice(3, 6),
      's!k:\u{10001}',
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
    // the keys of x:{day},{channel} slices at reply:{thread},{id}, in the order of their
    // parameters, where a value may be another followed by '-' or '.'
    const days = ['2026-10', '2026-10-06'];
    const channels = ['gen', 'gen-2', 'gen.x'];
    const threads = ['t1', 't1-2'];
    const ids = ['', 'm1', 'm1-2'];
    const slices = days.flatMap((d) => channels.map((c) => `x:${d},${c}`));
    const keys = slices.flatMap((st) =>
      threads.flatMap((t) => ids.map((id) => `${st}!reply:${t},${id}`)),
    );
    const store = seeded(...[...keys].reverse());

    // the family, one slice, and one slice's thread
    const family = { family: 'x', params: [null, null] };
    expect(
      storeKeys(store, {
        pattern: { slice: family, name: 'reply', local: [null, null] },
        limit: 7,
      }),
    ).toEqual(keys);
    const one = 'x:2026-10,gen';
    expect(
      storeKeys(store, { pattern: { slice: one, name: 'reply', local: [null, null] }, limit: 7 }),
    ).toEqual(keys.filter((k) => k.startsWith(`${one}!`)));
    const thread: KeyPattern = { slice: one, name: 'reply', local: [{ eq: 't1' }, null] };
    expect(storeKeys(store, { pattern: thread, limit: 7 })).toEqual(
      ids.map((id) => `${one}!reply:t1,${id}`),
    );

    // slice names alone sort the same way
    expect([...slices].reverse().sort(compareKeys)).toEqual(slices);
  });

  test('a prefix match holds exactly the values that start with it', () => {
    const prefixes = ['\uD7FF', '\uFFFF', '\u{1F600}', '\u{10FFFF}'];
    const values = ordered.flatMap((a) => ordered.map((b) => a + b));
    const store = seeded(...values.map((v) => `s!k:${v}`));
    for (const p of prefixes) {
      const under = values.filter((v) => v.startsWith(p)).map((v) => `s!k:${v}`);
      expect(storeKeys(store, { pattern: ks({ prefix: p }), limit: 4 })).toEqual(
        under.sort(compareKeys),
      );
    }
  });
});

describe('delPrefix', () => {
  test('delPrefix reports exactly the keys deleted and nothing outside the prefix moves', () => {
    const store = seeded('p/1', 'p/2', 'pq/1', 'q/1');
    const deleted = store.write((txn) => {
      return txn.delPrefix('p/');
    });
    expect(deleted).toEqual(['p/1', 'p/2']);
    expect(contents(store)).toEqual({ 'pq/1': 'pq/1', 'q/1': 'q/1' });
  });

  test('it sees the keys a transaction wrote and not the ones it deleted', () => {
    const store = seeded('p/1', 'p/2');
    const deleted = store.write((txn) => {
      txn.set('p/0', T, JS, 'p/0');
      txn.del('p/2');
      return txn.delPrefix('p/');
    });
    expect(deleted).toEqual(['p/0', 'p/1']);
    expect(contents(store)).toEqual({});
  });
});

describe('applying edits', () => {
  // an edit of slice s at a seq, writing ops, normal unless told
  const edit = (seq: number, ops: [string, unknown][], lifecycle: Lifecycle = 'normal') => {
    const env: EditEnvelope = {
      position: 10 + seq,
      slice: 's',
      seq,
      id: `m${seq}`,
      servertime: new Date(0),
      lifecycle,
    };
    return { ...env, raw: rawEdit(env, ops) };
  };

  test('an edit sets and deletes keys in order, and answers the keys it changed', () => {
    const store = seeded('s!a', 's!b');
    const changed = store.write((txn) =>
      txn.applyEdits([
        edit(1, [
          ['s!a', 'a2'],
          ['s!b', undefined],
          ['s!c', null],
        ]),
        edit(2, [['s!d', 'd']]),
      ]),
    );
    expect(changed).toEqual(['s!a', 's!b', 's!c', 's!d']);
    expect(contents(store)).toEqual({ 's!a': 'a2', 's!c': null, 's!d': 'd' });
  });

  test("a birth deletes the slice's keys before its writes, and no other slice's", () => {
    const store = seeded('s!a', 's!b', 'sx!a', 't!a');
    const changed = store.write((txn) => txn.applyEdits([edit(1, [['s!b', 'b2']], 'birth')]));
    expect(changed.sort()).toEqual(['s!a', 's!b']);
    expect(contents(store)).toEqual({ 's!b': 'b2', 'sx!a': 'sx!a', 't!a': 't!a' });
  });

  test("a death deletes the slice's keys, and one that writes throws", () => {
    const store = seeded('s!a', 's!b', 't!a');
    const changed = store.write((txn) => txn.applyEdits([edit(1, [], 'death')]));
    expect(changed.sort()).toEqual(['s!a', 's!b']);
    expect(contents(store)).toEqual({ 't!a': 't!a' });
    expect(() => store.write((txn) => txn.applyEdits([edit(2, [['s!a', 1]], 'death')]))).toThrow(
      'a death of s writes "s!a"',
    );
  });

  test("an edit that writes outside its slice throws, and so does an opcode the store doesn't know", () => {
    const store = seeded();
    expect(() => store.write((txn) => txn.applyEdits([edit(1, [['t!a', 1]])]))).toThrow(
      'an edit of s writes "t!a"',
    );
    const bad = { ...edit(1, []), raw: bytes([[11, 's', 1, 'm', 0, false], 7, 's!a']) };
    expect(() => store.write((txn) => txn.applyEdits([bad]))).toThrow('unknown opcode 7');
    expect(contents(store)).toEqual({});
  });

  test("applyParked applies a slice's parked edits from a seq on, in seq order, and leaves them parked", () => {
    const store = seeded('s!a');
    store.write((txn) => {
      for (const e of [
        edit(1, [['s!x', 1]]),
        edit(2, [['s!b', 'b']], 'birth'),
        edit(3, [['s!b', 'b3']]),
        edit(4, [['s!c', 'c']]),
      ]) {
        txn.set(parkedEdit('s', e.seq), '.edits', MSGPACK, e.raw);
      }
      txn.set(parkedEdit('sx', 1), '.edits', MSGPACK, edit(1, [['s!z', 1]]).raw);
    });
    const changed = store.write((txn) => txn.applyParked('s', 2));
    expect(changed.sort()).toEqual(['s!a', 's!b', 's!c']);
    const data = contents(store);
    expect(Object.keys(data).filter((k) => !k.startsWith('!'))).toEqual(['s!b', 's!c']);
    expect(data['s!b']).toBe('b3');
    expect(Object.keys(data).filter((k) => k.startsWith('!park-edit:s!'))).toHaveLength(4);
  });

  test('a parked edit reads as its envelope, as often as it is read, and as its bytes in msgpack', () => {
    const store = seeded();
    const e = edit(3, [['s!a', 1]], 'birth');
    store.write((txn) => txn.set(parkedEdit('s', 3), '.edits', MSGPACK, e.raw));
    const read = () => store.read((txn) => txn.get(parkedEdit('s', 3), '.edits', JS));
    const { raw: _, ...env } = e;
    expect(read()).toEqual(env);
    expect(read()).toEqual(env);
    const raw = store.read((txn) => txn.get(parkedEdit('s', 3), '.edits', MSGPACK));
    expect(raw).toEqual(e.raw);
  });

  test("applySnapshot applies a selector's pages in order, skipping the slices it is told to", () => {
    const store = seeded('s1!old', 's2!kept');
    store.write((txn) => {
      txn.set(
        parkedPage('s*', 0),
        '.page',
        MSGPACK,
        page([
          ['s1!a', 1],
          ['s2!a', 1],
        ]),
      );
      txn.set(
        parkedPage('s*', 2),
        '.page',
        MSGPACK,
        page([
          ['s1!a', 2],
          ['s3!a', 3],
        ]),
      );
      txn.set(parkedPage('t', 0), '.page', MSGPACK, page([['t!a', 1]]));
    });
    const changed = store.write((txn) => txn.applySnapshot('s*', ['s2']));
    expect(changed.sort()).toEqual(['s1!a', 's3!a']);
    const data = contents(store);
    expect(data).toMatchObject({ 's1!a': 2, 's1!old': 's1!old', 's2!kept': 's2!kept', 's3!a': 3 });
    expect(data['s2!a']).toBeUndefined();
    expect(data['t!a']).toBeUndefined();
  });

  test('a snapshot page holding a key outside its selector throws', () => {
    const store = seeded();
    store.write((txn) => txn.set(parkedPage('s', 0), '.page', MSGPACK, page([['t!a', 1]])));
    expect(() => store.write((txn) => txn.applySnapshot('s', []))).toThrow(
      'the snapshot of s holds "t!a"',
    );
  });

  test("applied bytes decode on read with the reader's type, and the decoded value takes their place", () => {
    let decodes = 0;
    const counting = {
      ...registry,
      convert: (...a: Parameters<typeof registry.convert>) => {
        if (a[2] === MSGPACK && a[3] === JS) decodes++;
        return registry.convert(...a);
      },
    };
    const store = new InMemStore(counting);
    store.write((txn) => txn.applyEdits([edit(1, [['s!a', { n: 1 }]])]));
    expect(decodes).toBe(0);
    const read = () => store.read((txn) => txn.get('s!a', T, JS) as { n: number });
    const first = read();
    first.n = 2;
    expect(read()).toEqual({ n: 1 });
    expect(decodes).toBe(1);
    expect(store.read((txn) => txn.get('s!a', T, MSGPACK))).toEqual(bytes({ n: 1 }));
  });

  test('a value that fails to decode is an error naming its key, in dev mode', () => {
    const store = seeded();
    store.write((txn) => txn.applyEdits([edit(1, [['s!a', { type: INVALID }]])]));
    expect(() => store.read((txn) => txn.get('s!a', T, JS))).toThrow('s!a: $.type: invalid');
  });

  test('a harness edit applies its log key', () => {
    const store = seeded();
    store.write((txn) => txn.applyEdits([ev('patron:p1', 4, 11)]));
    expect(Object.keys(contents(store))).toEqual(['patron:p1!log:000004']);
  });
});

describe('a store of many keys', () => {
  // a seeded random integer below n
  let seed = 1;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return Math.floor((seed / 4294967296) * n);
  };

  // a fresh id, now and then holding code points the native order gets wrong
  const freshId = () => {
    const tail = ['', '', '', '\u{1F600}', '\uFF0C'][rand(5)];
    return `${String(rand(1e9)).padStart(9, '0')}${tail}`;
  };
  const fresh = () => `s!k:${freshId()}`;

  // a random match on the id over the reference's ids, with any mix of bounds on either side
  function randomMatch(ids: string[]): ParamMatch {
    const pick = () => (ids.length > 0 && rand(4) > 0 ? ids[rand(ids.length)] : freshId());
    const m: { gte?: string; gt?: string; lte?: string; lt?: string } = {};
    const lower = rand(4);
    if (lower & 1) m.gte = pick();
    if (lower & 2) m.gt = pick();
    const upper = rand(4);
    if (upper & 1) m.lt = pick();
    if (upper & 2) m.lte = pick();
    return m;
  }

  // the keys a match picks out, from the reference's keys in walk order
  function expected(sorted: string[], m: ParamMatch, reverse: boolean): string[] {
    const r = m as { gte?: string; gt?: string; lte?: string; lt?: string };
    const inside = sorted.filter((k) => {
      const id = k.slice('s!k:'.length);
      return (
        (r.gte === undefined || compareKeys(id, r.gte) >= 0) &&
        (r.gt === undefined || compareKeys(id, r.gt) > 0) &&
        (r.lt === undefined || compareKeys(id, r.lt) < 0) &&
        (r.lte === undefined || compareKeys(id, r.lte) <= 0)
      );
    });
    return reverse ? inside.reverse() : inside;
  }

  // check random walks of txn against the reference
  function checkWalks(txn: RTxn, keys: Set<string>): void {
    const sorted = [...keys].sort(compareKeys);
    const ids = sorted.map((k) => k.slice('s!k:'.length));
    for (let i = 0; i < 4; i++) {
      const m = randomMatch(ids);
      const reverse = rand(2) === 0;
      const got = scanKeys(txn, { pattern: ks(m), reverse, limit: 1 + rand(60) });
      expect(got).toEqual(expected(sorted, m, reverse));
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
        checkWalks(txn, new Set([...keys, ...add].filter((k) => !gone.has(k))));
      });
      for (const k of add) keys.add(k);
      for (const k of drop) keys.delete(k);
      store.read((txn) => checkWalks(txn, keys));
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
    const name = (i: number) => `s!k:${String(i).padStart(4, '0')}`;

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

  test('delPrefix covers every key under the prefix across blocks', () => {
    const names = Array.from({ length: 5000 }, (_, i) => String(i).padStart(5, '0'));
    const store = seeded(...names.map((n) => `a/${n}`), ...names.map((n) => `b/${n}`));
    const deleted = store.write((txn) => txn.delPrefix('a/'));
    expect(deleted).toEqual(names.map((n) => `a/${n}`));
    const after = contents(store);
    expect(Object.keys(after)).toEqual(names.map((n) => `b/${n}`));
    expect(after['b/04999']).toBe('b/04999');
  });
});

describe('overlay', () => {
  test('refuses to apply edits, which no prediction does', () => {
    const base = seeded('s!k:1');
    const overlay = new Overlay(registry);
    expect(() => base.read((b) => overlay.apply(b, (txn) => txn.applyEdits([])))).toThrow(
      'the overlay applies no edits',
    );
  });

  test('answers the keys a scratch layer wrote, deletions included', () => {
    const base = seeded('s!k:1');
    const overlay = new Overlay(registry);
    const written = base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('s!k:2', T, JS, 's!k:2');
        txn.del('s!k:1');
      }),
    );
    expect(written.sort()).toEqual(['s!k:1', 's!k:2']);
  });

  test('deletes whole slices, from the base and its own layers', () => {
    const base = seeded('s!k:1', 's!m', 'sx!k:1', 't!k:1');
    const overlay = new Overlay(registry);
    let deleted: string[] = [];
    base.read((b) =>
      overlay.apply(b, (txn: WTxn) => {
        txn.set('s!k:2', T, JS, 's!k:2');
        deleted = txn.delPrefix('s!');
      }),
    );
    expect(deleted).toEqual(['s!k:1', 's!k:2', 's!m']);
    expect(base.read((b) => scanKeys(overlay.view(b), { pattern: EVERY }))).toEqual([
      'sx!k:1',
      't!k:1',
    ]);
    expect(() => base.read((b) => overlay.apply(b, (txn) => txn.delPrefix('s!k:')))).toThrow(
      'the overlay deletes whole slices, not s!k:',
    );
  });

  test('scan answers with pending writes merged in and pending deletes removed', () => {
    const base = seeded('s!k:1', 's!k:2', 's!k:3');
    const overlay = new Overlay(registry);
    let inside: [string, unknown][] = [];
    base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('s!k:4', T, JS, 's!k:4');
        txn.del('s!k:2');
        inside = scanAll(txn, { pattern: ks(), limit: 10, values: { type: T, rep: JS } });
      }),
    );
    expect(inside).toEqual([
      ['s!k:1', 's!k:1'],
      ['s!k:3', 's!k:3'],
      ['s!k:4', 's!k:4'],
    ]);
    const after = base.read((b) => scanKeys(overlay.view(b), { pattern: ks() }));
    expect(after).toEqual(['s!k:1', 's!k:3', 's!k:4']);
    expect(storeKeys(base, { pattern: ks() })).toEqual(['s!k:1', 's!k:2', 's!k:3']);
    const gone = base.read((b) => overlay.view(b).get('s!k:2', T, JS));
    expect(gone).toBeUndefined();
  });

  test('a base batch the overlay deletes entirely still resumes the walk past it', () => {
    const base = seeded('s!k:1', 's!k:2', 's!k:3', 's!k:4');
    const overlay = new Overlay(registry);
    base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.del('s!k:1');
        txn.del('s!k:2');
      }),
    );
    const batches = base.read((b) => {
      return batchesOf(overlay.view(b), { pattern: ks(), limit: 2, values: false });
    });
    expect(batches).toEqual([
      [[], 's!k:2'],
      [['s!k:3', 's!k:4'], null],
    ]);
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
      txn.set('s!k:1', T, JS, { n: 1 });
    });
    const entries = store.read((txn) => {
      return scanAll(txn, { pattern: ks(), limit: 10, values: { type: T, rep: JS } });
    });
    (entries[0][1] as { n: number }).n = 2;
    expect(contents(store)['s!k:1']).toEqual({ n: 1 });
  });

  test('the overlay copies its layer both ways, in gets and in scans', () => {
    const base = seeded('s!k:1');
    const overlay = new Overlay(registry);
    const obj = { n: 1 };
    base.read((b) =>
      overlay.apply(b, (txn) => {
        txn.set('s!k:2', T, JS, obj);
      }),
    );
    obj.n = 2;
    const read = () =>
      base.read((b) => {
        const txn = overlay.view(b);
        const got = txn.get('s!k:2', T, JS) as { n: number };
        const all = scanAll(txn, { pattern: ks(), limit: 10, values: { type: T, rep: JS } });
        return { got, scanned: all[1][1] as { n: number }, base: all[0][1] };
      });
    const first = read();
    expect(first).toEqual({ got: { n: 1 }, scanned: { n: 1 }, base: 's!k:1' });
    first.got.n = 3;
    first.scanned.n = 4;
    expect(read()).toEqual({ got: { n: 1 }, scanned: { n: 1 }, base: 's!k:1' });
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
        applyEdits: () => [],
        applyParked: () => [],
        applySnapshot: () => [],
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
