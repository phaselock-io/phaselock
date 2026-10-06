import { describe, expect, test } from 'vitest';
import { crc32c, Fnv64 } from '../src/checksum.js';

const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('crc32c', () => {
  test('standard vectors', () => {
    expect(crc32c(new Uint8Array(0))).toBe(0);
    expect(crc32c(utf8.encode('123456789'))).toBe(0xe3069283);
    expect(crc32c(utf8.encode('a'))).toBe(0xc1d04330);
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
  });

  test('chains across pieces the way the blob checks key then value', () => {
    const key = utf8.encode('patron:p1!patron');
    const value = utf8.encode('{"name":"Ann"}');
    const whole = new Uint8Array([...key, ...value]);
    expect(crc32c(value, crc32c(key))).toBe(crc32c(whole));
  });
});

// a BigInt reference for the limb arithmetic
function fnvRef(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

describe('Fnv64', () => {
  test('standard vectors', () => {
    expect(hex(new Fnv64().digest())).toBe('cbf29ce484222325');
    const a = new Fnv64();
    a.update(utf8.encode('a'));
    expect(hex(a.digest())).toBe('af63dc4c8601ec8c');
    const f = new Fnv64();
    f.update(utf8.encode('foobar'));
    expect(hex(f.digest())).toBe('85944171f73967e8');
  });

  test('matches a BigInt reference on random input, updated in pieces', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let round = 0; round < 20; round++) {
      const n = 1 + ((rand() * 7) % 500);
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = rand();
      const f = new Fnv64();
      const cut = rand() % n;
      f.update(bytes.subarray(0, cut));
      f.update(bytes.subarray(cut));
      expect(hex(f.digest())).toBe(fnvRef(bytes));
    }
  });
});
