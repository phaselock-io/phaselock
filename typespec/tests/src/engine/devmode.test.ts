// dev mode: a query result is a read-only proxy, and a mutation throws where it happens

import { describe, expect, test } from 'vitest';

import { DEV, JS, type QueryAnswer } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  type Forecaster,
  type Rig,
  rig,
  settle,
  type State,
} from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2 },
  values: [['patron.p1/state', { count: 2, fields: { tags: ['a'] } }]],
};

/** the value a store answer carries for a key */
function stateOf(a: QueryAnswer, key: string): State | undefined {
  const res = a.store[key];
  if (!('value' in res)) return undefined;
  return (res.value as Record<number, unknown> | undefined)?.[JS] as State | undefined;
}

/** a query on patron.p1's state, collecting every value delivered */
function watch(r: Rig): (State | undefined)[] {
  const values: (State | undefined)[] = [];
  const q = r.engine.newQuery(function* () {
    const a = (yield { store: { 'patron.p1/state': { type: 'state', want: JS } } }) as QueryAnswer;
    return stateOf(a, 'patron.p1/state');
  });
  q.subscribe((v) => values.push(v));
  return values;
}

describe('dev mode', () => {
  test('the suite runs in dev mode', () => {
    expect(DEV).toBe(true);
  });

  test('a query result is read-only, and the throw names the key and the property', async () => {
    const r = rig();
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const values = watch(r);
    await settle();
    const v = values[0]!;
    const fields = v.fields as { tags: string[] };
    expect(v).toEqual({ count: 2, fields: { tags: ['a'] } });
    expect(() => {
      v.count = 3;
    }).toThrow('patron.p1/state.count is read-only: set');
    expect(() => {
      fields.tags = [];
    }).toThrow('patron.p1/state.fields.tags is read-only: set');
    expect(() => fields.tags.push('b')).toThrow('patron.p1/state.fields.tags is read-only: push');
    expect(() => {
      delete (v.fields as Record<string, unknown>).tags;
    }).toThrow('patron.p1/state.fields.tags is read-only: delete');
    // reading is unaffected
    expect(fields.tags.map((t) => t.toUpperCase())).toEqual(['A']);
    expect(fields.tags.length).toBe(1);
  });

  test('a forecast that mutates what it read throws, so it forecasts nothing', async () => {
    const forecaster: Forecaster = function* () {
      const ask = { store: { 'patron.p1/state': { type: 'state', want: JS } } };
      const a = (yield ask) as QueryAnswer;
      stateOf(a, 'patron.p1/state')!.count++;
      return [{ stream: 'patron.p1', event: { id: 'p1', type: 'bump' } }];
    };
    const r = rig({ forecaster });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const values = watch(r);
    await settle();
    r.engine.sendCommands([{}]);
    await settle();
    expect(values).toEqual([{ count: 2, fields: { tags: ['a'] } }]);
  });
});
