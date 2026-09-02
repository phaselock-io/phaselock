/**
 * Solver unit tests: build interned PTypes directly and assert the shape of the solution tree
 * that solveUnion() produces for each discrimination strategy.  No TypeSpec compiler involved —
 * these exercise solver.ts and ptypes.ts in isolation.
 */

import {
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  GetField,
  GetIndex,
  HasField,
  Match,
  members,
  PType,
  PTypeRegistry,
  Solution,
  solveUnion,
} from '@phaselock/typespec-core';
import { describe, expect, it } from 'vitest';

/** Solve a union of the given members, returning the top-level CheckJsonType. */
function solve(r: PTypeRegistry, types: PType[]): CheckJsonType {
  return solveUnion(r, members(r.union(types)));
}

/** Assert a solution is a Match on the expected type and return it. */
function expectMatch(s: Solution | undefined, t: PType): void {
  expect(s).toBeInstanceOf(Match);
  expect((s as Match).typ).toBe(t);
}

describe('solveUnion — json-type layer', () => {
  it('routes distinct json types to a single Match each', () => {
    const r = new PTypeRegistry();
    const sln = solve(r, [r.int(), r.string()]);
    expect(sln).toBeInstanceOf(CheckJsonType);
    expect([...sln.options.keys()].sort()).toEqual(['int', 'string']);
    expectMatch(sln.options.get('int'), r.int());
    expectMatch(sln.options.get('string'), r.string());
  });

  it('dispatches a mix of literal bucket and struct across json types', () => {
    const r = new PTypeRegistry();
    const a = r.struct([['n', r.int(), false]]);
    const sln = solve(r, [r.literal('x'), r.literal('y'), a]);
    // string bucket has two literals -> CheckLiteral; object bucket has one struct -> Match
    const str = sln.options.get('string');
    expect(str).toBeInstanceOf(CheckLiteral);
    expect([...(str as CheckLiteral).options.keys()].sort()).toEqual(['x', 'y']);
    expectMatch(sln.options.get('object'), a);
  });
});

describe('solveUnion — literal buckets', () => {
  it('solves a union of string literals', () => {
    const r = new PTypeRegistry();
    const a = r.literal('a');
    const b = r.literal('b');
    const lit = solve(r, [a, b]).options.get('string');
    expect(lit).toBeInstanceOf(CheckLiteral);
    expectMatch((lit as CheckLiteral).options.get('a'), a);
    expectMatch((lit as CheckLiteral).options.get('b'), b);
  });

  it("solves a union of int literals (bucketed under 'int', not 'integer')", () => {
    const r = new PTypeRegistry();
    const one = r.literal(1);
    const two = r.literal(2);
    const sln = solve(r, [one, two]);
    const lit = sln.options.get('int');
    expect(lit).toBeInstanceOf(CheckLiteral);
    expectMatch((lit as CheckLiteral).options.get(1), one);
    expectMatch((lit as CheckLiteral).options.get(2), two);
  });

  it('solves a union of boolean literals', () => {
    const r = new PTypeRegistry();
    const t = r.literal(true);
    const f = r.literal(false);
    const lit = solve(r, [t, f]).options.get('boolean');
    expect(lit).toBeInstanceOf(CheckLiteral);
    expectMatch((lit as CheckLiteral).options.get(true), t);
    expectMatch((lit as CheckLiteral).options.get(false), f);
  });
});

describe('solveUnion — struct discrimination', () => {
  it("discriminates on a common literal 'type' key", () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['type', r.literal('a'), false],
      ['x', r.int(), false],
    ]);
    const b = r.struct([
      ['type', r.literal('b'), false],
      ['y', r.string(), false],
    ]);
    const obj = solve(r, [a, b]).options.get('object');
    expect(obj).toBeInstanceOf(GetField);
    expect((obj as GetField).key).toBe('type');
    const lit = (obj as GetField).solution;
    expect(lit).toBeInstanceOf(CheckLiteral);
    expectMatch((lit as CheckLiteral).options.get('a'), a);
    expectMatch((lit as CheckLiteral).options.get('b'), b);
  });

  it('recurses into a [type, v] sub-discriminator', () => {
    const r = new PTypeRegistry();
    const a1 = r.struct([
      ['type', r.literal('a'), false],
      ['v', r.literal(1), false],
      ['x', r.int(), false],
    ]);
    const a2 = r.struct([
      ['type', r.literal('a'), false],
      ['v', r.literal(2), false],
      ['y', r.string(), false],
    ]);
    const b = r.struct([
      ['type', r.literal('b'), false],
      ['v', r.literal(1), false],
      ['z', r.bool(), false],
    ]);
    const obj = solve(r, [a1, a2, b]).options.get('object') as GetField;
    expect(obj.key).toBe('type');
    const byType = obj.solution as CheckLiteral;
    // "b" resolves directly; "a" needs a further split on "v"
    expectMatch(byType.options.get('b'), b);
    const byV = byType.options.get('a') as GetField;
    expect(byV).toBeInstanceOf(GetField);
    expect(byV.key).toBe('v');
    const vlit = byV.solution as CheckLiteral;
    expectMatch(vlit.options.get(1), a1);
    expectMatch(vlit.options.get(2), a2);
  });

  it('solves a one-of union via HasField (each member has a single distinct key)', () => {
    const r = new PTypeRegistry();
    const book = r.struct([['book', r.int(), false]]);
    const edition = r.struct([['edition', r.string(), false]]);
    const obj = solve(r, [book, edition]).options.get('object');
    expect(obj).toBeInstanceOf(HasField);
    const entries = new Map((obj as HasField).solutions);
    expectMatch(entries.get('book'), book);
    expectMatch(entries.get('edition'), edition);
  });

  it('discriminates single-key members sharing the key by their literal values', () => {
    const r = new PTypeRegistry();
    const yes = r.struct([['key', r.literal(true), false]]);
    const no = r.struct([['key', r.literal(false), false]]);
    const obj = solve(r, [yes, no]).options.get('object');
    expect(obj).toBeInstanceOf(GetField);
    expect((obj as GetField).key).toBe('key');
    const lit = (obj as GetField).solution as CheckLiteral;
    expectMatch(lit.options.get(true), yes);
    expectMatch(lit.options.get(false), no);
  });

  it('solves a one-of union whose groups need a further literal split', () => {
    const r = new PTypeRegistry();
    const aTrue = r.struct([['a', r.literal(true), false]]);
    const aFalse = r.struct([['a', r.literal(false), false]]);
    const b = r.struct([['b', r.int(), false]]);
    const obj = solve(r, [aTrue, aFalse, b]).options.get('object');
    expect(obj).toBeInstanceOf(HasField);
    const entries = new Map((obj as HasField).solutions);
    expectMatch(entries.get('b'), b);
    const byA = entries.get('a') as GetField;
    expect(byA).toBeInstanceOf(GetField);
    expect(byA.key).toBe('a');
    const lit = byA.solution as CheckLiteral;
    expectMatch(lit.options.get(true), aTrue);
    expectMatch(lit.options.get(false), aFalse);
  });
});

describe('solveUnion — arrays and tuples', () => {
  it('distinguishes tuples of different lengths via CheckLength', () => {
    const r = new PTypeRegistry();
    const t2 = r.tuple([r.int(), r.string()]);
    const t3 = r.tuple([r.int(), r.string(), r.bool()]);
    const arr = solve(r, [t2, t3]).options.get('array');
    expect(arr).toBeInstanceOf(CheckLength);
    const cl = arr as CheckLength;
    expect(cl.default).toBeNull();
    expectMatch(cl.options.get(2), t2);
    expectMatch(cl.options.get(3), t3);
  });

  it('distinguishes same-length tuples via GetIndex + remap to the tuple types', () => {
    const r = new PTypeRegistry();
    const ta = r.tuple([r.literal('a'), r.int()]);
    const tb = r.tuple([r.literal('b'), r.string()]);
    const cl = solve(r, [ta, tb]).options.get('array') as CheckLength;
    const gi = cl.options.get(2);
    expect(gi).toBeInstanceOf(GetIndex);
    expect((gi as GetIndex).i).toBe(0);
    // the inner solution discriminates on the index-0 literal, remapped back to the tuple types
    const inner = (gi as GetIndex).solution as CheckJsonType;
    const lit = inner.options.get('string') as CheckLiteral;
    expectMatch(lit.options.get('a'), ta);
    expectMatch(lit.options.get('b'), tb);
  });
});

describe('solveUnion — error paths', () => {
  it('rejects a struct union with no discriminator', () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['x', r.int(), false],
      ['z', r.int(), false],
    ]);
    const b = r.struct([
      ['y', r.int(), false],
      ['w', r.int(), false],
    ]);
    expect(() => solve(r, [a, b])).toThrow(/without discriminator/);
  });

  it('rejects a discriminator that is not present on every member', () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['type', r.literal('a'), false],
      ['x', r.int(), false],
    ]);
    const b = r.struct([
      ['kind', r.literal('b'), false],
      ['y', r.int(), false],
    ]);
    expect(() => solve(r, [a, b])).toThrow(/no discriminator common to all/);
  });

  it('rejects a sole discriminator that does not uniquely identify all members', () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['type', r.literal('same'), false],
      ['x', r.int(), false],
    ]);
    const b = r.struct([
      ['type', r.literal('same'), false],
      ['y', r.int(), false],
    ]);
    // reports the correct discriminator key in the message
    expect(() => solve(r, [a, b])).toThrow(/only discriminator \(type\)/);
  });

  it('rejects single-key members sharing a key with nothing to distinguish them', () => {
    const r = new PTypeRegistry();
    const a = r.struct([['key', r.int(), false]]);
    const b = r.struct([['key', r.string(), false]]);
    expect(() => solve(r, [a, b])).toThrow(/without discriminator/);
  });

  it('rejects a union of two possibly-empty arrays', () => {
    const r = new PTypeRegistry();
    const a = r.array(r.int());
    const b = r.array(r.string());
    expect(() => solve(r, [a, b])).toThrow(/possibly-empty arrays/);
  });

  it('rejects a union of non-struct objects', () => {
    const r = new PTypeRegistry();
    const a = r.object(r.int());
    const b = r.object(r.string());
    expect(() => solve(r, [a, b])).toThrow(/non-struct objects/);
  });
});
