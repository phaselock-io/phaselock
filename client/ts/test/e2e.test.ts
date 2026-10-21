// Drives the HTTP transport against the v0 server.  Skipped unless db/phaselockdb has been built.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, encode } from '@msgpack/msgpack';
import { HTTPTransport } from '../src/http.js';
import { AuthError, restoreSession, type Session } from '../src/session.js';
import type { Backfill, Connection, ConnectionHooks, Mutation } from '../src/contract.js';
import { editOps } from '../src/edits.js';

const db = join(import.meta.dirname, '..', '..', '..', 'db');

// hooks that ignore everything
const quiet: ConnectionHooks = {
  onOpen() {},
  onView() {},
  onEdits() {},
  onLive() {},
  onVouch() {},
  onEnd() {},
};

// a mutation in one series, its id a uuid made from its name
function mut(name: string, n: number, data: unknown): Mutation<Uint8Array> {
  const id = `00000000-0000-0000-0000-${name.padStart(12, '0')}`;
  return { id, series: 'e2e', n, data: encode(data) };
}
const binary = join(db, 'phaselockdb');

describe.skipIf(!existsSync(binary))('against phaselockdb', () => {
  let proc: ChildProcess;
  let data: string;
  let transport: HTTPTransport;
  let session: Session;

  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'phaselockdb-'));
    const port = 18000 + Math.floor(Math.random() * 1000);
    transport = new HTTPTransport(`http://127.0.0.1:${port}/phaselock`);
    proc = spawn(
      binary,
      [
        '--bundle',
        join(db, 'testdata/bundle.js'),
        '--dev-auth',
        '--listen',
        `127.0.0.1:${port}`,
        '--data',
        data,
      ],
      {
        stdio: 'ignore',
      },
    );
    for (let i = 0; i < 50; i++) {
      try {
        session = await transport.login({ kind: 'dev', identity: 'root' });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('phaselockdb did not start');
  });

  afterAll(() => {
    proc.kill();
    rmSync(data, { recursive: true, force: true });
  });

  async function run(
    conn: Connection,
    selector: string,
    until: number,
    resume: Backfill['resume'] = null,
    signal = new AbortController().signal,
  ) {
    const got = {
      header: null as null | { position: number; seqs: Record<string, number> },
      values: [] as [string, Uint8Array][],
      skips: [] as number[],
      checksums: [] as string[],
      tails: [] as [number, string, number][][],
    };
    const outcome = await conn.backfill({
      selector,
      until,
      resume,
      signal,
      push: async (item) => {
        if ('header' in item) {
          got.header = item.header;
        } else if ('page' in item) {
          for (const [key, value] of editOps(item.page, false)) got.values.push([key, value!]);
          got.skips.push(item.skip);
          got.checksums.push(item.checksum);
        } else if ('edits' in item) {
          got.tails.push(item.edits.map((e) => [e.position, e.slice, e.seq]));
        }
      },
    });
    return { outcome, ...got };
  }

  test('stream, mutations, backfills, resume, stale, and one end', async () => {
    const log: unknown[][] = [];
    let ended = 0;
    let live: number | null = null;
    const ctl = new AbortController();
    let viewToken = '';
    let epoch = '';
    const conn = transport.connect(
      -1,
      null,
      ['*'],
      ctl.signal,
      {
        onOpen: (e) => {
          epoch = e;
        },
        onView: (t, position, selectors) => {
          viewToken = t;
          log.push(['view', t.length > 0, position, selectors]);
        },
        onEdits: (edits) =>
          log.push(['edits', edits.map((e) => [e.position, e.slice, e.seq, e.lifecycle])]),
        onLive: (p) => {
          live = p;
        },
        onVouch: () => {},
        onEnd: () => {
          ended++;
        },
      },
      session,
    );
    await new Promise((r) => setTimeout(r, 300));
    // a bootstrap presents no token and gets the view as its first frame
    expect(log[0]).toEqual(['view', true, 0, ['*']]);
    expect(live).toBe(0);
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);

    // mutations: ok, ok, ok for a resend that is not run again, a structural reject
    const res = await conn.sendMutations([
      mut('c1', 1, { type: 'add-patron', id: 'p1', name: 'Ann' }),
      mut('c2', 2, { type: 'add-patron', id: 'p2', name: 'Bob' }),
      mut('c1', 1, { type: 'add-patron', id: 'p1', name: 'Ann' }),
      mut('c3', 3, { type: 'nope' }),
    ]);
    expect(res.map((r) => r.kind)).toEqual(['ok', 'ok', 'ok', 'reject']);
    const rename = await conn.sendMutations([
      mut('c4', 4, { type: 'rename-patron', id: 'p1', name: 'Anne' }),
    ]);
    expect(rename[0].kind).toBe('ok');
    const cursor = (rename[0] as { position: number }).position;

    await new Promise((r) => setTimeout(r, 300));
    const delivered = log
      .filter((l) => l[0] === 'edits')
      .flatMap((l) => l[1] as [number, string, number, string][]);
    expect(delivered.map((e) => [e[1], e[2], e[3]])).toEqual([
      ['patron:p1', 1, 'birth'],
      ['patron:p2', 1, 'birth'],
      ['patron:p1', 2, 'normal'],
    ]);
    expect(delivered.at(-1)![0]).toBe(cursor);

    // a reconnect presenting the current token gets no view frame at all
    const again: unknown[][] = [];
    const ctl2 = new AbortController();
    transport.connect(
      cursor,
      viewToken,
      ['*'],
      ctl2.signal,
      {
        onOpen() {},
        onView: (t, position, selectors) =>
          again.push(['view', t === viewToken, position, selectors]),
        onEdits() {},
        onLive: (p) => again.push(['live', p]),
        onVouch() {},
        onEnd() {},
      },
      session,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(again).toEqual([['live', cursor]]);
    ctl2.abort();

    // a family backfill: header, pages, an empty tail (the live cut is at the cursor)
    const fam = await run(conn, 'patron:*', cursor);
    expect(fam.outcome).toBe('done');
    expect(fam.header).toEqual({ position: cursor, seqs: { 'patron:p1': 2, 'patron:p2': 1 } });
    expect(fam.values.map(([k]) => k)).toEqual([
      'patron:p1!holds',
      'patron:p1!messages',
      'patron:p1!patron',
      'patron:p2!holds',
      'patron:p2!messages',
      'patron:p2!patron',
    ]);
    expect((decode(fam.values[2][1]) as { name: string }).name).toBe('Anne');
    expect(fam.tails).toEqual([]);

    // an exact selector, and a resume whose position still matches (nothing written since)
    const p1 = await run(conn, 'patron:p1', cursor);
    expect(p1.header!.seqs).toEqual({ 'patron:p1': 2 });
    const back = await run(conn, 'patron:p1', cursor, {
      position: cursor,
      skipBytes: p1.skips[0],
      checksum: p1.checksums[0],
      fromPosition: cursor,
      snapshotDone: false,
      tailDone: false,
    });
    expect(back.outcome).toBe('done');
    expect(back.header).toBeNull();
    expect(back.values).toEqual([]);

    // stale: the position no longer matches after a write
    await conn.sendMutations([mut('c5', 5, { type: 'rename-patron', id: 'p2', name: 'Rob' })]);
    const stale = await run(conn, 'patron:p1', cursor, {
      position: cursor,
      skipBytes: 30,
      checksum: '',
      fromPosition: cursor,
      snapshotDone: false,
      tailDone: false,
    });
    expect(stale.outcome).toBe('stale');

    // coverage: anonymous sees book but not a patron
    const anon = transport.connect(-1, null, ['*'], ctl.signal, quiet, null);
    await expect(run(anon, 'patron:p1', cursor)).rejects.toThrow(/403/);
    expect((await run(anon, 'book', cursor)).outcome).toBe('done');

    ctl.abort();
    await new Promise((r) => setTimeout(r, 200));
    expect(ended).toBe(1);
  });

  test('a login, a refresh in place, and a refused session ending its connection', async () => {
    // a login the database refuses names its status
    await expect(transport.login({ kind: 'dev', identity: 'nobody' })).rejects.toThrow(AuthError);

    // a refresh replaces the token in place and tells the app
    const s = await transport.login({ kind: 'dev', identity: 'root' });
    const before = s.token;
    let refreshed = 0;
    s.onRefresh = () => refreshed++;
    await new Promise((r) => setTimeout(r, 1100)); // a new iat, so a new token
    await Promise.all([transport.refresh(s), transport.refresh(s)]);
    expect(refreshed).toBe(1);
    expect(s.token).not.toBe(before);
    expect(s.user).toBe('root');

    // a token the database never signed: the stream's 401 ends the connection fatally
    const [head, payload, sig] = s.token.split('.');
    const forged = restoreSession(`${head}.${payload}.${'A'.repeat(sig.length)}`);
    let end: unknown[] = [];
    const ctl = new AbortController();
    transport.connect(
      -1,
      null,
      ['*'],
      ctl.signal,
      {
        ...quiet,
        onEnd: (code, _, fatal) => (end = [code, fatal]),
      },
      forged,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(end[0]).toBe(401);
    expect(end[1]).toBeInstanceOf(AuthError);
    expect(forged.ended).toBe(true);

    // an ended session fails a post at once, without sending
    await expect(transport.post([mut('c9', 9, { type: 'nope' })], forged)).rejects.toThrow(
      AuthError,
    );
    ctl.abort();
  });
});
