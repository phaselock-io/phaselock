// The HTTP transport: logins and sessions, connections, and commands posted outside them.

import type {
  Backfill,
  BackfillOutcome,
  Command,
  CommandResult,
  Connection,
  ConnectionHooks,
  Registry,
  Schema,
  Signal,
  Transport,
  WireEvent,
} from './contract.js';
import { be, decodeAny, utf8, Writer } from './msgpack.js';
import { crc32c, Fnv64, sameBytes } from './checksum.js';
import { ByteReader } from './bytes.js';
import { frames } from './frames.js';
import { buildRegistry } from './registry.js';
import { AuthError, claims, Session } from './session.js';
import { uuidBytes } from './uuid.js';

const pageSize = 1000;
const batchRecords = 1000;
const batchBytes = 256 * 1024;
const maxRecord = 16 * 1024 * 1024;
// a send that fails for a reason that may not recur is tried again this many times, waiting
// this long before the first retry and twice as long before each one after
const sendRetries = 3;
const sendRetryDelay = 100;
// a session is refreshed once it has lived this share of its lifetime
const refreshAfter = 0.5;

// the most commands one request carries, with a session and without one: the database's
// defaults, until a 413 names the database's own
type CommandLimits = { session: number; anonymous: number };

type BlobHeader = { position: number; streams: Record<string, number> };

// a blob body opened past its header: the reader at its first record, whether the download is
// fresh, and the content hash so far, which only a fresh download checks
type BlobReading = { br: ByteReader; fresh: boolean; fnv: Fnv64 };

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

/** What a login presents: a password, or an account's identity alone, which only a database run
    with --dev-auth accepts */
export type Credentials =
  { kind: 'password'; identity: string; password: string } | { kind: 'dev'; identity: string };

/** The Transport to a database over HTTP, at its base URL: its origin and the path its routes are
    under, such as `https://example.com/phaselock`.  It signs in and refreshes sessions, and
    refreshes a session it is handed once the session has lived half its lifetime. */
export class HTTPTransport implements Transport {
  #url: string;
  // each schema's Registry, built once and shared by every Engine and client over it
  #registries = new WeakMap<Schema, Registry>();
  // each session's refresh in flight, which every caller that wants it refreshed meanwhile shares
  #refreshes = new WeakMap<Session, Promise<void>>();
  // shared with every connection, so a limit one request learns holds for all of them
  #limits: CommandLimits = { session: 128, anonymous: 8 };

  constructor(url: string) {
    this.#url = baseURL(url);
  }

  buildRegistry(schema: Schema): Registry {
    let reg = this.#registries.get(schema);
    if (reg === undefined) {
      reg = buildRegistry(schema);
      this.#registries.set(schema, reg);
    }
    return reg;
  }

  connect(
    since: number,
    view: string | null,
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
    session: Session | null,
  ): Connection {
    ours(session);
    const ready = () => (session === null ? Promise.resolve() : this.#fresh(session));
    return new HTTPConnection(
      this.#url,
      session,
      ready,
      this.#limits,
      since,
      view,
      wants,
      signal,
      hooks,
    );
  }

  /** Commands outside any connection, as the session or as anonymous, answered with their
      outcomes in order, in as many requests as the database's limit on commands per request
      calls for, one after another.  A request of numbered commands that fails for a reason that
      may not recur is tried again a few times under the same ids, which the database's dedup
      makes safe; a request with an unnumbered command is tried once.  A 4xx stands at once, and
      a refused session ends, and the post rejects with an AuthError. */
  async post(
    commands: Command<Uint8Array>[],
    session: Session | null = null,
  ): Promise<CommandResult[]> {
    ours(session);
    if (session !== null) await this.#fresh(session);
    return inRequests(commands, this.#limits, session === null, async (request) => {
      const numbered = request.every((c) => c.series !== null && c.n !== null);
      for (let attempt = 0; ; attempt++) {
        try {
          return await postCommands(this.#url, authorization(session), request);
        } catch (e: unknown) {
          const clientError = e instanceof StatusError && e.status >= 400 && e.status < 500;
          if (!numbered || clientError || attempt === sendRetries) throw refusal(e, session);
          await sleep(sendRetryDelay * 2 ** attempt, new AbortController().signal);
        }
      }
    });
  }

  /** Signs in, answering a new session.  A login the database refuses, for any reason, rejects
      with an AuthError naming the response's status. */
  async login(credentials: Credentials): Promise<Session> {
    try {
      const reply = await this.#authToken(credentials, null);
      return new Session(reply.token);
    } catch (e: unknown) {
      if (e instanceof StatusError) throw new AuthError(e.status, e.message);
      throw e;
    }
  }

  /** Re-issues the session's token in place, then calls its onRefresh.  Refreshes of one session
      while one is in flight share it.  A session the database refuses is ended, and the refresh
      rejects with an AuthError. */
  refresh(session: Session): Promise<void> {
    ours(session);
    let pending = this.#refreshes.get(session);
    if (pending === undefined) {
      pending = this.#reissue(session).finally(() => this.#refreshes.delete(session));
      this.#refreshes.set(session, pending);
    }
    return pending;
  }

  async #reissue(session: Session): Promise<void> {
    if (session.ended) throw new AuthError(401, 'the session has ended');
    let reply: { token: string; exp: number };
    try {
      reply = await this.#authToken({ kind: 'refresh' }, session.token);
    } catch (e: unknown) {
      throw refusal(e, session);
    }
    session.token = reply.token;
    session.exp = reply.exp;
    session.onRefresh?.(session);
  }

  /* The session ready to present: refreshed first once it has lived refreshAfter of its lifetime.
     A refresh that fails for any reason but a refusal leaves a token that has not expired to be
     presented as it is, since it is still good. */
  async #fresh(session: Session): Promise<void> {
    if (session.ended) throw new AuthError(401, 'the session has ended');
    const { iat, exp } = claims(session.token);
    const now = Date.now() / 1000;
    if (now < iat + (exp - iat) * refreshAfter) return;
    try {
      await this.refresh(session);
    } catch (e: unknown) {
      if (e instanceof AuthError || now >= exp) throw e;
    }
  }

  // one POST to /auth/token, answered with the token it signs; any status but 200 rejects
  async #authToken(
    body: Record<string, string>,
    token: string | null,
  ): Promise<{ token: string; exp: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/msgpack' };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const w = new Writer();
    w.any(body);
    const resp = await fetch(`${this.#url}/auth/token`, {
      method: 'POST',
      headers,
      body: w.bytes(),
    });
    if (resp.status !== 200) {
      throw new StatusError(resp.status, `auth: ${resp.status} ${(await resp.text()).trim()}`);
    }
    const reply = decodeAny(new Uint8Array(await resp.arrayBuffer())) as Record<string, unknown>;
    if (typeof reply.token !== 'string' || typeof reply.exp !== 'number') {
      throw new Error('auth: malformed reply');
    }
    return { token: reply.token, exp: reply.exp };
  }
}

// a session this library made, since the Engine hands back whatever object it was given; any
// other object fails here rather than as a malformed token
function ours(session: Session | null): void {
  if (session !== null && !(session instanceof Session)) {
    throw new TypeError('not a session from @phaselock/client: sign in with HTTPTransport.login');
  }
}

// the Authorization header of a request as the session, or none for anonymous
function authorization(session: Session | null): Record<string, string> {
  return session === null ? {} : { Authorization: `Bearer ${session.token}` };
}

// the error a failed auth or command request rejects with: a 401 is the database refusing the
// session, which ends it; any other failure is itself
function refusal(e: unknown, session: Session | null): unknown {
  if (!(e instanceof StatusError) || e.status !== 401) return e;
  if (session !== null) session.ended = true;
  return new AuthError(401, e.message);
}

/* One connection over HTTP: the live stream, the backfills and command sends that ride on it, and
   the session they all present.  Before it opens the stream and before each send it readies the
   session, which refreshes it when due; a 401 from any of them is the database refusing the
   session, which ends the connection fatally. */
class HTTPConnection implements Connection {
  #url: string;
  #session: Session | null;
  #ready: () => Promise<void>;
  #limits: CommandLimits;
  #signal: AbortSignal;
  #hooks: ConnectionHooks;
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
    session: Session | null,
    ready: () => Promise<void>,
    limits: CommandLimits,
    since: number,
    view: string | null,
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
  ) {
    this.#url = url;
    this.#session = session;
    this.#ready = ready;
    this.#limits = limits;
    this.#signal = AbortSignal.any([nativeSignal(signal), this.#stop.signal]);
    this.#hooks = hooks;
    void this.#run(since, view, wants);
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...authorization(this.#session) };
  }

  // the one onEnd: server end frames pass their code through; transport-level ends carry the
  // HTTP status, and local ends (abort, closed body) carry 0
  #end(code: number, reason: string, fatal?: AuthError): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#hooks.onEnd(code, reason, fatal);
  }

  // the database refused the session: it ends for good, and so does this connection, fatally
  #refuse(message: string): AuthError {
    if (this.#session !== null) this.#session.ended = true;
    const err = new AuthError(401, message);
    this.#end(401, message, err);
    this.#stop.abort();
    return err;
  }

  async #run(since: number, view: string | null, wants: string[]): Promise<void> {
    try {
      await this.#ready();
      const q = new URLSearchParams({ since: String(since) });
      if (view !== null) q.set('view', view);
      for (const w of wants) q.append('want', w);
      // a stream never ends, so it bypasses the HTTP cache, which would otherwise hold back an
      // identical request until this one finished
      const resp = await fetch(`${this.#url}/stream?${q}`, {
        signal: this.#signal,
        headers: this.#headers(),
        cache: 'no-store',
      });
      if (resp.status === 401) {
        this.#refuse(await resp.text());
        return;
      }
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
      const reason = e instanceof Error ? e.message : String(e);
      this.#end(e instanceof AuthError ? e.status : 0, reason, fatalOf(e));
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
      if (first.status === 401) throw this.#refuse(await first.text());
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

      // a fresh blob's header reaches the Engine before anything of the tail
      const reading = await this.#blobOpen(b, blob, position, skip);
      if (reading !== null) snapshot = this.#blobRecords(b, reading);
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

  /* Open a blob's body: push its length, and for a fresh download check and push its header.
     Answers where its records start, or null for a resumed blob that was already complete. */
  async #blobOpen(
    b: Backfill,
    resp: Response,
    position: number,
    skip: number,
  ): Promise<BlobReading | null> {
    if (resp.status === 416) {
      // skip is the end: every value was delivered already
      await b.push({ valuesDone: true });
      return null;
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
    return { br, fresh, fnv };
  }

  // a blob's records and footer, from where #blobOpen left its body
  async #blobRecords(b: Backfill, { br, fresh, fnv }: BlobReading): Promise<void> {
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
      if (resp.status === 401) throw this.#refuse(await resp.text());
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

  /* One call, as the requests the database's limit calls for, each with its retries.  A retry
     repeats the request under the same ids, which the database's dedup makes safe: a command the
     first attempt committed answers dup.  A 4xx answer is the client's own doing and stands at
     once; so does any failure once the stream has ended or the connection was aborted, since the
     next connection resends. */
  async #post(commands: Command<Uint8Array>[]): Promise<CommandResult[]> {
    await this.#ready();
    return inRequests(commands, this.#limits, this.#session === null, async (request) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await postCommands(this.#url, this.#headers(), request, this.#signal);
        } catch (e: unknown) {
          const clientError = e instanceof StatusError && e.status >= 400 && e.status < 500;
          if (attempt === sendRetries || clientError || this.#ended || this.#signal.aborted) {
            throw e;
          }
          await sleep(sendRetryDelay * 2 ** attempt, this.#signal);
          if (this.#ended) throw e;
        }
      }
    });
  }

  // a send that failed ends the connection: the one onEnd carries the response's status, or 0
  // when no response arrived, and the stream stops; a refused session ends it fatally
  #failed(e: unknown): void {
    if (e instanceof AuthError || (e instanceof StatusError && e.status === 401)) {
      this.#refuse(e.message);
      return;
    }
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

/** a 413: the request carried more commands than the database takes in one, max */
class TooManyCommands extends StatusError {
  max: number;
  constructor(max: number, message: string) {
    super(413, message);
    this.max = max;
  }
}

/* Commands in requests of at most the sender's limit each, one after another so that a series'
   commands reach the database in order, answered with their outcomes in order.  send makes one
   request, with whatever retries its caller wants.  A 413 names the limit the database held the
   request to, which the commands not yet answered are split again under; the database refuses
   such a request before checking any of its commands, so nothing in it was decided. */
async function inRequests(
  commands: Command<Uint8Array>[],
  limits: CommandLimits,
  anonymous: boolean,
  send: (request: Command<Uint8Array>[]) => Promise<CommandResult[]>,
): Promise<CommandResult[]> {
  const sender = anonymous ? 'anonymous' : 'session';
  const results: CommandResult[] = [];
  while (results.length < commands.length) {
    const request = commands.slice(results.length, results.length + limits[sender]);
    try {
      results.push(...(await send(request)));
    } catch (e: unknown) {
      // a limit that would not split the request is the database's mistake, and stands
      if (!(e instanceof TooManyCommands) || e.max >= request.length) throw e;
      limits[sender] = e.max;
    }
  }
  return results;
}

/* One POST of commands, answered with their outcomes in order.  Any status but 200 rejects, since
   such a response answers no command; a 413 naming the database's limit rejects with
   TooManyCommands. */
// a database's base URL, without the trailing slash that would double the one every route starts
// with
function baseURL(url: string): string {
  return url.replace(/\/+$/, '');
}

async function postCommands(
  url: string,
  headers: Record<string, string>,
  commands: Command<Uint8Array>[],
  signal?: AbortSignal,
): Promise<CommandResult[]> {
  const w = new Writer();
  for (const c of commands) {
    w.arrayHeader(4);
    if (c.series === null || c.n === null) {
      w.nil();
      w.nil();
    } else {
      w.str(c.series);
      w.int(c.n);
    }
    w.bin(uuidBytes(c.id));
    w.raw(c.data);
  }
  const resp = await fetch(`${url}/commands`, {
    method: 'POST',
    signal,
    headers: { ...headers, 'Content-Type': 'application/msgpack' },
    body: w.bytes(),
  });
  if (resp.status !== 200) {
    const message = `commands: ${resp.status} ${resp.statusText}`;
    const max = Number(resp.headers.get('PhaseLock-Max-Commands'));
    if (resp.status === 413 && Number.isSafeInteger(max) && max > 0) {
      throw new TooManyCommands(max, message);
    }
    throw new StatusError(resp.status, message);
  }
  const outcomes = decodeAny(new Uint8Array(await resp.arrayBuffer())) as unknown[][];
  return outcomes.map((o): CommandResult => {
    switch (o[0]) {
      case 'ok':
        return { kind: 'ok', position: o[1] as number };
      case 'reject':
        return { kind: 'reject', reason: o[1] as string };
      case 'conflict':
        return { kind: 'conflict', current: o[1] as Record<string, number> };
      default:
        throw new Error(`unknown command outcome ${String(o[0])}`);
    }
  });
}

/** Posts one command to the database at url and answers with its outcome: the request beneath
    HTTPTransport.post, for a transport of the app's own.  The command is the wire envelope: an id
    the caller mints, the command's wire bytes, and a series and number, or null for both to send
    it unnumbered.  The token is a session's, or null for an anonymous request.  A failed request
    rejects, and nothing is retried. */
export async function postCommand(
  url: string,
  command: Command<Uint8Array>,
  token: string | null = null,
): Promise<CommandResult> {
  const headers: Record<string, string> =
    token === null ? {} : { Authorization: `Bearer ${token}` };
  const [result] = await postCommands(baseURL(url), headers, [command]);
  return result;
}

// the error a connection ends fatally with: a refused session, and nothing else
function fatalOf(e: unknown): AuthError | undefined {
  return e instanceof AuthError ? e : undefined;
}
