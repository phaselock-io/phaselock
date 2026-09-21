import { describe, expect, test } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { ByteReader } from '../src/bytes.js';
import { frames, parseFrame } from '../src/frames.js';

function stream(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
}

function join(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

describe('ByteReader', () => {
  const body = join([
    encode(['vouch', 1]),
    encode(['events', [[[1, 's', 1, 'i', 0], 'x'.repeat(100000)]]]),
    encode(['end', 0, '']),
  ]);

  test.each([1, 7, 1000, 65536, 1 << 20])(
    'yields whole values across %d-byte chunks',
    async (chunk) => {
      const br = new ByteReader(stream(body, chunk), 10);
      const tags: string[] = [];
      let refills = 0;
      for (;;) {
        let v: Uint8Array | null;
        while ((v = br.tryValue()) !== null) tags.push(parseFrame(v).tag);
        if (!(await br.more())) break;
        refills++;
      }
      expect(tags).toEqual(['vouch', 'events', 'end']);
      expect(br.available).toBe(0);
      expect(br.offset).toBe(10 + body.length);
      // awaits track chunks, never values
      expect(refills).toBeLessThanOrEqual(Math.ceil(body.length / chunk));
    },
  );

  test('fill, take, and skipBytes across a chunk boundary, with offsets', async () => {
    const br = new ByteReader(stream(body, 5));
    await br.fill(3);
    expect(br.take(3)).toEqual(body.subarray(0, 3));
    expect(() => br.take(3)).toThrow(/past the buffer/);
    await br.skipBytes(4);
    expect(br.offset).toBe(7);
    await br.fill(2);
    expect(br.take(2)).toEqual(body.subarray(7, 9));
    await br.fill(20);
    expect(br.available).toBeGreaterThanOrEqual(20);
  });

  test('grows past its initial buffer for a value larger than it', async () => {
    const big = encode('y'.repeat(300 * 1024));
    const br = new ByteReader(stream(big, 16 * 1024));
    let v: Uint8Array | null = null;
    while ((v = br.tryValue()) === null) expect(await br.more()).toBe(true);
    expect(v.length).toBe(big.length);
  });

  test('fill past the end throws; more reports EOF once', async () => {
    const br = new ByteReader(stream(body, 100));
    await expect(br.fill(body.length + 1)).rejects.toThrow(/ended early/);
    expect(await br.more()).toBe(false);
    expect(await br.more()).toBe(false);
  });

  test('take returns a view that is valid until the next refill', async () => {
    const br = new ByteReader(stream(body, 3));
    await br.fill(2);
    const view = br.take(2);
    expect(view).toEqual(body.subarray(0, 2));
  });
});

describe('frames', () => {
  test('drains buffered frames synchronously and ends cleanly at EOF', async () => {
    const body = join([encode(['live', 5]), encode(['vouch', 6]), encode(['vouch', 7])]);
    const seen: string[] = [];
    await frames(new ByteReader(stream(body, 1 << 16)), (f) => {
      seen.push(f.tag);
      return true;
    });
    expect(seen).toEqual(['live', 'vouch', 'vouch']);
  });

  test('stops when the callback returns false', async () => {
    const body = join([encode(['end', 1, 'bye']), encode(['vouch', 6])]);
    const seen: string[] = [];
    await frames(new ByteReader(stream(body, 1 << 16)), (f) => {
      seen.push(f.tag);
      return f.tag !== 'end';
    });
    expect(seen).toEqual(['end']);
  });

  test('a body that ends mid-frame is an error', async () => {
    const b = encode(['vouch', 1000000]);
    await expect(
      frames(new ByteReader(stream(b.subarray(0, b.length - 1), 2)), () => true),
    ).rejects.toThrow(/mid-frame/);
  });
});
