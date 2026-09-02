/**
 * Behavioral test of the emitted TypeScript checkers.
 *
 * This runs the actual generated code: `pnpm gen` compiles fixtures/main.tsp through the TS
 * emitter into tsp-output/, and the assertions below feed plain JSON values to the checkX
 * functions and inspect the returned list of problem strings.  Checkers validate structure and
 * discriminate unions; a valid value yields [], a malformed one yields one or more problems.
 */

import { describe, expect, it } from 'vitest';

import * as M from '../../tsp-output/@phaselock/typespec-ts/fixtures.gen.ts';

const ISO = '2024-01-02T03:04:05Z';
const ISO_MS = '2020-06-07T08:09:10.123Z';

/** assert the checker accepts `value` (no problems) */
function ok(fn: (val: any) => string[], value: any): void {
  expect(fn(value)).toEqual([]);
}

/** assert the checker rejects `value`, optionally with a problem containing `needle` */
function fails(fn: (val: any) => string[], value: any, needle?: string): void {
  const problems = fn(value);
  expect(problems).not.toEqual([]);
  if (needle !== undefined) expect(problems.join('\n')).toContain(needle);
}

describe('plain / scalar structs', () => {
  it('accepts a well-formed struct', () => {
    ok(M.checkPlain, { id: 'x', n: 7, flag: true });
  });

  it('rejects wrong field types, missing keys, and non-objects', () => {
    fails(M.checkPlain, { id: 1, n: 7, flag: true }, 'not string');
    fails(M.checkPlain, { id: 'x', n: '7', flag: true }, 'not int');
    fails(M.checkPlain, { id: 'x', n: 7.5, flag: true }, 'not int');
    fails(M.checkPlain, { id: 'x', n: 7, flag: 1 }, 'not bool');
    fails(M.checkPlain, { id: 'x', n: 7 }, 'missing required key flag');
    fails(M.checkPlain, ['not', 'an', 'object'], 'not json object');
    fails(M.checkPlain, null, 'not json object');
  });

  it('rejects extra keys', () => {
    fails(M.checkPlain, { id: 'x', n: 7, flag: true, surprise: 1 }, 'contains extra keys');
  });
});

describe('dates', () => {
  it('accepts both ISO formats, with the optional field absent or present', () => {
    ok(M.checkTimed, { at: ISO });
    ok(M.checkTimed, { at: ISO_MS, note: ISO });
  });

  it('rejects bad, out-of-range, and missing dates', () => {
    fails(M.checkTimed, { at: 'nope' }, 'invalid timestamp');
    fails(M.checkTimed, { at: 1704164645 }, 'invalid timestamp');
    fails(M.checkTimed, { at: '2024-13-02T03:04:05Z' }, 'invalid timestamp');
    fails(M.checkTimed, { note: ISO }, 'missing required key at');
  });
});

describe('nested / collections', () => {
  it('recurses into inner structs', () => {
    ok(M.checkNested, { inner: { at: ISO }, tags: ['a', 'b'], count: 3 });
    fails(M.checkNested, { inner: { at: 'bad' }, tags: [], count: 3 }, 'invalid timestamp');
  });

  it('checks array elements', () => {
    fails(M.checkNested, { inner: { at: ISO }, tags: ['a', 2], count: 3 }, 'not string');
    fails(M.checkNested, { inner: { at: ISO }, tags: 'ab', count: 3 }, 'not json array');
  });

  it('checks record values', () => {
    ok(M.checkWithRecord, { meta: { a: 1, b: 2 } });
    fails(M.checkWithRecord, { meta: { a: 'one' } }, 'not int');
  });

  it('checks date record values', () => {
    ok(M.checkWithDateRecord, { stamps: { a: ISO, b: ISO_MS } });
    fails(M.checkWithDateRecord, { stamps: { a: 'nope' } }, 'invalid timestamp');
    fails(M.checkWithDateRecord, { stamps: { a: 123 } }, 'invalid timestamp');
    fails(M.checkWithDateRecord, { stamps: 'x' }, 'not json object');
  });

  it('checks tuple shape and elements', () => {
    ok(M.checkWithTuple, { pair: ['label', ISO] });
    fails(M.checkWithTuple, { pair: ['label'] }, 'expected 2 items');
    fails(M.checkWithTuple, { pair: [5, ISO] }, 'not string');
    fails(M.checkWithTuple, { pair: ['label', 'nope'] }, 'invalid timestamp');
    fails(M.checkWithTuple, { pair: 'notlist' }, 'not json array');
  });
});

describe('discriminated union (by `type`)', () => {
  it('discriminates on type', () => {
    ok(M.checkGreek, { type: 'alpha', a: 1 });
    ok(M.checkGreek, { type: 'beta', at: ISO });
  });

  it('rejects a bad discriminator', () => {
    fails(M.checkGreek, { a: 1 }, 'missing discriminator "type"');
    fails(M.checkGreek, { type: 'gamma' }, 'unexpected value');
    fails(M.checkGreek, 'not an object', 'not allowed here');
  });
});

describe('sub-discriminated union (by `[type, v]`)', () => {
  it('splits on type, then on v within the shared-type bucket', () => {
    ok(M.checkVersioned, { type: 'va', v: 1, a: 9 });
    ok(M.checkVersioned, { type: 'va', v: 2, at: ISO });
    ok(M.checkVersioned, { type: 'vb', v: 1, b: 'z' });
  });

  it('rejects a bad sub-discriminator', () => {
    // reads `v` off the object, not the extracted `type` string
    fails(M.checkVersioned, { type: 'va', v: 99, a: 1 }, 'unexpected value');
    fails(M.checkVersioned, { type: 'va', v: true, a: 1 }, 'unexpected value');
    fails(M.checkVersioned, { type: 'va', a: 1 }, 'missing discriminator "v"');
    fails(M.checkVersioned, { type: 'vc' }, 'unexpected value');
  });
});

describe('one-of union (by present key)', () => {
  it('detects the present key', () => {
    ok(M.checkTarget, { book: 'b1' });
    ok(M.checkTarget, { at: ISO });
  });

  it('rejects when no member key is present', () => {
    fails(M.checkTarget, { nope: 1 }, 'no matching keys found');
    fails(M.checkTarget, 5, 'not allowed here');
  });
});

describe('literal unions', () => {
  it('checks string and int literal unions', () => {
    ok(M.checkColor, 'green');
    fails(M.checkColor, 'purple', 'unexpected value');
    fails(M.checkColor, 3, 'not allowed here');
    ok(M.checkLevel, 2);
    fails(M.checkLevel, 9, 'unexpected value');
    fails(M.checkLevel, '2', 'not allowed here');
  });
});

describe('bool literals', () => {
  it('checks bool-literal fields exactly', () => {
    ok(M.checkToggled, { on: true });
    fails(M.checkToggled, { on: 1 }, 'is not true');
    fails(M.checkToggled, { on: false }, 'is not true');
  });
});

describe('engine event / command unions', () => {
  it('checks events and commands through their unions', () => {
    ok(M.checkEvents, { type: 'beta', at: ISO });
    ok(M.checkEvents, { type: 'other' });
    fails(M.checkEvents, { type: 'nope' }, 'unexpected value');
    ok(M.checkCommands, { type: 'do-thing', when: ISO });
    ok(M.checkCommands, { type: 'undo' });
    fails(M.checkCommands, { type: 'nope' }, 'unexpected value');
  });
});
