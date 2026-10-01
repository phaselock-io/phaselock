// dev mode: a query result is a read-only proxy, and a mutation throws where it happens

import { describe, expect, test } from 'vitest';

import { DEV } from '../../../ts/assets/skeleton.ts';

import {
  type Blob,
  bootstrap,
  type Forecaster,
  rig,
  settle,
  type State,
  watch,
} from './harness.ts';

const patrons: Blob = {
  position: 10,
  seqs: { 'patron.p1': 2 },
  values: [['patron.p1/state', { count: 2, fields: { tags: ['a'] } }]],
};

describe('dev mode', () => {
  test('the suite runs in dev mode', () => {
    expect(DEV).toBe(true);
  });

  test('a query result is read-only, and the throw names the key and the property', async () => {
    const r = rig();
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const { values } = watch(r, 'patron.p1');
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
    const forecaster: Forecaster = (qx) => {
      (qx.get('patron.p1/state', 'state') as State).count++;
      return [{ stream: 'patron.p1', event: { id: 'p1', type: 'bump' } }];
    };
    const r = rig({ forecaster });
    await bootstrap(r, ['patron.*'], { 'patron.*': patrons });
    const { values } = watch(r, 'patron.p1');
    await settle();
    r.engine.sendCommands([{}]);
    await settle();
    expect(values).toEqual([{ count: 2, fields: { tags: ['a'] } }]);
  });
});
