// TESTS.md: Outbox and mutations

import { describe, expect, test } from 'vitest';

import { type Mutation, type MutationResult, Reject } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  checkpoint,
  ev,
  FakeServer,
  keys,
  log,
  parse,
  predict,
  type Predictor,
  readState,
  rig,
  type Rig,
  settle,
  state,
  type State,
  watch,
} from './harness.ts';

/** a test mutation: what the prediction should do with it */
type Cmd = {
  field?: string;
  value?: unknown;
  slice?: string;
  reason?: true;
  throws?: true;
  reads?: true;
  ghost?: true;
};

/** predicts a `set` on patron:p1 (or the named slice), or misbehaves as the mutation asks */
const predictor: Predictor = (txn, mutation) => {
  const cmd = mutation as Cmd;
  if (cmd.reason) throw new Reject('not this time');
  if (cmd.throws) throw new Error('prediction boom');
  if (cmd.ghost) return predict(txn, 'ghost:g1', { id: 'g1', type: 'bump' });
  if (cmd.reads) {
    const seen = JSON.stringify(readState(txn, 'patron:p1')?.fields ?? {});
    return predict(txn, 'patron:p1', { id: 'p1', type: 'set', field: 'seen', value: seen });
  }
  const slice = cmd.slice ?? 'patron:p1';
  const id = slice.slice(slice.indexOf(':') + 1);
  predict(txn, slice, { id, type: 'set', field: cmd.field ?? 'f', value: cmd.value ?? 1 });
};

const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};

/** a live Engine holding patron:p1 and patron:p2 at position 10, with the predictor */
async function held(server = new FakeServer()): Promise<Rig> {
  const r = rig({ predictor, server });
  await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
  return r;
}

type SendCall = {
  cmds: Mutation<Uint8Array>[];
  resolve: (results: MutationResult[]) => void;
  reject: (e: unknown) => void;
};

/** take over the server's sendMutations: every call is recorded and answered by the test */
function sendControl(server: FakeServer): SendCall[] {
  const calls: SendCall[] = [];
  server.onSend = (cmds) =>
    new Promise<MutationResult[]>((resolve, reject) => {
      calls.push({ cmds, resolve, reject });
    });
  return calls;
}

const ok = (position: number): MutationResult => ({ kind: 'ok', position });
const reject: MutationResult = { kind: 'reject', reason: 'no' };
const conflict: MutationResult = { kind: 'conflict', current: {} };

/** the outbox as stored: ordinal keys and their envelopes, the wire bytes parsed back */
function outbox(data: Record<string, unknown>): { key: string; id: string; data: unknown }[] {
  return keys(data, '!mutation:').map((key) => {
    const c = data[key] as Mutation<Uint8Array>;
    return { key, id: c.id, data: parse(c.data) };
  });
}

/** freeze the base: a gap on patron:p2 whose backfill is held; returns the release */
async function freeze(r: Rig, position = 11): Promise<() => void> {
  const hold = r.server.hold('patron:p2');
  r.server.edits(ev('patron:p2', 9, position));
  await settle();
  expect(r.data()['!backfill:patron:p2']).toBeDefined();
  return () => {
    r.server.blobs.set('patron:p2', {
      position,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    hold.go();
  };
}

describe('outbox rows and sends', () => {
  test('sendMutation writes padded ordinal rows holding the envelope and sends them in order', async () => {
    const r = await held();
    r.engine.sendMutation({ field: 'a', value: 1 });
    r.engine.sendMutation({ field: 'b', value: 2 });
    await settle();
    const rows = outbox(r.data());
    expect(rows.map((x) => x.key)).toEqual([
      '!mutation:00000000000000000000',
      '!mutation:00000000000000000001',
    ]);
    expect(rows.map((x) => x.data)).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    expect(r.server.sends.length).toBe(1);
    expect(r.server.sends[0].map((c) => c.id)).toEqual(rows.map((x) => x.id));
    // wire data is the mutation through the mutations type; the row keeps the JS envelope
    expect(r.server.sends[0].map((c) => parse(c.data))).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    expect(typeof rows[0].id).toBe('string');
  });

  test('an ok releases once the applied position reaches it; a reject and a conflict at once', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    r.engine.sendMutation({ field: 'b' });
    r.engine.sendMutation({ field: 'c' });
    r.engine.sendMutation({ field: 'd' });
    await settle();
    calls[0].resolve([ok(15), ok(16), reject, conflict]);
    await settle();
    const rows = outbox(r.data());
    expect(rows.map((x) => x.data)).toEqual([{ field: 'a' }, { field: 'b' }]);
    r.server.vouch(15);
    await settle();
    expect(outbox(r.data()).map((x) => x.data)).toEqual([{ field: 'b' }]);
    r.server.vouch(16);
    await settle();
    expect(outbox(r.data())).toEqual([]);
  });

  test('an edit carrying the mutation id releases it when applied, before the ack', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    const id = outbox(r.data())[0].id;
    r.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'a', value: 1 }, id));
    await settle();
    expect(outbox(r.data())).toEqual([]);
    expect(log(r.data(), 'patron:p1')).toEqual(['set a=1']);
    // the late ack finds nothing to release and changes nothing
    calls[0].resolve([ok(11)]);
    await settle();
    expect(outbox(r.data())).toEqual([]);
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: { a: 1 } });
  });

  test("a failed call's mutations wait for the connection's end; the next connection resends them in order in one call", async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    r.engine.sendMutation({ field: 'b' });
    await settle();
    calls[0].reject(new Error('500'));
    await settle();
    expect(outbox(r.data()).length).toBe(2);
    // the connection has not ended yet, so a new mutation goes alone
    r.engine.sendMutation({ field: 'c' });
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

  test('a row an earlier build wrote, unreadable now, is still sent as stored and predicts nothing', async () => {
    const server = new FakeServer();
    const calls = sendControl(server);
    const stale = new TextEncoder().encode('not json');
    const r = rig({
      predictor,
      server,
      seed: {
        '!view': { token: 't1', position: 10, selectors: ['patron:*'] },
        '!checkpoint': { epoch: 'e1', position: 10, applied: 10 },
        '!seq:patron:p1': 2,
        'patron:p1!state': { count: 2, fields: {} },
        '!mutation:00000000000000000000': { id: 'old', data: stale },
      },
    });
    const w = watch(r, 'patron:p1');
    await settle();
    r.server.open();
    r.server.live(10);
    await settle();

    // sent byte for byte, and the graph delivered the base with no prediction on it
    expect(calls.length).toBe(1);
    expect(calls[0].cmds).toEqual([{ id: 'old', data: stale }]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });

    // acked like any other mutation
    calls[0].resolve([ok(10)]);
    await settle();
    expect(keys(r.data(), '!mutation:')).toEqual([]);
  });

  test('a new connection flushes every mutation not acked, in ordinal order, in one call', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    calls[0].resolve([ok(500)]);
    await settle();
    r.engine.sendMutation({ field: 'b' });
    r.engine.sendMutation({ field: 'c' });
    await settle();
    expect(calls.length).toBe(2);
    // the connection ends with b and c unanswered; a is acked and waits for the cursor
    r.server.end();
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.length).toBe(3);
    expect(r.server.sends[2].map((c) => parse(c.data))).toEqual([{ field: 'b' }, { field: 'c' }]);
    expect(outbox(r.data()).length).toBe(3);
  });

  test('mutations survive a restart in order and are flushed on connect; the next ordinal continues', async () => {
    const r = await held();
    sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    r.engine.sendMutation({ field: 'b' });
    await settle();
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron:*', patrons);
    const calls = sendControl(server);
    const r2 = rig({ store: r.store, server, predictor });
    await settle();
    expect(server.sends.length).toBe(1);
    expect(server.sends[0].map((c) => parse(c.data))).toEqual([{ field: 'a' }, { field: 'b' }]);
    expect(calls.length).toBe(1);
    r2.engine.sendMutation({ field: 'c' });
    await settle();
    expect(outbox(r2.data()).map((x) => x.key)).toEqual([
      '!mutation:00000000000000000000',
      '!mutation:00000000000000000001',
      '!mutation:00000000000000000002',
    ]);
  });

  test('acks are memory only: acked before a crash, resent under its series, ok again, dropped the same way', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    calls[0].resolve([ok(15)]);
    await settle();
    expect(outbox(r.data()).length).toBe(1);
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron:*', patrons);
    const calls2 = sendControl(server);
    rig({ store: r.store, server, predictor });
    await settle();
    expect(server.sends.length).toBe(1);
    expect(server.sends[0].map((c) => parse(c.data))).toEqual([{ field: 'a' }]);
    expect(server.sends[0].map((c) => [c.series, c.n])).toEqual(
      r.server.sends[0].map((c) => [c.series, c.n]),
    );
    calls2[0].resolve([ok(15)]);
    await settle();
    expect(outbox(r.data()).length).toBe(1);
    server.open();
    server.vouch(15);
    await settle();
    expect(outbox(r.data())).toEqual([]);
  });
});

describe('series', () => {
  test('outbox and @online mutations take consecutive numbers of one series, in submission order', async () => {
    const r = await held();
    sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    void r.engine.sendOnlineMutation({ field: 'x' });
    r.engine.sendMutation({ field: 'b' });
    await settle();
    const sent = r.server.sends.flat();
    expect(sent.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(new Set(sent.map((c) => c.series)).size).toBe(1);
    expect(sent[0].series).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // the outbox rows keep the series and number they were minted with
    const rows = keys(r.data(), '!mutation:').map((k) => r.data()[k] as Mutation<Uint8Array>);
    expect(rows.map((c) => [c.series, c.n])).toEqual([
      [sent[0].series, 1],
      [sent[0].series, 3],
    ]);
  });
});

describe('predictions', () => {
  test('the overlay is rebuilt from the outbox; a throwing prediction is dropped and the Engine survives', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    await settle();
    expect(w.values).toEqual([{ count: 2, fields: {} }]);
    r.engine.sendMutation({ throws: true });
    r.engine.sendMutation({ field: 'a', value: 1 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1 } });
    // a base change rebuilds the overlay over the new base, predictions still on top
    r.server.edits(ev('patron:p1', 3, 11));
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 3, fields: { a: 1 } });
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 3, fields: {} });
  });

  test('predictions run in outbox order, each reading the overlay the earlier ones left', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    r.engine.sendMutation({ field: 'a', value: 1 });
    await settle();
    r.engine.sendMutation({ reads: true });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, seen: '{"a":1}' } });
  });

  test('a rejection adds nothing; a write to a slice type the Engine does not declare stays off the base', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    await settle();
    r.engine.sendMutation({ reason: true });
    r.engine.sendMutation({ ghost: true });
    await settle();
    expect(outbox(r.data()).length).toBe(2);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });
    expect(keys(r.data(), 'ghost')).toEqual([]);
  });

  test('a dropped mutation rebuilds the overlay and runs the graph even while frozen', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a', value: 1 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1 } });
    await freeze(r);
    calls[0].resolve([reject]);
    await settle();
    expect(r.data()['!backfill:patron:p2']).toBeDefined();
    expect(outbox(r.data())).toEqual([]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: {} });
  });
});

describe('the applied position', () => {
  test('a frame that breaks parks whole, a vouch while frozen, an ack already applied past, and the land', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a', value: 1 });
    r.engine.sendMutation({ field: 'b', value: 2 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 2 } });
    // p2's gap at 12 parks the whole frame, p1's edit at 11 with it, and freezes the base at 10
    const hold = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p1', 3, 11), ev('patron:p2', 9, 12));
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 12, applied: 10 });
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 2 } });
    // acks past the applied position release nothing while frozen
    calls[0].resolve([ok(11), ok(12)]);
    await settle();
    expect(outbox(r.data()).map((x) => x.data)).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    // a vouch moves the cursor but not the applied position while frozen
    r.server.vouch(20);
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 20, applied: 10 });
    // an ack at a position already applied past releases at once, frozen or not
    r.engine.sendMutation({ field: 'c', value: 3 });
    await settle();
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 2, c: 3 } });
    calls[1].resolve([ok(5)]);
    await settle();
    expect(outbox(r.data()).map((x) => x.data)).toEqual([
      { field: 'a', value: 1 },
      { field: 'b', value: 2 },
    ]);
    // a's and b's predictions never left the overlay through the freeze
    for (const v of w.values.slice(1)) expect(v?.fields).toMatchObject({ a: 1, b: 2 });
    // the land applies the base through the cursor and releases both
    r.server.blobs.set('patron:p2', {
      position: 12,
      seqs: { 'patron:p2': 9 },
      values: [['patron:p2!state', { count: 9, fields: {} }]],
    });
    hold.go();
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 20, applied: 20 });
    expect(outbox(r.data())).toEqual([]);
    expect(w.values.at(-1)).toEqual({ count: 3, fields: {} });
  });

  test('the applied position is persisted and restored on boot mid-freeze', async () => {
    const r = await held();
    // p1's edit at 11 applies, then p2's gap at 12 freezes the base there
    const hold = r.server.hold('patron:p2');
    r.server.edits(ev('patron:p1', 3, 11));
    r.server.edits(ev('patron:p2', 9, 12));
    r.server.vouch(20);
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 20, applied: 11 });
    void hold;
    r.abort.abort();
    await settle();
    const server = new FakeServer();
    server.blobs.set('patron:*', patrons);
    server.hold('patron:p2');
    const calls = sendControl(server);
    const r2 = rig({ store: r.store, server, predictor });
    await settle();
    expect(server.conn.since).toBe(20);
    r2.engine.sendMutation({ field: 'a' });
    r2.engine.sendMutation({ field: 'b' });
    await settle();
    calls[0].resolve([ok(11), ok(12)]);
    await settle();
    expect(outbox(r2.data()).map((x) => x.data)).toEqual([{ field: 'b' }]);
  });

  test('the round trip is observed in a landed backfill tail', async () => {
    const server = new FakeServer();
    const hold = server.hold('patron:*');
    const r = rig({ predictor, server });
    await bootstrap(r, ['patron:*'], {});
    sendControl(server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    const id = outbox(r.data())[0].id;
    server.blobs.set('patron:*', {
      position: 8,
      seqs: { 'patron:p1': 2 },
      values: [['patron:p1!state', { count: 2, fields: {} }]],
      tail: [ev('patron:p1', 3, 9, { type: 'set', field: 'a', value: 1 }, id)],
    });
    hold.go();
    await settle();
    expect(state(r.data(), 'patron:p1')).toEqual({ count: 2, fields: { a: 1 } });
    expect(outbox(r.data())).toEqual([]);
  });

  test('the round trip is observed in the land', async () => {
    const r = await held();
    sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    const id = outbox(r.data())[0].id;
    const land = await freeze(r);
    r.server.edits(ev('patron:p1', 3, 12, { type: 'set', field: 'a', value: 1 }, id));
    await settle();
    expect(outbox(r.data()).length).toBe(1);
    expect(log(r.data(), 'patron:p1')).toEqual([]);
    land();
    await settle();
    expect(log(r.data(), 'patron:p1')).toEqual(['set a=1']);
    expect(outbox(r.data())).toEqual([]);
  });

  test('a no-op mutation acked during a freeze is released at the land', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const land = await freeze(r);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    calls[0].resolve([ok(15)]);
    r.server.vouch(15);
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 15, applied: 10 });
    expect(outbox(r.data()).length).toBe(1);
    land();
    await settle();
    expect(checkpoint(r.data())).toEqual({ epoch: 'e1', position: 15, applied: 15 });
    expect(outbox(r.data())).toEqual([]);
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

describe('@online mutations', () => {
  test('one goes in a call of its own, behind the mutations submitted before it and ahead of those after', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    void r.engine.sendOnlineMutation({ field: 'x' });
    r.engine.sendMutation({ field: 'b' });
    await settle();
    expect(r.server.sends.map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }],
      [{ field: 'x' }],
      [{ field: 'b' }],
    ]);
    // never persisted, never predicted
    expect(outbox(r.data()).map((x) => x.data)).toEqual([{ field: 'a' }, { field: 'b' }]);
    expect(w.values.at(-1)).toEqual({ count: 2, fields: { a: 1, b: 1 } });
  });

  test('after a reconnect it goes behind the resent outbox', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    await settle();
    calls[0].reject(new Error('500'));
    r.server.end();
    await settle();
    r.engine.sendMutation({ field: 'b' });
    r.engine.reconnectNow();
    await settle();
    void r.engine.sendOnlineMutation({ field: 'x' });
    await settle();
    expect(r.server.sends.slice(1).map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }, { field: 'b' }],
      [{ field: 'x' }],
    ]);
  });

  test('a reject or a conflict settles it at once', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const rejected = r.engine.sendOnlineMutation({ field: 'x' });
    const conflicted = r.engine.sendOnlineMutation({ field: 'y' });
    await settle();
    calls[0].resolve([reject]);
    calls[1].resolve([conflict]);
    expect(await rejected).toEqual(reject);
    expect(await conflicted).toEqual(conflict);
  });

  test('an ack settles on the round trip, once the queries show its edit', async () => {
    const r = await held();
    const w = watch(r, 'patron:p1');
    const calls = sendControl(r.server);
    let shown: State | undefined;
    const t = track(
      r.engine.sendOnlineMutation({ field: 'x' }).finally(() => (shown = w.values.at(-1))),
    );
    await settle();
    // the mutation also wrote past the edit this client sees
    calls[0].resolve([ok(12)]);
    await settle();
    expect(t.settled).toBe(false);
    const id = r.server.sends[0][0].id;
    r.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'x', value: 1 }, id));
    await settle();
    expect(t.value).toEqual(ok(12));
    expect(shown).toEqual({ count: 2, fields: { x: 1 } });
  });

  test('an edit carrying its id that arrives before the answer settles it on the answer', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
    await settle();
    const id = r.server.sends[0][0].id;
    r.server.edits(ev('patron:p1', 3, 11, { type: 'set', field: 'x', value: 1 }, id));
    await settle();
    expect(t.settled).toBe(false);
    calls[0].resolve([ok(12)]);
    await settle();
    expect(t.value).toEqual(ok(12));
  });

  test('an ack with no visible edits settles once the base is applied through its position', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
    await settle();
    calls[0].resolve([ok(15)]);
    r.server.vouch(14);
    await settle();
    expect(t.settled).toBe(false);
    r.server.vouch(15);
    await settle();
    expect(t.value).toEqual(ok(15));
  });

  test('an acked mutation whose round trip is observed during a freeze settles at the land', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const land = await freeze(r);
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
    await settle();
    calls[0].resolve([ok(5)]);
    await settle();
    expect(t.settled).toBe(false);
    land();
    await settle();
    expect(t.value).toEqual(ok(5));
  });

  test('with no connection it rejects at once, while outbox mutations wait for the next one', async () => {
    const r = await held();
    r.server.end();
    await settle();
    r.engine.sendMutation({ field: 'a' });
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
    await settle();
    expect((t.error as Error).message).toBe('no connection');
    expect(outbox(r.data()).map((x) => x.data)).toEqual([{ field: 'a' }]);
    r.engine.reconnectNow();
    await settle();
    expect(r.server.sends.map((call) => call.map((c) => parse(c.data)))).toEqual([
      [{ field: 'a' }],
    ]);
  });

  test('a failed call rejects it, and it is never resent', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    r.engine.sendMutation({ field: 'a' });
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
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
    const t = track(r.engine.sendOnlineMutation({ field: 'x' }));
    await settle();
    calls[0].resolve([ok(15)]);
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
    expect(t.value).toEqual(ok(15));
  });

  test('the Engine ending rejects every one waiting, and one sent afterwards', async () => {
    const r = await held();
    const calls = sendControl(r.server);
    const answered = track(r.engine.sendOnlineMutation({ field: 'x' }));
    const inFlight = track(r.engine.sendOnlineMutation({ field: 'y' }));
    await settle();
    calls[0].resolve([ok(15)]);
    await settle();
    r.abort.abort();
    await settle();
    expect((answered.error as Error).message).toBe('engine shut down');
    expect((inFlight.error as Error).message).toBe('engine shut down');
    await expect(r.engine.sendOnlineMutation({ field: 'z' })).rejects.toThrow('engine ended');
  });

  test('a mutation that fails to convert ends the Engine and rejects with its error', async () => {
    const r = await held();
    const t = track(r.engine.sendOnlineMutation({ field: 'x', value: 1n }));
    await expect(settle()).rejects.toThrow('BigInt');
    expect((t.error as Error).message).toMatch('BigInt');
  });
});
