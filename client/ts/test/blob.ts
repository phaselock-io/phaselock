// Builds version-1 snapshot blobs for tests: the header, the body's set operations, and the end
// marker and footer.

import { encode } from '@msgpack/msgpack';
import { crc32c, Fnv64 } from '../src/checksum.js';

const utf8 = new TextEncoder();

function u32(n: number): Uint8Array {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export type BlobSpec = {
  selector: string;
  position: number;
  epoch: string;
  slices: Record<string, number>;
  // the last position any slice under the selector changed, the cut unless given
  visible?: number;
  // sorted by key by the builder
  values: Record<string, unknown>;
};

/** one set operation, `0, key, value`, as msgpack items back to back */
export function setOp(key: string, value: unknown): Uint8Array {
  return concat([Uint8Array.of(0), encode(key), encode(value)]);
}

/** blob builds a blob; start is the byte offset of its first operation, and opEnds are the
    offsets after each one, for resume tests */
export function blob(spec: BlobSpec): { bytes: Uint8Array; start: number; opEnds: number[] } {
  const keys = Object.keys(spec.values).sort();
  const header = encode({
    selector: spec.selector,
    position: spec.position,
    epoch: spec.epoch,
    slices: spec.slices,
    visible: spec.visible ?? spec.position,
  });
  const parts: Uint8Array[] = [
    utf8.encode('PLSN'),
    Uint8Array.of(1),
    u32(header.length),
    header,
    u32(crc32c(header)),
  ];
  const start = parts.reduce((n, p) => n + p.length, 0);
  let offset = start;
  const fnv = new Fnv64();
  const opEnds: number[] = [];
  for (const k of keys) {
    const op = setOp(k, spec.values[k]);
    fnv.update(op);
    parts.push(op);
    offset += op.length;
    opEnds.push(offset);
  }
  const footer = concat([u32(keys.length), fnv.digest()]);
  parts.push(u32(0xffffffff), footer, u32(crc32c(footer)));
  return { bytes: concat(parts), start, opEnds };
}
