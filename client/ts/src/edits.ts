// Edits as bytes: an edit's envelope, read from its raw bytes, and the operations of an edit or a
// snapshot page, split into byte spans without decoding a value.
//
// An edit on the wire is one msgpack array, its envelope and then its payload's items, flat:
//
//   [[position, slice, seq, id, servertime, lifecycle, ...], 0, key, value, 1, key, ...]
//
// The id is 16 bytes of bin, the server time a timestamp, and the lifecycle 0, 1, or 2.  The
// payload is a stream of operations, each an opcode and the items it fixes: `0, key, value` sets
// a key, and `1, key` deletes one.  A snapshot page is a run of operations with no envelope and
// no array around them, all of them sets.

import type { EditEnvelope, EditOp, Lifecycle } from './contract.js';
import { Reader } from './msgpack.js';
import { uuidString } from './uuid.js';

// the lifecycles by their wire number
const LIFECYCLES: Lifecycle[] = ['normal', 'birth', 'death'];

// the opcodes
const SET = 0;
const DEL = 1;

/** The envelope of the raw edit at the cursor, which is left at the edit's first payload item.
    Envelope elements a later protocol appends are skipped. */
export function readEnvelope(r: Reader): EditEnvelope {
  if (r.arrayHeader() < 1) throw new Error('an edit without an envelope');
  const n = r.arrayHeader();
  if (n < 6) throw new Error('short envelope');
  const position = r.int();
  const slice = r.str();
  const seq = r.int();
  const id = uuidString(r.bin());
  const servertime = r.timestamp();
  const life = r.int();
  const lifecycle = LIFECYCLES[life];
  if (lifecycle === undefined) throw new Error(`unknown lifecycle ${life}`);
  for (let k = 6; k < n; k++) r.skip();
  return { position, slice, seq, id, servertime, lifecycle };
}

/** The operations of a raw edit, its envelope skipped, or of a snapshot page, in order: each a
    key and its value's bytes as a view into bytes, or undefined for a deletion.  An opcode this
    library does not know throws. */
export function editOps(bytes: Uint8Array, edit: boolean): EditOp[] {
  const r = new Reader(bytes);

  // an edit's operations are the items after its envelope; a page's run to the end of its bytes
  let left = Infinity;
  if (edit) {
    left = r.arrayHeader() - 1;
    if (left < 0) throw new Error('an edit without an envelope');
    r.skip();
  }

  // each operation, its opcode first
  const out: EditOp[] = [];
  while (edit ? left > 0 : !r.done) {
    const op = r.int();
    if (op !== SET && op !== DEL) throw new Error(`unknown opcode ${op}`);
    const key = r.str();
    if (op === SET) {
      out.push([key, r.view()]);
      left -= 3;
    } else {
      out.push([key, undefined]);
      left -= 2;
    }
  }
  if (left < 0) throw new Error('an edit ends inside an operation');
  return out;
}
