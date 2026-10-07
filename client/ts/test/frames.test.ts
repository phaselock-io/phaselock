import { describe, expect, test } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { parseFrame } from '../src/frames.js';
import { uuidBytes } from '../src/uuid.js';

const at = new Date('2026-01-02T03:04:05.678Z');
// a command id as a connector hands it on, and as an envelope carries it
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const id = uuidBytes(ID);

describe('parseFrame', () => {
  test('events: envelope decoded, data sliced out undecoded', () => {
    const f = parseFrame(
      encode(['events', [[[7, 'patron:p1', 3, id, at], { type: 'x', n: [1, 2] }]]]),
    );
    if (f.tag !== 'events') throw new Error(f.tag);
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    expect([e.position, e.stream, e.seq, e.id, e.servertime]).toEqual([7, 'patron:p1', 3, ID, at]);
    expect(decode(e.data)).toEqual({ type: 'x', n: [1, 2] });
    // raw is the whole pair, and data is a view into it
    expect(decode(e.raw)).toEqual([[7, 'patron:p1', 3, id, at], { type: 'x', n: [1, 2] }]);
    expect(e.data.buffer).toBe(e.raw.buffer);
  });

  test('events: several events in one atom keep their order', () => {
    const f = parseFrame(
      encode([
        'events',
        [
          [[1, 'a', 1, id, at], 'one'],
          [[2, 'b', 1, id, at], 'two'],
          [[3, 'a', 2, id, at], 'three'],
        ],
      ]),
    );
    if (f.tag !== 'events') throw new Error(f.tag);
    expect(f.events.map((e) => [e.position, e.stream, decode(e.data)])).toEqual([
      [1, 'a', 'one'],
      [2, 'b', 'two'],
      [3, 'a', 'three'],
    ]);
  });

  test('later protocol additions are skipped: envelope, event pair, and frame elements', () => {
    const f = parseFrame(
      encode(['events', [[[7, 's', 3, id, at, 'newer', { x: 1 }], 5, 'newer']], 'newer']),
    );
    if (f.tag !== 'events') throw new Error(f.tag);
    expect(decode(f.events[0].data)).toBe(5);
    expect(parseFrame(encode(['live', 1, 'newer']))).toEqual({ tag: 'live', position: 1 });
  });

  test('the other tags', () => {
    expect(parseFrame(encode(['live', 99]))).toEqual({ tag: 'live', position: 99 });
    expect(parseFrame(encode(['vouch', 100]))).toEqual({ tag: 'vouch', position: 100 });
    expect(parseFrame(encode(['view', 'tok', 12, ['a', 'b:*']]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 12,
      refs: ['a', 'b:*'],
    });
    expect(parseFrame(encode(['view', 'tok', 0, []]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 0,
      refs: [],
    });
    expect(parseFrame(encode(['end', 4, 'bye']))).toEqual({ tag: 'end', code: 4, reason: 'bye' });
  });

  test('rejects malformed frames', () => {
    expect(() => parseFrame(encode([]))).toThrow(/empty frame/);
    expect(() => parseFrame(encode(['nope']))).toThrow(/unknown frame/);
    expect(() => parseFrame(encode(['live']))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['view', 'tok', 1]))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, id], 'x']]]))).toThrow(
      /short envelope/,
    );
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, id, at]]]]))).toThrow(/without data/);
    // the server time is a timestamp, never an integer
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, id, 0], 'x']]]))).toThrow(/timestamp/);
    // the command id is 16 bytes of bin, never a string or another length
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, ID, at], 'x']]]))).toThrow(/bin/);
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, id.slice(1), at], 'x']]]))).toThrow(
      /15 bytes/,
    );
    expect(() => parseFrame(encode('not an array'))).toThrow(/expected msgpack array/);
  });
});
