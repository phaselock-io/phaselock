/**
 * Lowering unit tests: compile small TypeSpec programs in-memory and assert that lowerProgram()
 * translates them into the expected interned IR — type mapping, naming, interning identity, and
 * store/engine discovery.
 */

import { fileURLToPath } from 'node:url';

import {
  LoweredProgram,
  lowerProgram,
  PArray,
  PBool,
  PDate,
  PInt,
  PLiteral,
  PObject,
  PString,
  PStruct,
  PTuple,
  PType,
  PUnion,
} from '@phaselock/typespec-core';
import { type Program, resolvePath } from '@typespec/compiler';
import { createTester } from '@typespec/compiler/testing';
import { describe, expect, it } from 'vitest';

const base = fileURLToPath(new URL('..', import.meta.url));
const Tester = createTester(resolvePath(base), { libraries: ['@phaselock/typespec-core'] })
  .import('@phaselock/typespec-core')
  .using('PhaseLock');

interface Lowered {
  program: Program;
  diagnostics: readonly { code: string }[];
  lowered: LoweredProgram;
}

async function lower(code: string): Promise<Lowered> {
  const [result, diagnostics] = await Tester.compileAndDiagnose(code);
  return { program: result.program, diagnostics, lowered: lowerProgram(result.program) };
}

/** Find the named root that lowered from a declaration. */
function root(l: LoweredProgram, name: string): PType {
  const found = l.roots.find((t) => t.name === name);
  if (found === undefined)
    throw new Error(`no root named ${name} in [${l.roots.map((t) => t.name)}]`);
  return found;
}

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
    expect(diagnostics.some((d) => d.code.endsWith('/duplicate-name'))).toBe(true);
  });
});

describe('lowerProgram — stores', () => {
  it('discovers a store, its name, and its key templates', async () => {
    const { lowered } = await lower(`
      model Book { id: string; }
      model BookSpec { \`book.{id}\`: Book; }
      interface BookStore extends Store<BookSpec> {}
    `);
    expect(lowered.stores).toHaveLength(1);
    const store = lowered.stores[0];
    expect(store.name).toBe('BookStore');
    expect(store.items.map((i) => i.name)).toEqual(['book']);
    expect(store.items[0].tpl).toBe('book.{id}');
  });

  it('inherits items from dependency stores', async () => {
    const { lowered } = await lower(`
      model Book { id: string; }
      model Patron { id: string; }
      model BookSpec { \`book.{id}\`: Book; }
      model PatronSpec { \`patron.{id}\`: Patron; }
      interface BookStore extends Store<BookSpec> {}
      interface BigStore extends Store<PatronSpec, [BookStore]> {}
    `);
    const big = lowered.stores.find((s) => s.name === 'BigStore')!;
    expect(big.items.map((i) => i.name).sort()).toEqual(['book', 'patron']);
    expect(big.originalItems.map((i) => i.name)).toEqual(['patron']);
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

  it('keeps queries interfaces out of stores and engines', async () => {
    const { lowered } = await lower(`
      model Info { id: string; }
      interface AdminQueries extends Queries { allInfos(): Info[]; }
    `);
    expect(lowered.stores).toHaveLength(0);
    expect(lowered.engines).toHaveLength(0);
  });
});

describe('lowerProgram — engines', () => {
  it('discovers an engine and its event, command, and store types', async () => {
    const { lowered } = await lower(`
      model E1 { type: "e1"; }
      model E2 { type: "e2"; }
      model C1 { type: "c1"; }
      model C2 { type: "c2"; }
      union Events { E1, E2 }
      union Commands { C1, C2 }
      model Book { id: string; }
      model BookSpec { \`book.{id}\`: Book; }
      interface BookStore extends Store<BookSpec> {}
      interface MyEngine extends Engine<Events, Commands, BookStore> {}
    `);
    expect(lowered.engines).toHaveLength(1);
    const eng = lowered.engines[0];
    expect(eng.name).toBe('MyEngine');
    expect(eng.eventType.name).toBe('Events');
    expect(eng.commandType.name).toBe('Commands');
    expect(eng.store.name).toBe('BookStore');
  });
});
