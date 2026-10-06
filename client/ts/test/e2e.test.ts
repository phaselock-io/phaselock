// Drives the connector against the v0 server.  Skipped unless db/pldb has been built.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, encode } from '@msgpack/msgpack';
import { NewHTTPConnector } from '../src/http.js';
import type { Backfill, Connector } from '../src/contract.js';

const db = join(import.meta.dirname, '..', '..', '..', 'db');
const binary = join(db, 'pldb');

describe.skipIf(!existsSync(binary))('against pldb', () => {
  let proc: ChildProcess;
  let data: string;
  let url: string;
  let token: string;

  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'pldb-'));
    const port = 18000 + Math.floor(Math.random() * 1000);
    url = `http://127.0.0.1:${port}`;
    proc = spawn(
      binary,
      [
        '--bundle',
        join(db, 'server/testdata/bundle.js'),
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
        const auth = await fetch(`${url}/auth/token`, {
          method: 'POST',
          body: encode({ kind: 'dev', identity: 'root' }),
        });
        token = (decode(new Uint8Array(await auth.arrayBuffer())) as { token: string }).token;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('pldb did not start');
  });

  afterAll(() => {
    proc.kill();
    rmSync(data, { recursive: true, force: true });
  });

  async function run(
    conn: Connector,
    ref: string,
    until: number,
    resume: Backfill['resume'] = null,
    signal = new AbortController().signal,
  ) {
    const got = {
      header: null as null | { position: number; seqs: Record<string, number> },
      values: [] as [string, Uint8Array][],
      skips: [] as number[],
      tails: [] as [number, string, number][][],
    };
    const outcome = await conn.backfill({
      ref,
      until,
      resume,
      signal,
      push: async (item) => {
        if ('header' in item) got.header = item.header;
        else if ('values' in item) {
          got.values.push(...item.values);
          got.skips.push(item.skip);
        } else if ('events' in item)
          got.tails.push(item.events.map((e) => [e.position, e.stream, e.seq]));
      },
    });
    return { outcome, ...got };
  }

  test('stream, commands, list, backfills, resume, stale, and one end', async () => {
    const log: unknown[][] = [];
    let ended = 0;
    let live: number | null = null;
    const ctl = new AbortController();
    const factory = NewHTTPConnector(url, () => token);
    let viewToken = '';
    let epoch = '';
    const conn = factory(-1, null, ['*'], ctl.signal, {
      onOpen: (e) => {
        epoch = e;
      },
      onView: (t, position, refs) => {
        viewToken = t;
        log.push(['view', t.length > 0, position, refs]);
      },
      onEvents: (evs) =>
        log.push(['events', evs.map((e) => [e.position, e.stream, e.seq, decode(e.data)])]),
      onLive: (p) => {
        live = p;
      },
      onVouch: () => {},
      onEnd: () => {
        ended++;
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    // a bootstrap presents no token and gets the view as its first frame
    expect(log[0]).toEqual(['view', true, 0, ['*']]);
    expect(live).toBe(0);
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);

    // commands: ack, ack, dup, reject
    const res = await conn.sendCommands([
      { id: 'c1', data: encode({ type: 'add-patron', id: 'p1', name: 'Ann' }) },
      { id: 'c2', data: encode({ type: 'add-patron', id: 'p2', name: 'Bob' }) },
      { id: 'c1', data: encode({ type: 'add-patron', id: 'p1', name: 'Ann' }) },
      { id: 'c3', data: encode({ type: 'nope' }) },
    ]);
    expect(res.map((r) => r.kind)).toEqual(['ack', 'ack', 'dup', 'reject']);
    const rename = await conn.sendCommands([
      { id: 'c4', data: encode({ type: 'rename-patron', id: 'p1', name: 'Anne' }) },
    ]);
    expect(rename[0].kind).toBe('ack');
    const cursor = (rename[0] as { position: number }).position;

    await new Promise((r) => setTimeout(r, 300));
    const delivered = log
      .filter((l) => l[0] === 'events')
      .flatMap((l) => l[1] as [number, string, number, unknown][]);
    expect(delivered.map((e) => [e[1], e[2]])).toEqual([
      ['patron.p1', 1],
      ['patron.p1', 2],
      ['patron.p2', 1],
      ['patron.p2', 2],
      ['patron.p1', 3],
    ]);
    expect(delivered.at(-1)![0]).toBe(cursor);
    expect((delivered[0][3] as { $sys: string }).$sys).toBe('birth');

    // a reconnect presenting the current token gets no view frame at all
    const again: unknown[][] = [];
    const ctl2 = new AbortController();
    factory(cursor, viewToken, ['*'], ctl2.signal, {
      onOpen() {},
      onView: (t, position, refs) => again.push(['view', t === viewToken, position, refs]),
      onEvents() {},
      onLive: (p) => again.push(['live', p]),
      onVouch() {},
      onEnd() {},
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(again).toEqual([['live', cursor]]);
    ctl2.abort();

    // a family backfill: header, values, an empty tail (the live cut is at the cursor)
    const fam = await run(conn, 'patron.*', cursor);
    expect(fam.outcome).toBe('done');
    expect(fam.header).toEqual({ position: cursor, seqs: { 'patron.p1': 3, 'patron.p2': 2 } });
    expect(fam.values.map(([k]) => k)).toEqual([
      'patron.p1/holds',
      'patron.p1/messages',
      'patron.p1/patron',
      'patron.p2/holds',
      'patron.p2/messages',
      'patron.p2/patron',
    ]);
    expect((decode(fam.values[2][1]) as { name: string }).name).toBe('Anne');
    expect(fam.tails).toEqual([]);

    // an exact ref, and a resume whose position still matches (nothing written since)
    const p1 = await run(conn, 'patron.p1', cursor);
    expect(p1.header!.seqs).toEqual({ 'patron.p1': 3 });
    const back = await run(conn, 'patron.p1', cursor, {
      position: cursor,
      skipBytes: p1.skips[0],
      fromPosition: cursor,
      snapshotDone: false,
      tailDone: false,
    });
    expect(back.outcome).toBe('done');
    expect(back.header).toBeNull();
    expect(back.values).toEqual([]);

    // stale: the position no longer matches after a write
    await conn.sendCommands([
      { id: 'c5', data: encode({ type: 'rename-patron', id: 'p2', name: 'Rob' }) },
    ]);
    const stale = await run(conn, 'patron.p1', cursor, {
      position: cursor,
      skipBytes: 30,
      fromPosition: cursor,
      snapshotDone: false,
      tailDone: false,
    });
    expect(stale.outcome).toBe('stale');

    // coverage: anonymous sees book but not a patron
    const anon = NewHTTPConnector(url)(-1, null, ['*'], ctl.signal, {
      onOpen() {},
      onView() {},
      onEvents() {},
      onLive() {},
      onVouch() {},
      onEnd() {},
    });
    await expect(run(anon, 'patron.p1', cursor)).rejects.toThrow(/403/);
    expect((await run(anon, 'book', cursor)).outcome).toBe('done');

    ctl.abort();
    await new Promise((r) => setTimeout(r, 200));
    expect(ended).toBe(1);
  });
});
