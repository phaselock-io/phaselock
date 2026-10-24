// A skeleton-only harness for the Engine: an in-memory store, a registry whose "msgpack" is
// UTF-8 JSON (the Engine never looks inside the bytes), two slice types whose edits each write a
// log key, so a test can fold what was applied and in what order, and a scripted transport the
// test drives frame by frame.

import { vi } from 'vitest';

import {
  $engineStatus,
  type Backfill,
  type BackfillOutcome,
  type Connection,
  type ConnectionHooks,
  type ConnectionStatus,
  type EditEnvelope,
  type EditOp,
  Engine,
  type Predictor as EnginePredictor,
  type EngineStatus,
  InMemStore,
  JS,
  type Lifecycle,
  MSGPACK,
  type Mutation,
  type MutationResult,
  type OutboxStatus,
  type ProgressStatus,
  type ReadTxn,
  type Registry,
  type Rep,
  scanAll,
  scanEach,
  type Schema,
  type Session,
  type Signal,
  type Store,
  type Transport,
  unboundRef,
  type WireEdit,
  type WriteTxn,
} from '../../../ts/assets/skeleton.ts';

// bytes /////////////////////////////////////////////////////////////////////

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytes = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
export const parse = (b: Uint8Array): unknown => JSON.parse(dec.decode(b));

/* A raw edit is the JSON of [envelope, ...payload], the payload flat as on the wire: 0, key,
   value sets a key and 1, key deletes one.  The envelope's server time is in milliseconds, and
   its lifecycle 0, 1, or 2 as on the wire.  A snapshot page is the JSON of its set operations
   alone. */
type Env = [number, string, number, string, number, number];

const LIFECYCLES: Lifecycle[] = ['normal', 'birth', 'death'];

function envelopeOf(env: Env): EditEnvelope {
  const [position, slice, seq, id, ms, life] = env;
  const lifecycle = LIFECYCLES[life];
  if (lifecycle === undefined) throw new Error(`unknown lifecycle ${life}`);
  return { position, slice, seq, id, servertime: new Date(ms), lifecycle };
}

/** a raw edit from its envelope and its operations */
export function rawEdit(e: EditEnvelope, ops: [string, unknown][]): Uint8Array {
  const life = LIFECYCLES.indexOf(e.lifecycle);
  const env: Env = [e.position, e.slice, e.seq, e.id, e.servertime.getTime(), life];
  return bytes([env, ...flatOps(ops)]);
}

/** a snapshot page of set operations */
export function page(sets: [string, unknown][]): Uint8Array {
  return bytes(flatOps(sets));
}

// operations flat, a set of undefined being a deletion
function flatOps(ops: [string, unknown][]): unknown[] {
  return ops.flatMap(([k, v]) => (v === undefined ? [1, k] : [0, k, v]));
}

// registry //////////////////////////////////////////////////////////////////

/** the registry rejects a value with this type, standing in for one that fails its schema */
export const INVALID = 'invalid';

export const registry: Registry = {
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown {
    if (from === to) return value;
    if (from === MSGPACK && to === JS) {
      const raw = parse(value as Uint8Array);
      if (type === '.edits') return envelopeOf((raw as [Env])[0]);
      if ((raw as { type?: string } | null)?.type === INVALID) throw new Error('$.type: invalid');
      return raw;
    }
    if (from === JS && to === MSGPACK) {
      if (type === '.edits') throw new Error('.edits converts from msgpack only');
      return bytes(value);
    }
    throw new Error(`no conversion from ${from} to ${to}`);
  },
  ops(b: Uint8Array, edit: boolean): EditOp[] {
    const items = parse(b) as unknown[];
    const out: EditOp[] = [];
    let i = edit ? 1 : 0;
    while (i < items.length) {
      const op = items[i++];
      if (op === 0) {
        out.push([items[i] as string, bytes(items[i + 1])]);
        i += 2;
      } else if (op === 1) {
        out.push([items[i] as string, undefined]);
        i += 1;
      } else {
        throw new Error(`unknown opcode ${String(op)}`);
      }
    }
    return out;
  },
  mutations: 'mutation',
};

// model /////////////////////////////////////////////////////////////////////

/** what an edit records: which instance of the family, and what it does to the folded state */
export type TestEdit =
  | { id: string; type: 'set'; field: string; value: unknown }
  | { id: string; type: 'bump' }
  | { id: string; type: 'noop' }
  | { id: string; type: 'boom' }
  | { id: string; type: typeof INVALID };

export type State = { count: number; fields: Record<string, unknown> };

/** the log key an edit at a seq writes, its seq zero-padded so the log folds in order */
export const logKey = (slice: string, seq: number): string =>
  `${slice}!log:${String(seq).padStart(6, '0')}`;

/** a slice's state: its snapshot state, or empty when only edits wrote it, with every logged
    edit folded on in key order; undefined when the slice holds neither */
export function fold(base: State | undefined, entries: TestEdit[]): State | undefined {
  if (base === undefined && entries.length === 0) return undefined;
  const s = JSON.parse(JSON.stringify(base ?? { count: 0, fields: {} })) as State;
  for (const e of entries) {
    if (e.type === 'set') s.fields[e.field] = e.value;
    if (e.type === 'bump') s.count++;
  }
  return s;
}

const label = (e: TestEdit): string =>
  e.type === 'set' ? `set ${e.field}=${String(e.value)}` : e.type;

// edits /////////////////////////////////////////////////////////////////////

let nextId = 1;

/** a wire edit of a slice, logging data under its seq, normal unless told; data gets the
    instance id from the slice name */
export function ev(
  slice: string,
  seq: number,
  position: number,
  data: Partial<TestEdit> & { type: TestEdit['type'] } = { type: 'bump' },
  id?: string,
  lifecycle: Lifecycle = 'normal',
): WireEdit {
  const inst = slice.slice(slice.indexOf(':') + 1);
  const full = { id: inst, ...data } as TestEdit;
  const env: EditEnvelope = {
    id: id ?? `ev${nextId++}`,
    position,
    slice,
    seq,
    servertime: new Date(0),
    lifecycle,
  };
  return { ...env, raw: rawEdit(env, [[logKey(slice, seq), full]]) };
}

/** a birth that writes nothing: the slice, unborn or deleted, starts empty */
export function birth(slice: string, seq: number, position: number): WireEdit {
  return reset(slice, seq, position, 'birth');
}

/** a death: the slice is deleted */
export function death(slice: string, seq: number, position: number): WireEdit {
  return reset(slice, seq, position, 'death');
}

function reset(slice: string, seq: number, position: number, lifecycle: Lifecycle): WireEdit {
  const env: EditEnvelope = {
    id: `sys${nextId++}`,
    position,
    slice,
    seq,
    servertime: new Date(0),
    lifecycle,
  };
  return { ...env, raw: rawEdit(env, []) };
}

// the fake server ///////////////////////////////////////////////////////////

/** what a backfill of a selector serves: a snapshot at a cut and the edits after it, and the length
    its response states, if any; its values come as one page, each value counting as one byte */
export type Blob = {
  position: number;
  // the last position any slice under the selector changed, the cut unless given
  visible?: number;
  seqs: Record<string, number>;
  values: [string, unknown][];
  tail?: WireEdit[];
  length?: number;
};

export type BackfillCall = { selector: string; until: number; resume: Backfill['resume'] };

/** a tail read: the positions above after and below before */
export type TailRead = { selector: string; after: number; before: number };

/** a backfill call the test drives by hand: the Engine's Backfill, to push to, and how the call
    ends */
export type DrivenCall = {
  backfill: Backfill;
  done: (outcome: BackfillOutcome) => void;
  fail: (e: unknown) => void;
};

type Hold = {
  promise: Promise<'go' | 'fail' | 'stale'>;
  resolve: (how: 'go' | 'fail' | 'stale') => void;
};

function newHold(): Hold {
  let resolve!: Hold['resolve'];
  const promise = new Promise<'go' | 'fail' | 'stale'>((r) => (resolve = r));
  return { promise, resolve };
}

function raceAbort<T>(signal: Signal, p: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class FakeConn {
  ended = false;
  constructor(
    public since: number,
    public view: string | null,
    public wants: string[],
    public signal: Signal,
    public hooks: ConnectionHooks,
    public session: Session | null,
  ) {}
}

export class FakeServer {
  epoch = 'e1';
  conns: FakeConn[] = [];
  blobs = new Map<string, Blob>();
  /** every backfill() call, in order */
  backfills: BackfillCall[] = [];
  /** every sendMutations() call, in order */
  sends: Mutation<Uint8Array>[][] = [];
  /** what sendMutations answers; the default answers each mutation ok at a new position */
  onSend: (mutations: Mutation<Uint8Array>[]) => Promise<MutationResult[]> = (mutations) =>
    Promise.resolve(
      mutations.map(() => ({ kind: 'ok' as const, position: this.nextAckPosition++ })),
    );
  nextAckPosition = 1000;
  /** holds: a backfill of the selector waits at the start until released */
  holds = new Map<string, Hold>();
  /** a backfill of the selector fails once with this error */
  failOnce = new Map<string, unknown>();
  /** every tail read, in order */
  tails: TailRead[] = [];
  /** backfills of the selector that the test drives by hand, each call as it arrives */
  driven = new Map<string, DrivenCall[]>();
  /** whether the Engine's store is inside a write transaction, which rig wires up */
  writing: () => boolean = () => false;
  /** backfill() calls made while the Engine's store was inside a write transaction */
  callsInTransaction = 0;

  /** the transport the Engine is handed: the harness's registry for any schema, and connections
      to this server */
  transport: Transport = {
    buildRegistry: () => registry,
    connect: (since, view, wants, signal, hooks, session) =>
      this.connect(since, view, wants, signal, hooks, session),
    post: () => Promise.reject(new Error('the Engine never posts')),
  };

  connect(
    since: number,
    view: string | null,
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
    session: Session | null,
  ): Connection {
    const conn = new FakeConn(since, view, wants, signal, hooks, session);
    this.conns.push(conn);
    signal.addEventListener('abort', () => {
      if (!conn.ended) {
        conn.ended = true;
        hooks.onEnd(0, 'aborted');
      }
    });
    return {
      backfill: (b) => this.#backfill(conn, b),
      sendMutations: (mutations) => {
        this.sends.push(mutations);
        return raceAbort(signal, this.onSend(mutations));
      },
    };
  }

  /** the current connection */
  get conn(): FakeConn {
    return this.conns[this.conns.length - 1];
  }

  // driving the live connection
  open(epoch = this.epoch, head = 0): void {
    this.conn.hooks.onOpen(epoch, head);
  }
  view(token: string, position: number, selectors: string[]): void {
    this.conn.hooks.onView(token, position, selectors);
  }
  edits(...edits: WireEdit[]): void {
    this.conn.hooks.onEdits(edits);
  }
  live(position: number): void {
    this.conn.hooks.onLive(position);
  }
  vouch(position: number): void {
    this.conn.hooks.onVouch(position);
  }
  end(code = 0, reason = 'closed', fatal?: unknown): void {
    const conn = this.conn;
    if (conn.ended) return;
    conn.ended = true;
    conn.hooks.onEnd(code, reason, fatal);
  }

  /** drive every backfill of the selector by hand from here; answers the calls as they arrive */
  drive(selector: string): DrivenCall[] {
    const calls: DrivenCall[] = [];
    this.driven.set(selector, calls);
    return calls;
  }

  /** hold every backfill of the selector at its start until released */
  hold(selector: string): { go: () => void; fail: () => void; stale: () => void } {
    const h = newHold();
    this.holds.set(selector, h);
    return {
      go: () => {
        this.holds.delete(selector);
        h.resolve('go');
      },
      fail: () => {
        this.holds.delete(selector);
        h.resolve('fail');
      },
      stale: () => {
        this.holds.delete(selector);
        h.resolve('stale');
      },
    };
  }

  async #backfill(conn: FakeConn, b: Backfill): Promise<BackfillOutcome> {
    if (this.writing()) this.callsInTransaction++;
    this.backfills.push({
      selector: b.selector,
      until: b.until,
      resume: b.resume === null ? null : { ...b.resume },
    });
    const driven = this.driven.get(b.selector);
    if (driven !== undefined) {
      const call = new Promise<BackfillOutcome>((done, fail) => {
        driven.push({ backfill: b, done, fail });
      });
      return raceAbort(b.signal, call);
    }
    const hold = this.holds.get(b.selector);
    if (hold !== undefined) {
      const how = await raceAbort(b.signal, hold.promise);
      if (how === 'fail') throw new Error(`backfill ${b.selector}: held failure`);
      if (how === 'stale') return 'stale';
    }
    if (this.failOnce.has(b.selector)) {
      const e = this.failOnce.get(b.selector);
      this.failOnce.delete(b.selector);
      throw e;
    }
    const blob = this.blobs.get(b.selector);
    if (blob === undefined) throw new Error(`backfill ${b.selector}: 403`);
    const push = (item: Parameters<Backfill['push']>[0]) => raceAbort(b.signal, b.push(item));
    const r = b.resume;
    if (!r?.snapshotDone) {
      if (r !== null && r.skipBytes > 0 && r.position !== blob.position) return 'stale';
      if (blob.length !== undefined) await push({ length: blob.length });
      if (r === null || r.skipBytes === 0) {
        const visible = blob.visible ?? blob.position;
        await push({ header: { position: blob.position, seqs: blob.seqs, visible } });
        if (blob.values.length > 0) {
          // the checksum is opaque to the Engine, so any string that names the page will do
          const skip = blob.values.length;
          await push({ page: page(blob.values), skip, checksum: `check-${skip}` });
        }
      }
      await push({ pagesDone: true });
    }
    if (!r?.tailDone) {
      const from = Math.max(r?.fromPosition ?? blob.position, blob.position);
      this.tails.push({ selector: b.selector, after: from, before: b.until });
      const run = (blob.tail ?? []).filter((e) => e.position > from && e.position < b.until);
      if (run.length > 0) await push({ edits: run, scanned: run[run.length - 1].position });
      await push({ editsDone: true });
    }
    void conn;
    return 'done';
  }
}

// engine errors ////////////////////////////////////////////////////////////

/* Anything thrown out of an advancer pass ends the Engine.  The harness takes it through onError
   so `settle` can fail the test with the Engine's own error instead of a silent hang; thrown
   from the timer callback, it would be an uncaught exception rather than a test failure. */
const errors: unknown[] = [];

/** the Engine's error, if it ended; clears it */
export function engineError(): unknown {
  return errors.shift();
}

// the engine ////////////////////////////////////////////////////////////////

// the registry data the Engine hands its transport, which answers with the harness's registry
const schema: Schema = { nodes: [], ids: {}, mutations: 'mutation' };

/** the harness's predict context is the write transaction's own interface, and its query context
    the read transaction's with the Engine's status */
export type Predictor = EnginePredictor<WriteTxn, unknown>;
export type QueryTxn = ReadTxn & { status: EngineStatus };

/** the harness's contexts, each passing every call through to the transaction its box holds */
function contexts(): {
  queries: { ctx: QueryTxn; $ref: { txn: ReadTxn } };
  predictions: { ctx: WriteTxn; $ref: { txn: WriteTxn } };
} {
  const q = unboundRef<ReadTxn>();
  const p = unboundRef<WriteTxn>();
  const queries: QueryTxn = {
    get: (key, type) => q.txn.get(key, type),
    scan: (req) => q.txn.scan(req),
    status: $engineStatus(q),
  };
  const predictions: WriteTxn = {
    get: (key, type) => p.txn.get(key, type),
    scan: (req) => p.txn.scan(req),
    set: (key, type, value) => p.txn.set(key, type, value),
    del: (key) => p.txn.del(key),
    deleteSlice: (slice, erase) => p.txn.deleteSlice(slice, erase),
  };
  return { queries: { ctx: queries, $ref: q }, predictions: { ctx: predictions, $ref: p } };
}

export type Rig = {
  server: FakeServer;
  store: InMemStore;
  engine: Engine<QueryTxn, WriteTxn, unknown, unknown>;
  abort: AbortController;
  /** every key in the store and its value, as of the call */
  data: () => Record<string, unknown>;
};

/** an Engine over an in-memory store: a fresh one holding seed, or store as an earlier Engine
    left it; it wants the selectors of wants, `patron:*` and `book:*` unless given */
export function rig(
  opts: {
    seed?: Record<string, unknown>;
    store?: InMemStore;
    predictor?: Predictor;
    wants?: string[];
    server?: FakeServer;
    session?: Session | null;
  } = {},
): Rig {
  errors.length = 0;
  const server = opts.server ?? new FakeServer();
  const store = opts.store ?? seeded(opts.seed ?? {});
  const abort = new AbortController();
  const { queries, predictions } = contexts();

  // the Engine's store, telling the server when a write transaction is open
  let writes = 0;
  server.writing = () => writes > 0;
  const counted: Store = {
    write: (fn) => {
      writes++;
      try {
        return store.write(fn);
      } finally {
        writes--;
      }
    },
    read: (fn) => store.read(fn),
  };
  const engine = new Engine<QueryTxn, WriteTxn, unknown, unknown>(
    queries,
    predictions,
    schema,
    server.transport,
    {
      session: opts.session ?? null,
      store: () => counted,
      wants: opts.wants ?? ['patron:*', 'book:*'],
      predictor: opts.predictor,
      signal: abort.signal,
      onError: (e) => errors.push(e),
    },
  );
  return { server, store, engine, abort, data: () => contents(store) };
}

// the store type of a key the Engine writes
function typeOf(key: string): string {
  if (key.startsWith('!mutation:')) return '.mutation';
  if (key.startsWith('!park-edit:')) return '.edits';
  if (key.startsWith('!park-snap:')) return '.page';
  if (key.startsWith('!')) return '.json';
  return 'state';
}

/* A fresh store holding seed.  Bytes are set as msgpack, a wire edit as its raw bytes, and any
   other value as JS. */
function seeded(seed: Record<string, unknown>): InMemStore {
  const store = new InMemStore(registry);
  store.write((txn) => {
    for (const [key, value] of Object.entries(seed)) {
      if (value instanceof Uint8Array) {
        txn.set(key, typeOf(key), MSGPACK, value);
      } else if (typeof value === 'object' && value !== null && 'raw' in value) {
        txn.set(key, typeOf(key), MSGPACK, (value as WireEdit).raw);
      } else {
        txn.set(key, typeOf(key), JS, value);
      }
    }
  });
  return store;
}

// every key in a store and its value: a parked edit as its envelope, a page as its operations
function contents(store: Store): Record<string, unknown> {
  return store.read((txn) => {
    const out: Record<string, unknown> = {};
    const pattern = { slice: null, name: null, local: [] };
    for (const [key] of scanAll(txn, { pattern, limit: 1000, values: false })) {
      const type = typeOf(key);
      out[key] =
        type === '.page'
          ? parse(txn.get(key, type, MSGPACK) as Uint8Array)
          : txn.get(key, type, JS);
    }
    return out;
  });
}

/** let the advancer run everything it can: scheduled wakeups, promise chains, hook pushes */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(1);
    } else {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (errors.length > 0) throw errors.shift();
}

/** a slice's state as a query reads it: its snapshot state with its log folded on */
export function readState(txn: ReadTxn, slice: string): State | undefined {
  const base = txn.get(`${slice}!state`, 'state') as State | undefined;
  const pattern = { slice, name: 'log', local: [null] };
  const entries = [...scanEach(txn, { pattern, type: 'state' })].map(([, v]) => v as TestEdit);
  return fold(base, entries);
}

/** a query on a slice's state, collecting every value it delivers and counting its runs */
export function watch(
  r: Rig,
  slice: string,
): { values: (State | undefined)[]; runs: () => number } {
  const values: (State | undefined)[] = [];
  let runs = 0;
  const q = r.engine.newQuery((qx) => {
    runs++;
    return readState(qx, slice);
  });
  q.subscribe((v) => values.push(v));
  return { values, runs: () => runs };
}

/** a query on each part of the Engine's status, collecting every value it delivers */
export function watchStatus(r: Rig): {
  connection: ConnectionStatus[];
  progress: ProgressStatus[];
  outbox: OutboxStatus[];
} {
  const seen = {
    connection: [] as ConnectionStatus[],
    progress: [] as ProgressStatus[],
    outbox: [] as OutboxStatus[],
  };
  r.engine.newQuery((qx) => qx.status.connection()).subscribe((v) => seen.connection.push(v));
  r.engine.newQuery((qx) => qx.status.progress()).subscribe((v) => seen.progress.push(v));
  r.engine.newQuery((qx) => qx.status.outbox()).subscribe((v) => seen.outbox.push(v));
  return seen;
}

/** a predictor's write of an edit's data to a slice, as the edit would log it, under a key that
    sorts after every real edit's; a `boom` throws, predicting nothing */
let nextPredicted = 1;
export function predict(txn: WriteTxn, slice: string, data: TestEdit): void {
  if (data.type === 'boom') throw new Error('prediction boom');
  txn.set(`${slice}!log:~${String(nextPredicted++).padStart(6, '0')}`, 'state', data);
}

/** the last of a list */
export const last = <T>(xs: T[]): T => xs[xs.length - 1];

/** the keys under a prefix, sorted */
export function keys(data: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(data)
    .filter((k) => k.startsWith(prefix))
    .sort();
}

/** the slice keys a selector's parked snapshot pages set, sorted */
export function parkedKeys(data: Record<string, unknown>, selector: string): string[] {
  const out: string[] = [];
  for (const k of keys(data, `!park-snap:${selector}!`)) {
    const ops = data[k] as unknown[];
    for (let i = 0; i < ops.length; i += 3) out.push(ops[i + 1] as string);
  }
  return out.sort();
}

export function state(data: Record<string, unknown>, slice: string): State | undefined {
  const entries = keys(data, `${slice}!log:`).map((k) => data[k] as TestEdit);
  return fold(data[`${slice}!state`] as State | undefined, entries);
}

export function log(data: Record<string, unknown>, slice: string): string[] {
  const base = (data[`${slice}!log`] as string[] | undefined) ?? [];
  const entries = keys(data, `${slice}!log:`).map((k) => label(data[k] as TestEdit));
  return [...base, ...entries];
}

export function seq(data: Record<string, unknown>, slice: string): number | undefined {
  return data[`!seq:${slice}`] as number | undefined;
}

export function checkpoint(
  data: Record<string, unknown>,
): { epoch: string; position: number; applied: number } | undefined {
  return data['!checkpoint'] as { epoch: string; position: number; applied: number } | undefined;
}

export const parkedEdit = (slice: string, seq: number): string =>
  `!park-edit:${slice}!${String(seq).padStart(20, '0')}`;

export const parkedPage = (selector: string, offset: number): string =>
  `!park-snap:${selector}!${String(offset).padStart(20, '0')}`;

/** bootstrap: connect, present the first view with these selectors, serve their blobs, go live */
export async function bootstrap(
  r: Rig,
  selectors: string[],
  blobs: Record<string, Blob>,
  position = 10,
): Promise<void> {
  for (const [selector, blob] of Object.entries(blobs)) r.server.blobs.set(selector, blob);
  await settle();
  r.server.open();
  r.server.view('t1', position, selectors);
  r.server.live(position);
  await settle();
}
