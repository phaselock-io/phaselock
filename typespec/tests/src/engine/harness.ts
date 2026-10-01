// A skeleton-only harness for the Engine: an in-memory store, a registry whose "msgpack" is
// UTF-8 JSON (the Engine never looks inside the bytes), two families with reducers that log what
// they applied, and a scripted connector the test drives frame by frame.

import { vi } from 'vitest';

import {
  type Backfill,
  type BackfillOutcome,
  type Command,
  type CommandResult,
  type Connector,
  type ConnectorFactory,
  type ConnectorHooks,
  type DbEvent,
  Engine,
  type Forecaster as EngineForecaster,
  InMemStore,
  JS,
  MSGPACK,
  type ReadTxn,
  type ReducerTxn,
  type Registry,
  type SliceReducer,
  type StoreValue,
  type WireEvent,
} from '../../../ts/assets/skeleton.ts';

// bytes /////////////////////////////////////////////////////////////////////

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytes = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
export const parse = (b: Uint8Array): unknown => JSON.parse(dec.decode(b));

type Env = [number, string, number, string, number];

function eventFromWire(pair: unknown): DbEvent<unknown> {
  const [env, data] = pair as [Env, unknown];
  return { position: env[0], stream: env[1], seq: env[2], id: env[3], servertime: env[4], data };
}

function wireFromEvent(ev: DbEvent<unknown>): [Env, unknown] {
  return [[ev.position, ev.stream, ev.seq, ev.id, ev.servertime], ev.data];
}

// registry //////////////////////////////////////////////////////////////////

export const registry: Registry = {
  convert(type: string, value: StoreValue, want: number): StoreValue {
    const out = { ...value } as Record<number, unknown>;
    if (want & JS && !(JS in out) && MSGPACK in out) {
      const raw = parse(out[MSGPACK] as Uint8Array);
      out[JS] = type === '.event' ? eventFromWire(raw) : raw;
    }
    if (want & MSGPACK && !(MSGPACK in out) && JS in out) {
      const js = out[JS];
      out[MSGPACK] = bytes(type === '.event' ? wireFromEvent(js as DbEvent<unknown>) : js);
    }
    return out as StoreValue;
  },
  commands: 'cmd',
  eventTypes: { patron: 'patronEvent', book: 'bookEvent' },
  storeTypes: {
    'patron/state': 'state',
    'patron/log': 'log',
    'book/state': 'state',
    'book/log': 'log',
  },
};

// model /////////////////////////////////////////////////////////////////////

/** an event's data: which instance of the family, and what to do to it */
export type TestEvent =
  | { id: string; type: 'set'; field: string; value: unknown }
  | { id: string; type: 'bump' }
  | { id: string; type: 'noop' }
  | { id: string; type: 'boom' };

export type State = { count: number; fields: Record<string, unknown> };

/** a family's reducer: every event lands on the stream's local `state` key and is logged on its
    `log` key, so a test can assert what was applied and in what order; a `boom` event throws */
function familyReducer(): SliceReducer {
  return {
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
  patron: familyReducer(),
  book: familyReducer(),
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
  const inst = stream.slice(stream.indexOf('.') + 1);
  const full = { id: inst, ...data } as TestEvent;
  const e: DbEvent<unknown> = {
    id: id ?? `ev${nextId++}`,
    data: full,
    position,
    stream,
    seq,
    servertime: 0,
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
    servertime: 0,
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
    servertime: 0,
  };
  return { ...e, data: bytes(e.data), raw: bytes(wireFromEvent(e)) };
}

// the fake server ///////////////////////////////////////////////////////////

/** what a backfill of a ref serves: a snapshot at a cut and the events after it */
export type Blob = {
  position: number;
  seqs: Record<string, number>;
  values: [string, unknown][];
  tail?: WireEvent[];
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

function raceAbort<T>(signal: AbortSignal, p: Promise<T>): Promise<T> {
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
    public signal: AbortSignal,
    public hooks: ConnectorHooks,
  ) {}
}

export class FakeServer {
  epoch = 'e1';
  conns: FakeConn[] = [];
  blobs = new Map<string, Blob>();
  /** every backfill() call, in order */
  backfills: BackfillCall[] = [];
  /** every sendCommand() call, in order */
  sends: Command<Uint8Array>[][] = [];
  /** what sendCommand answers; the default acks each command at a new position */
  onSend: (cmds: Command<Uint8Array>[]) => Promise<CommandResult[]> = (cmds) =>
    Promise.resolve(cmds.map(() => ({ kind: 'ack' as const, position: this.nextAckPosition++ })));
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
      sendCommand: (cmds) => {
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
  open(epoch = this.epoch): void {
    this.conn.hooks.onOpen(epoch);
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
      if (page.length > 0) await push({ events: page });
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

/** the harness's query context is the read transaction itself */
export type Forecaster = EngineForecaster<ReadTxn, unknown>;

export type Rig = {
  server: FakeServer;
  data: Record<string, unknown>;
  engine: Engine<ReadTxn, unknown>;
  abort: AbortController;
};

/** an Engine over an in-memory store, whose keys the test can read straight out of `data` */
export function rig(
  opts: {
    data?: Record<string, unknown>;
    forecaster?: Forecaster;
    reducers?: Record<string, SliceReducer>;
    wants?: string[];
    server?: FakeServer;
  } = {},
): Rig {
  errors.length = 0;
  const server = opts.server ?? new FakeServer();
  const data = opts.data ?? {};
  const abort = new AbortController();
  const engine = new Engine<ReadTxn, unknown>(
    (txn) => txn,
    new InMemStore(registry, data),
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
  return { server, data, engine, abort };
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
    return qx.get(`${stream}/state`, 'state') as State | undefined;
  });
  q.subscribe((v) => values.push(v));
  return { values, runs: () => runs };
}

/** the keys under a prefix, sorted */
export function keys(data: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(data)
    .filter((k) => k.startsWith(prefix))
    .sort();
}

export function state(data: Record<string, unknown>, stream: string): State | undefined {
  return data[`${stream}/state`] as State | undefined;
}

export function log(data: Record<string, unknown>, stream: string): string[] {
  return (data[`${stream}/log`] as string[] | undefined) ?? [];
}

export function seq(
  data: Record<string, unknown>,
  stream: string,
): number | 'backfill' | undefined {
  return data[`/seq.${stream}`] as number | 'backfill' | undefined;
}

export function checkpoint(
  data: Record<string, unknown>,
): { epoch: string; position: number; reduced: number } | undefined {
  return data['/checkpoint'] as { epoch: string; position: number; reduced: number } | undefined;
}

export const parkedEvent = (stream: string, seq: number): string =>
  `/park.ev.${stream}/${String(seq).padStart(20, '0')}`;

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
