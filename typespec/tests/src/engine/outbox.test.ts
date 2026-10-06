// TESTS.md: Outbox and commands

import { describe, expect, test } from 'vitest';

import { type Command, type CommandResult, Reject } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  FakeServer,
  type Forecaster,
  keys,
  log,
  parse,
  type Rig,
  rig,
  seq,
  settle,
  type State,
  state,
  watch,
} from './harness.ts';

/** a test command: what the forecast should do with it */
type Cmd = {
  field?: string;
  value?: unknown;
  stream?: string;
  reason?: true;
  throws?: true;
  reads?: true;
  ghost?: true;
};

/** forecasts a `set` on patron.p1 (or the named stream), or misbehaves as the command asks */
const forecaster: Forecaster = (qx, command) => {
  const cmd = command as Cmd;
  if (cmd.reason) throw new Reject('not this time');
  if (cmd.throws) throw new Error('forecast boom');
  if (cmd.ghost) return [{ stream: 'ghost.g1', event: { id: 'g1', type: 'bump' } }];
  if (cmd.reads) {
    const st = qx.get('patron.p1/state', 'state') as State | undefined;
    const seen = JSON.stringify(st?.fields ?? {});
    return [{ stream: 'patron.p1', event: { id: 'p1', type: 'set', field: 'seen', value: seen } }];
  }
  const stream = cmd.stream ?? 'patron.p1';
  const id = stream.slice(stream.indexOf('.') + 1);
  return [{ stream, event: { id, type: 'set', field: cmd.field ?? 'f', value: cmd.value ?? 1 } }];
};

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2, 'patron.p2': 1 },
  values: [
    ['patron.p1/state', { count: 2, fields: {} }],
    ['patron.p2/state', { count: 1, fields: {} }],
  ],
};

/** a live Engine holding patron.p1 and patron.p2 at position 10, with the forecaster */
async function held(server = new FakeServer()): Promise<Rig> {
  const r = rig({ forecaster, server });
  await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
  return r;
}

type SendCall = {
  cmds: Command<Uint8Array>[];
  resolve: (results: CommandResult[]) => void;
  reject: (e: unknown) => void;
};

/** take over the server's sendCommands: every call is recorded and answered by the test */
function sendControl(server: FakeServer): SendCall[] {
  const calls: SendCall[] = [];
  server.onSend = (cmds) =>
    new Promise<CommandResult[]>((resolve, reject) => {
      calls.push({ cmds, resolve, reject });
    });
  return calls;
}

const ack = (position: number): CommandResult => ({ kind: 'ack', position });
const dup = (position: number): CommandResult => ({ kind: 'dup', position });
const reject: CommandResult = { kind: 'reject', reason: 'no' };
const conflict: CommandResult = { kind: 'conflict', current: {} };

/** the outbox as stored: ordinal keys and their envelopes, the wire bytes parsed back */
function outbox(data: Record<string, unknown>): { key: string; id: string; data: unknown }[] {
  return keys(data, '/command.').map((key) => {
    const c = data[key] as Command<Uint8Array>;
    return { key, id: c.id, data: parse(c.data) };
  });
}

/** freeze the base: a gap on patron.p2 whose replacing backfill is held; returns the release */
async function freeze(r: Rig, position = 11): Promise<() => void> {
  const hold = r.server.hold('patron.p2');
  r.server.events(ev('patron.p2', 9, position));
  await settle();
  expect(seq(r.data, 'patron.p2')).toBe('backfill');
  return () => {
    r.server.blobs.set('patron.p2', {
      position,
      seqs: { 'patron.p2': 9 },
      values: [['patron.p2/state', { count: 9, fields: {} }]],
    });
    hold.go();
  };
}

describe('outbox rows and sends', () => {
  test('sendCommand writes padded ordinal rows holding the envelope and sends them in order', async () => {
    const r = await held();
    r.engine.sendCommand({ field: 'a', value: 1 });
    r.engine.sendCommand({ field: 'b', value: 2 });
    await settle();
    const rows = outbox(r.data);
    expect(rows.map((x) => x.key)).toEqual([
      '/command.00000000000000000000',
      '/command.00000000000000000001',
    ]);
    expect(rows.map((x) => x.data)).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    expect(r.server.sends.length).toBe(1);
    expect(r.server.sends[0].map((c) => c.id)).toEqual(rows.map((x) => x.id));
    // wire data is the command through the commands type; the row keeps the JS envelope
    expect(r.server.sends[0].map((c) => parse(c.data))).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    expect(typeof rows[0].id).toBe('string');
  });

  test('ack and dup release once the reduced position reaches them; reject and conflict at once', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    r.engine.sendCommand({ field: 'b' });
    r.engine.sendCommand({ field: 'c' });
    r.engine.sendCommand({ field: 'd' });
    await settle();
    calls[0].resolve([ack(15), dup(16), reject, conflict]);
    await settle();
    const rows = outbox(r.data);
    expect(rows.map((x) => x.data)).toEqual([{ field: 'a' }, { field: 'b' }]);
    r.server.vouch(15);
    await settle();
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'b' }]);
    r.server.vouch(16);
    await settle();
    expect(outbox(r.data)).toEqual([]);
  });

  test('an event carrying the command id releases it when reduced, before the ack', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    const id = outbox(r.data)[0].id;
    r.server.events(ev('patron.p1', 3, 11, { type: 'set', field: 'a', value: 1 }, id));
    await settle();
    expect(outbox(r.data)).toEqual([]);
    expect(log(r.data, 'patron.p1')).toEqual(['set a=1']);
    // the late ack finds nothing to release and changes nothing
    calls[0].resolve([ack(11)]);
    await settle();
    expect(outbox(r.data)).toEqual([]);
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: { a: 1 } });
  });

  test("a failed call's commands wait for the connection's end; the next connection resends them in order in one call", async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    r.engine.sendCommand({ field: 'b' });
    await settle();
    calls[0].reject(new Error('500'));
    await settle();
    expect(outbox(r.data).length).toBe(2);
    // the connection has not ended yet, so a new command goes alone
    r.engine.sendCommand({ field: 'c' });
    await settle();
    expect(r.server.sends.map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }, { field: 'b' }],
      [{ field: 'c' }],
    ]);
    calls[1].reject(new Error('500'));
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(r.server.sends.length).toBe(3);
    expect(r.server.sends[2].map((c) => parse(c.data))).toEqual([
      { field: 'a' },
      { field: 'b' },
      { field: 'c' },
    ]);
  });

  test('a row an earlier build wrote, unreadable now, is still sent as stored and forecasts nothing', async () => {
    const server = new FakeServer();
    const calls = sendControl(server);
    const stale = new TextEncoder().encode('not json');
    const r = rig({
      forecaster,
      server,
      data: {
        '/view': { token: 't1', position: 10, refs: ['patron.*'] },
        '/checkpoint': { epoch: 'e1', position: 10, reduced: 10 },
        '/seq.patron.p1': 2,
        'patron.p1/state': { count: 2, fields: {} },
        '/command.00000000000000000000': { id: 'old', data: stale },
      },
    });
    const w = watch(r, 'patron.p1');
    await settle();
    r.server.open();
    r.server.live(10);
    await settle();

    // sent byte for byte, and the graph delivered the base with no forecast on it
    expect(calls.length).toBe(1);
    expect(calls[0].cmds).toEqual([{ id: 'old', data: stale }]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });

    // acked like any other command
    calls[0].resolve([ack(10)]);
    await settle();
    expect(keys(r.data, '/command.')).toEqual([]);
  });

  test('a new connection flushes every command not acked, in ordinal order, in one call', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    calls[0].resolve([ack(500)]);
    await settle();
    r.engine.sendCommand({ field: 'b' });
    r.engine.sendCommand({ field: 'c' });
    await settle();
    expect(calls.length).toBe(2);
    // the connection ends with b and c unanswered; a is acked and waits for the cursor
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.length).toBe(3);
    expect(r.server.sends[2].map((c) => parse(c.data))).toEqual([{ field: 'b' }, { field: 'c' }]);
    expect(outbox(r.data).length).toBe(3);
  });

  test('commands survive a restart in order and are flushed on connect; the next ordinal continues', async () => {
    const r = await held();
    sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    r.engine.sendCommand({ field: 'b' });
    await settle();
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron.*', patrons);
    const calls = sendControl(server);
    const r2 = rig({ data: r.data, server, forecaster });
    await settle();
    expect(server.sends.length).toBe(1);
    expect(server.sends[0].map((c) => parse(c.data))).toEqual([{ field: 'a' }, { field: 'b' }]);
    expect(calls.length).toBe(1);
    r2.engine.sendCommand({ field: 'c' });
    await settle();
    expect(outbox(r2.data).map((x) => x.key)).toEqual([
      '/command.00000000000000000000',
      '/command.00000000000000000001',
      '/command.00000000000000000002',
    ]);
  });

  test('acks are memory only: acked before a crash, resent, dup at the same position, dropped the same way', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    calls[0].resolve([ack(15)]);
    await settle();
    expect(outbox(r.data).length).toBe(1);
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron.*', patrons);
    const calls2 = sendControl(server);
    rig({ data: r.data, server, forecaster });
    await settle();
    expect(server.sends.length).toBe(1);
    expect(server.sends[0].map((c) => parse(c.data))).toEqual([{ field: 'a' }]);
    calls2[0].resolve([dup(15)]);
    await settle();
    expect(outbox(r.data).length).toBe(1);
    server.open();
    server.vouch(15);
    await settle();
    expect(outbox(r.data)).toEqual([]);
  });
});

describe('forecasts', () => {
  test('the overlay is rebuilt from the outbox; a throwing forecast is dropped and the Engine survives', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    r.engine.sendCommand({ throws: true });
    r.engine.sendCommand({ field: 'a', value: 1 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1 } });
    // a base change rebuilds the overlay over the new base, forecasts still on top
    r.server.events(ev('patron.p1', 3, 11));
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 3, fields: { a: 1 } });
    expect(state(r.data, 'patron.p1')).toEqual({ count: 3, fields: {} });
  });

  test('forecasts run in outbox order, each reading the overlay the earlier ones left', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    r.engine.sendCommand({ field: 'a', value: 1 });
    await settle();
    r.engine.sendCommand({ reads: true });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, seen: '{"a":1}' } });
  });

  test('a rejection adds nothing; a family with no reducer adds nothing', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    await settle();
    r.engine.sendCommand({ reason: true });
    r.engine.sendCommand({ ghost: true });
    await settle();
    expect(outbox(r.data).length).toBe(2);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });
    expect(keys(r.data, 'ghost')).toEqual([]);
  });

  test('a dropped command rebuilds the overlay and runs the graph even while frozen', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a', value: 1 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1 } });
    await freeze(r);
    calls[0].resolve([reject]);
    await settle();
    expect(seq(r.data, 'patron.p2')).toBe('backfill');
    expect(outbox(r.data)).toEqual([]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });
  });
});

describe('the reduced position', () => {
  test('a batch that froze part way, a vouch while frozen, an ack already reduced past, and the unfreeze', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a', value: 1 });
    r.engine.sendCommand({ field: 'b', value: 2 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 2 } });
    // p1 reduces at 11, then p2's gap at 12 freezes the rest of the atom
    const hold = r.server.hold('patron.p2');
    r.server.events(ev('patron.p1', 3, 11), ev('patron.p2', 9, 12));
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 12, reduced: 11 });
    // frozen: the base change reaches no query
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 2 } });
    calls[0].resolve([ack(11), ack(12)]);
    await settle();
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'b', value: 2 }]);
    // the release rebuilds the overlay over the reduced base, b's forecast still on it
    expect(w.values.at(-1)).toEqual({ count: 3, fields: { b: 2 } });
    // a vouch moves the cursor but not the reduced position while frozen
    r.server.vouch(20);
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 20, reduced: 11 });
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'b', value: 2 }]);
    // an ack at a position already reduced past releases at once, frozen or not
    r.engine.sendCommand({ field: 'c', value: 3 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 3, fields: { b: 2, c: 3 } });
    calls[1].resolve([ack(5)]);
    await settle();
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'b', value: 2 }]);
    // b's forecast never left the overlay through the freeze
    for (const v of w.values.slice(1)) expect(v?.fields.b).toBe(2);
    // the unfreeze moves the reduced position to the checkpoint and releases b
    r.server.blobs.set('patron.p2', {
      position: 12,
      seqs: { 'patron.p2': 9 },
      values: [['patron.p2/state', { count: 9, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 20, reduced: 20 });
    expect(outbox(r.data)).toEqual([]);
    expect(w.values.at(-1)).toEqual({ count: 3, fields: {} });
  });

  test('the reduced position is persisted and restored on boot mid-freeze', async () => {
    const r = await held();
    const hold = r.server.hold('patron.p2');
    r.server.events(ev('patron.p1', 3, 11), ev('patron.p2', 9, 12));
    r.server.vouch(20);
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 20, reduced: 11 });
    void hold;
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron.*', patrons);
    server.hold('patron.p2');
    const calls = sendControl(server);
    const r2 = rig({ data: r.data, server, forecaster });
    await settle();
    expect(server.conn.since).toBe(20);
    r2.engine.sendCommand({ field: 'a' });
    r2.engine.sendCommand({ field: 'b' });
    await settle();
    calls[0].resolve([ack(11), ack(12)]);
    await settle();
    expect(outbox(r2.data).map((x) => x.data)).toEqual([{ field: 'b' }]);
  });

  test('the round trip is observed in a landed backfill tail', async () => {
    const server = new FakeServer();
    const hold = server.hold('patron.*');
    const r = rig({ forecaster, server });
    await bootstrap(r, ['patron.*'], {});
    sendControl(server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    const id = outbox(r.data)[0].id;
    server.blobs.set('patron.*', {
      position: 8,
      seqs: { 'patron.p1': 2 },
      values: [['patron.p1/state', { count: 2, fields: {} }]],
      tail: [ev('patron.p1', 3, 9, { type: 'set', field: 'a', value: 1 }, id)],
    });
    hold.go();
    await settle();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: { a: 1 } });
    expect(outbox(r.data)).toEqual([]);
  });

  test('the round trip is observed in the frozen walk', async () => {
    const r = await held();
    sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    const id = outbox(r.data)[0].id;
    const unfreeze = await freeze(r);
    r.server.events(ev('patron.p1', 3, 12, { type: 'set', field: 'a', value: 1 }, id));
    await settle();
    expect(outbox(r.data).length).toBe(1);
    expect(log(r.data, 'patron.p1')).toEqual([]);
    unfreeze();
    await settle();
    expect(log(r.data, 'patron.p1')).toEqual(['set a=1']);
    expect(outbox(r.data)).toEqual([]);
  });

  test('a no-op command acked during a freeze is released at the unfreeze', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const unfreeze = await freeze(r);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    calls[0].resolve([ack(15)]);
    r.server.vouch(15);
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 15, reduced: 10 });
    expect(outbox(r.data).length).toBe(1);
    unfreeze();
    await settle();
    expect(checkpoint(r.data)).toEqual({ epoch: 'e1', position: 15, reduced: 15 });
    expect(outbox(r.data)).toEqual([]);
  });
});

/** a promise's outcome, observed as it happens without awaiting it */
function track<T>(p: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const t: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => Object.assign(t, { settled: true, value }),
    (error: unknown) => Object.assign(t, { settled: true, error }),
  );
  return t;
}

describe('@online commands', () => {
  test('one goes in a call of its own, behind the commands submitted before it and ahead of those after', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    void r.engine.sendOnlineCommand({ field: 'x' });
    r.engine.sendCommand({ field: 'b' });
    await settle();
    expect(r.server.sends.map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }],
      [{ field: 'x' }],
      [{ field: 'b' }],
    ]);
    // never persisted, never forecast
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'a' }, { field: 'b' }]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 1 } });
  });

  test('after a reconnect it goes behind the resent outbox', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    await settle();
    calls[0].reject(new Error('500'));
    r.server.end();
    await settle();
    r.engine.sendCommand({ field: 'b' });
    r.engine.reconnectNow();
    await settle();
    void r.engine.sendOnlineCommand({ field: 'x' });
    await settle();
    expect(r.server.sends.slice(1).map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }, { field: 'b' }],
      [{ field: 'x' }],
    ]);
  });

  test('a reject or a conflict settles it at once', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const rejected = r.engine.sendOnlineCommand({ field: 'x' });
    const conflicted = r.engine.sendOnlineCommand({ field: 'y' });
    await settle();
    calls[0].resolve([reject]);
    calls[1].resolve([conflict]);
    expect(await rejected).toEqual(reject);
    expect(await conflicted).toEqual(conflict);
  });

  test('an ack settles on the round trip, once the queries show its event', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    const calls = sendControl(r.server);
    let shown: State | undefined;
    const t = track(
      r.engine.sendOnlineCommand({ field: 'x' }).finally(() => (shown = w.values.at(-1))),
    );
    await settle();
    // the command also wrote past the event this client sees
    calls[0].resolve([ack(12)]);
    await settle();
    expect(t.settled).toBe(false);
    const id = r.server.sends[0][0].id;
    r.server.events(ev('patron.p1', 3, 11, { type: 'set', field: 'x', value: 1 }, id));
    await settle();
    expect(t.value).toEqual(ack(12));
    expect(shown).toEqual({ count: 2, fields: { x: 1 } });
  });

  test('an event carrying its id that arrives before the answer settles it on the answer', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    const id = r.server.sends[0][0].id;
    r.server.events(ev('patron.p1', 3, 11, { type: 'set', field: 'x', value: 1 }, id));
    await settle();
    expect(t.settled).toBe(false);
    calls[0].resolve([ack(12)]);
    await settle();
    expect(t.value).toEqual(ack(12));
  });

  test('an ack with no visible events settles once the base is reduced through its position', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    calls[0].resolve([ack(15)]);
    r.server.vouch(14);
    await settle();
    expect(t.settled).toBe(false);
    r.server.vouch(15);
    await settle();
    expect(t.value).toEqual(ack(15));
  });

  test('an acked command whose round trip is observed during a freeze settles at the unfreeze', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const unfreeze = await freeze(r);
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    calls[0].resolve([ack(5)]);
    await settle();
    expect(t.settled).toBe(false);
    unfreeze();
    await settle();
    expect(t.value).toEqual(ack(5));
  });

  test('with no connection it rejects at once, while outbox commands wait for the next one', async () => {
    const r = await held();
    r.server.end();
    await settle();
    r.engine.sendCommand({ field: 'a' });
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    expect((t.error as Error).message).toBe('no connection');
    expect(outbox(r.data).map((x) => x.data)).toEqual([{ field: 'a' }]);
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }],
    ]);
  });

  test('a failed call rejects it, and it is never resent', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommand({ field: 'a' });
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    const failure = new Error('500');
    calls[0].reject(failure);
    calls[1].reject(failure);
    await settle();
    expect(t.error).toBe(failure);
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.slice(2).map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }],
    ]);
  });

  test('a connection that ends after the ack leaves it waiting for the next connection to show the round trip', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const t = track(r.engine.sendOnlineCommand({ field: 'x' }));
    await settle();
    calls[0].resolve([ack(15)]);
    await settle();
    r.server.end();
    await settle();
    expect(t.settled).toBe(false);
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.length).toBe(1);
    r.server.open();
    r.server.live(15);
    await settle();
    expect(t.value).toEqual(ack(15));
  });

  test('the Engine ending rejects every one waiting, and one sent afterwards', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const answered = track(r.engine.sendOnlineCommand({ field: 'x' }));
    const inFlight = track(r.engine.sendOnlineCommand({ field: 'y' }));
    await settle();
    calls[0].resolve([ack(15)]);
    await settle();
    r.abort.abort();
    await settle();
    expect((answered.error as Error).message).toBe('engine shut down');
    expect((inFlight.error as Error).message).toBe('engine shut down');
    await expect(r.engine.sendOnlineCommand({ field: 'z' })).rejects.toThrow('engine ended');
  });

  test('a command that fails to convert ends the Engine and rejects with its error', async () => {
    const r = await held();
    const t = track(r.engine.sendOnlineCommand({ field: 'x', value: 1n }));
    await expect(settle()).rejects.toThrow('BigInt');
    expect((t.error as Error).message).toMatch('BigInt');
  });
});
