// The cursor and writer against @msgpack/msgpack as an oracle: every value the library encodes,
// the cursor reads back equal; every value the writer writes, byte for byte what the library
// writes; and every truncation of a value, an error.

import { describe, expect, test } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { Reader, Writer } from '../src/msgpack.js';

/** read any value with the cursor, the way the library decodes it */
function readAny(r: Reader): unknown {
  switch (r.kind()) {
    case 'nil':
      r.nil();
      return null;
    case 'bool':
      return r.bool();
    case 'int':
      return r.int();
    case 'float':
      return r.float();
    case 'str':
      return r.str();
    case 'ext':
      return r.timestamp();
    case 'array': {
      const n = r.arrayHeader();
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(readAny(r));
      return out;
    }
    case 'map': {
      const n = r.mapHeader();
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const k = r.key();
        out[k] = readAny(r);
      }
      return out;
    }
    case 'bin':
      throw new Error('bin is not a value here');
  }
}

/** write any value with the writer, the way the library encodes it */
function writeAny(w: Writer, v: unknown): void {
  if (v === null) return w.nil();
  if (typeof v === 'boolean') return w.bool(v);
  if (typeof v === 'number') return Number.isSafeInteger(v) ? w.int(v) : w.float64(v);
  if (typeof v === 'string') return w.str(v);
  if (v instanceof Date) return w.timestamp(v);
  if (Array.isArray(v)) {
    w.arrayHeader(v.length);
    for (const x of v) writeAny(w, x);
    return;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  w.mapHeader(entries.length);
  for (const [k, x] of entries) {
    w.str(k);
    writeAny(w, x);
  }
}

function written(v: unknown): Uint8Array {
  const w = new Writer();
  writeAny(w, v);
  return w.bytes();
}

// a seeded generator, so a failure reproduces
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const ints = [
  0,
  1,
  0x7f,
  0x80,
  0xff,
  0x100,
  0xffff,
  0x10000,
  0xffffffff,
  0x100000000,
  2 ** 40,
  2 ** 53 - 1,
  -1,
  -0x20,
  -0x21,
  -0x80,
  -0x81,
  -0x8000,
  -0x8001,
  -(2 ** 31),
  -(2 ** 31) - 1,
  -(2 ** 40),
  -(2 ** 53 - 1),
];
const floats = [0.5, -0.5, 1.5, 1e300, -1e-300, Math.PI, 2 ** 53 + 2, Infinity, -Infinity];
const strLengths = [0, 1, 15, 16, 31, 32, 50, 51, 200, 201, 255, 256, 65535, 65536];
const texts = ['a', 'é', '図', '😀', 'ab😀cd', '\u0000', '\ud800', 'x\udc00y'];
const dates = [
  new Date(0),
  new Date('2026-01-02T03:04:05Z'),
  new Date('2026-01-02T03:04:05.678Z'),
  new Date('1960-06-07T08:09:10.123Z'),
  new Date('2106-02-07T06:28:16Z'),
  new Date('2600-01-01T00:00:00.001Z'),
  new Date(-1),
];

function randomString(rand: () => number): string {
  const n = Math.floor(rand() * 40);
  let s = '';
  for (let i = 0; i < n; i++) s += texts[Math.floor(rand() * texts.length)];
  return s;
}

function randomValue(rand: () => number, depth = 0): unknown {
  const pick = Math.floor(rand() * (depth > 2 ? 7 : 9));
  switch (pick) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return ints[Math.floor(rand() * ints.length)];
    case 3:
      return floats[Math.floor(rand() * floats.length)];
    case 4:
      return randomString(rand);
    case 5:
      return dates[Math.floor(rand() * dates.length)];
    case 6:
      return Math.floor((rand() - 0.5) * 2 ** 40);
    case 7:
      return Array.from({ length: Math.floor(rand() * 8) }, () => randomValue(rand, depth + 1));
    default: {
      const out: Record<string, unknown> = {};
      const n = Math.floor(rand() * 8);
      for (let i = 0; i < n; i++) out[randomString(rand) || `k${i}`] = randomValue(rand, depth + 1);
      return out;
    }
  }
}

const scalars: unknown[] = [
  null,
  true,
  false,
  ...ints,
  ...floats,
  ...strLengths.map((n) => 'z'.repeat(n)),
  ...strLengths.map((n) => '図'.repeat(n)),
  ...texts,
  ...dates,
];
const containers: unknown[] = [
  [],
  {},
  ...[15, 16, 65535, 65536].map((n) => new Array(n).fill(1)),
  ...[15, 16, 65536].map((n) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])),
  ),
];

describe('the cursor reads what the library writes', () => {
  test.each(scalars.map((v) => [v]))('%s', (v) => {
    const bytes = encode(v);
    const r = new Reader(bytes);
    expect(readAny(r)).toEqual(decode(bytes));
    expect(r.done).toBe(true);
  });

  test('containers, every header width', () => {
    for (const v of containers) {
      const bytes = encode(v);
      expect(readAny(new Reader(bytes))).toEqual(decode(bytes));
    }
  });

  test('randomized values', () => {
    const rand = rng(0x5eed);
    for (let i = 0; i < 2000; i++) {
      const bytes = encode(randomValue(rand));
      expect(readAny(new Reader(bytes))).toEqual(decode(bytes));
    }
  });

  test('a repeated key reads the same through the key cache', () => {
    const bytes = encode([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ]);
    expect(readAny(new Reader(bytes))).toEqual(decode(bytes));
  });
});

describe('the writer writes what the library writes', () => {
  test.each(scalars.map((v) => [v]))('%s', (v) => {
    expect(written(v)).toEqual(encode(v));
  });

  test('containers, every header width', () => {
    for (const v of containers) expect(written(v)).toEqual(encode(v));
  });

  test('randomized values', () => {
    const rand = rng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const v = randomValue(rand);
      expect(written(v)).toEqual(encode(v));
    }
  });
});

describe('a truncated value is an error', () => {
  test('every cut of every scalar and of randomized values', () => {
    const rand = rng(0xbad);
    const values = [...scalars.filter((v) => typeof v !== 'string' || v.length < 300)];
    for (let i = 0; i < 200; i++) values.push(randomValue(rand));
    for (const v of values) {
      const bytes = encode(v);
      if (bytes.length > 4000) continue;
      for (let cut = 0; cut < bytes.length; cut++) {
        expect(() => readAny(new Reader(bytes.subarray(0, cut)))).toThrow();
      }
    }
  });
});

describe('timestamps the library writes but the cursor refuses', () => {
  test('a nanosecond count past a second', () => {
    const bytes = Uint8Array.of(0xd7, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0);
    expect(() => new Reader(bytes).timestamp()).toThrow(/malformed/);
  });

  test('a timestamp extension of no valid size', () => {
    const bytes = Uint8Array.of(0xc7, 5, 0xff, 0, 0, 0, 0, 0);
    expect(() => new Reader(bytes).timestamp()).toThrow(/timestamp/);
  });
});
