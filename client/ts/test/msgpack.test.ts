import { describe, expect, test } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { measure, Reader, Writer } from '../src/msgpack.js';

// every msgpack type tag, produced by the real encoder where it can and by hand otherwise
const ints = [0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 40, 2 ** 53 - 1];
const negs = [-1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1, -(2 ** 40)];
const strs = [0, 1, 31, 32, 255, 256, 65535, 65536].map((n) => 'x'.repeat(n));
const bins = [0, 1, 255, 256, 65535, 65536].map((n) => new Uint8Array(n).fill(7));
const arrays = [0, 1, 15, 16, 65535, 65536].map((n) => new Array(n).fill(null));
const maps = [0, 1, 15, 16, 65536].map((n) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i])),
);
const misc = [null, true, false, 1.5, -0.25, 1e300, 'héllo wörld', [1, [2, [3, { a: [] }]]]];
const byHand: [string, Uint8Array][] = [
  ['float32', Uint8Array.of(0xca, 0x3f, 0xc0, 0x00, 0x00)],
  ['fixext1', Uint8Array.of(0xd4, 1, 9)],
  ['fixext2', Uint8Array.of(0xd5, 1, 9, 9)],
  ['fixext4', Uint8Array.of(0xd6, 1, 9, 9, 9, 9)],
  ['fixext8', new Uint8Array([0xd7, 1, ...new Array(8).fill(9)])],
  ['fixext16', new Uint8Array([0xd8, 1, ...new Array(16).fill(9)])],
  ['ext8', Uint8Array.of(0xc7, 3, 1, 9, 9, 9)],
  ['ext16', new Uint8Array([0xc8, 1, 0, 1, ...new Array(256).fill(9)])],
  ['ext32', new Uint8Array([0xc9, 0, 1, 0, 0, 1, ...new Array(65536).fill(9)])],
];

describe('measure', () => {
  const encoded: [string, Uint8Array][] = [
    ...[...ints, ...negs, ...strs, ...bins, ...arrays, ...maps, ...misc].map(
      (v): [string, Uint8Array] => [JSON.stringify(v)?.slice(0, 30) ?? typeof v, encode(v)],
    ),
    ...byHand,
  ];

  test.each(encoded)('measures %s to its full length', (_name, bytes) => {
    expect(measure(bytes, 0, bytes.length)).toBe(bytes.length);
  });

  test.each(encoded)('reports %s incomplete at every shorter cut', (_name, bytes) => {
    // long values: sample cuts; short ones: every cut
    const step = Math.max(1, Math.floor(bytes.length / 64));
    for (let cut = 0; cut < bytes.length; cut += step) {
      expect(measure(bytes, 0, cut)).toBe(-1);
    }
    expect(measure(bytes, 0, bytes.length - 1)).toBe(-1);
  });

  test('measures a value inside a larger buffer from an offset', () => {
    const a = encode([1, 2]);
    const b = encode('after');
    const buf = new Uint8Array([...a, ...b, 0xff]);
    expect(measure(buf, 0, buf.length)).toBe(a.length);
    expect(measure(buf, a.length, buf.length)).toBe(a.length + b.length);
  });

  test('rejects the unused byte 0xc1', () => {
    expect(() => measure(Uint8Array.of(0xc1), 0, 1)).toThrow(/invalid msgpack/);
  });

  test('is iterative: deep nesting does not overflow', () => {
    let v: unknown = 0;
    for (let i = 0; i < 100000; i++) v = [v];
    // the stock encoder recurses, so build the bytes by hand: 100000 fixarray(1) headers then 0
    const bytes = new Uint8Array(100001).fill(0x91);
    bytes[100000] = 0;
    expect(measure(bytes, 0, bytes.length)).toBe(bytes.length);
  });
});

describe('Reader', () => {
  test.each([...ints, ...negs])('reads integer %d', (n) => {
    expect(new Reader(encode(n)).int()).toBe(n);
  });

  test.each(strs.map((s) => s.length))('reads a string of length %d', (n) => {
    expect(new Reader(encode('y'.repeat(n))).str()).toBe('y'.repeat(n));
  });

  test.each(arrays.map((a) => a.length))('reads an array header of %d', (n) => {
    expect(new Reader(encode(new Array(n).fill(0))).arrayHeader()).toBe(n);
  });

  test.each(maps.map((m) => Object.keys(m).length))('reads a map header of %d', (n) => {
    const m = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 0]));
    expect(new Reader(encode(m)).mapHeader()).toBe(n);
  });

  test('reads utf-8', () => {
    expect(new Reader(encode('héllo wörld ✓')).str()).toBe('héllo wörld ✓');
  });

  test('refuses the wrong shape', () => {
    expect(() => new Reader(encode('s')).int()).toThrow(/expected msgpack integer/);
    expect(() => new Reader(encode(1)).str()).toThrow(/expected msgpack string/);
    expect(() => new Reader(encode({})).arrayHeader()).toThrow(/expected msgpack array/);
    expect(() => new Reader(encode([])).mapHeader()).toThrow(/expected msgpack map/);
  });

  test('refuses truncated input', () => {
    const b = encode('x'.repeat(40));
    expect(() => new Reader(b.subarray(0, 10)).str()).toThrow(/truncated/);
    expect(() => new Reader(b.subarray(0, 10)).skip()).toThrow(/truncated/);
    expect(() => new Reader(b.subarray(0, 10)).raw()).toThrow(/truncated/);
    expect(() => new Reader(new Uint8Array(0)).int()).toThrow(/truncated/);
  });

  test('skip and raw walk any value, and raw round-trips through the real decoder', () => {
    const values = [...misc, ...bins.slice(0, 3), { deep: [maps[3], strs[4]] }];
    const buf = encode(values);
    const r = new Reader(buf);
    expect(r.arrayHeader()).toBe(values.length);
    for (const v of values) {
      const raw = r.raw();
      expect(decode(raw)).toEqual(v);
    }
    expect(r.done).toBe(true);
    const s = new Reader(buf);
    s.arrayHeader();
    for (let i = 0; i < values.length; i++) s.skip();
    expect(s.done).toBe(true);
  });

  test('raw returns a copy, not a view', () => {
    const buf = encode([1]);
    const raw = new Reader(buf).raw();
    raw[0] = 0;
    expect(buf[0]).toBe(0x91);
  });
});

describe('Writer', () => {
  test.each([0, 1, 15, 16, 255, 65535, 65536])('array header of %d matches the encoder', (n) => {
    const w = new Writer();
    w.arrayHeader(n);
    const expected = encode(new Array(n).fill(null));
    expect(w.bytes()).toEqual(expected.subarray(0, expected.length - n));
  });

  test.each(strs.map((s) => s.length))('string of length %d matches the encoder', (n) => {
    const w = new Writer();
    w.str('z'.repeat(n));
    expect(w.bytes()).toEqual(encode('z'.repeat(n)));
  });

  test('splices pre-encoded values into a frame the decoder accepts', () => {
    const w = new Writer();
    w.arrayHeader(2);
    w.str('cmd-1');
    w.raw(encode({ type: 'add', n: 1 }));
    w.arrayHeader(2);
    w.str('cmd-2');
    w.raw(encode([1, 2, 3]));
    const bytes = w.bytes();
    const first = measure(bytes, 0, bytes.length);
    expect(decode(bytes.subarray(0, first))).toEqual(['cmd-1', { type: 'add', n: 1 }]);
    expect(decode(bytes.subarray(first))).toEqual(['cmd-2', [1, 2, 3]]);
  });
});
