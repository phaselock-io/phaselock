// A skeleton-only harness for the Engine: an in-memory store, a registry whose "msgpack" is
// UTF-8 JSON (the Engine never looks inside the bytes), two families with reducers that log what
// they applied, and a scripted connector the test drives frame by frame.

import { vi } from 'vitest';

import {
  type Backfill,
  type BackfillOutcome,
  type Command,
  type CommandResult,
  type ConnectionStatus,
  type Connector,
  type ConnectorFactory,
  type ConnectorHooks,
  type DbEvent,
  Engine,
  type Forecaster as EngineForecaster,
  engineStatus,
  type EngineStatus,
  InMemStore,
  JS,
  MSGPACK,
  type OutboxStatus,
  type ProgressStatus,
  type ReadTxn,
  type ReducerTxn,
  type Registry,
  type Rep,
  scanAll,
  type Signal,
  type SliceReducer,
  type Store,
  storeTypeOf,
  type WireEvent,
} from '../../../ts/assets/skeleton.ts';

// bytes /////////////////////////////////////////////////////////////////////

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytes = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
export const parse = (b: Uint8Array): unknown => JSON.parse(dec.decode(b));

// the envelope, with the server time as milliseconds
type Env = [number, string, number, string, number];

function eventFromWire(pair: unknown): DbEvent<unknown> {
  const [env, data] = pair as [Env, unknown];
  const servertime = new Date(env[4]);
  return { position: env[0], stream: env[1], seq: env[2], id: env[3], servertime, data };
}

function wireFromEvent(ev: DbEvent<unknown>): [Env, unknown] {
  return [[ev.position, ev.stream, ev.seq, ev.id, ev.servertime.getTime()], ev.data];
}

// registry //////////////////////////////////////////////////////////////////

/** the registry rejects an event of this type, standing in for one that fails its schema */
export const INVALID = 'invalid';

export const registry: Registry = {
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown {
    if (from === to) return value;
    if (from === MSGPACK && to === JS) {
      const raw = parse(value as Uint8Array);
      if (type !== '.event') return raw;
      const ev = eventFromWire(raw);
      if ((ev.data as { type?: string }).type === INVALID) throw new Error('$.type: invalid');
      return ev;
    }
    if (from === JS && to === MSGPACK) {
      return bytes(type === '.event' ? wireFromEvent(value as DbEvent<unknown>) : value);
    }
    throw new Error(`no conversion from ${from} to ${to}`);
  },
  commands: 'cmd',
  eventTypes: { patron: 'patronEvent', book: 'bookEvent' },
  storeTypes: {
    'patron/state': 'state',
    'patron/log': 'log',
    'book/state': 'state',
    'book/log': 'log',
    // reduce.test's reducer writes a marker into patron streams
    'patron/marker': 'state',
    // scan.test's reducer walks items in patron streams
    'patron/item': 'state',
  },
};

// model /////////////////////////////////////////////////////////////////////

/** an event's data: which instance of the family, and what to do to it */
export type TestEvent =
  | { id: string; type: 'set'; field: string; value: unknown }
  | { id: string; type: 'bump' }
  | { id: string; type: 'noop' }
  | { id: string; type: 'boom' }
  | { id: string; type: typeof INVALID };

export type State = { count: number; fields: Record<string, unknown> };

/** a family's reducer: every event lands on the stream's local `state` key and is logged on its
    `log` key, so a test can assert what was applied and in what order; a `boom` event throws */
function familyReducer(family: string): SliceReducer {
  return {
    template: `${family}:{id}`,
    keys: ['state', 'log'],
    reducer(txn: ReducerTxn, events: unknown[]): void {
      for (const e of events as TestEvent[]) {
        if (e.type === 'boom') throw new Error('reducer boom');
        const state = (txn.get('state', 'state') as State | undefined) ?? {
          count: 0,
          fields: {},
        };
        const log = (txn.get('log', 'log') as string[] | undefined) ?? [];
        if (e.type === 'set') state.fields[e.field] = e.value;
        if (e.type === 'bump') state.count++;
        log.push(e.type === 'set' ? `set ${e.field}=${String(e.value)}` : e.type);
        txn.set('state', 'state', state);
        txn.set('log', 'log', log);
      }
    },
  };
}

export const reducers: Record<string, SliceReducer> = {
  patron: familyReducer('patron'),
  book: familyReducer('book'),
};

// events ////////////////////////////////////////////////////////////////////

let nextId = 1;

/** a wire event for a stream: data gets the instance id from the stream name */
export function ev(
  stream: string,
  seq: number,
  position: number,
  data: Partial<TestEvent> & { type: TestEvent['type'] } = { type: 'bump' },
  id?: string,
): WireEvent {
  const inst = stream.slice(stream.indexOf(':') + 1);
  const full = { id: inst, ...data } as TestEvent;
  const e: DbEvent<unknown> = {
    id: id ?? `ev${nextId++}`,
    data: full,
    position,
    stream,
    seq,
    servertime: new Date(0),
  };
  return { ...e, data: bytes(full), raw: bytes(wireFromEvent(e)) };
}

export function birth(stream: string, seq: number, position: number): WireEvent {
  const e: DbEvent<unknown> = {
    id: `sys${nextId++}`,
    data: { $sys: 'birth' },
    position,
    stream,
    seq,
    servertime: new Date(0),
  };
  return { ...e, data: bytes(e.data), raw: bytes(wireFromEvent(e)) };
}

export function death(stream: string, seq: number, position: number): WireEvent {
  const e: DbEvent<unknown> = {
    id: `sys${nextId++}`,
    data: { $sys: 'death' },
    position,
    stream,
    seq,
    servertime: new Date(0),
  };
  return { ...e, data: bytes(e.data), raw: bytes(wireFromEvent(e)) };
}

// the fake server ///////////////////////////////////////////////////////////

/** what a backfill of a ref serves: a snapshot at a cut and the events after it, and the length
    its response states, if any; each value counts as one byte */
export type Blob = {
  position: number;
  seqs: Record<string, number>;
  values: [string, unknown][];
  tail?: WireEvent[];
  length?: number;
};

export type BackfillCall = { ref: string; until: number; resume: Backfill['resume'] };

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
    public hooks: ConnectorHooks,
  ) {}
}

export class FakeServer {
  epoch = 'e1';
  conns: FakeConn[] = [];
  blobs = new Map<string, Blob>();
  /** every backfill() call, in order */
  backfills: BackfillCall[] = [];
  /** every sendCommands() call, in order */
  sends: Command<Uint8Array>[][] = [];
  /** what sendCommands answers; the default answers each command ok at a new position */
  onSend: (cmds: Command<Uint8Array>[]) => Promise<CommandResult[]> = (cmds) =>
    Promise.resolve(cmds.map(() => ({ kind: 'ok' as const, position: this.nextAckPosition++ })));
  nextAckPosition = 1000;
  /** holds: a backfill of the ref waits at the start until released */
  holds = new Map<string, Hold>();
  /** a backfill of the ref fails once with this error */
  failOnce = new Map<string, unknown>();

  factory: ConnectorFactory = (since, view, wants, signal, hooks) => {
    const conn = new FakeConn(since, view, wants, signal, hooks);
    this.conns.push(conn);
    signal.addEventListener('abort', () => {
      if (!conn.ended) {
        conn.ended = true;
        hooks.onEnd(0, 'aborted');
      }
    });
    const server = this;
    const connector: Connector = {
      backfill: (b) => server.#backfill(conn, b),
      sendCommands: (cmds) => {
        server.sends.push(cmds);
        return raceAbort(signal, server.onSend(cmds));
      },
    };
    return connector;
  };

  /** the current connection */
  get conn(): FakeConn {
    return this.conns[this.conns.length - 1];
  }

  // driving the live stream
  open(epoch = this.epoch, head = 0): void {
    this.conn.hooks.onOpen(epoch, head);
  }
  view(token: string, position: number, refs: string[]): void {
    this.conn.hooks.onView(token, position, refs);
  }
  events(...events: WireEvent[]): void {
    this.conn.hooks.onEvents(events);
  }
  live(position: number): void {
    this.conn.hooks.onLive(position);
  }
  vouch(position: number): void {
    this.conn.hooks.onVouch(position);
  }
  end(code = 0, reason = 'closed'): void {
    const conn = this.conn;
    if (conn.ended) return;
    conn.ended = true;
    conn.hooks.onEnd(code, reason);
  }

  /** hold every backfill of the ref at its start until released */
  hold(ref: string): { go: () => void; fail: () => void; stale: () => void } {
    const h = newHold();
    this.holds.set(ref, h);
    return {
      go: () => {
        this.holds.delete(ref);
        h.resolve('go');
      },
      fail: () => {
        this.holds.delete(ref);
        h.resolve('fail');
      },
      stale: () => {
        this.holds.delete(ref);
        h.resolve('stale');
      },
    };
  }

  async #backfill(conn: FakeConn, b: Backfill): Promise<BackfillOutcome> {
    this.backfills.push({
      ref: b.ref,
      until: b.until,
      resume: b.resume === null ? null : { ...b.resume },
    });
    const hold = this.holds.get(b.ref);
    if (hold !== undefined) {
      const how = await raceAbort(b.signal, hold.promise);
      if (how === 'fail') throw new Error(`backfill ${b.ref}: held failure`);
      if (how === 'stale') return 'stale';
    }
    if (this.failOnce.has(b.ref)) {
      const e = this.failOnce.get(b.ref);
      this.failOnce.delete(b.ref);
      throw e;
    }
    const blob = this.blobs.get(b.ref);
    if (blob === undefined) throw new Error(`backfill ${b.ref}: 403`);
    const push = (item: Parameters<Backfill['push']>[0]) => raceAbort(b.signal, b.push(item));
    const r = b.resume;
    if (!r?.snapshotDone) {
      if (r !== null && r.skipBytes > 0 && r.position !== blob.position) return 'stale';
      if (blob.length !== undefined) await push({ length: blob.length });
      if (r === null || r.skipBytes === 0) {
        await push({ header: { position: blob.position, seqs: blob.seqs } });
        if (blob.values.length > 0) {
          await push({
            values: blob.values.map(([k, v]) => [k, bytes(v)]),
            skip: blob.values.length,
          });
        }
      }
      await push({ valuesDone: true });
    }
    if (!r?.tailDone) {
      const from = Math.max(r?.fromPosition ?? blob.position, blob.position);
      const page = (blob.tail ?? []).filter((e) => e.position > from && e.position <= b.until);
      if (page.length > 0) await push({ events: page, scanned: page[page.length - 1].position });
      await push({ eventsDone: true });
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

/** the harness's forecast context is the read transaction itself, and its query context the read
    transaction with the Engine's status */
export type Forecaster = EngineForecaster<ReadTxn, unknown>;
export type QueryTxn = ReadTxn & { status: EngineStatus };

export type Rig = {
  server: FakeServer;
  store: InMemStore;
  engine: Engine<QueryTxn, ReadTxn, unknown, unknown>;
  abort: AbortController;
  /** every key in the store and its value, as of the call */
  data: () => Record<string, unknown>;
};

/** an Engine over an in-memory store: a fresh one holding seed, or store as an earlier Engine
    left it */
export function rig(
  opts: {
    seed?: Record<string, unknown>;
    store?: InMemStore;
    forecaster?: Forecaster;
    reducers?: Record<string, SliceReducer>;
    wants?: string[];
    server?: FakeServer;
  } = {},
): Rig {
  errors.length = 0;
  const server = opts.server ?? new FakeServer();
  const store = opts.store ?? seeded(opts.seed ?? {});
  const abort = new AbortController();
  const engine = new Engine<QueryTxn, ReadTxn, unknown, unknown>(
    (txn) => Object.assign(txn, { status: engineStatus(txn) }),
    (txn) => txn,
    store,
    registry,
    server.factory,
    {
      reducers: opts.reducers ?? reducers,
      wants: opts.wants ?? ['*'],
      forecaster: opts.forecaster,
      signal: abort.signal,
      onError: (e) => errors.push(e),
    },
  );
  return { server, store, engine, abort, data: () => contents(store) };
}

// the store type of a key the Engine writes
function typeOf(key: string): string {
  if (key.startsWith('!command:')) return '.command';
  if (key.startsWith('!park-ev:')) return '.event';

  // a parked value has the type of the key it parks
  const parked = '!park-kv:';
  const local = key.startsWith(parked) ? key.slice(key.indexOf('!', parked.length) + 1) : key;
  if (local.startsWith('!')) return '.json';
  const type = storeTypeOf(registry, local);
  if (type === undefined) throw new Error(`no store type for ${key}`);
  return type;
}

// a fresh store holding seed
function seeded(seed: Record<string, unknown>): InMemStore {
  const store = new InMemStore(registry);
  store.write((txn) => {
    for (const [key, value] of Object.entries(seed)) txn.set(key, typeOf(key), JS, value);
  });
  return store;
}

// every key in a store and its value
function contents(store: Store): Record<string, unknown> {
  return store.read((txn) => {
    const out: Record<string, unknown> = {};
    const pattern = { stream: null, name: null, local: [] };
    for (const [key] of scanAll(txn, { pattern, limit: 1000, values: false })) {
      out[key] = txn.get(key, typeOf(key), JS);
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

/** a query on a stream's state, collecting every value it delivers and counting its runs */
export function watch(
  r: Rig,
  stream: string,
): { values: (State | undefined)[]; runs: () => number } {
  const values: (State | undefined)[] = [];
  let runs = 0;
  const q = r.engine.newQuery((qx) => {
    runs++;
    return qx.get(`${stream}!state`, 'state') as State | undefined;
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

/** the last of a list */
export const last = <T>(xs: T[]): T => xs[xs.length - 1];

/** the keys under a prefix, sorted */
export function keys(data: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(data)
    .filter((k) => k.startsWith(prefix))
    .sort();
}

export function state(data: Record<string, unknown>, stream: string): State | undefined {
  return data[`${stream}!state`] as State | undefined;
}

export function log(data: Record<string, unknown>, stream: string): string[] {
  return (data[`${stream}!log`] as string[] | undefined) ?? [];
}

export function seq(
  data: Record<string, unknown>,
  stream: string,
): number | 'backfill' | undefined {
  return data[`!seq:${stream}`] as number | 'backfill' | undefined;
}

export function checkpoint(
  data: Record<string, unknown>,
): { epoch: string; position: number; reduced: number } | undefined {
  return data['!checkpoint'] as { epoch: string; position: number; reduced: number } | undefined;
}

export const parkedEvent = (stream: string, seq: number): string =>
  `!park-ev:${stream}!${String(seq).padStart(20, '0')}`;

/** bootstrap: connect, present the first view with these refs, serve their blobs, go live */
export async function bootstrap(
  r: Rig,
  refs: string[],
  blobs: Record<string, Blob>,
  position = 10,
): Promise<void> {
  for (const [ref, blob] of Object.entries(blobs)) r.server.blobs.set(ref, blob);
  await settle();
  r.server.open();
  r.server.view('t1', position, refs);
  r.server.live(position);
  await settle();
}
