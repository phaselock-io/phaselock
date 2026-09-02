/**
 * Interning unit tests: PTypeRegistry hands back one object per structurally distinct type, so
 * object identity is 1:1 with type equality.  The solver and emitters rely on this.
 */

import { PType, PTypeRegistry, PUnion } from '@phaselock/typespec-core';
import { describe, expect, it } from 'vitest';

describe('PTypeRegistry — primitive singletons', () => {
  it('returns the same object for each builtin', () => {
    const r = new PTypeRegistry();
    expect(r.int()).toBe(r.int());
    expect(r.string()).toBe(r.string());
    expect(r.bool()).toBe(r.bool());
    expect(r.date()).toBe(r.date());
    expect(r.null_()).toBe(r.null_());
    expect(r.json()).toBe(r.json());
  });

  it('keeps date distinct from string despite sharing a json type', () => {
    const r = new PTypeRegistry();
    expect(r.date()).not.toBe(r.string());
    expect(r.date().jsonType).toBe(r.string().jsonType);
  });
});

describe('PTypeRegistry — literals', () => {
  it('interns by value', () => {
    const r = new PTypeRegistry();
    expect(r.literal('a')).toBe(r.literal('a'));
    expect(r.literal(1)).toBe(r.literal(1));
    expect(r.literal(true)).toBe(r.literal(true));
  });

  it('keeps literals of different type but equal spelling distinct', () => {
    const r = new PTypeRegistry();
    expect(r.literal(1)).not.toBe(r.literal('1'));
  });
});

describe('PTypeRegistry — structs', () => {
  it('is insensitive to field order', () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['x', r.int(), false],
      ['y', r.string(), false],
    ]);
    const b = r.struct([
      ['y', r.string(), false],
      ['x', r.int(), false],
    ]);
    expect(a).toBe(b);
  });

  it('preserves first-creation field order for display', () => {
    const r = new PTypeRegistry();
    const a = r.struct([
      ['x', r.int(), false],
      ['y', r.string(), false],
    ]);
    r.struct([
      ['y', r.string(), false],
      ['x', r.int(), false],
    ]);
    expect([...a.fields.keys()]).toEqual(['x', 'y']);
  });

  it('distinguishes optional from required fields', () => {
    const r = new PTypeRegistry();
    const req = r.struct([['x', r.int(), false]]);
    const opt = r.struct([['x', r.int(), true]]);
    expect(req).not.toBe(opt);
    expect(req.always.has('x')).toBe(true);
    expect(opt.maybes.has('x')).toBe(true);
  });

  it('distinguishes structs whose fields differ only by type', () => {
    const r = new PTypeRegistry();
    expect(r.struct([['x', r.int(), false]])).not.toBe(r.struct([['x', r.string(), false]]));
  });
});

describe('PTypeRegistry — collections', () => {
  it('interns arrays, objects, and tuples by child identity', () => {
    const r = new PTypeRegistry();
    expect(r.array(r.int())).toBe(r.array(r.int()));
    expect(r.object(r.string())).toBe(r.object(r.string()));
    expect(r.tuple([r.int(), r.string()])).toBe(r.tuple([r.int(), r.string()]));
  });

  it('keeps arrays and objects of different element types distinct', () => {
    const r = new PTypeRegistry();
    expect(r.array(r.int())).not.toBe(r.array(r.string()));
    expect(r.tuple([r.int(), r.string()])).not.toBe(r.tuple([r.string(), r.int()]));
  });
});

describe('PTypeRegistry — unions', () => {
  it('collapses a single-member union to the member itself', () => {
    const r = new PTypeRegistry();
    expect(r.union([r.int()])).toBe(r.int());
  });

  it('drops duplicate members', () => {
    const r = new PTypeRegistry();
    const u = r.union([r.int(), r.int(), r.string()]) as PUnion;
    expect(u).toBeInstanceOf(PUnion);
    expect(u.types).toHaveLength(2);
  });

  it('flattens nested unions', () => {
    const r = new PTypeRegistry();
    const inner = r.union([r.int(), r.string()]);
    const outer = r.union([inner, r.bool()]) as PUnion;
    expect(outer.types.some((t) => t instanceof PUnion)).toBe(false);
    expect(outer.types).toHaveLength(3);
  });

  it('is insensitive to member order for identity', () => {
    const r = new PTypeRegistry();
    expect(r.union([r.int(), r.string()])).toBe(r.union([r.string(), r.int()]));
  });

  it('throws on an empty union', () => {
    const r = new PTypeRegistry();
    expect(() => r.union([])).toThrow(/no types/);
  });
});

describe('PTypeRegistry — bookkeeping', () => {
  it('records every distinct type once in creation order', () => {
    const r = new PTypeRegistry();
    const i = r.int();
    const s = r.string();
    r.int(); // duplicate, not re-added
    const arr = r.array(i);
    expect(r.all).toContain(i);
    expect(r.all).toContain(s);
    expect(r.all).toContain(arr);
    expect(r.all.filter((t: PType) => t === i)).toHaveLength(1);
  });
});
