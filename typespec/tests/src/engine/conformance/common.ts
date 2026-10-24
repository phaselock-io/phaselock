// What the conformance groups share: a held family, blobs, a resumed store, backfill records, and
// the crash that boots a new Engine over the same store

import type { BackfillRecord, ViewRecord } from '../../../../ts/assets/skeleton.ts';
import {
  type Blob,
  bootstrap,
  ev,
  FakeServer,
  type Predictor,
  type Rig,
  rig,
  settle,
} from '../harness.ts';

/** a family of two members at position 10: patron:p1 at seq 2 and patron:p2 at seq 1 */
export const patrons: Blob = {
  position: 10,
  seqs: { 'patron:p1': 2, 'patron:p2': 1 },
  values: [
    ['patron:p1!state', { count: 2, fields: {} }],
    ['patron:p2!state', { count: 1, fields: {} }],
  ],
};

/** a blob of one slice cut at position, holding the slice at seq with state count and fields */
export function one(
  slice: string,
  position: number,
  seq: number,
  count = seq,
  fields: Record<string, unknown> = {},
): Blob {
  return { position, seqs: { [slice]: seq }, values: [[`${slice}!state`, { count, fields }]] };
}

/** a live Engine that bootstrapped patrons at position 10 */
export async function held(opts: { predictor?: Predictor } = {}): Promise<Rig> {
  const r = rig(opts);
  await bootstrap(r, ['patron:*'], { 'patron:*': patrons });
  return r;
}

/** a store an earlier run left: patrons held, the view t1, and the checkpoint at position 10 */
export const resumed = {
  '!view': { token: 't1', position: 10, selectors: ['patron:*'] },
  '!checkpoint': { epoch: 'e1', position: 10, applied: 10 },
  '!seq:patron:p1': 2,
  'patron:p1!state': { count: 2, fields: {} },
  '!seq:patron:p2': 1,
  'patron:p2!state': { count: 1, fields: {} },
};

/** an edit that sets one field */
export const set = (
  slice: string,
  seq: number,
  position: number,
  field: string,
  value: unknown,
  id?: string,
) => ev(slice, seq, position, { type: 'set', field, value }, id);

/** a birth that sets a name, so a state built without it shows */
export const named = (slice: string, seq: number, position: number, name: string) =>
  ev(slice, seq, position, { type: 'set', field: 'name', value: name }, undefined, 'birth');

/** a backfill's persisted record */
export const record = (r: Rig, selector: string): BackfillRecord | undefined =>
  r.data()[`!backfill:${selector}`] as BackfillRecord | undefined;

/** the persisted view */
export const view = (r: Rig): ViewRecord | undefined => r.data()['!view'] as ViewRecord | undefined;

/** The crash: the Engine ends, and a new one boots over the same store against a fresh server,
    which serves blobs and is shaped by prepare before the new Engine first connects. */
export async function restart(
  r: Rig,
  blobs: Record<string, Blob> = {},
  prepare: (server: FakeServer) => void = () => {},
): Promise<Rig> {
  r.abort.abort();
  await settle();
  const server = new FakeServer();
  for (const [selector, blob] of Object.entries(blobs)) server.blobs.set(selector, blob);
  prepare(server);
  const r2 = rig({ store: r.store, server });
  await settle();
  return r2;
}
