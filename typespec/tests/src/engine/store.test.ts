// TESTS.md: Store primitives (every implementation), against InMemStore and OverlayStore

import { describe, expect, test } from 'vitest';

import {
  InMemStore,
  JS,
  OverlayStore,
  prefixRange,
  resumeRange,
  type Store,
  type StoreRange,
  type StoreValue,
  txnDel,
  txnDelPrefix,
  txnGet,
  txnMove,
  txnScan,
  txnScanAll,
  txnSet,
  withRTxn,
  withWTxn,
} from '../../../ts/assets/skeleton.ts';

import { fx, registry, run } from './harness.ts';

const T = '.json';
const js = (v: unknown): StoreValue => ({ [JS]: v });
const asJs = (v: StoreValue | undefined): unknown =>
  (v as Record<number, unknown> | undefined)?.[JS];

/** a store seeded with these keys, each holding its own name */
function seeded(data: Record<string, unknown>, ...keys: string[]): InMemStore {
  const store = new InMemStore(registry, data);
  run(
    withWTxn(fx(), store, function* () {
      for (const k of keys) yield* txnSet(k, T, js(k));
    }),
  );
  return store;
}

function scanKeys(store: Store, range: StoreRange): string[] {
  return run(
    withRTxn(fx(), store, function* () {
      return (yield* txnScanAll(range)).map(([k]) => k);
    }),
  );
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
    const batches = run(
      withRTxn(fx(), store, function* () {
        const out: [string[], string | null][] = [];
        let range: StoreRange = { reverse: true, limit: 2, values: false };
        for (;;) {
          const { entries, next } = yield* txnScan(range);
          out.push([entries.map(([k]) => k), next]);
          if (next === null) return out;
          range = resumeRange(range, next);
        }
      }),
    );
    expect(batches).toEqual([
      [['k5', 'k4'], 'k4'],
      [['k3', 'k2'], 'k2'],
      [['k1'], null],
    ]);
  });

  test('limit batching with next', () => {
    const store = seeded({}, ...five);
    const batches = run(
      withRTxn(fx(), store, function* () {
        const out: [string[], string | null][] = [];
        let range: StoreRange = prefixRange('k', 2, false);
        for (;;) {
          const { entries, next } = yield* txnScan(range);
          out.push([entries.map(([k]) => k), next]);
          if (next === null) return out;
          range = resumeRange(range, next);
        }
      }),
    );
    expect(batches).toEqual([
      [['k1', 'k2'], 'k2'],
      [['k3', 'k4'], 'k4'],
      [['k5'], null],
    ]);
  });

  test('keys only versus values with a want', () => {
    const store = seeded({}, 'k1', 'k2');
    const keysOnly = run(
      withRTxn(fx(), store, function* () {
        return yield* txnScanAll(prefixRange('k', 10, false));
      }),
    );
    expect(keysOnly).toEqual([
      ['k1', undefined],
      ['k2', undefined],
    ]);
    const withValues = run(
      withRTxn(fx(), store, function* () {
        return yield* txnScanAll(prefixRange('k', 10, { type: T, want: JS }));
      }),
    );
    expect(withValues.map(([k, v]) => [k, asJs(v)])).toEqual([
      ['k1', 'k1'],
      ['k2', 'k2'],
    ]);
  });

  test('an empty range, and a range covering the whole store', () => {
    const store = seeded({}, ...five);
    const empty = run(
      withRTxn(fx(), store, function* () {
        return yield* txnScan({ gte: 'z', limit: 10, values: false });
      }),
    );
    expect(empty).toEqual({ entries: [], next: null });
    expect(scanKeys(store, prefixRange('', 10, false))).toEqual(five);
  });

  test('while writing: a key written above the cursor is visited, one below is not, a deleted key ahead is skipped', () => {
    const store = seeded({}, ...five);
    const seen = run(
      withWTxn(fx(), store, function* () {
        const first = yield* txnScan(prefixRange('k', 1, false));
        expect(first.entries.map(([k]) => k)).toEqual(['k1']);
        yield* txnSet('k1a', T, js('k1a'));
        yield* txnSet('k0', T, js('k0'));
        yield* txnDel('k3');
        const rest = yield* txnScanAll(resumeRange(prefixRange('k', 10, false), first.next!));
        return rest.map(([k]) => k);
      }),
    );
    expect(seen).toEqual(['k1a', 'k2', 'k4', 'k5']);
  });
});

describe('delPrefix and move', () => {
  test('delPrefix reports exactly the keys deleted and nothing outside the prefix moves', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'p/2', 'pq/1', 'q/1');
    const deleted = run(
      withWTxn(fx(), store, function* () {
        return yield* txnDelPrefix('p/');
      }),
    );
    expect(deleted).toEqual(['p/1', 'p/2']);
    expect(Object.keys(data).sort()).toEqual(['pq/1', 'q/1']);
    expect(data['q/1']).toBe('q/1');
  });

  test('move rekeys every key under the prefix, reports the keys as they now exist, and leaves the source empty', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'p/2', 'q/1');
    const moved = run(
      withWTxn(fx(), store, function* () {
        return yield* txnMove('p/', 'r/');
      }),
    );
    expect(moved).toEqual(['r/1', 'r/2']);
    expect(Object.keys(data).sort()).toEqual(['q/1', 'r/1', 'r/2']);
    expect(data['r/1']).toBe('p/1');
    expect(data['r/2']).toBe('p/2');
  });

  test('move into an occupied destination overwrites key by key', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, 'p/1', 'r/1', 'r/3');
    run(
      withWTxn(fx(), store, function* () {
        yield* txnMove('p/', 'r/');
      }),
    );
    expect(Object.keys(data).sort()).toEqual(['r/1', 'r/3']);
    expect(data['r/1']).toBe('p/1');
    expect(data['r/3']).toBe('r/3');
  });

  test('move to the empty prefix lands keys at their remainder', () => {
    const data: Record<string, unknown> = {};
    const store = seeded(data, '/park.kv.x/a/1', '/park.kv.x/b/1');
    const moved = run(
      withWTxn(fx(), store, function* () {
        return yield* txnMove('/park.kv.x/', '');
      }),
    );
    expect(moved).toEqual(['a/1', 'b/1']);
    expect(Object.keys(data).sort()).toEqual(['a/1', 'b/1']);
    expect(data['a/1']).toBe('/park.kv.x/a/1');
  });
});

describe('overlay', () => {
  test('scan answers with pending writes merged in and pending deletes removed', () => {
    const base = seeded({}, 'k1', 'k2', 'k3');
    const overlay = new OverlayStore(base, registry);
    const inside = run(
      withWTxn(fx(), overlay, function* () {
        yield* txnSet('k4', T, js('k4'));
        yield* txnDel('k2');
        return (yield* txnScanAll(prefixRange('k', 10, { type: T, want: JS }))).map(([k, v]) => [
          k,
          asJs(v),
        ]);
      }),
    );
    expect(inside).toEqual([
      ['k1', 'k1'],
      ['k3', 'k3'],
      ['k4', 'k4'],
    ]);
    const after = run(
      withRTxn(fx(), overlay, function* () {
        return (yield* txnScanAll(prefixRange('k', 10, false))).map(([k]) => k);
      }),
    );
    expect(after).toEqual(['k1', 'k3', 'k4']);
    expect(scanKeys(base, prefixRange('k', 10, false))).toEqual(['k1', 'k2', 'k3']);
    const gone = run(
      withRTxn(fx(), overlay, function* () {
        return yield* txnGet('k2', T);
      }),
    );
    expect(gone).toBeUndefined();
  });
});
