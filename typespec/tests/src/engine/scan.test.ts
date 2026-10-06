// Scans through the query context and the reducer context: what a query's scan depends on, the
// parameters a walk yields, a scan's lifetime, and a reducer's scans of its own stream

import { describe, expect, test } from 'vitest';

import {
  InMemStore,
  JS,
  type KeyPattern,
  QueryGraph,
  type ReadTxn,
  type ReducerTxn,
  scanEach,
  scanEachLocal,
  type ScanRequest,
  type SliceReducer,
} from '../../../ts/assets/skeleton.ts';

import { type Blob, bootstrap, ev, registry, rig, settle } from './harness.ts';

const T = '.json';

/** a store seeded with these keys, each holding its own name */
function seeded(...keys: string[]): InMemStore {
  const store = new InMemStore(registry);
  store.write((txn) => {
    for (const k of keys) txn.set(k, T, JS, k);
  });
  return store;
}

/** a graph over a store, each query reading through the bare ReadTxn, and a way to commit a
    write, mark what it wrote, and run the graph */
function graphOver(store: InMemStore) {
  const graph = new QueryGraph<ReadTxn>((txn) => txn);
  const run = () => store.read((txn) => graph.run(txn))();
  const write = (set: string[], del: string[] = []) => {
    store.write((txn) => {
      for (const k of set) txn.set(k, T, JS, k);
      for (const k of del) txn.del(k);
    });
    graph.dirty(Object.fromEntries([...set, ...del].map((k) => [k, true as const])));
    run();
  };
  return { graph, run, write };
}

/** a query of every key a pattern picks out, counting its runs */
function counted(graph: QueryGraph<ReadTxn>, pattern: KeyPattern, stopAfter = Infinity) {
  const counter = { runs: 0 };
  const query = graph.newQuery((txn) => {
    counter.runs++;
    const keys: string[] = [];
    for (const [params] of scanEach(txn, { pattern, type: false })) {
      keys.push(params.join(' '));
      if (keys.length >= stopAfter) break;
    }
    return keys;
  });
  return { query, counter };
}

const posts = (org: string | null): KeyPattern => ({
  stream: { family: 'chat', params: [org === null ? null : { eq: org }, null] },
  name: 'post',
  local: [null],
});

describe("a query's scans", () => {
  test('a write inside what a scan walked dirties the query; one outside it or unmatched does not', () => {
    const store = seeded('chat:acme,gen!post:1', 'chat:acme,gen!post:3', 'chat:beta,gen!post:1');
    const { graph, run, write } = graphOver(store);
    const { query, counter } = counted(graph, posts('acme'));
    run();
    expect(query.latest).toEqual(['acme gen 1', 'acme gen 3']);

    // another org, another template in the walked stream, and a key the pattern skips
    write(['chat:beta,gen!post:2', 'chat:acme,gen!meta', 'chat:acme,gen!post-x:1']);
    expect(counter.runs).toBe(1);

    // a new post between the two, and a deletion of one
    write(['chat:acme,gen!post:2']);
    expect(counter.runs).toBe(2);
    expect(query.latest).toEqual(['acme gen 1', 'acme gen 2', 'acme gen 3']);
    write([], ['chat:acme,gen!post:1']);
    expect(query.latest).toEqual(['acme gen 2', 'acme gen 3']);
  });

  test('a stream created after the walk dirties a pattern over its family', () => {
    const store = seeded('chat:acme,gen!post:1');
    const { graph, run, write } = graphOver(store);
    const { query } = counted(graph, posts(null));
    run();
    write(['chat:acme,gen-2!post:1', 'chat:zeta,a!post:1']);
    expect(query.latest).toEqual(['acme gen 1', 'acme gen-2 1', 'zeta a 1']);
  });

  test('a query that stopped early depends only on the batches it fetched', () => {
    // more posts than the first batch of 16 holds
    const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0'));
    const store = seeded(...ids.map((id) => `chat:acme,gen!post:${id}`));
    const { graph, run, write } = graphOver(store);
    const { query, counter } = counted(graph, posts('acme'), 1);
    run();
    expect(query.latest).toEqual(['acme gen 00']);

    // past the first batch, nothing it read changed
    write(['chat:acme,gen!post:30a']);
    expect(counter.runs).toBe(1);

    // inside it, the query runs again
    write(['chat:acme,gen!post:05a']);
    expect(counter.runs).toBe(2);
  });

  test('a walk over several batches depends on all of them, as one stretch', () => {
    // the walk fetches 16, then 32, so its read reaches past the first batch
    const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0'));
    const store = seeded(...ids.map((id) => `chat:acme,gen!post:${id}`));
    const { graph, run, write } = graphOver(store);
    const { query, counter } = counted(graph, posts('acme'));
    run();
    expect(query.latest).toHaveLength(40);

    // a key of another template inside the stretch, then a post inside the second batch
    write(['chat:acme,gen!meta']);
    expect(counter.runs).toBe(1);
    write(['chat:acme,gen!post:30a']);
    expect(counter.runs).toBe(2);
    expect(query.latest).toHaveLength(41);
  });

  test('a scan yields the template parameters in order, stream ones first, the last holding the rest', () => {
    const store = seeded(
      'chat:acme,gen!reply:t1,a,b!c',
      'chat:acme,gen!reply:t1,',
      'chat:acme,gen-2!reply:t2,z',
    );
    const pattern: KeyPattern = {
      stream: { family: 'chat', params: [{ eq: 'acme' }, null] },
      name: 'reply',
      local: [null, null],
    };
    const got = store.read((txn) => [...scanEach(readOf(txn), { pattern, type: T })]);
    expect(got).toEqual([
      [['acme', 'gen', 't1', ''], 'chat:acme,gen!reply:t1,'],
      [['acme', 'gen', 't1', 'a,b!c'], 'chat:acme,gen!reply:t1,a,b!c'],
      [['acme', 'gen-2', 't2', 'z'], 'chat:acme,gen-2!reply:t2,z'],
    ]);
  });

  test('a scan carried out of its query throws rather than reading on', () => {
    const store = seeded('chat:acme,gen!post:1', 'chat:acme,gen!post:2');
    const { graph, run } = graphOver(store);
    const query = graph.newQuery((txn) => scanEach(txn, { pattern: posts('acme'), type: T }));
    run();
    expect(() => query.latest!.next()).toThrow(
      'a scan was used after its query or forecast returned',
    );
  });

  test('in dev mode a scanned value is read-only, as a got one is', () => {
    const store = new InMemStore(registry);
    store.write((txn) => txn.set('chat:acme,gen!post:1', T, JS, { n: 1 }));
    const { graph, run } = graphOver(store);
    graph.newQuery((txn) => {
      for (const [, value] of scanEach(txn, { pattern: posts('acme'), type: T })) {
        (value as { n: number }).n = 2;
      }
    });
    expect(run).toThrow('chat:acme,gen!post:1.n is read-only');
  });
});

// a ReadTxn over a store transaction, as the Engine hands one to a query
function readOf(txn: Parameters<Parameters<InMemStore['read']>[0]>[0]): ReadTxn {
  return {
    get: (key, type) => txn.get(key, type, JS),
    scan: (req) => {
      const values: ScanRequest['values'] =
        req.type === false ? false : { type: req.type, rep: JS };
      return txn.scan({ ...req, values });
    },
  };
}

describe("a reducer's scans", () => {
  const held: Blob = {
    position: 10,
    seqs: { 'patron:p1': 1, 'patron:p2': 1 },
    values: [
      ['patron:p1!item:a', { count: 1, fields: {} }],
      ['patron:p1!item:c', { count: 1, fields: {} }],
      ['patron:p2!item:b', { count: 1, fields: {} }],
    ],
  };

  test('a reducer walks only its own stream, keyed locally, and sees its own writes', async () => {
    const seen: string[][] = [];
    const scanner: SliceReducer = {
      template: 'patron:{id}',
      keys: ['item:{name}'],
      reducer(txn: ReducerTxn): void {
        txn.set('item:b', 'state', { count: 1, fields: {} });
        txn.del('item:c');
        const items = [...scanEachLocal(txn, { name: 'item', local: [null], type: 'state' })];
        seen.push(items.map(([[name]]) => name));
        const raw = txn.scan({ name: 'item', local: [null], type: false, limit: 10 });
        seen.push(raw.entries.map(([k]) => k));
      },
    };
    const r = rig({ reducers: { patron: scanner } });
    await bootstrap(r, ['patron:*'], { 'patron:*': held });
    r.server.events(ev('patron:p1', 2, 11));
    await settle();
    expect(seen).toEqual([
      ['a', 'b'],
      ['item:a', 'item:b'],
    ]);
  });
});
