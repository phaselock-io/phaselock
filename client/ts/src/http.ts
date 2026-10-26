// The HTTP transport: logins and sessions, connections, and mutations posted outside them.

import type {
  Backfill,
  BackfillOutcome,
  Connection,
  ConnectionHooks,
  Mutation,
  MutationResult,
  Registry,
  Schema,
  Signal,
  Transport,
  WireEdit,
} from './contract.js';
import { be, decodeAny, utf8, Writer } from './msgpack.js';
import { crc32c, Fnv64, sameBytes } from './checksum.js';
import { ByteReader } from './bytes.js';
import { frames } from './frames.js';
import { buildRegistry } from './registry.js';
import { AuthError, claims, Session } from './session.js';
import { uuidBytes } from './uuid.js';

// the most edits one tail request asks for
const tailMax = 1000;
// a snapshot page closes at this many operations or bytes, whichever comes first
const pageOps = 1000;
const pageBytes = 256 * 1024;
// a blob operation longer than this is corruption, since a key and a value are each at most 16 MiB
const maxOperation = 32 * 1024 * 1024;
// a blob's set opcode, and the first byte of its end marker, which sits where an opcode would
const SET = 0x00;
const END = 0xff;
// a send that fails for a reason that may not recur is tried again this many times, waiting
// this long before the first retry and twice as long before each one after
const sendRetries = 3;
const sendRetryDelay = 100;
// a session is refreshed once it has lived this share of its lifetime
const refreshAfter = 0.5;

// the most mutations one request carries, with a session and without one: the database's
// defaults, until a 413 names the database's own
type MutationLimits = { session: number; anonymous: number };

type BlobHeader = {
  position: number;
  epoch: string;
  slices: Record<string, number>;
  visible: number;
};

// a blob body opened past its header: the reader at its first operation, and the operation count
// and content hash of every operation before it
type BlobReading = { br: ByteReader; count: number; fnv: Fnv64 };

// a page's checksum, `{count}:{hash}`: the operation count and the content hash's running state
// through the page's last operation
const pageChecksum = /^(0|[1-9]\d*):([0-9a-f]{16})$/;

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

// a response header's integer, or NaN when the header is absent or empty
function headerInt(resp: Response, name: string): number {
  const v = resp.headers.get(name);
  return v === null || v === '' ? NaN : Number(v);
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
  #limits: MutationLimits = { session: 128, anonymous: 8 };

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

  /** Mutations outside any connection, as the session or as anonymous, answered with their
      outcomes in order, in as many requests as the database's limit on mutations per request
      calls for, one after another.  A request of numbered mutations that fails for a reason that
      may not recur is tried again a few times under the same ids, which the database's dedup
      makes safe; a request with an unnumbered mutation is tried once.  A 4xx stands at once, and
      a refused session ends, and the post rejects with an AuthError. */
  async post(
    mutations: Mutation<Uint8Array>[],
    session: Session | null = null,
  ): Promise<MutationResult[]> {
    ours(session);
    if (session !== null) await this.#fresh(session);
    return inRequests(mutations, this.#limits, session === null, async (request) => {
      const numbered = request.every((m) => m.series !== null && m.n !== null);
      for (let attempt = 0; ; attempt++) {
        try {
          return await postMutations(this.#url, authorization(session), request);
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

// the error a failed auth or mutation request rejects with: a 401 is the database refusing the
// session, which ends it; any other failure is itself
function refusal(e: unknown, session: Session | null): unknown {
  if (!(e instanceof StatusError) || e.status !== 401) return e;
  if (session !== null) session.ended = true;
  return new AuthError(401, e.message);
}

/* One connection over HTTP: the live stream, the backfills and mutation sends that ride on it, and
   the session they all present.  Before it opens the stream and before each send it readies the
   session, which refreshes it when due; a 401 from any of them is the database refusing the
   session, which ends the connection fatally. */
class HTTPConnection implements Connection {
  #url: string;
  #session: Session | null;
  #ready: () => Promise<void>;
  #limits: MutationLimits;
  #signal: AbortSignal;
  #hooks: ConnectionHooks;
  #ended = false;
  // the log's epoch once the stream opens, or a rejection when the connection ends before that
  #epoch: Promise<string>;
  #opened!: (epoch: string) => void;
  #unopened!: (e: Error) => void;
  // ends the connection from inside, when a send fails
  #stop = new AbortController();
  // the send queue: one call in flight, retried a few times when its failure may not recur, and
  // a failure that stands rejects every call queued at that moment without sending it and ends
  // the connection, after which every call rejects
  #sends: {
    mutations: Mutation<Uint8Array>[];
    resolve: (r: MutationResult[]) => void;
    reject: (e: unknown) => void;
  }[] = [];
  #sending = false;

  constructor(
    url: string,
    session: Session | null,
    ready: () => Promise<void>,
    limits: MutationLimits,
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

    // a backfill awaits the epoch only when it needs it, so a rejection nobody awaits is no error
    this.#epoch = new Promise((resolve, reject) => {
      this.#opened = resolve;
      this.#unopened = reject;
    });
    this.#epoch.catch(() => {});

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
    this.#unopened(new Error(`connection ended before its stream opened: ${reason}`));
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
      const head = headerInt(resp, 'PhaseLock-Position');
      if (!Number.isSafeInteger(head)) {
        this.#end(resp.status, 'stream: no position');
        return;
      }
      this.#hooks.onOpen(epoch, head);
      this.#opened(epoch);
      await frames(new ByteReader(resp.body), (f) => {
        switch (f.tag) {
          case 'edits':
            this.#hooks.onEdits(f.edits);
            return true;
          case 'live':
            this.#hooks.onLive(f.position);
            return true;
          case 'vouch':
            this.#hooks.onVouch(f.position);
            return true;
          case 'view':
            this.#hooks.onView(f.token, f.position, f.selectors);
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
    if (this.#ended) throw new Error(`snapshot ${b.selector}: the connection has ended`);

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
      const first = await fetch(`${this.#url}/snapshot/${b.selector}`, {
        signal,
        headers: this.#headers(range),
      });
      const okStatus = (r: Response) => r.status === 200 || r.status === 206 || r.status === 416;
      if (first.status === 401) throw this.#refuse(await first.text());
      if (!okStatus(first)) {
        throw new Error(`snapshot ${b.selector}: ${first.status} ${first.statusText}`);
      }

      // the origin's response carries the position and the epoch; a blob store owes only the bytes
      position = headerInt(first, 'PhaseLock-Position');
      if (!Number.isSafeInteger(position)) throw new Error(`snapshot ${b.selector}: no position`);
      const epoch = first.headers.get('PhaseLock-Epoch');
      if (epoch === null || epoch === '') throw new Error(`snapshot ${b.selector}: no epoch`);

      // a cut from another log is stale, and so is a resumed download whose cut moved; the
      // connection learns its log's epoch when the stream opens, so this waits for that
      if (epoch !== (await this.#epoch)) return 'stale';
      if (skip > 0 && position !== r!.position) return 'stale';

      // the blob, inline or where a pointer leads
      let blob = first;
      if (first.headers.get('Content-Type')?.startsWith('text/plain')) {
        // a pointer to the blob
        const target = await first.text();
        blob = await fetch(target, { signal, headers: range });
        if (blob.status === 404 || blob.status === 410) return 'stale';
        if (!okStatus(blob)) {
          throw new Error(`snapshot ${b.selector}: ${blob.status} ${blob.statusText}`);
        }
      }

      // a fresh blob's header reaches the Engine before anything of the tail
      const reading = await this.#blobOpen(b, blob, position, epoch, skip);
      if (reading === 'stale') return 'stale';
      if (reading !== null) snapshot = this.#blobPages(b, reading);
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
     Answers where its operations start, null for a resumed blob that was already complete, or
     'stale' for a fresh blob cut from a log other than the one the origin named. */
  async #blobOpen(
    b: Backfill,
    resp: Response,
    position: number,
    epoch: string,
    skip: number,
  ): Promise<BlobReading | null | 'stale'> {
    if (resp.status === 416) {
      // skip is the end: every page was delivered already
      await b.push({ pagesDone: true });
      return null;
    }
    if (!resp.body) throw new Error(`snapshot ${b.selector}: no body`);

    // the blob's whole length, for the Engine's progress, when the response states one
    const length = blobLength(resp);
    if (length !== null) await b.push({ length });

    const br = new ByteReader(resp.body, resp.status === 206 ? skip : 0);
    // a server that ignored the Range sent the whole blob; skip what we already have
    if (resp.status === 200 && skip > 0) await br.skipBytes(skip);

    // if the download is fresh, check and push its header
    if (skip === 0) {
      await br.fill(9);
      if (utf8.decode(br.take(4)) !== 'PLSN') throw new Error(`snapshot ${b.selector}: bad magic`);
      const version = br.take(1)[0];
      if (version !== 1) throw new Error(`snapshot ${b.selector}: version ${version}`);
      const hlen = readU32(br.take(4));
      await br.fill(hlen + 4);
      const hdr = br.take(hlen).slice();
      const crc = readU32(br.take(4));
      if (crc !== crc32c(hdr)) throw new Error(`snapshot ${b.selector}: header crc`);
      const header = decodeAny(hdr) as BlobHeader;
      if (header.epoch !== epoch) return 'stale'; // a pointer that led to another log's blob
      if (header.position !== position) {
        throw new Error(`snapshot ${b.selector}: position mismatch`);
      }
      if (typeof header.visible !== 'number') {
        throw new Error(`snapshot ${b.selector}: header without visible`);
      }
      await b.push({ header: { position, seqs: header.slices ?? {}, visible: header.visible } });
      return { br, count: 0, fnv: new Fnv64() };
    }

    // otherwise it resumes, so the count and the hash continue from its last parked page
    const m = pageChecksum.exec(b.resume!.checksum);
    if (m === null) throw new Error(`snapshot ${b.selector}: bad resume checksum`);
    return { br, count: Number(m[1]), fnv: Fnv64.resume(m[2]) };
  }

  /* A blob's set operations, as pages of whole ones, and its footer, from where #blobOpen left
     its body.  A page is the operations' bytes as the blob holds them; its skip is the offset
     after its last one, which a resume starts from, and its checksum the count and the hash
     through it, which a resume continues. */
  async #blobPages(b: Backfill, { br, count, fnv }: BlobReading): Promise<void> {
    const page = new Writer();
    let ops = 0;
    let bytes = 0;
    // the offset after the last whole operation: what a resume skips to
    let opEnd = br.offset;
    // one page in flight at the Engine while the next is parsed
    let pending: Promise<void> = Promise.resolve();
    const flush = async () => {
      const done = page.bytes();
      const at = opEnd;
      const checksum = `${count}:${fnv.state()}`;
      page.reset();
      ops = 0;
      bytes = 0;
      await pending;
      pending = b.push({ page: done, skip: at, checksum });
    };

    // awaits only when the buffer runs dry, so they track chunks rather than operations
    for (;;) {
      if (br.available < 1) await br.fill(1);

      // the end marker, then the footer: the operation count, the content hash, and its crc
      if (br.peek() === END) {
        if (br.available < 20) await br.fill(20);
        if (readU32(br.take(4)) !== 0xffffffff) {
          throw new Error(`snapshot ${b.selector}: corrupt operation`);
        }
        const footer = br.take(16).slice();
        if (readU32(footer.subarray(12)) !== crc32c(footer.subarray(0, 12))) {
          throw new Error(`snapshot ${b.selector}: footer crc`);
        }
        if (readU32(footer) !== count) throw new Error(`snapshot ${b.selector}: operation count`);
        if (!sameBytes(footer.subarray(4, 12), fnv.digest())) {
          throw new Error(`snapshot ${b.selector}: content hash`);
        }
        break;
      }

      // one set operation, whole: its opcode, key, and value
      if (br.peek() !== SET) throw new Error(`snapshot ${b.selector}: corrupt operation`);
      let op: Uint8Array | null;
      while ((op = br.tryValues(3)) === null) {
        if (br.available > maxOperation) {
          throw new Error(`snapshot ${b.selector}: corrupt operation`);
        }
        if (!(await br.more())) throw new Error('body ended early');
      }

      // views from tryValues die at the next refill, so hash and copy it now
      fnv.update(op);
      page.raw(op);
      count++;
      ops++;
      bytes += op.length;
      opEnd = br.offset;
      if (ops >= pageOps || bytes >= pageBytes) await flush();
    }
    if (ops > 0) await flush();
    await pending;
    await b.push({ pagesDone: true });
  }

  async #tail(b: Backfill, from: number, signal: AbortSignal): Promise<void> {
    let after = from;
    for (;;) {
      const q = `after=${after}&before=${b.until}&max=${tailMax}`;
      const resp = await fetch(`${this.#url}/edits/${b.selector}?${q}`, {
        signal,
        headers: this.#headers(),
      });
      if (resp.status === 401) throw this.#refuse(await resp.text());
      if (resp.status !== 200 || !resp.body) {
        throw new Error(`edits ${b.selector}: ${resp.status} ${resp.statusText}`);
      }
      const scanned = headerInt(resp, 'PhaseLock-Scanned');
      const edits: WireEdit[] = [];
      await frames(new ByteReader(resp.body), (f) => {
        if (f.tag !== 'edits') throw new Error(`edits ${b.selector}: ${f.tag} frame`);
        edits.push(...f.edits);
        return true;
      });
      const known = Number.isSafeInteger(scanned);
      if (edits.length > 0) {
        const reached = known ? scanned : edits[edits.length - 1].position;
        await b.push({ edits, scanned: reached });
      }

      // the scan is done once it reaches until, or when it reports no progress; a page's edit
      // count says nothing, since a page never splits the edits of one position
      if (!known || scanned >= b.until || scanned <= after) {
        await b.push({ editsDone: true });
        return;
      }
      after = scanned;
    }
  }

  sendMutations(mutations: Mutation<Uint8Array>[]): Promise<MutationResult[]> {
    return new Promise((resolve, reject) => {
      if (this.#ended) {
        reject(new Error('mutations: the connection has ended'));
        return;
      }
      this.#sends.push({ mutations, resolve, reject });
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
        next.resolve(await this.#post(next.mutations));
      } catch (e: unknown) {
        next.reject(e);
        for (const behind of this.#sends.splice(0)) behind.reject(e);
        this.#failed(e);
      }
    }
    this.#sending = false;
  }

  /* One call, as the requests the database's limit calls for, each with its retries.  A retry
     repeats the request under the same ids, which the database's dedup makes safe: a mutation the
     first attempt committed answers dup.  A 4xx answer is the client's own doing and stands at
     once; so does any failure once the stream has ended or the connection was aborted, since the
     next connection resends. */
  async #post(mutations: Mutation<Uint8Array>[]): Promise<MutationResult[]> {
    await this.#ready();
    return inRequests(mutations, this.#limits, this.#session === null, async (request) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await postMutations(this.#url, this.#headers(), request, this.#signal);
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

/** a /mutations response whose status answers no mutation */
class StatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** a 413: the request carried more mutations than the database takes in one, max */
class TooManyMutations extends StatusError {
  max: number;
  constructor(max: number, message: string) {
    super(413, message);
    this.max = max;
  }
}

/* Mutations in requests of at most the sender's limit each, one after another so that a series'
   mutations reach the database in order, answered with their outcomes in order.  send makes one
   request, with whatever retries its caller wants.  A 413 names the limit the database held the
   request to, which the mutations not yet answered are split again under; the database refuses
   such a request before checking any of its mutations, so nothing in it was decided. */
async function inRequests(
  mutations: Mutation<Uint8Array>[],
  limits: MutationLimits,
  anonymous: boolean,
  send: (request: Mutation<Uint8Array>[]) => Promise<MutationResult[]>,
): Promise<MutationResult[]> {
  const sender = anonymous ? 'anonymous' : 'session';
  const results: MutationResult[] = [];
  while (results.length < mutations.length) {
    const request = mutations.slice(results.length, results.length + limits[sender]);
    try {
      results.push(...(await send(request)));
    } catch (e: unknown) {
      // a limit that would not split the request is the database's mistake, and stands
      if (!(e instanceof TooManyMutations) || e.max >= request.length) throw e;
      limits[sender] = e.max;
    }
  }
  return results;
}

// a database's base URL, without the trailing slash that would double the one every route starts
// with
function baseURL(url: string): string {
  return url.replace(/\/+$/, '');
}

/* One POST of mutations, answered with their outcomes in order.  Any status but 200 rejects,
   since such a response answers no mutation; a 413 naming the database's limit rejects with
   TooManyMutations. */
async function postMutations(
  url: string,
  headers: Record<string, string>,
  mutations: Mutation<Uint8Array>[],
  signal?: AbortSignal,
): Promise<MutationResult[]> {
  const w = new Writer();
  for (const m of mutations) {
    w.arrayHeader(4);
    if (m.series === null || m.n === null) {
      w.nil();
      w.nil();
    } else {
      w.str(m.series);
      w.int(m.n);
    }
    w.bin(uuidBytes(m.id));
    w.raw(m.data);
  }
  const resp = await fetch(`${url}/mutations`, {
    method: 'POST',
    signal,
    headers: { ...headers, 'Content-Type': 'application/msgpack' },
    body: w.bytes(),
  });
  if (resp.status !== 200) {
    const message = `mutations: ${resp.status} ${resp.statusText}`;
    const max = headerInt(resp, 'PhaseLock-Max-Mutations');
    if (resp.status === 413 && Number.isSafeInteger(max) && max > 0) {
      throw new TooManyMutations(max, message);
    }
    throw new StatusError(resp.status, message);
  }
  const outcomes = decodeAny(new Uint8Array(await resp.arrayBuffer())) as unknown[][];
  return outcomes.map((o): MutationResult => {
    switch (o[0]) {
      case 'ok':
        return { kind: 'ok', position: o[1] as number };
      case 'reject':
        return { kind: 'reject', reason: o[1] as string };
      case 'conflict':
        return { kind: 'conflict', current: o[1] as Record<string, number> };
      default:
        throw new Error(`unknown mutation outcome ${String(o[0])}`);
    }
  });
}

/** Posts one mutation to the database at url and answers with its outcome: the request beneath
    HTTPTransport.post, for a transport of the app's own.  The mutation is the wire envelope: an
    id the caller mints, the mutation's wire bytes, and a series and number, or null for both to
    send it unnumbered.  The token is a session's, or null for an anonymous request.  A failed
    request rejects, and nothing is retried. */
export async function postMutation(
  url: string,
  mutation: Mutation<Uint8Array>,
  token: string | null = null,
): Promise<MutationResult> {
  const headers: Record<string, string> =
    token === null ? {} : { Authorization: `Bearer ${token}` };
  const [result] = await postMutations(baseURL(url), headers, [mutation]);
  return result;
}

// the error a connection ends fatally with: a refused session, and nothing else
function fatalOf(e: unknown): AuthError | undefined {
  return e instanceof AuthError ? e : undefined;
}
