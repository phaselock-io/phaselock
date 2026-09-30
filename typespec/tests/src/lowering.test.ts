/**
 * Lowering unit tests: compile small TypeSpec programs in-memory and assert that lowerProgram()
 * translates them into the expected interned IR — type mapping, naming, interning identity, and
 * queries discovery.  Slices, engines, databases, and commands are in vocabulary.test.ts.
 */

import {
  PArray,
  PBool,
  PDate,
  PInt,
  PLiteral,
  PObject,
  PString,
  PStruct,
  PTuple,
  PUnion,
} from '@phaselock/typespec-core';
import { describe, expect, it } from 'vitest';

import { lower, root } from './lower-harness.ts';

describe('lowerProgram — scalar and builtin mapping', () => {
  it('maps builtin scalars to their IR primitives', async () => {
    const { lowered } = await lower(`
      model Foo {
        a: int32;
        b: string;
        c: boolean;
        d: utcDateTime;
      }
    `);
    const foo = root(lowered, 'Foo') as PStruct;
    expect(foo).toBeInstanceOf(PStruct);
    expect(foo.fields.get('a')).toBeInstanceOf(PInt);
    expect(foo.fields.get('b')).toBeInstanceOf(PString);
    expect(foo.fields.get('c')).toBeInstanceOf(PBool);
    expect(foo.fields.get('d')).toBeInstanceOf(PDate);
  });

  it('records optional fields as maybes', async () => {
    const { lowered } = await lower(`model Foo { a: int32; b?: string; }`);
    const foo = root(lowered, 'Foo') as PStruct;
    expect(foo.always.has('a')).toBe(true);
    expect(foo.maybes.has('b')).toBe(true);
  });
});

describe('lowerProgram — collections', () => {
  it('maps arrays, records, and tuples', async () => {
    const { lowered } = await lower(`
      model Foo {
        xs: string[];
        m: Record<int32>;
        pair: [string, int32];
      }
    `);
    const foo = root(lowered, 'Foo') as PStruct;
    const xs = foo.fields.get('xs') as PArray;
    expect(xs).toBeInstanceOf(PArray);
    expect(xs.itemType).toBeInstanceOf(PString);
    const m = foo.fields.get('m') as PObject;
    expect(m).toBeInstanceOf(PObject);
    expect(m.valueType).toBeInstanceOf(PInt);
    const pair = foo.fields.get('pair') as PTuple;
    expect(pair).toBeInstanceOf(PTuple);
    expect(pair.itemTypes.map((t) => t.constructor.name)).toEqual(['PString', 'PInt']);
  });
});

describe('lowerProgram — unions and enums', () => {
  it('lowers a named union of literals', async () => {
    const { lowered } = await lower(`union Color { "red", "green", "blue" }`);
    const color = root(lowered, 'Color') as PUnion;
    expect(color).toBeInstanceOf(PUnion);
    expect(color.types.every((t) => t instanceof PLiteral)).toBe(true);
    expect(color.types.map((t) => (t as PLiteral).value).sort()).toEqual(['blue', 'green', 'red']);
  });

  it('lowers an enum to a union of its member-name literals', async () => {
    const { lowered } = await lower(`enum Suit { hearts, spades }`);
    const suit = root(lowered, 'Suit') as PUnion;
    expect(suit).toBeInstanceOf(PUnion);
    expect(suit.types.map((t) => (t as PLiteral).value).sort()).toEqual(['hearts', 'spades']);
  });
});

describe('lowerProgram — interning across a program', () => {
  it('gives repeated references to a model the same IR object', async () => {
    const { lowered } = await lower(`
      model A { n: int32; }
      model Wrap { x: A; y: A; }
    `);
    const a = root(lowered, 'A');
    const wrap = root(lowered, 'Wrap') as PStruct;
    expect(wrap.fields.get('x')).toBe(a);
    expect(wrap.fields.get('y')).toBe(a);
  });

  it('reports two names that resolve to the same structural type', async () => {
    const { diagnostics } = await lower(`
      model A { n: int32; }
      model B { n: int32; }
    `);
    expect(diagnostics.some((d) => d.code === 'duplicate-name')).toBe(true);
  });
});

describe('lowerProgram — queries', () => {
  it('discovers a queries interface with its ops, args, and result types', async () => {
    const { lowered } = await lower(`
      model PatronInfo { id: string; name: string; }
      interface AdminQueries extends Queries {
        allPatrons(): PatronInfo[];
        patronsNamed(name: string, limit?: int32): PatronInfo[];
      }
    `);
    expect(lowered.queries).toHaveLength(1);
    const kq = lowered.queries[0];
    expect(kq.name).toBe('AdminQueries');
    expect(kq.queries.map((q) => q.name)).toEqual(['allPatrons', 'patronsNamed']);

    const [allPatrons, patronsNamed] = kq.queries;
    expect(allPatrons.args).toHaveLength(0);
    expect(allPatrons.result).toBeInstanceOf(PArray);
    // arg and result types intern with the rest of the program
    expect((allPatrons.result as PArray).itemType).toBe(root(lowered, 'PatronInfo'));

    expect(patronsNamed.args.map(([name]) => name)).toEqual(['name', 'limit']);
    const [[, nameType, nameOpt], [, limitType, limitOpt]] = patronsNamed.args;
    expect(nameType).toBeInstanceOf(PString);
    expect(nameOpt).toBe(false);
    expect(limitType).toBeInstanceOf(PInt);
    expect(limitOpt).toBe(true);
  });

  it('collects multiple queries interfaces in declaration order', async () => {
    const { lowered } = await lower(`
      model Info { id: string; }
      interface AdminQueries extends Queries { allInfos(): Info[]; }
      interface UserQueries extends Queries { myInfo(id: string): Info; }
    `);
    expect(lowered.queries.map((q) => q.name)).toEqual(['AdminQueries', 'UserQueries']);
    expect(lowered.queries[1].queries[0].result).toBe(root(lowered, 'Info'));
  });

  it('keeps queries interfaces out of slices and engines', async () => {
    const { lowered } = await lower(`
      model Info { id: string; }
      interface AdminQueries extends Queries { allInfos(): Info[]; }
    `);
    expect(lowered.slices).toHaveLength(0);
    expect(lowered.engines).toHaveLength(0);
  });
});
