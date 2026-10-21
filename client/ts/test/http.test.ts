import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decode, decodeMulti, encode } from '@msgpack/msgpack';
import { HTTPTransport, postMutation } from '../src/http.js';
import { AuthError, restoreSession, type Session } from '../src/session.js';
import { uuidString } from '../src/uuid.js';
import type {
  Backfill,
  BackfillOutcome,
  Connection,
  ConnectionHooks,
  Schema,
} from '../src/contract.js';
import { blob } from './blob.js';
import { Fnv64 } from '../src/checksum.js';
import { editOps } from '../src/edits.js';

// a scriptable origin: each route is a handler the test replaces as it likes
type Handler = (req: IncomingMessage, body: Uint8Array, res: ServerResponse) => void;

class Stub {
  server: Server;
  url = '';
  routes = new Map<string, Handler>();
  requests: {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: Uint8Array;
  }[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        const path = req.url!.split('?')[0];
        this.requests.push({ method: req.method!, path, headers: req.headers, body });
        const h = [...this.routes.entries()].find(([prefix]) => path.startsWith(prefix))?.[1];
        if (!h) {
          res.writeHead(404);
          res.end('no route');
          return;
        }
        h(req, body, res);
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    if (!a || typeof a === 'string') throw new Error('no address');
    this.url = `http://127.0.0.1:${a.port}`;
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  // a /stream that answers headers then holds the body open for frames
  stream(
    view = 'tok',
    position = 3,
  ): { push: (frame: unknown) => void; end: () => void; opened: Promise<void> } {
    let res: ServerResponse | null = null;
    let opened!: () => void;
    const openedP = new Promise<void>((r) => (opened = r));
    this.routes.set('/stream', (_req, _body, r) => {
      res = r;
      r.writeHead(200, {
        'Content-Type': 'application/msgpack',
        'PhaseLock-Epoch': 'e3',
        'PhaseLock-View': view,
        'PhaseLock-Position': String(position),
      });
      r.flushHeaders();
      opened();
    });
    return {
      push: (frame) => res!.write(Buffer.from(encode(frame))),
      end: () => res!.end(),
      opened: openedP,
    };
  }
}

function hooks(log: unknown[][]): ConnectionHooks {
  return {
    onOpen: (epoch, head) => log.push(['open', epoch, head]),
    onView: (token, position, selectors) => log.push(['view', token, position, selectors]),
    onEdits: (edits) =>
      log.push([
        'edits',
        edits.map((e) => [e.position, e.slice, e.seq, e.lifecycle, decode(e.raw)]),
      ]),
    onLive: (p) => log.push(['live', p]),
    onVouch: (p) => log.push(['vouch', p]),
    onEnd: (code, reason) => log.push(['end', code, reason]),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// an unsigned token with the claims a session reads, issued at iat with the lifetime given in
// seconds; only the database verifies its tokens, so the client never checks the signature
function token(sub = 'u1', iat = Math.floor(Date.now() / 1000), lifetime = 30 * 86400): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'EdDSA' })}.${part({ sub, iat, exp: iat + lifetime })}.sig`;
}
const JWT = token();

// a connection factory over the stub, as the session or as anonymous
function connector(session: Session | null = null) {
  return (
    since: number,
    view: string | null,
    wants: string[],
    signal: AbortSignal,
    h: ConnectionHooks,
  ): Connection => new HTTPTransport(stub.url).connect(since, view, wants, signal, h, session);
}

// a test's mutation id as the wire carries it: its name in 16 bytes, zero-padded
function label(name: string): Uint8Array {
  const b = new Uint8Array(16);
  b.set(new TextEncoder().encode(name));
  return b;
}
// the name back from those bytes
function nameOf(b: Uint8Array): string {
  return new TextDecoder().decode(b).replace(/\0+$/, '');
}
// a test's mutation id as the Engine mints it, a uuid
const uuidOf = (name: string) => uuidString(label(name));

let stub: Stub;
beforeEach(async () => {
  stub = new Stub();
  await stub.start();
});
afterEach(() => stub.stop());

describe('the live stream', () => {
  test('frames to hooks, no view call when the token was current, one end from the server', async () => {
    const s = stub.stream('t1');
    const log: unknown[][] = [];
    const ctl = new AbortController();
    connector(restoreSession(JWT))(-1, null, ['*', 'book'], ctl.signal, hooks(log));
    await s.opened;
    s.push(['live', 0]);
    s.push(['edits', [[[1, 'book', 1, label('c1'), new Date(5), 1], 0, 'book!title', 'Dune']]]);
    s.push(['view', 't2', 2, ['book', 'patron:p1']]);
    s.push(['vouch', 3]);
    s.push(['end', 7, 'done']);
    s.push(['vouch', 4]); // after end: never delivered
    s.end();
    await settle();
    expect(log).toEqual([
      ['open', 'e3', 3],
      ['live', 0],
      [
        'edits',
        [
          [
            1,
            'book',
            1,
            'birth',
            [[1, 'book', 1, label('c1'), new Date(5), 1], 0, 'book!title', 'Dune'],
          ],
        ],
      ],
      ['view', 't2', 2, ['book', 'patron:p1']],
      ['vouch', 3],
      ['end', 7, 'done'],
    ]);
    const req = stub.requests[0];
    expect(req.path).toBe('/stream');
    expect(req.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(new URL(stub.url + stub.requests[0].path + '?' + '')).toBeTruthy();
  });

  test('since and wants ride the query; no token means no Authorization header', async () => {
    const s = stub.stream();
    const seen: string[] = [];
    stub.server.on('request', (req) => seen.push(req.url!));
    connector()(42, 'stored', ['book', 'patron:*'], new AbortController().signal, hooks([]));
    await s.opened;
    expect(seen[0]).toBe('/stream?since=42&view=stored&want=book&want=patron%3A*');
    expect(stub.requests[0].headers.authorization).toBeUndefined();
  });

  test('a view frame first when the presented token was stale', async () => {
    const s = stub.stream('t9', 7);
    const log: unknown[][] = [];
    connector()(5, 'stale', ['*'], new AbortController().signal, hooks(log));
    await s.opened;
    s.push(['view', 't9', 7, ['book', 'patron:*']]);
    s.push(['live', 7]);
    s.end();
    await settle();
    expect(log).toEqual([
      ['open', 'e3', 7],
      ['view', 't9', 7, ['book', 'patron:*']],
      ['live', 7],
      ['end', 0, 'stream closed'],
    ]);
  });

  test('a closed body without an end frame ends with code 0', async () => {
    const s = stub.stream();
    const log: unknown[][] = [];
    connector()(-1, null, ['*'], new AbortController().signal, hooks(log));
    await s.opened;
    s.push(['live', 9]);
    s.end();
    await settle();
    expect(log).toEqual([
      ['open', 'e3', 3],
      ['live', 9],
      ['end', 0, 'stream closed'],
    ]);
  });

  test('a stream without an epoch header ends before any frame', async () => {
    stub.routes.set('/stream', (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/msgpack' });
      res.end();
    });
    const log: unknown[][] = [];
    connector()(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 200, 'stream: no epoch']]);
  });

  test('a stream without a position header ends before any frame', async () => {
    stub.routes.set('/stream', (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/msgpack', 'PhaseLock-Epoch': 'e3' });
      res.end();
    });
    const log: unknown[][] = [];
    connector()(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 200, 'stream: no position']]);
  });

  test('a refused handshake ends with the HTTP status', async () => {
    stub.routes.set('/stream', (_r, _b, res) => {
      res.writeHead(401);
      res.end('token rejected');
    });
    const log: unknown[][] = [];
    connector()(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 401, 'token rejected']]);
  });

  test('aborting the signal ends exactly once', async () => {
    const s = stub.stream();
    const log: unknown[][] = [];
    const ctl = new AbortController();
    connector()(-1, null, ['*'], ctl.signal, hooks(log));
    await s.opened;
    ctl.abort();
    await settle();
    s.end();
    await settle();
    expect(log.filter((l) => l[0] === 'end')).toHaveLength(1);
    expect(log.at(-1)![0]).toBe('end');
    expect(log.at(-1)![1]).toBe(0);
  });
});

describe('sendMutations', () => {
  let conn: Connection;
  let stream: ReturnType<Stub['stream']>;
  let seen: string[];
  // how many requests fail, with what status; 0 destroys the socket instead of answering
  let failures: number;
  let failStatus: number;
  let endStreamOnFirst: boolean;
  let log: unknown[][];
  beforeEach(() => {
    stream = stub.stream();
    seen = [];
    failures = 0;
    failStatus = 500;
    endStreamOnFirst = false;
    log = [];
    stub.routes.set('/mutations', (req, body, res) => {
      seen.push(nameOf((decode(body) as unknown[])[2] as Uint8Array));
      if (endStreamOnFirst && seen.length === 1) stream.end();
      if (failures > 0) {
        failures--;
        if (failStatus === 0) {
          req.socket.destroy();
          return;
        }
        res.writeHead(failStatus);
        res.end('boom');
        return;
      }
      // the first request answers slowly; serialization must still keep order
      const delay = seen.length === 1 ? 100 : 0;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/msgpack' });
        res.end(Buffer.from(encode([['ok', seen.length]])));
      }, delay);
    });
    conn = connector(restoreSession(JWT))(
      -1,
      null,
      ['*'],
      new AbortController().signal,
      hooks(log),
    );
  });
  const ends = () => log.filter((entry) => entry[0] === 'end');
  const send = (id: string) =>
    conn.sendMutations([{ id: uuidOf(id), series: 's1', n: 1, data: encode({ type: 'noop' }) }]);

  test('calls are applied in call order even when the first is slow', async () => {
    const [a, b, c] = await Promise.all([send('a'), send('b'), send('c')]);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect([a, b, c].map((r) => r[0])).toEqual([
      { kind: 'ok', position: 1 },
      { kind: 'ok', position: 2 },
      { kind: 'ok', position: 3 },
    ]);
    const req = stub.requests.find((r) => r.path === '/mutations')!;
    expect(req.headers['content-type']).toBe('application/msgpack');
    expect(decode(req.body)).toEqual(['s1', 1, label('a'), { type: 'noop' }]);
  });

  test('a call past the limit goes in requests under it, in order', async () => {
    stub.routes.set('/mutations', (_req, body, res) => {
      const muts = [...decodeMulti(body)] as unknown[][];
      seen.push(...muts.map((c) => nameOf(c[2] as Uint8Array)));
      if (muts.length > 4) {
        res.writeHead(413, { 'PhaseLock-Max-Mutations': '4' });
        res.end('too many');
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from(encode(muts.map((c) => ['ok', c[1]]))));
    });
    const ids = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const results = await conn.sendMutations(
      ids.map((id, i) => ({ id: uuidOf(id), series: 's1', n: i + 1, data: encode({}) })),
    );
    expect(results.map((r) => (r.kind === 'ok' ? r.position : null))).toEqual(
      ids.map((_, i) => i + 1),
    );
    const posts = stub.requests.filter((r) => r.path === '/mutations');
    expect(posts.map((r) => [...decodeMulti(r.body)].length)).toEqual([10, 4, 4, 2]);
    expect(seen.slice(10)).toEqual(ids);
    expect(ends()).toEqual([]);
  });

  test('a 5xx is retried under the same series and numbers, and the call succeeds', async () => {
    failures = 1;
    failStatus = 503;
    expect((await send('a'))[0]).toEqual({ kind: 'ok', position: 2 });
    expect(seen).toEqual(['a', 'a']);
    expect(ends()).toEqual([]);
  });

  test('a failure that stands fails every call queued behind it, unsent, and ends the connection with its status', async () => {
    await send('a');
    failures = Infinity;
    const results = await Promise.allSettled([send('b'), send('c'), send('d')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(seen).toEqual(['a', 'b', 'b', 'b', 'b']);
    expect(ends()).toEqual([['end', 500, expect.stringContaining('mutations: 500')]]);
    await expect(send('e')).rejects.toThrow('the connection has ended');
    expect(seen.length).toBe(5);
  });

  test('a 4xx is not retried', async () => {
    failures = Infinity;
    failStatus = 400;
    await expect(send('a')).rejects.toThrow('mutations: 400');
    expect(seen).toEqual(['a']);
    expect(ends()).toEqual([['end', 400, expect.stringContaining('mutations: 400')]]);
  });

  test('a request that gets no response is retried, then ends the connection with code 0', async () => {
    failures = Infinity;
    failStatus = 0;
    await expect(send('a')).rejects.toThrow();
    expect(seen).toEqual(['a', 'a', 'a', 'a']);
    expect(ends()).toEqual([['end', 0, expect.any(String)]]);
  });

  test('retries stop once the stream has ended', async () => {
    failures = Infinity;
    failStatus = 503;
    endStreamOnFirst = true;
    await expect(send('a')).rejects.toThrow('mutations: 503');
    expect(seen).toEqual(['a']);
    expect(ends()).toEqual([['end', 0, 'stream closed']]);
  });

  test('every outcome kind, and several mutations in one call', async () => {
    stub.routes.set('/mutations', (_req, body, res) => {
      // the body is back-to-back mutations
      const muts = [...decodeMulti(body)] as unknown[][];
      expect(muts.map((c) => nameOf(c[2] as Uint8Array))).toEqual(['a', 'b', 'c', 'd']);
      expect(muts.map((c) => [c[0], c[1]])).toEqual([
        ['s1', 1],
        ['s1', 2],
        [null, null],
        ['s2', 7],
      ]);
      res.writeHead(200);
      res.end(
        Buffer.from(
          encode([
            ['ok', 10],
            ['reject', 'no'],
            ['conflict', { 'patron:p1': 4 }],
            ['ok', 3],
          ]),
        ),
      );
    });
    const series: [string | null, number | null][] = [
      ['s1', 1],
      ['s1', 2],
      [null, null],
      ['s2', 7],
    ];
    const r = await conn.sendMutations(
      ['a', 'b', 'c', 'd'].map((id, i) => ({
        id: uuidOf(id),
        series: series[i][0],
        n: series[i][1],
        data: encode({}),
      })),
    );
    expect(r).toEqual([
      { kind: 'ok', position: 10 },
      { kind: 'reject', reason: 'no' },
      { kind: 'conflict', current: { 'patron:p1': 4 } },
      { kind: 'ok', position: 3 },
    ]);
  });
});

describe('HTTPTransport', () => {
  // an /auth/token that signs tokens for the user it was asked about, or refuses with status
  function auth(refuse?: number): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    stub.routes.set('/auth/token', (_req, body, res) => {
      const req = decode(body) as { identity?: string };
      bodies.push(req);
      if (refuse !== undefined) {
        res.writeHead(refuse);
        res.end('no such account');
        return;
      }
      const t = token(req.identity ?? 'u1', Math.floor(Date.now() / 1000) + bodies.length);
      res.writeHead(200);
      res.end(Buffer.from(encode({ token: t, user: req.identity ?? 'u1', exp: 99 })));
    });
    return { bodies };
  }

  // a /mutations that answers every mutation ok, or refuses with status
  function mutations(refuse?: number): void {
    stub.routes.set('/mutations', (_req, body, res) => {
      if (refuse !== undefined) {
        res.writeHead(refuse);
        res.end('token rejected');
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from(encode([...decodeMulti(body)].map(() => ['ok', 7]))));
    });
  }

  test('a login answers a session for the user its token names', async () => {
    const { bodies } = auth();
    const s = await new HTTPTransport(stub.url).login({ kind: 'dev', identity: 'ann' });
    expect(bodies).toEqual([{ kind: 'dev', identity: 'ann' }]);
    expect(s.user).toBe('ann');
    expect(s.ended).toBe(false);
  });

  test('a refused login rejects with an AuthError naming the status', async () => {
    auth(401);
    const login = new HTTPTransport(stub.url).login({ kind: 'dev', identity: 'nobody' });
    await expect(login).rejects.toThrow(AuthError);
    await expect(login).rejects.toMatchObject({ status: 401 });
  });

  test('a session past half its lifetime is refreshed in place before it is presented', async () => {
    const { bodies } = auth();
    mutations();
    const old = token('ann', Math.floor(Date.now() / 1000) - 100, 150);
    const s = restoreSession(old);
    const seen: string[] = [];
    s.onRefresh = (r) => seen.push(r.token);
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    const t = new HTTPTransport(stub.url);

    // two posts at once share one refresh, and both present the new token
    await Promise.all([t.post([mutation], s), t.post([mutation], s)]);
    expect(bodies).toEqual([{ kind: 'refresh' }]);
    const refresh = stub.requests.find((r) => r.path === '/auth/token')!;
    expect(refresh.headers.authorization).toBe(`Bearer ${old}`);
    expect(seen).toEqual([s.token]);
    expect(s.token).not.toBe(old);
    expect(s.exp).toBe(99);
    const posts = stub.requests.filter((r) => r.path === '/mutations');
    expect(posts.map((r) => r.headers.authorization)).toEqual([
      `Bearer ${s.token}`,
      `Bearer ${s.token}`,
    ]);
  });

  test('a session in the first half of its lifetime is presented as it is', async () => {
    const { bodies } = auth();
    mutations();
    const s = restoreSession(JWT);
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    expect(await new HTTPTransport(stub.url).post([mutation], s)).toEqual([
      { kind: 'ok', position: 7 },
    ]);
    expect(bodies).toEqual([]);
    expect(s.token).toBe(JWT);
  });

  test('a refused post ends its session, and a post with an ended session sends nothing', async () => {
    mutations(401);
    const s = restoreSession(JWT);
    const t = new HTTPTransport(stub.url);
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    await expect(t.post([mutation], s)).rejects.toThrow(AuthError);
    expect(s.ended).toBe(true);
    await expect(t.post([mutation], s)).rejects.toThrow(AuthError);
    expect(stub.requests.length).toBe(1);
  });

  test('a refused stream ends the connection fatally and ends its session', async () => {
    stub.routes.set('/stream', (_req, _body, res) => {
      res.writeHead(401);
      res.end('token rejected');
    });
    const s = restoreSession(JWT);
    let fatal: unknown;
    const h = hooks([]);
    connector(s)(-1, null, ['*'], new AbortController().signal, {
      ...h,
      onEnd: (_code, _reason, f) => (fatal = f),
    });
    await settle();
    expect(fatal).toBeInstanceOf(AuthError);
    expect(s.ended).toBe(true);
  });

  test('a refused mutation send ends the connection fatally', async () => {
    const st = stub.stream();
    mutations(401);
    const s = restoreSession(JWT);
    const log: unknown[][] = [];
    let fatal: unknown;
    const conn = connector(s)(-1, null, ['*'], new AbortController().signal, {
      ...hooks(log),
      onEnd: (code, reason, f) => {
        log.push(['end', code, reason]);
        fatal = f;
      },
    });
    await st.opened;
    const mutation = { id: uuidOf('c1'), series: 's', n: 1, data: encode({}) };
    await expect(conn.sendMutations([mutation])).rejects.toThrow();
    expect(log.at(-1)).toEqual(['end', 401, 'mutations: 401 Unauthorized']);
    expect(fatal).toBeInstanceOf(AuthError);
    expect(s.ended).toBe(true);
  });

  test('an ended session fails its connection before it opens the stream', async () => {
    const s = restoreSession(JWT);
    s.ended = true;
    let end: unknown[] = [];
    connector(s)(-1, null, ['*'], new AbortController().signal, {
      ...hooks([]),
      onEnd: (code, _reason, fatal) => (end = [code, fatal]),
    });
    await settle();
    expect(end[0]).toBe(401);
    expect(end[1]).toBeInstanceOf(AuthError);
    expect(stub.requests).toEqual([]);
  });

  // a /mutations that fails with each status in turn, then answers every mutation ok
  function flaky(...statuses: number[]): void {
    stub.routes.set('/mutations', (_req, body, res) => {
      const status = statuses.shift();
      if (status !== undefined) {
        res.writeHead(status);
        res.end('no');
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from(encode([...decodeMulti(body)].map(() => ['ok', 7]))));
    });
  }

  test('a numbered post that fails for a reason that may not recur is retried under the same ids', async () => {
    flaky(503, 502);
    const mutation = { id: uuidOf('c1'), series: 's1', n: 1, data: encode({}) };
    expect(await new HTTPTransport(stub.url).post([mutation])).toEqual([
      { kind: 'ok', position: 7 },
    ]);
    expect(stub.requests.length).toBe(3);
    const bodies = stub.requests.map((r) => [...decodeMulti(r.body)]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  test('an unnumbered post is tried once', async () => {
    flaky(503);
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    await expect(new HTTPTransport(stub.url).post([mutation])).rejects.toThrow('mutations: 503');
    expect(stub.requests.length).toBe(1);
  });

  test('a 4xx stands at once, numbered or not', async () => {
    flaky(400);
    const mutation = { id: uuidOf('c1'), series: 's1', n: 1, data: encode({}) };
    await expect(new HTTPTransport(stub.url).post([mutation])).rejects.toThrow('mutations: 400');
    expect(stub.requests.length).toBe(1);
  });

  // a /mutations that takes at most max mutations a request, refusing more with a 413 that names
  // max, and answers each mutation it takes ok at its number
  function limited(max: number): void {
    stub.routes.set('/mutations', (_req, body, res) => {
      const muts = [...decodeMulti(body)] as unknown[][];
      if (muts.length > max) {
        res.writeHead(413, { 'PhaseLock-Max-Mutations': String(max) });
        res.end('too many');
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from(encode(muts.map((c) => ['ok', c[1]]))));
    });
  }
  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: uuidOf(`c${i}`),
      series: 's1',
      n: i + 1,
      data: encode({}),
    }));
  const sizes = () =>
    stub.requests
      .filter((r) => r.path === '/mutations')
      .map((r) => [...decodeMulti(r.body)].length);
  const positions = (rs: { kind: string; position?: number }[]) => rs.map((r) => r.position);

  test('a post goes in requests of 8 mutations without a session, and of 128 with one', async () => {
    limited(128);
    const t = new HTTPTransport(stub.url);
    const anonymous = await t.post(numbered(20));
    const signedIn = await t.post(numbered(300), restoreSession(JWT));
    expect(sizes()).toEqual([8, 8, 4, 128, 128, 44]);
    expect(positions(anonymous)).toEqual(numbered(20).map((c) => c.n));
    expect(positions(signedIn)).toEqual(numbered(300).map((c) => c.n));
  });

  test('a 413 naming a lower limit splits the rest of the post under it, and later posts start there', async () => {
    limited(3);
    const t = new HTTPTransport(stub.url);
    expect(positions(await t.post(numbered(10)))).toEqual(numbered(10).map((c) => c.n));
    expect(positions(await t.post(numbered(5)))).toEqual(numbered(5).map((c) => c.n));
    expect(sizes()).toEqual([8, 3, 3, 3, 1, 3, 2]);
  });

  test('a session this library did not make is refused before anything is sent', async () => {
    const t = new HTTPTransport(stub.url);
    const foreign = { token: JWT, user: 'u1', exp: 0, ended: false } as unknown as Session;
    const mutation = { id: uuidOf('c1'), series: 's1', n: 1, data: encode({}) };
    await expect(t.post([mutation], foreign)).rejects.toThrow(/not a session from @phaselock/);
    expect(() =>
      t.connect(-1, null, ['*'], new AbortController().signal, hooks([]), foreign),
    ).toThrow(TypeError);
    expect(() => t.refresh(foreign)).toThrow(TypeError);
    expect(stub.requests).toEqual([]);
  });

  test('builds each schema into a Registry once', () => {
    const schema: Schema = { nodes: [], ids: {}, mutations: null };
    const t = new HTTPTransport(stub.url);
    expect(t.buildRegistry(schema)).toBe(t.buildRegistry(schema));
    expect(t.buildRegistry({ ...schema })).not.toBe(t.buildRegistry(schema));
  });
});

describe('the base URL', () => {
  test("every route is under the base URL's path, with or without a trailing slash", async () => {
    stub.routes.set('/phaselock/mutations', (_req, _body, res) => {
      res.writeHead(200);
      res.end(Buffer.from(encode([['ok', 7]])));
    });
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    for (const base of [`${stub.url}/phaselock`, `${stub.url}/phaselock/`]) {
      await new HTTPTransport(base).post([mutation]);
      await postMutation(base, mutation);
    }
    expect(stub.requests.map((r) => r.path)).toEqual(Array(4).fill('/phaselock/mutations'));
  });
});

describe('postMutation', () => {
  test('one mutation, with the token when given, answered with its outcome', async () => {
    stub.routes.set('/mutations', (_req, _body, res) => {
      res.writeHead(200);
      res.end(Buffer.from(encode([['reject', 'taken']])));
    });
    const mutation = {
      id: uuidOf('c1'),
      series: null,
      n: null,
      data: encode({ type: 'create-account' }),
    };
    expect(await postMutation(stub.url, mutation, JWT)).toEqual({
      kind: 'reject',
      reason: 'taken',
    });
    expect(await postMutation(stub.url, mutation)).toEqual({ kind: 'reject', reason: 'taken' });
    const [signed, anonymous] = stub.requests;
    expect(signed.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(signed.headers['content-type']).toBe('application/msgpack');
    expect(decode(signed.body)).toEqual([null, null, label('c1'), { type: 'create-account' }]);
    expect(anonymous.headers.authorization).toBeUndefined();
  });

  test('a failed request rejects and is not retried', async () => {
    stub.routes.set('/mutations', (_req, _body, res) => {
      res.writeHead(503);
      res.end('busy');
    });
    const mutation = { id: uuidOf('c1'), series: null, n: null, data: encode({}) };
    await expect(postMutation(stub.url, mutation)).rejects.toThrow('mutations: 503');
    expect(stub.requests.length).toBe(1);
  });
});

describe('backfill', () => {
  const values = Object.fromEntries(
    Array.from({ length: 2500 }, (_, i) => [
      `patron:p${String(i).padStart(4, '0')}!patron`,
      { name: 'n'.repeat(200), i },
    ]),
  );
  const slices = Object.fromEntries(Object.keys(values).map((k) => [k.split('!')[0], 2]));
  const built = blob({ selector: 'patron:*', position: 40, epoch: 'e3', slices, values });
  // the body's operations, from the first to the end marker
  const body = built.bytes.subarray(built.start, built.opEnds.at(-1));
  // the checksum a page ending with operation i carries: the count and the hash through it
  function checksumAt(i: number): string {
    const fnv = new Fnv64();
    fnv.update(built.bytes.subarray(built.start, built.opEnds[i]));
    return `${i + 1}:${fnv.state()}`;
  }

  type Run = {
    outcome: BackfillOutcome;
    header: { position: number; seqs: Record<string, number> } | null;
    pages: { bytes: Uint8Array; keys: string[]; skip: number; checksum: string }[];
    tails: [number, string, number][][];
    scanned: number[];
    lengths: number[];
    done: ('pages' | 'edits')[];
  };

  async function run(
    conn: Connection,
    selector: string,
    until: number,
    resume: Backfill['resume'] = null,
  ): Promise<Run> {
    const got: Run = {
      outcome: 'done',
      header: null,
      pages: [],
      tails: [],
      scanned: [],
      lengths: [],
      done: [],
    };
    got.outcome = await conn.backfill({
      selector,
      until,
      resume,
      signal: new AbortController().signal,
      push: async (item) => {
        if ('length' in item) {
          got.lengths.push(item.length);
        } else if ('header' in item) {
          got.header = item.header;
        } else if ('page' in item) {
          const keys = editOps(item.page, false).map(([k]) => k);
          got.pages.push({ bytes: item.page, keys, skip: item.skip, checksum: item.checksum });
        } else if ('pagesDone' in item) {
          got.done.push('pages');
        } else if ('edits' in item) {
          got.tails.push(item.edits.map((e) => [e.position, e.slice, e.seq]));
          got.scanned.push(item.scanned);
        } else {
          got.done.push('edits');
        }
      },
    });
    return got;
  }

  // serve the blob inline at position 40 of the stream's log, honoring Range
  function serveBlob(bytes = built.bytes, position = 40, epoch = 'e3') {
    stub.routes.set('/snapshot/', (req, _body, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const skip = range ? Number(range[1]) : 0;
      if (skip >= bytes.length) {
        res.writeHead(416, { 'PhaseLock-Position': String(position), 'PhaseLock-Epoch': epoch });
        res.end();
        return;
      }
      const length =
        skip > 0
          ? { 'Content-Range': `bytes ${skip}-${bytes.length - 1}/${bytes.length}` }
          : { 'Content-Length': String(bytes.length) };
      res.writeHead(skip > 0 ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': String(position),
        'PhaseLock-Epoch': epoch,
        ...length,
      });
      res.end(Buffer.from(bytes.subarray(skip)));
    });
  }

  // a tail: pages of edits for `selector` between after and before, from a fixed log of one edit
  // per position
  const log: [number, string, number][] = [];
  for (let p = 41; p <= 3500; p++) log.push([p, `patron:p${String(p % 7).padStart(4, '0')}`, p]);
  const wireEdit = ([p, slice, seq]: [number, string, number]) => [
    [p, slice, seq, label(`c${p}`), new Date(0), 0],
    0,
    `${slice}!n`,
    p,
  ];
  function serveTail() {
    stub.routes.set('/edits/', (req, _body, res) => {
      const u = new URL(req.url!, stub.url);
      const after = Number(u.searchParams.get('after'));
      const before = Number(u.searchParams.get('before') ?? Infinity);
      const max = Number(u.searchParams.get('max'));
      const page = log.filter(([p]) => p > after && p < before).slice(0, max);
      const scanned = page.length === max ? page[page.length - 1][0] : before;
      res.writeHead(200, {
        'Content-Type': 'application/msgpack',
        'PhaseLock-Scanned': String(scanned),
      });
      const frames = page.map((e) => encode(['edits', [wireEdit(e)]]));
      res.end(Buffer.concat(frames.map((b) => Buffer.from(b))));
    });
  }

  let conn: Connection;
  beforeEach(() => {
    stub.stream();
    conn = connector(restoreSession(JWT))(-1, null, ['*'], new AbortController().signal, hooks([]));
  });

  test('header, pages with operation-boundary skips, checksums, and an empty tail', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 40);
    expect(r.outcome).toBe('done');
    expect(r.lengths).toEqual([built.bytes.length]);
    expect(r.header).toEqual({ position: 40, seqs: slices });
    const keys = r.pages.flatMap((p) => p.keys);
    expect(keys).toEqual(Object.keys(values).sort());
    // pages are bounded by operations or bytes; each skip is the offset after its last one, and
    // each checksum the count and the hash through it
    expect(r.pages.length).toBeGreaterThan(1);
    let n = 0;
    for (const p of r.pages) {
      n += p.keys.length;
      expect(p.skip).toBe(built.opEnds[n - 1]);
      expect(p.checksum).toBe(checksumAt(n - 1));
    }
    // each half ends with exactly one done call, and no empty page is ever delivered
    expect(r.tails).toEqual([]);
    expect(r.done.sort()).toEqual(['edits', 'pages']);
    const reqs = stub.requests.filter((q) => q.path.startsWith('/edits/'));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers.authorization).toBe(`Bearer ${JWT}`);
  });

  test("the pages are the blob's operations as it holds them, values undecoded", async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 40);
    const joined = new Uint8Array(r.pages.reduce((n, p) => n + p.bytes.length, 0));
    let at = 0;
    for (const p of r.pages) {
      joined.set(p.bytes, at);
      at += p.bytes.length;
    }
    expect(Buffer.from(joined).equals(body)).toBe(true);
    const [key, value] = editOps(r.pages[0].bytes, false)[0];
    expect([key, decode(value!)]).toEqual(['patron:p0000!patron', { name: 'n'.repeat(200), i: 0 }]);
  });

  test('the tail pages forward from the blob position to until and stops on reaching it', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 2600);
    const positions = r.tails.flat().map(([p]) => p);
    expect(positions[0]).toBe(41);
    expect(positions.at(-1)).toBe(2599);
    expect(positions).toHaveLength(2559);
    expect(r.tails).toHaveLength(3);
    // each page reports how far its scan reached: a full page its last edit, a short one until
    expect(r.scanned).toEqual([1040, 2040, 2600]);
    expect(r.done.filter((d) => d === 'edits')).toEqual(['edits']);
    expect(stub.requests.filter((q) => q.path.startsWith('/edits/'))).toHaveLength(3);
  });

  test('a page of fewer edits than asked for continues while its scan is short of until', async () => {
    serveBlob();
    // pages of two positions, each with an edit to two slices, whatever max asks for
    stub.routes.set('/edits/', (req, _body, res) => {
      const after = Number(new URL(req.url!, stub.url).searchParams.get('after'));
      const scanned = Math.min(after + 2, 46);
      res.writeHead(200, { 'PhaseLock-Scanned': String(scanned) });
      const frames: Uint8Array[] = [];
      for (let p = after + 1; p <= scanned && p < 46; p++) {
        frames.push(encode(['edits', [wireEdit([p, 'a', p]), wireEdit([p, 'b', p])]]));
      }
      res.end(Buffer.concat(frames.map((b) => Buffer.from(b))));
    });
    const r = await run(conn, 'patron:*', 46);
    expect(r.tails.flat().map(([p, s]) => `${p}${s}`)).toEqual([
      '41a',
      '41b',
      '42a',
      '42b',
      '43a',
      '43b',
      '44a',
      '44b',
      '45a',
      '45b',
    ]);
    expect(r.scanned).toEqual([42, 44, 46]);
  });

  test('a tail page without a scan ends the tail', async () => {
    serveBlob();
    stub.routes.set('/edits/', (_req, _body, res) => {
      res.writeHead(200);
      res.end(Buffer.from(encode(['edits', [wireEdit([41, 'a', 1])]])));
    });
    const r = await run(conn, 'patron:*', 1000);
    expect(r.scanned).toEqual([41]);
    expect(r.done).toContain('edits');
    expect(stub.requests.filter((q) => q.path.startsWith('/edits/'))).toHaveLength(1);
  });

  test('the tail honors the fromPosition floor and a newer blob overrides it', async () => {
    serveBlob();
    serveTail();
    const seenAfter: number[] = [];
    stub.server.on('request', (req) => {
      if (req.url!.startsWith('/edits/'))
        seenAfter.push(Number(new URL(req.url!, stub.url).searchParams.get('after')));
    });
    await run(conn, 'patron:*', 200, {
      position: 40,
      skipBytes: 0,
      checksum: '',
      fromPosition: 100,
      snapshotDone: false,
      tailDone: false,
    });
    expect(seenAfter).toEqual([100]);
    seenAfter.length = 0;
    await run(conn, 'patron:*', 200, {
      position: 10,
      skipBytes: 0,
      checksum: '',
      fromPosition: 20,
      snapshotDone: false,
      tailDone: false,
    });
    expect(seenAfter).toEqual([40]);
  });

  test('resume: 206 continues at skipBytes with no header call, and the footer checks out', async () => {
    serveBlob();
    serveTail();
    const skip = built.opEnds[1000];
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: skip,
      checksum: checksumAt(1000),
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('done');
    expect(r.header).toBeNull();
    expect(r.lengths).toEqual([built.bytes.length]);
    expect(r.pages.flatMap((p) => p.keys)).toEqual(Object.keys(values).sort().slice(1001));
    expect(r.pages[0].skip).toBeGreaterThan(skip);
    expect(stub.requests.find((q) => q.path.startsWith('/snapshot/'))!.headers.range).toBe(
      `bytes=${skip}-`,
    );
  });

  test('resume: a server that ignores Range gets skipped locally', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      res.end(Buffer.from(built.bytes));
    });
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: built.opEnds[2400],
      checksum: checksumAt(2400),
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.pages.flatMap((p) => p.keys)).toEqual(Object.keys(values).sort().slice(2401));
  });

  test.each([
    // a value's last byte, its `i`, changed to another valid int, past the resume point
    ['content hash', checksumAt(1000), (b: Uint8Array) => (b[built.opEnds[2000] - 1] ^= 1)],
    // the resume point's hash, with a count one short
    ['operation count', checksumAt(1000).replace(/^\d+/, '1000'), () => {}],
    // a count that matches, with the hash of a different resume point
    ['content hash', `1001:${checksumAt(999).split(':')[1]}`, () => {}],
  ])(
    'resume: the footer is checked through the resumed checksum: %s',
    async (what, checksum, corrupt) => {
      const bytes = built.bytes.slice();
      corrupt(bytes);
      serveBlob(bytes);
      serveTail();
      const resume = {
        position: 40,
        skipBytes: built.opEnds[1000],
        checksum,
        fromPosition: 40,
        snapshotDone: false,
        tailDone: false,
      };
      await expect(run(conn, 'patron:*', 40, resume)).rejects.toThrow(new RegExp(what));
    },
  );

  test.each(['', '1001', `1001:${'0'.repeat(15)}`, `x:${'0'.repeat(16)}`, `01:${'0'.repeat(16)}`])(
    'resume: a malformed checksum is an error: %j',
    async (checksum) => {
      serveBlob();
      serveTail();
      const resume = {
        position: 40,
        skipBytes: built.opEnds[1000],
        checksum,
        fromPosition: 40,
        snapshotDone: false,
        tailDone: false,
      };
      await expect(run(conn, 'patron:*', 40, resume)).rejects.toThrow(/bad resume checksum/);
    },
  );

  test('resume: 416 means nothing is left', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: built.bytes.length,
      checksum: checksumAt(2499),
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('done');
    expect(r.pages).toEqual([]);
    expect(r.done).toContain('pages');
  });

  test('resume: a finished half is skipped outright', async () => {
    serveBlob();
    serveTail();
    const snapshotDone = {
      position: 40,
      skipBytes: 0,
      checksum: '',
      fromPosition: 40,
      snapshotDone: true,
      tailDone: false,
    };
    const r = await run(conn, 'patron:*', 100, snapshotDone);
    expect(r.outcome).toBe('done');
    expect(r.header).toBeNull();
    expect(r.pages).toEqual([]);
    expect(r.done).toEqual(['edits']);
    expect(stub.requests.filter((q) => q.path.startsWith('/snapshot/'))).toHaveLength(0);
    const tailDone = {
      position: 40,
      skipBytes: 0,
      checksum: '',
      fromPosition: 99,
      snapshotDone: false,
      tailDone: true,
    };
    const r2 = await run(conn, 'patron:*', 100, tailDone);
    expect(r2.outcome).toBe('done');
    expect(r2.header!.position).toBe(40);
    expect(r2.tails).toEqual([]);
    expect(r2.done).toEqual(['pages']);
    expect(stub.requests.filter((q) => q.path.startsWith('/edits/'))).toHaveLength(1);
  });

  test('stale: a resumed position that no longer matches', async () => {
    serveBlob(built.bytes, 41);
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: 100,
      checksum: '',
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('stale');
    expect(r.header).toBeNull();
    expect(r.pages).toEqual([]);
  });

  test('the pointer form, and stale when the pointer target is gone', async () => {
    let gone = false;
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      res.end(`${stub.url}/blob/xyz`);
    });
    stub.routes.set('/blob/', (req, _body, res) => {
      if (gone) {
        res.writeHead(404);
        res.end();
        return;
      }
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(200);
      res.end(Buffer.from(built.bytes));
    });
    serveTail();
    const r = await run(conn, 'patron:*', 40);
    expect(r.outcome).toBe('done');
    expect(r.header!.position).toBe(40);
    expect(r.pages.flatMap((p) => p.keys)).toHaveLength(2500);
    gone = true;
    expect((await run(conn, 'patron:*', 40)).outcome).toBe('stale');
  });

  test('a 403 on the snapshot rejects, and is not mistaken for a pointer', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('selector not visible');
    });
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(/403/);
  });

  test('a snapshot response without a position rejects', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'PhaseLock-Epoch': 'e3' });
      res.end(Buffer.from(built.bytes));
    });
    serveTail();
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(/no position/);
  });

  test('a snapshot response without an epoch rejects', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
      });
      res.end(Buffer.from(built.bytes));
    });
    serveTail();
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(/no epoch/);
  });

  test("stale: an origin epoch other than the stream's, fresh or resumed", async () => {
    serveBlob(built.bytes, 40, 'e4');
    serveTail();
    const fresh = await run(conn, 'patron:*', 40);
    expect(fresh.outcome).toBe('stale');
    expect(fresh.header).toBeNull();
    expect(fresh.pages).toEqual([]);
    const resumed = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: built.opEnds[1000],
      checksum: checksumAt(1000),
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(resumed.outcome).toBe('stale');
    expect(resumed.pages).toEqual([]);
    expect(stub.requests.filter((q) => q.path.startsWith('/edits/'))).toHaveLength(0);
  });

  test("stale: a blob whose header names an epoch other than the origin's", async () => {
    const other = blob({ selector: 'patron:*', position: 40, epoch: 'e9', slices, values });
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      res.end(`${stub.url}/blob/xyz`);
    });
    stub.routes.set('/blob/', (_req, _body, res) => {
      res.writeHead(200);
      res.end(Buffer.from(other.bytes));
    });
    serveTail();
    const r = await run(conn, 'patron:*', 40);
    expect(r.outcome).toBe('stale');
    expect(r.header).toBeNull();
    expect(r.pages).toEqual([]);
  });

  test('a backfill started before the stream opens waits for it', async () => {
    // a stream that answers only once released
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    stub.routes.set('/stream', (_req, _body, res) => {
      void gate.then(() => {
        res.writeHead(200, {
          'Content-Type': 'application/msgpack',
          'PhaseLock-Epoch': 'e3',
          'PhaseLock-Position': '3',
        });
        res.flushHeaders();
      });
    });
    serveBlob();
    serveTail();
    const log: unknown[][] = [];
    const early = connector(restoreSession(JWT))(
      -1,
      null,
      ['*'],
      new AbortController().signal,
      hooks(log),
    );

    // the snapshot is requested at once, but nothing is pushed until the stream opens
    let settled = false;
    const p = run(early, 'patron:*', 40).finally(() => (settled = true));
    await settle();
    expect(stub.requests.some((q) => q.path.startsWith('/snapshot/'))).toBe(true);
    expect(settled).toBe(false);
    expect(log).toEqual([]);
    release();
    const r = await p;
    expect(r.outcome).toBe('done');
    expect(r.header).toEqual({ position: 40, seqs: slices });
    expect(log).toEqual([['open', 'e3', 3]]);
  });

  test('a backfill waiting for the stream fails when the connection ends before it opens', async () => {
    stub.routes.set('/stream', (_req, _body, res) => {
      setTimeout(() => {
        res.writeHead(503);
        res.end('unavailable');
      }, 50);
    });
    serveBlob();
    serveTail();
    const failing = connector(restoreSession(JWT))(
      -1,
      null,
      ['*'],
      new AbortController().signal,
      hooks([]),
    );
    await expect(run(failing, 'patron:*', 40)).rejects.toThrow(/before its stream opened/);
  });

  test.each([
    ['header crc', (b: Uint8Array) => (b[9] ^= 1)],
    // an opcode other than a set
    ['corrupt operation', (b: Uint8Array) => (b[built.opEnds[5]] = 1)],
    // a value's last byte, its `i`, changed to another valid int
    ['content hash', (b: Uint8Array) => (b[built.opEnds[5] - 1] ^= 1)],
    ['footer crc', (b: Uint8Array) => (b[b.length - 1] ^= 1)],
    ['bad magic', (b: Uint8Array) => (b[0] = 0x58)],
  ])('corruption is detected: %s', async (what, corrupt) => {
    const bytes = built.bytes.slice();
    corrupt(bytes);
    serveBlob(bytes);
    serveTail();
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(new RegExp(what));
  });

  test("a fresh blob's header is pushed before anything of the tail, however slow its body", async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      // the headers go at once, and the body starts well after the tail has answered
      res.flushHeaders();
      setTimeout(() => res.end(Buffer.from(built.bytes)), 100);
    });
    serveTail();
    const order: string[] = [];
    await conn.backfill({
      selector: 'patron:*',
      until: 45,
      resume: null,
      signal: new AbortController().signal,
      push: async (item) => {
        order.push(Object.keys(item)[0]);
      },
    });
    const header = order.indexOf('header');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(order.findIndex((k) => k === 'edits' || k === 'editsDone')).toBeGreaterThan(header);
  });

  test('a position in the blob header that disagrees with the origin is an error', async () => {
    serveBlob(built.bytes, 41);
    serveTail();
    await expect(run(conn, 'patron:*', 41)).rejects.toThrow(/position mismatch/);
  });

  test('a failing tail aborts the blob download', async () => {
    let blobAborted = false;
    stub.routes.set('/snapshot/', (req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      // trickle the blob past its header and first operation, so the tail failure lands
      // mid-download
      res.write(Buffer.from(built.bytes.subarray(0, built.opEnds[0])));
      req.on('close', () => (blobAborted = true));
    });
    stub.routes.set('/edits/', (_req, _body, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    await expect(run(conn, 'patron:*', 100)).rejects.toThrow(/edits patron:\*: 500/);
    await settle();
    expect(blobAborted).toBe(true);
  });

  test('the backfill signal cancels it', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
        'PhaseLock-Epoch': 'e3',
      });
      res.write(Buffer.from(built.bytes.subarray(0, 100)));
    });
    serveTail();
    const ctl = new AbortController();
    const p = conn.backfill({
      selector: 'patron:*',
      until: 40,
      resume: null,
      signal: ctl.signal,
      push: async () => {},
    });
    ctl.abort();
    await expect(p).rejects.toThrow();
  });

  test('backpressure: the body is not read past one page ahead of the Engine', async () => {
    serveBlob();
    serveTail();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const p = conn.backfill({
      selector: 'patron:*',
      until: 40,
      resume: null,
      signal: new AbortController().signal,
      push: async (item) => {
        if (!('page' in item)) return;
        calls++;
        if (calls === 1) await gate;
      },
    });
    await settle();
    // the first page is held; at most one more has been handed over
    expect(calls).toBeLessThanOrEqual(2);
    release();
    expect(await p).toBe('done');
    expect(calls).toBeGreaterThan(2);
  });
});
