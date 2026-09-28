// TESTS.md: Outbox and commands

import { describe, expect, test } from 'vitest';

import {
  type Command,
  type CommandResult,
  JS,
  type LocalQuery,
  type QueryAnswer,
} from '../../../ts/assets/skeleton.ts';

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
} from './harness.ts';

/** a test command: what the forecast should do with it */
type Cmd = {
  field?: string;
  value?: unknown;
  stream?: string;
  reason?: true;
  throws?: true;
  awaitsQuery?: true;
  reads?: true;
  ghost?: true;
};

/** forecasts a `set` on patron.p1 (or the named stream), or misbehaves as the command asks */
const forecaster: Forecaster = function* (_qx, command) {
  const cmd = command as Cmd;
  if (cmd.reason) return 'not this time';
  if (cmd.throws) throw new Error('forecast boom');
  if (cmd.awaitsQuery) {
    yield { query: { x: true } };
    return [];
  }
  if (cmd.ghost) return [{ stream: 'ghost.g1', event: { id: 'g1', type: 'bump' } }];
  if (cmd.reads) {
    const a = (yield { store: { 'patron.p1/state': { type: 'state', want: JS } } }) as QueryAnswer;
    const res = a.store['patron.p1/state'];
    const st =
      'value' in res
        ? ((res.value as Record<number, unknown> | undefined)?.[JS] as State | undefined)
        : undefined;
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

/** a query on a stream's state, collecting every value delivered */
function watch(
  r: Rig,
  stream: string,
): { values: (State | undefined)[]; q: LocalQuery<State | undefined> } {
  const values: (State | undefined)[] = [];
  const key = `${stream}/state`;
  const q = r.engine.newQuery(function* () {
    const a = (yield { store: { [key]: { type: 'state', want: JS } } }) as QueryAnswer;
    const res = a.store[key];
    return 'value' in res
      ? ((res.value as Record<number, unknown> | undefined)?.[JS] as State | undefined)
      : undefined;
  });
  q.subscribe((v) => values.push(v));
  return { values, q };
}

type SendCall = {
  cmds: Command<Uint8Array>[];
  resolve: (results: CommandResult[]) => void;
  reject: (e: unknown) => void;
};

/** take over the server's sendCommand: every call is recorded and answered by the test */
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
  test('sendCommands writes padded ordinal rows holding the envelope and sends them in order', async () => {
    const r = await held();
    r.engine.sendCommands([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
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
    r.engine.sendCommands([{ field: 'a' }, { field: 'b' }, { field: 'c' }, { field: 'd' }]);
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
    r.engine.sendCommands([{ field: 'a' }]);
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

  test('a failed sendCommand keeps the commands queued; the next connection flushes them in order in one call', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendCommands([{ field: 'a' }, { field: 'b' }]);
    await settle();
    calls[0].reject(new Error('500'));
    await settle();
    expect(outbox(r.data).length).toBe(2);
    expect(r.server.sends.length).toBe(1);
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.conns.length).toBe(2);
    expect(r.server.sends.length).toBe(2);
    expect(r.server.sends[1].map((c) => parse(c.data))).toEqual([{ field: 'a' }, { field: 'b' }]);
    expect(calls.length).toBe(2);
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
    r.engine.sendCommands([{ field: 'a' }]);
    await settle();
    calls[0].resolve([ack(500)]);
    await settle();
    r.engine.sendCommands([{ field: 'b' }, { field: 'c' }]);
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
    r.engine.sendCommands([{ field: 'a' }, { field: 'b' }]);
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
    r2.engine.sendCommands([{ field: 'c' }]);
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
    r.engine.sendCommands([{ field: 'a' }]);
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
    r.engine.sendCommands([{ throws: true }, { field: 'a', value: 1 }]);
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
    r.engine.sendCommands([{ field: 'a', value: 1 }]);
    await settle();
    r.engine.sendCommands([{ reads: true }]);
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, seen: '{"a":1}' } });
  });

  test('a reason adds nothing; a family with no reducer adds nothing', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    await settle();
    r.engine.sendCommands([{ reason: true }, { ghost: true }]);
    await settle();
    expect(outbox(r.data).length).toBe(2);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });
    expect(keys(r.data, 'ghost')).toEqual([]);
  });

  test('a forecast that awaits a query ends the Engine', async () => {
    const r = await held();
    r.engine.sendCommands([{ awaitsQuery: true }]);
    await expect(settle()).rejects.toThrow(/awaited a query/);
  });

  test('a dropped command rebuilds the overlay and runs the graph even while frozen', async () => {
    const r = await held();
    const w = watch(r, 'patron.p1');
    const calls = sendControl(r.server);
    r.engine.sendCommands([{ field: 'a', value: 1 }]);
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
    r.engine.sendCommands([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
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
    r.engine.sendCommands([{ field: 'c', value: 3 }]);
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
    r2.engine.sendCommands([{ field: 'a' }, { field: 'b' }]);
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
    r.engine.sendCommands([{ field: 'a' }]);
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
    r.engine.sendCommands([{ field: 'a' }]);
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
    r.engine.sendCommands([{ field: 'a' }]);
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
