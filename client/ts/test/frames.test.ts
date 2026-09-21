import { describe, expect, test } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { parseFrame } from '../src/frames.js';

describe('parseFrame', () => {
  test('events: envelope decoded, data sliced out undecoded', () => {
    const f = parseFrame(
      encode(['events', [[[7, 'patron.p1', 3, 'id-1', 1700000000000], { type: 'x', n: [1, 2] }]]]),
    );
    if (f.tag !== 'events') throw new Error(f.tag);
    expect(f.events).toHaveLength(1);
    const e = f.events[0];
    expect([e.position, e.stream, e.seq, e.id, e.servertime]).toEqual([
      7,
      'patron.p1',
      3,
      'id-1',
      1700000000000,
    ]);
    expect(decode(e.data)).toEqual({ type: 'x', n: [1, 2] });
  });

  test('events: several events in one atom keep their order', () => {
    const f = parseFrame(
      encode([
        'events',
        [
          [[1, 'a', 1, 'i', 0], 'one'],
          [[2, 'b', 1, 'i', 0], 'two'],
          [[3, 'a', 2, 'i', 0], 'three'],
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
      encode(['events', [[[7, 's', 3, 'id', 1, 'newer', { x: 1 }], 5, 'newer']], 'newer']),
    );
    if (f.tag !== 'events') throw new Error(f.tag);
    expect(decode(f.events[0].data)).toBe(5);
    expect(parseFrame(encode(['live', 1, 'newer']))).toEqual({ tag: 'live', position: 1 });
  });

  test('the other tags', () => {
    expect(parseFrame(encode(['live', 99]))).toEqual({ tag: 'live', position: 99 });
    expect(parseFrame(encode(['vouch', 100]))).toEqual({ tag: 'vouch', position: 100 });
    expect(parseFrame(encode(['view', 'tok', 12, ['a'], ['b', 'c']]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 12,
      grants: ['a'],
      revokes: ['b', 'c'],
    });
    expect(parseFrame(encode(['view', 'tok', 0, [], []]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 0,
      grants: [],
      revokes: [],
    });
    expect(parseFrame(encode(['end', 4, 'bye']))).toEqual({ tag: 'end', code: 4, reason: 'bye' });
  });

  test('rejects malformed frames', () => {
    expect(() => parseFrame(encode([]))).toThrow(/empty frame/);
    expect(() => parseFrame(encode(['nope']))).toThrow(/unknown frame/);
    expect(() => parseFrame(encode(['live']))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['view', 'tok', 1, ['a']]))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, 'i'], 'x']]]))).toThrow(
      /short envelope/,
    );
    expect(() => parseFrame(encode(['events', [[[1, 's', 1, 'i', 0]]]]))).toThrow(/without data/);
    expect(() => parseFrame(encode('not an array'))).toThrow(/expected msgpack array/);
  });
});
