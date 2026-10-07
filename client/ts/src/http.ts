// The HTTP connector.

import type {
  Backfill,
  BackfillOutcome,
  Command,
  CommandResult,
  Connector,
  ConnectorFactory,
  ConnectorHooks,
  Signal,
  WireEvent,
} from './contract.js';
import { be, decodeAny, utf8, Writer } from './msgpack.js';
import { crc32c, Fnv64, sameBytes } from './checksum.js';
import { ByteReader } from './bytes.js';
import { frames } from './frames.js';

/** TokenSource supplies the bearer token for each request, or null for anonymous */
export type TokenSource = () => string | null;

const pageSize = 1000;
const batchRecords = 1000;
const batchBytes = 256 * 1024;
const maxRecord = 16 * 1024 * 1024;
// a send that fails for a reason that may not recur is tried again this many times, waiting
// this long before the first retry and twice as long before each one after
const sendRetries = 3;
const sendRetryDelay = 100;

type BlobHeader = { position: number; streams: Record<string, number> };

// a blob response's whole length: a full response's Content-Length, or a range response's
// Content-Range total; null when it states neither, or is encoded, which makes the stated length
// the encoded one
function blobLength(resp: Response): number | null {
  const encoding = resp.headers.get('Content-Encoding');
  if (encoding !== null && encoding !== 'identity') return null;
  const stated =
    resp.status === 206
      ? /\/(\d+)$/.exec(resp.headers.get('Content-Range') ?? '')?.[1]
      : resp.headers.get('Content-Length');
  if (stated === undefined || stated === null || stated === '') return null;
  const n = Number(stated);
  return Number.isSafeInteger(n) ? n : null;
}

function readU32(b: Uint8Array): number {
  return be(b, 0, 4);
}

export class HTTPConnector implements Connector {
  #url: string;
  #token: TokenSource;
  #signal: AbortSignal;
  #hooks: ConnectorHooks;
  #ended = false;
  // ends the connection from inside, when a send fails
  #stop = new AbortController();
  // the send queue: one call in flight, retried a few times when its failure may not recur, and
  // a failure that stands rejects every call queued at that moment without sending it and ends
  // the connection, after which every call rejects
  #sends: {
    commands: Command<Uint8Array>[];
    resolve: (r: CommandResult[]) => void;
    reject: (e: unknown) => void;
  }[] = [];
  #sending = false;

  constructor(
    url: string,
    token: TokenSource,
    since: number,
    view: string | null,
    wants: string[],
    signal: Signal,
    hooks: ConnectorHooks,
  ) {
    this.#url = url;
    this.#token = token;
    this.#signal = AbortSignal.any([nativeSignal(signal), this.#stop.signal]);
    this.#hooks = hooks;
    void this.#run(since, view, wants);
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const t = this.#token();
    return t === null ? extra : { ...extra, Authorization: `Bearer ${t}` };
  }

  // the one onEnd: server end frames pass their code through; transport-level ends carry the
  // HTTP status, and local ends (abort, closed body) carry 0
  #end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#hooks.onEnd(code, reason);
  }

  async #run(since: number, view: string | null, wants: string[]): Promise<void> {
    try {
      const q = new URLSearchParams({ since: String(since) });
      if (view !== null) q.set('view', view);
      for (const w of wants) q.append('want', w);
      const resp = await fetch(`${this.#url}/stream?${q}`, {
        signal: this.#signal,
        headers: this.#headers(),
      });
      if (resp.status !== 200 || !resp.body) {
        this.#end(resp.status, await resp.text());
        return;
      }
      const epoch = resp.headers.get('PhaseLock-Epoch');
      if (epoch === null || epoch === '') {
        this.#end(resp.status, 'stream: no epoch');
        return;
      }
      const position = resp.headers.get('PhaseLock-Position');
      const head = position === null || position === '' ? NaN : Number(position);
      if (!Number.isSafeInteger(head)) {
        this.#end(resp.status, 'stream: no position');
        return;
      }
      this.#hooks.onOpen(epoch, head);
      await frames(new ByteReader(resp.body), (f) => {
        switch (f.tag) {
          case 'events':
            this.#hooks.onEvents(f.events);
            return true;
          case 'live':
            this.#hooks.onLive(f.position);
            return true;
          case 'vouch':
            this.#hooks.onVouch(f.position);
            return true;
          case 'view':
            this.#hooks.onView(f.token, f.position, f.refs);
            return true;
          case 'end':
            this.#end(f.code, f.reason);
            return false;
        }
      });
      this.#end(0, 'stream closed');
    } catch (e: unknown) {
      this.#end(0, e instanceof Error ? e.message : String(e));
    }
  }

  async backfill(b: Backfill): Promise<BackfillOutcome> {
    // when one download fails the other is pointless
    const sibling = new AbortController();
    const signal = AbortSignal.any([nativeSignal(b.signal), sibling.signal]);
    const r = b.resume;

    // the snapshot half, unless a previous attempt finished it
    let position: number;
    let snapshot: Promise<void> = Promise.resolve();
    if (r?.snapshotDone) {
      position = r.position;
    } else {
      const skip = r?.skipBytes ?? 0;
      const range: Record<string, string> = skip > 0 ? { Range: `bytes=${skip}-` } : {};
      const first = await fetch(`${this.#url}/snapshot/${b.ref}`, {
        signal,
        headers: this.#headers(range),
      });
      const okStatus = (r: Response) => r.status === 200 || r.status === 206 || r.status === 416;
      if (!okStatus(first))
        throw new Error(`snapshot ${b.ref}: ${first.status} ${first.statusText}`);
      let blob = first;
      if (first.headers.get('Content-Type')?.startsWith('text/plain')) {
        // a pointer to the blob
        const target = await first.text();
        blob = await fetch(target, { signal, headers: range });
        if (blob.status === 404 || blob.status === 410) return 'stale';
        if (!okStatus(blob))
          throw new Error(`snapshot ${b.ref}: ${blob.status} ${blob.statusText}`);
      }
      // the origin's response carries the position; a blob store owes only the bytes
      position = Number(first.headers.get('PhaseLock-Position'));
      if (!Number.isSafeInteger(position)) throw new Error(`snapshot ${b.ref}: no position`);
      if (skip > 0 && position !== r!.position) return 'stale';
      snapshot = this.#blob(b, blob, position, skip, signal);
    }

    // the tail half, unless a previous attempt finished it
    const from = Math.max(r?.fromPosition ?? position, position);
    const tail = r?.tailDone ? Promise.resolve() : this.#tail(b, from, signal);

    try {
      await Promise.all([snapshot, tail]);
    } catch (e: unknown) {
      sibling.abort();
      throw e;
    }
    return 'done';
  }

  async #blob(
    b: Backfill,
    resp: Response,
    position: number,
    skip: number,
    _signal: AbortSignal,
  ): Promise<void> {
    if (resp.status === 416) {
      // skip is the end: every value was delivered already
      await b.push({ valuesDone: true });
      return;
    }
    if (!resp.body) throw new Error(`snapshot ${b.ref}: no body`);

    // the blob's whole length, for the Engine's progress, when the response states one
    const length = blobLength(resp);
    if (length !== null) await b.push({ length });

    const br = new ByteReader(resp.body, resp.status === 206 ? skip : 0);
    // a server that ignored the Range sent the whole blob; skip what we already have
    if (resp.status === 200 && skip > 0) await br.skipBytes(skip);
    const fresh = skip === 0;
    const fnv = new Fnv64();

    if (fresh) {
      await br.fill(9);
      if (utf8.decode(br.take(4)) !== 'PLSN') throw new Error(`snapshot ${b.ref}: bad magic`);
      const version = br.take(1)[0];
      if (version !== 1) throw new Error(`snapshot ${b.ref}: version ${version}`);
      const hlen = readU32(br.take(4));
      await br.fill(hlen + 4);
      const hdr = br.take(hlen).slice();
      const crc = readU32(br.take(4));
      if (crc !== crc32c(hdr)) throw new Error(`snapshot ${b.ref}: header crc`);
      const header = decodeAny(hdr) as BlobHeader;
      if (header.position !== position) throw new Error(`snapshot ${b.ref}: position mismatch`);
      await b.push({ header: { position, seqs: header.streams ?? {} } });
    }

    let batch: [string, Uint8Array][] = [];
    let bytes = 0;
    let count = 0;
    // the offset after the last complete record: what a resume skips to
    let recordEnd = br.offset;
    // one batch in flight at the Engine while the next is parsed
    let pending: Promise<void> = Promise.resolve();
    const flush = async () => {
      const values = batch;
      const at = recordEnd;
      batch = [];
      bytes = 0;
      await pending;
      pending = b.push({ values, skip: at });
    };

    // awaits only when the buffer runs dry, so they track chunks rather than records
    for (;;) {
      if (br.available < 4) await br.fill(4);
      const klenBytes = br.take(4);
      const klen = readU32(klenBytes);
      if (klen === 0xffffffff) {
        if (br.available < 16) await br.fill(16);
        const footer = br.take(16).slice();
        if (readU32(footer.subarray(12)) !== crc32c(footer.subarray(0, 12))) {
          throw new Error(`snapshot ${b.ref}: footer crc`);
        }
        if (fresh) {
          if (readU32(footer) !== count) throw new Error(`snapshot ${b.ref}: record count`);
          if (!sameBytes(footer.subarray(4, 12), fnv.digest())) {
            throw new Error(`snapshot ${b.ref}: content hash`);
          }
        }
        break;
      }
      if (klen > maxRecord) throw new Error(`snapshot ${b.ref}: corrupt record`);
      if (fresh) fnv.update(klenBytes);
      if (br.available < klen + 4) await br.fill(klen + 4);
      const key = br.take(klen).slice();
      const vlenBytes = br.take(4);
      const vlen = readU32(vlenBytes);
      if (vlen > maxRecord) throw new Error(`snapshot ${b.ref}: corrupt record`);
      // views from take() die at the next refill, so hash these before filling
      if (fresh) {
        fnv.update(key);
        fnv.update(vlenBytes);
      }
      if (br.available < vlen + 4) await br.fill(vlen + 4);
      const value = br.take(vlen).slice();
      const crcBytes = br.take(4);
      if (readU32(crcBytes) !== crc32c(value, crc32c(key))) {
        throw new Error(`snapshot ${b.ref}: record crc`);
      }
      if (fresh) {
        fnv.update(value);
        fnv.update(crcBytes);
      }
      count++;
      recordEnd = br.offset;
      batch.push([utf8.decode(key), value]);
      bytes += klen + vlen;
      if (batch.length >= batchRecords || bytes >= batchBytes) await flush();
    }
    if (batch.length > 0) await flush();
    await pending;
    await b.push({ valuesDone: true });
  }

  async #tail(b: Backfill, from: number, signal: AbortSignal): Promise<void> {
    let after = from;
    for (;;) {
      const q = `after=${after}&before=${b.until}&max=${pageSize}`;
      const resp = await fetch(`${this.#url}/events/${b.ref}?${q}`, {
        signal,
        headers: this.#headers(),
      });
      if (resp.status !== 200 || !resp.body) {
        throw new Error(`events ${b.ref}: ${resp.status} ${resp.statusText}`);
      }
      const scanned = Number(resp.headers.get('PhaseLock-Scanned'));
      const events: WireEvent[] = [];
      await frames(new ByteReader(resp.body), (f) => {
        if (f.tag !== 'events') throw new Error(`events ${b.ref}: ${f.tag} frame`);
        events.push(...f.events);
        return true;
      });
      if (events.length > 0) {
        const reached = Number.isSafeInteger(scanned)
          ? scanned
          : events[events.length - 1].position;
        await b.push({ events, scanned: reached });
      }
      if (events.length < pageSize || !Number.isSafeInteger(scanned) || scanned >= b.until) {
        await b.push({ eventsDone: true });
        return;
      }
      after = scanned;
    }
  }

  sendCommands(commands: Command<Uint8Array>[]): Promise<CommandResult[]> {
    return new Promise((resolve, reject) => {
      if (this.#ended) {
        reject(new Error('commands: the connection has ended'));
        return;
      }
      this.#sends.push({ commands, resolve, reject });
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    for (;;) {
      const next = this.#sends.shift();
      if (!next) break;
      try {
        next.resolve(await this.#post(next.commands));
      } catch (e: unknown) {
        next.reject(e);
        for (const behind of this.#sends.splice(0)) behind.reject(e);
        this.#failed(e);
      }
    }
    this.#sending = false;
  }

  /* One call, as up to one request plus the retries.  A retry repeats the request under the same
     ids, which the database's dedup makes safe: a command the first attempt committed answers dup.
     A 4xx answer is the client's own doing and stands at once; so does any failure once the
     stream has ended or the connection was aborted, since the next connection resends. */
  async #post(commands: Command<Uint8Array>[]): Promise<CommandResult[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await postCommands(this.#url, this.#headers(), commands, this.#signal);
      } catch (e: unknown) {
        const clientError = e instanceof StatusError && e.status >= 400 && e.status < 500;
        if (attempt === sendRetries || clientError || this.#ended || this.#signal.aborted) throw e;
        await sleep(sendRetryDelay * 2 ** attempt, this.#signal);
        if (this.#ended) throw e;
      }
    }
  }

  // a send that failed ends the connection: the one onEnd carries the response's status, or 0
  // when no response arrived, and the stream stops
  #failed(e: unknown): void {
    const code = e instanceof StatusError ? e.status : 0;
    this.#end(code, e instanceof Error ? e.message : String(e));
    this.#stop.abort();
  }
}

/** The native AbortSignal behind a contract Signal, for fetch: the signal itself when the host's
    AbortController made a native one, as a browser's or Node's does, else a native one that
    follows it. */
function nativeSignal(signal: Signal): AbortSignal {
  if (signal instanceof AbortSignal) return signal;
  const c = new AbortController();
  if (signal.aborted) {
    c.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => c.abort(signal.reason), { once: true });
  }
  return c.signal;
}

/** resolves after ms, or at once when the signal fires */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** a /commands response whose status answers no command */
class StatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* One POST of commands, answered with their outcomes in order.  Any status but 200 rejects, since
   such a response answers no command. */
async function postCommands(
  url: string,
  headers: Record<string, string>,
  commands: Command<Uint8Array>[],
  signal?: AbortSignal,
): Promise<CommandResult[]> {
  const w = new Writer();
  for (const c of commands) {
    w.arrayHeader(2);
    w.str(c.id);
    w.raw(c.data);
  }
  const resp = await fetch(`${url}/commands`, {
    method: 'POST',
    signal,
    headers: { ...headers, 'Content-Type': 'application/msgpack' },
    body: w.bytes(),
  });
  if (resp.status !== 200) {
    throw new StatusError(resp.status, `commands: ${resp.status} ${resp.statusText}`);
  }
  const outcomes = decodeAny(new Uint8Array(await resp.arrayBuffer())) as unknown[][];
  return outcomes.map((o): CommandResult => {
    switch (o[0]) {
      case 'ack':
        return { kind: 'ack', position: o[1] as number };
      case 'dup':
        return { kind: 'dup', position: o[1] as number };
      case 'reject':
        return { kind: 'reject', reason: o[1] as string };
      case 'conflict':
        return { kind: 'conflict', current: o[1] as Record<string, number> };
      default:
        throw new Error(`unknown command outcome ${String(o[0])}`);
    }
  });
}

/** Sends one command outside any Engine, such as one that creates an account before there is a
    token to connect with, and answers with its outcome.  The command is the wire envelope: an id
    the caller mints and the command's wire bytes.  The token is null for an anonymous request.  A
    failed request rejects, and nothing is retried. */
export async function postCommand(
  url: string,
  command: Command<Uint8Array>,
  token: string | null = null,
): Promise<CommandResult> {
  const headers: Record<string, string> =
    token === null ? {} : { Authorization: `Bearer ${token}` };
  const [result] = await postCommands(url, headers, [command]);
  return result;
}

export function NewHTTPConnector(url: string, token: TokenSource = () => null): ConnectorFactory {
  return (since, view, wants, signal, hooks) =>
    new HTTPConnector(url, token, since, view, wants, signal, hooks);
}
