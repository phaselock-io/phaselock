// Builds version-1 snapshot blobs for tests, per db/README.md.

import { encode } from '@msgpack/msgpack';
import { crc32c, Fnv64 } from '../src/checksum.js';

const utf8 = new TextEncoder();

function u32(n: number): Uint8Array {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export type BlobSpec = {
  ref: string;
  position: number;
  streams: Record<string, number>;
  // sorted by key by the builder
  records: Record<string, unknown>;
};

/** blob builds a blob; recordEnds are the byte offsets after each record, for resume tests */
export function blob(spec: BlobSpec): { bytes: Uint8Array; recordEnds: number[] } {
  const keys = Object.keys(spec.records).sort();
  const header = encode({
    ref: spec.ref,
    position: spec.position,
    fold: 1,
    count: keys.length,
    streams: spec.streams,
  });
  const parts: Uint8Array[] = [
    utf8.encode('PLSN'),
    Uint8Array.of(1),
    u32(header.length),
    header,
    u32(crc32c(header)),
  ];
  let offset = parts.reduce((n, p) => n + p.length, 0);
  const fnv = new Fnv64();
  const recordEnds: number[] = [];
  for (const k of keys) {
    const key = utf8.encode(k);
    const value = encode(spec.records[k]);
    const record = concat([
      u32(key.length),
      key,
      u32(value.length),
      value,
      u32(crc32c(value, crc32c(key))),
    ]);
    fnv.update(record);
    parts.push(record);
    offset += record.length;
    recordEnds.push(offset);
  }
  const footer = concat([u32(keys.length), fnv.digest()]);
  parts.push(u32(0xffffffff), footer, u32(crc32c(footer)));
  return { bytes: concat(parts), recordEnds };
}
