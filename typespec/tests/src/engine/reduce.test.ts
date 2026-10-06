// The reducer protocol, forecasts on the overlay, and synchronous queries

import { describe, expect, test } from 'vitest';

import type { ReducerTxn, SliceReducer } from '../../../ts/assets/skeleton.ts';

import { type Blob, bootstrap, ev, type Forecaster, rig, settle, state, watch } from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2, 'patron.p2': 1 },
  values: [
    ['patron.p1/state', { count: 2, fields: {} }],
    ['patron.p2/state', { count: 1, fields: {} }],
  ],
};

/** a reducer that records how it was called and writes a local `marker` key */
function recorder(calls: { stream: string; pending: boolean }[], family: string): SliceReducer {
  return {
    template: `${family}.{id}`,
    keys: ['marker'],
    reducer(txn: ReducerTxn, events: unknown[], stream: string, pending: boolean): void {
      calls.push({ stream, pending });
      txn.set('marker', 'state', { count: events.length, fields: {} });
    },
  };
}

describe('the reducer protocol', () => {
  test('a reducer gets local keys, its stream, and pending false for real events', async () => {
    const calls: { stream: string; pending: boolean }[] = [];
    const r = rig({
      reducers: { patron: recorder(calls, 'patron'), book: recorder(calls, 'book') },
    });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    r.server.events(ev('patron.p1', 3, 11));
    await settle();
    expect(calls).toEqual([{ stream: 'patron.p1', pending: false }]);
    expect(r.data['patron.p1/marker']).toEqual({ count: 1, fields: {} });
    expect(r.data['marker']).toBeUndefined();
  });

  test("a forecast's events reach the reducer with pending true, and stay off the base", async () => {
    const calls: { stream: string; pending: boolean }[] = [];
    const forecaster: Forecaster = () => [
      { stream: 'patron.p2', event: { id: 'p2', type: 'bump' } },
    ];
    const r = rig({
      forecaster,
      reducers: { patron: recorder(calls, 'patron'), book: recorder(calls, 'book') },
    });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    r.engine.sendCommand({});
    await settle();
    expect(calls).toContainEqual({ stream: 'patron.p2', pending: true });
    expect(calls).not.toContainEqual({ stream: 'patron.p2', pending: false });
    expect(r.data['patron.p2/marker']).toBeUndefined();
  });
});

describe('forecasts', () => {
  // each command names the events it forecasts
  const forecaster: Forecaster = (_qx, command) =>
    (command as { emit: ({ stream: string; event: unknown } | { stream: string; death: true })[] })
      .emit;
  const set = (stream: string, field: string) => ({
    stream,
    event: { id: stream.slice(stream.indexOf('.') + 1), type: 'set', field, value: 1 },
  });

  test("a reducer that throws cancels that command's whole forecast, and the others stand", async () => {
    const r = rig({ forecaster });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const p1 = watch(r, 'patron.p1');
    const p2 = watch(r, 'patron.p2');
    r.engine.sendCommand({ emit: [set('patron.p1', 'a')] });
    // its event on patron.p2 is rolled back with the throw on patron.p1
    r.engine.sendCommand({
      emit: [set('patron.p2', 'b'), { stream: 'patron.p1', event: { id: 'p1', type: 'boom' } }],
    });
    r.engine.sendCommand({ emit: [set('patron.p1', 'c')] });
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { a: 1, c: 1 } });
    expect(p2.values.at(-1)).toEqual({ count: 1, fields: {} });
  });

  test('a label that does not fill its family template forecasts nothing for that command', async () => {
    const r = rig({ forecaster });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const p1 = watch(r, 'patron.p1');
    r.engine.sendCommand({ emit: [set('patron.p1', 'a'), set('patron.', 'b')] });
    r.engine.sendCommand({ emit: [set('patron.p1', 'c'), { stream: '', death: true }] });
    r.engine.sendCommand({ emit: [set('patron.p1', 'd'), set('ghost.g/1', 'e')] });
    r.engine.sendCommand({ emit: [set('patron.p1', 'f'), set('ghost.g~1', 'g')] });
    await settle();
    expect(p1.values.at(-1)).toEqual({ count: 2, fields: { f: 1 } });
  });

  test("a forecast death drops the stream's keys from the overlay only", async () => {
    const r = rig({ forecaster });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const p1 = watch(r, 'patron.p1');
    r.engine.sendCommand({ emit: [{ stream: 'patron.p1', death: true }] });
    await settle();
    expect(p1.values.at(-1)).toBeUndefined();
    expect(state(r.data, 'patron.p1')).toEqual({ count: 2, fields: {} });
  });
});

describe('queries', () => {
  test('a query runs again only when a key it read changes', async () => {
    const r = rig();
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const p1 = watch(r, 'patron.p1');
    await settle();
    const before = p1.runs();
    expect(before).toBeGreaterThan(0);

    // an event on another stream leaves the query alone
    r.server.events(ev('patron.p2', 2, 11));
    await settle();
    expect(p1.runs()).toBe(before);

    // an event on its own stream runs it again
    r.server.events(ev('patron.p1', 3, 12));
    await settle();
    expect(p1.runs()).toBe(before + 1);
    expect(p1.values.at(-1)).toEqual({ count: 3, fields: {} });
  });
});
