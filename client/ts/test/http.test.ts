import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decode, decodeMulti, encode } from '@msgpack/msgpack';
import { NewHTTPConnector, postCommand } from '../src/http.js';
import type {
  Backfill,
  BackfillOutcome,
  Connector,
  ConnectorHooks,
  DbEvent,
} from '../src/contract.js';
import { blob } from './blob.js';
import { crc32c } from '../src/checksum.js';

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

function hooks(log: unknown[][]): ConnectorHooks {
  return {
    onOpen: (epoch, head) => log.push(['open', epoch, head]),
    onView: (token, position, refs) => log.push(['view', token, position, refs]),
    onEvents: (events) =>
      log.push(['events', events.map((e) => [e.position, e.stream, e.seq, decode(e.data)])]),
    onLive: (p) => log.push(['live', p]),
    onVouch: (p) => log.push(['vouch', p]),
    onEnd: (code, reason) => log.push(['end', code, reason]),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

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
    NewHTTPConnector(stub.url, () => 'jwt')(-1, null, ['*', 'book'], ctl.signal, hooks(log));
    await s.opened;
    s.push(['live', 0]);
    s.push(['events', [[[1, 'book', 1, 'c1', new Date(5)], { $sys: 'birth' }]]]);
    s.push(['view', 't2', 2, ['book', 'patron:p1']]);
    s.push(['vouch', 3]);
    s.push(['end', 7, 'done']);
    s.push(['vouch', 4]); // after end: never delivered
    s.end();
    await settle();
    expect(log).toEqual([
      ['open', 'e3', 3],
      ['live', 0],
      ['events', [[1, 'book', 1, { $sys: 'birth' }]]],
      ['view', 't2', 2, ['book', 'patron:p1']],
      ['vouch', 3],
      ['end', 7, 'done'],
    ]);
    const req = stub.requests[0];
    expect(req.path).toBe('/stream');
    expect(req.headers.authorization).toBe('Bearer jwt');
    expect(new URL(stub.url + stub.requests[0].path + '?' + '')).toBeTruthy();
  });

  test('since and wants ride the query; no token means no Authorization header', async () => {
    const s = stub.stream();
    const seen: string[] = [];
    stub.server.on('request', (req) => seen.push(req.url!));
    NewHTTPConnector(stub.url)(
      42,
      'stored',
      ['book', 'patron:*'],
      new AbortController().signal,
      hooks([]),
    );
    await s.opened;
    expect(seen[0]).toBe('/stream?since=42&view=stored&want=book&want=patron%3A*');
    expect(stub.requests[0].headers.authorization).toBeUndefined();
  });

  test('a view frame first when the presented token was stale', async () => {
    const s = stub.stream('t9', 7);
    const log: unknown[][] = [];
    NewHTTPConnector(stub.url)(5, 'stale', ['*'], new AbortController().signal, hooks(log));
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
    NewHTTPConnector(stub.url)(-1, null, ['*'], new AbortController().signal, hooks(log));
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
    NewHTTPConnector(stub.url)(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 200, 'stream: no epoch']]);
  });

  test('a stream without a position header ends before any frame', async () => {
    stub.routes.set('/stream', (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/msgpack', 'PhaseLock-Epoch': 'e3' });
      res.end();
    });
    const log: unknown[][] = [];
    NewHTTPConnector(stub.url)(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 200, 'stream: no position']]);
  });

  test('a refused handshake ends with the HTTP status', async () => {
    stub.routes.set('/stream', (_r, _b, res) => {
      res.writeHead(401);
      res.end('token rejected');
    });
    const log: unknown[][] = [];
    NewHTTPConnector(stub.url)(-1, null, ['*'], new AbortController().signal, hooks(log));
    await settle();
    expect(log).toEqual([['end', 401, 'token rejected']]);
  });

  test('aborting the signal ends exactly once', async () => {
    const s = stub.stream();
    const log: unknown[][] = [];
    const ctl = new AbortController();
    NewHTTPConnector(stub.url)(-1, null, ['*'], ctl.signal, hooks(log));
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

describe('sendCommands', () => {
  let conn: Connector;
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
    stub.routes.set('/commands', (req, body, res) => {
      seen.push((decode(body) as [string, unknown])[0]);
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
        res.end(Buffer.from(encode([['ack', seen.length]])));
      }, delay);
    });
    conn = NewHTTPConnector(stub.url, () => 'jwt')(
      -1,
      null,
      ['*'],
      new AbortController().signal,
      hooks(log),
    );
  });
  const ends = () => log.filter((entry) => entry[0] === 'end');
  const send = (id: string) => conn.sendCommands([{ id, data: encode({ type: 'noop' }) }]);

  test('calls are applied in call order even when the first is slow', async () => {
    const [a, b, c] = await Promise.all([send('a'), send('b'), send('c')]);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect([a, b, c].map((r) => r[0])).toEqual([
      { kind: 'ack', position: 1 },
      { kind: 'ack', position: 2 },
      { kind: 'ack', position: 3 },
    ]);
    const req = stub.requests.find((r) => r.path === '/commands')!;
    expect(req.headers['content-type']).toBe('application/msgpack');
    expect(decode(req.body)).toEqual(['a', { type: 'noop' }]);
  });

  test('a 5xx is retried under the same ids, and the call succeeds', async () => {
    failures = 1;
    failStatus = 503;
    expect((await send('a'))[0]).toEqual({ kind: 'ack', position: 2 });
    expect(seen).toEqual(['a', 'a']);
    expect(ends()).toEqual([]);
  });

  test('a failure that stands fails every call queued behind it, unsent, and ends the connection with its status', async () => {
    await send('a');
    failures = Infinity;
    const results = await Promise.allSettled([send('b'), send('c'), send('d')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(seen).toEqual(['a', 'b', 'b', 'b', 'b']);
    expect(ends()).toEqual([['end', 500, expect.stringContaining('commands: 500')]]);
    await expect(send('e')).rejects.toThrow('the connection has ended');
    expect(seen.length).toBe(5);
  });

  test('a 4xx is not retried', async () => {
    failures = Infinity;
    failStatus = 400;
    await expect(send('a')).rejects.toThrow('commands: 400');
    expect(seen).toEqual(['a']);
    expect(ends()).toEqual([['end', 400, expect.stringContaining('commands: 400')]]);
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
    await expect(send('a')).rejects.toThrow('commands: 503');
    expect(seen).toEqual(['a']);
    expect(ends()).toEqual([['end', 0, 'stream closed']]);
  });

  test('every outcome kind, and several commands in one call', async () => {
    stub.routes.set('/commands', (_req, body, res) => {
      // the body is back-to-back command frames
      const ids = [...decodeMulti(body)].map((v) => (v as [string, unknown])[0]);
      expect(ids).toEqual(['a', 'b', 'c', 'd']);
      res.writeHead(200);
      res.end(
        Buffer.from(
          encode([
            ['ack', 10],
            ['dup', 3],
            ['reject', 'no'],
            ['conflict', { 'patron:p1': 4 }],
          ]),
        ),
      );
    });
    const r = await conn.sendCommands(['a', 'b', 'c', 'd'].map((id) => ({ id, data: encode({}) })));
    expect(r).toEqual([
      { kind: 'ack', position: 10 },
      { kind: 'dup', position: 3 },
      { kind: 'reject', reason: 'no' },
      { kind: 'conflict', current: { 'patron:p1': 4 } },
    ]);
  });
});

describe('postCommand', () => {
  test('one command, with the token when given, answered with its outcome', async () => {
    stub.routes.set('/commands', (_req, _body, res) => {
      res.writeHead(200);
      res.end(Buffer.from(encode([['reject', 'taken']])));
    });
    const command = { id: 'c1', data: encode({ type: 'create-account' }) };
    expect(await postCommand(stub.url, command, 'jwt')).toEqual({
      kind: 'reject',
      reason: 'taken',
    });
    expect(await postCommand(stub.url, command)).toEqual({ kind: 'reject', reason: 'taken' });
    const [signed, anonymous] = stub.requests;
    expect(signed.headers.authorization).toBe('Bearer jwt');
    expect(signed.headers['content-type']).toBe('application/msgpack');
    expect(decode(signed.body)).toEqual(['c1', { type: 'create-account' }]);
    expect(anonymous.headers.authorization).toBeUndefined();
  });

  test('a failed request rejects and is not retried', async () => {
    stub.routes.set('/commands', (_req, _body, res) => {
      res.writeHead(503);
      res.end('busy');
    });
    const command = { id: 'c1', data: encode({}) };
    await expect(postCommand(stub.url, command)).rejects.toThrow('commands: 503');
    expect(stub.requests.length).toBe(1);
  });
});

describe('backfill', () => {
  const records = Object.fromEntries(
    Array.from({ length: 2500 }, (_, i) => [
      `patron:p${String(i).padStart(4, '0')}!patron`,
      { name: 'n'.repeat(200), i },
    ]),
  );
  const streams = Object.fromEntries(Object.keys(records).map((k) => [k.split('!')[0], 2]));
  const built = blob({ ref: 'patron:*', position: 40, streams, records });

  type Run = {
    outcome: BackfillOutcome;
    header: { position: number; seqs: Record<string, number> } | null;
    batches: { keys: string[]; skip: number }[];
    tails: [number, string, number][][];
    scanned: number[];
    lengths: number[];
    done: ('values' | 'events')[];
  };

  async function run(
    conn: Connector,
    ref: string,
    until: number,
    resume: Backfill['resume'] = null,
  ): Promise<Run> {
    const got: Run = {
      outcome: 'done',
      header: null,
      batches: [],
      tails: [],
      scanned: [],
      lengths: [],
      done: [],
    };
    got.outcome = await conn.backfill({
      ref,
      until,
      resume,
      signal: new AbortController().signal,
      push: async (item) => {
        if ('length' in item) got.lengths.push(item.length);
        else if ('header' in item) got.header = item.header;
        else if ('values' in item)
          got.batches.push({ keys: item.values.map(([k]) => k), skip: item.skip });
        else if ('valuesDone' in item) got.done.push('values');
        else if ('events' in item) {
          got.tails.push(item.events.map((e) => [e.position, e.stream, e.seq]));
          got.scanned.push(item.scanned);
        } else got.done.push('events');
      },
    });
    return got;
  }

  // serve the blob inline at position 40, honoring Range
  function serveBlob(bytes = built.bytes, position = 40) {
    stub.routes.set('/snapshot/', (req, _body, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const skip = range ? Number(range[1]) : 0;
      if (skip >= bytes.length) {
        res.writeHead(416, { 'PhaseLock-Position': String(position) });
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
        ...length,
      });
      res.end(Buffer.from(bytes.subarray(skip)));
    });
  }

  // a tail: pages of events for `ref` between after and before, from a fixed log
  const log: [number, string, number][] = [];
  for (let p = 41; p <= 3500; p++) log.push([p, `patron:p${String(p % 7).padStart(4, '0')}`, p]);
  function serveTail() {
    stub.routes.set('/events/', (req, _body, res) => {
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
      const body = page.map(([p, s, seq]) =>
        encode(['events', [[[p, s, seq, `c${p}`, new Date(0)], { p }]]]),
      );
      res.end(Buffer.concat(body.map((b) => Buffer.from(b))));
    });
  }

  let conn: Connector;
  beforeEach(() => {
    stub.stream();
    conn = NewHTTPConnector(stub.url, () => 'jwt')(
      -1,
      null,
      ['*'],
      new AbortController().signal,
      hooks([]),
    );
  });

  test('header, batched values with record-boundary skips, checksums, and an empty tail', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 40);
    expect(r.outcome).toBe('done');
    expect(r.lengths).toEqual([built.bytes.length]);
    expect(r.header).toEqual({ position: 40, seqs: streams });
    const keys = r.batches.flatMap((b) => b.keys);
    expect(keys).toEqual(Object.keys(records).sort());
    // batches are bounded by records or bytes, and each skip is the offset after its last record
    expect(r.batches.length).toBeGreaterThan(1);
    let n = 0;
    for (const b of r.batches) {
      n += b.keys.length;
      expect(b.skip).toBe(built.recordEnds[n - 1]);
    }
    // each half ends with exactly one done call, and no empty batch is ever delivered
    expect(r.tails).toEqual([]);
    expect(r.done.sort()).toEqual(['events', 'values']);
    const reqs = stub.requests.filter((q) => q.path.startsWith('/events/'));
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers.authorization).toBe('Bearer jwt');
  });

  test('the tail pages forward from the blob position to until and stops on a short page', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 2600);
    const positions = r.tails.flat().map(([p]) => p);
    expect(positions[0]).toBe(41);
    expect(positions.at(-1)).toBe(2599);
    expect(positions).toHaveLength(2559);
    expect(r.tails).toHaveLength(3);
    // each page reports how far its scan reached: a full page its last event, a short one until
    expect(r.scanned).toEqual([1040, 2040, 2600]);
    expect(r.done.filter((d) => d === 'events')).toEqual(['events']);
    const pages = stub.requests.filter((q) => q.path.startsWith('/events/')).map((q) => q.path);
    expect(pages).toHaveLength(3);
    const urls =
      stub.server.listeners('request') &&
      stub.requests.filter((q) => q.path.startsWith('/events/'));
    expect(urls).toHaveLength(3);
  });

  test('the tail honors the fromPosition floor and a newer blob overrides it', async () => {
    serveBlob();
    serveTail();
    const seenAfter: number[] = [];
    stub.server.on('request', (req) => {
      if (req.url!.startsWith('/events/'))
        seenAfter.push(Number(new URL(req.url!, stub.url).searchParams.get('after')));
    });
    await run(conn, 'patron:*', 200, {
      position: 40,
      skipBytes: 0,
      fromPosition: 100,
      snapshotDone: false,
      tailDone: false,
    });
    expect(seenAfter).toEqual([100]);
    seenAfter.length = 0;
    await run(conn, 'patron:*', 200, {
      position: 10,
      skipBytes: 0,
      fromPosition: 20,
      snapshotDone: false,
      tailDone: false,
    });
    expect(seenAfter).toEqual([40]);
  });

  test('resume: 206 continues at skipBytes with no header call', async () => {
    serveBlob();
    serveTail();
    const skip = built.recordEnds[1000];
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: skip,
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('done');
    expect(r.header).toBeNull();
    expect(r.lengths).toEqual([built.bytes.length]);
    expect(r.batches.flatMap((b) => b.keys)).toEqual(Object.keys(records).sort().slice(1001));
    expect(stub.requests.find((q) => q.path.startsWith('/snapshot/'))!.headers.range).toBe(
      `bytes=${skip}-`,
    );
  });

  test('resume: a server that ignores Range gets skipped locally', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
      });
      res.end(Buffer.from(built.bytes));
    });
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: built.recordEnds[2400],
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.batches.flatMap((b) => b.keys)).toEqual(Object.keys(records).sort().slice(2401));
  });

  test('resume: 416 means nothing is left', async () => {
    serveBlob();
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: built.bytes.length,
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('done');
    expect(r.batches).toEqual([]);
    expect(r.done).toContain('values');
  });

  test('resume: a finished half is skipped outright', async () => {
    serveBlob();
    serveTail();
    const snapshotDone = {
      position: 40,
      skipBytes: 0,
      fromPosition: 40,
      snapshotDone: true,
      tailDone: false,
    };
    const r = await run(conn, 'patron:*', 100, snapshotDone);
    expect(r.outcome).toBe('done');
    expect(r.header).toBeNull();
    expect(r.batches).toEqual([]);
    expect(r.done).toEqual(['events']);
    expect(stub.requests.filter((q) => q.path.startsWith('/snapshot/'))).toHaveLength(0);
    const tailDone = {
      position: 40,
      skipBytes: 0,
      fromPosition: 99,
      snapshotDone: false,
      tailDone: true,
    };
    const r2 = await run(conn, 'patron:*', 100, tailDone);
    expect(r2.outcome).toBe('done');
    expect(r2.header!.position).toBe(40);
    expect(r2.tails).toEqual([]);
    expect(r2.done).toEqual(['values']);
    expect(stub.requests.filter((q) => q.path.startsWith('/events/'))).toHaveLength(1);
  });

  test('stale: a resumed position that no longer matches', async () => {
    serveBlob(built.bytes, 41);
    serveTail();
    const r = await run(conn, 'patron:*', 40, {
      position: 40,
      skipBytes: 100,
      fromPosition: 40,
      snapshotDone: false,
      tailDone: false,
    });
    expect(r.outcome).toBe('stale');
    expect(r.header).toBeNull();
    expect(r.batches).toEqual([]);
  });

  test('the pointer form, and stale when the pointer target is gone', async () => {
    let gone = false;
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'PhaseLock-Position': '40' });
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
    expect(r.batches.flatMap((b) => b.keys)).toHaveLength(2500);
    gone = true;
    expect((await run(conn, 'patron:*', 40)).outcome).toBe('stale');
  });

  test('a 403 on the snapshot rejects, and is not mistaken for a pointer', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('ref not visible');
    });
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(/403/);
  });

  test.each([
    ['header crc', (b: Uint8Array) => (b[9] ^= 1)],
    ['record crc', (b: Uint8Array) => (b[built.recordEnds[5] - 6] ^= 1)],
    [
      'content hash',
      (b: Uint8Array) => {
        // change a value byte and recompute that record's crc, so only the hash disagrees
        const start = built.recordEnds[4];
        const end = built.recordEnds[5];
        const klen = (b[start] << 24) | (b[start + 1] << 16) | (b[start + 2] << 8) | b[start + 3];
        const key = b.subarray(start + 4, start + 4 + klen);
        const value = b.subarray(start + 8 + klen, end - 4);
        value[value.length - 1] ^= 1;
        const crc = crc32c(value, crc32c(key));
        b.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], end - 4);
      },
    ],
    ['footer crc', (b: Uint8Array) => (b[b.length - 1] ^= 1)],
    ['bad magic', (b: Uint8Array) => (b[0] = 0x58)],
  ])('corruption is detected: %s', async (what, corrupt) => {
    const bytes = built.bytes.slice();
    corrupt(bytes);
    serveBlob(bytes);
    serveTail();
    await expect(run(conn, 'patron:*', 40)).rejects.toThrow(new RegExp(what));
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
      });
      // trickle the blob so the tail failure lands mid-download
      res.write(Buffer.from(built.bytes.subarray(0, 100)));
      req.on('close', () => (blobAborted = true));
    });
    stub.routes.set('/events/', (_req, _body, res) => {
      res.writeHead(500);
      res.end('nope');
    });
    await expect(run(conn, 'patron:*', 100)).rejects.toThrow(/events patron:\*: 500/);
    await settle();
    expect(blobAborted).toBe(true);
  });

  test('the backfill signal cancels it', async () => {
    stub.routes.set('/snapshot/', (_req, _body, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'PhaseLock-Position': '40',
      });
      res.write(Buffer.from(built.bytes.subarray(0, 100)));
    });
    serveTail();
    const ctl = new AbortController();
    const p = conn.backfill({
      ref: 'patron:*',
      until: 40,
      resume: null,
      signal: ctl.signal,
      push: async () => {},
    });
    ctl.abort();
    await expect(p).rejects.toThrow();
  });

  test('backpressure: the body is not read past one batch ahead of the Engine', async () => {
    serveBlob();
    serveTail();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const p = conn.backfill({
      ref: 'patron:*',
      until: 40,
      resume: null,
      signal: new AbortController().signal,
      push: async (item) => {
        if (!('values' in item)) return;
        calls++;
        if (calls === 1) await gate;
      },
    });
    await settle();
    // the first batch is held; at most one more has been handed over
    expect(calls).toBeLessThanOrEqual(2);
    release();
    expect(await p).toBe('done');
    expect(calls).toBeGreaterThan(2);
  });
});
