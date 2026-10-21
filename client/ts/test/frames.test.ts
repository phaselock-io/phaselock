import { describe, expect, test } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { parseFrame } from '../src/frames.js';
import { uuidBytes } from '../src/uuid.js';

const at = new Date('2026-01-02T03:04:05.678Z');
// a mutation id as a connection hands it on, and as an envelope carries it
const ID = '01234567-89ab-cdef-0123-456789abcdef';
const id = uuidBytes(ID);

describe('parseFrame', () => {
  test('edits: envelope decoded, the whole edit carried undecoded', () => {
    const edit = [[7, 'patron:p1', 3, id, at, 0], 0, 'patron:p1!name', 'Ann', 1, 'patron:p1!old'];
    const f = parseFrame(encode(['edits', [edit]]));
    if (f.tag !== 'edits') throw new Error(f.tag);
    expect(f.edits).toHaveLength(1);
    const e = f.edits[0];
    expect([e.position, e.slice, e.seq, e.id, e.servertime, e.lifecycle]).toEqual([
      7,
      'patron:p1',
      3,
      ID,
      at,
      'normal',
    ]);
    // raw is the whole edit, envelope and payload
    expect(decode(e.raw)).toEqual(edit);
  });

  test('edits: the lifecycle marker names normal, birth, and death', () => {
    const f = parseFrame(
      encode([
        'edits',
        [
          [[1, 'a', 1, id, at, 1], 0, 'a!x', 1],
          [[2, 'a', 2, id, at, 0], 0, 'a!x', 2],
          [[3, 'a', 3, id, at, 2]],
        ],
      ]),
    );
    if (f.tag !== 'edits') throw new Error(f.tag);
    expect(f.edits.map((e) => e.lifecycle)).toEqual(['birth', 'normal', 'death']);
  });

  test("edits: a mutation's edits to several slices keep their order", () => {
    const f = parseFrame(
      encode([
        'edits',
        [
          [[1, 'a', 1, id, at, 0], 0, 'a!k', 'one'],
          [[1, 'b', 1, id, at, 0], 0, 'b!k', 'two'],
          [[1, 'c', 4, id, at, 0], 1, 'c!k'],
        ],
      ]),
    );
    if (f.tag !== 'edits') throw new Error(f.tag);
    expect(f.edits.map((e) => [e.position, e.slice, e.seq])).toEqual([
      [1, 'a', 1],
      [1, 'b', 1],
      [1, 'c', 4],
    ]);
  });

  test('later protocol additions are skipped: envelope and frame elements', () => {
    const f = parseFrame(
      encode(['edits', [[[7, 's', 3, id, at, 0, 'newer', { x: 1 }], 0, 's!k', 5]], 'newer']),
    );
    if (f.tag !== 'edits') throw new Error(f.tag);
    expect([f.edits[0].slice, f.edits[0].seq]).toEqual(['s', 3]);
    expect(parseFrame(encode(['live', 1, 'newer']))).toEqual({ tag: 'live', position: 1 });
  });

  test('the other tags', () => {
    expect(parseFrame(encode(['live', 99]))).toEqual({ tag: 'live', position: 99 });
    expect(parseFrame(encode(['vouch', 100]))).toEqual({ tag: 'vouch', position: 100 });
    expect(parseFrame(encode(['view', 'tok', 12, ['a', 'b:*']]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 12,
      selectors: ['a', 'b:*'],
    });
    expect(parseFrame(encode(['view', 'tok', 0, []]))).toEqual({
      tag: 'view',
      token: 'tok',
      position: 0,
      selectors: [],
    });
    expect(parseFrame(encode(['end', 4, 'bye']))).toEqual({ tag: 'end', code: 4, reason: 'bye' });
  });

  test('rejects malformed frames', () => {
    const edits = (...edit: unknown[]) => encode(['edits', [edit]]);
    expect(() => parseFrame(encode([]))).toThrow(/empty frame/);
    expect(() => parseFrame(encode(['nope']))).toThrow(/unknown frame/);
    expect(() => parseFrame(encode(['live']))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['view', 'tok', 1]))).toThrow(/truncated/);
    expect(() => parseFrame(encode(['edits', [[]]]))).toThrow(/without an envelope/);
    expect(() => parseFrame(edits([1, 's', 1, id, at]))).toThrow(/short envelope/);
    // the lifecycle is 0, 1, or 2
    expect(() => parseFrame(edits([1, 's', 1, id, at, 3]))).toThrow(/unknown lifecycle 3/);
    expect(() => parseFrame(edits([1, 's', 1, id, at, 'birth']))).toThrow(/integer/);
    // the server time is a timestamp, never an integer
    expect(() => parseFrame(edits([1, 's', 1, id, 0, 0]))).toThrow(/timestamp/);
    // the mutation id is 16 bytes of bin, never a string or another length
    expect(() => parseFrame(edits([1, 's', 1, ID, at, 0]))).toThrow(/bin/);
    expect(() => parseFrame(edits([1, 's', 1, id.slice(1), at, 0]))).toThrow(/15 bytes/);
    expect(() => parseFrame(encode('not an array'))).toThrow(/expected msgpack array/);
  });
});
