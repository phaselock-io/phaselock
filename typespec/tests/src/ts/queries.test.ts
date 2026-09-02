/**
 * Behavioral test of the emitted query layer.
 *
 * Unlike check.test.ts / decode.test.ts, this compiles its TypeSpec in-memory and runs
 * generateTs() directly, prepending a minimal stub of the runtime skeleton (just the pieces the
 * query layer references).  The generated module is written under tsp-output/ and imported, so
 * the assertions below exercise the real generated wire ids, checkers, decoders, and the local
 * and remote provider constructions.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lowerProgram } from '@phaselock/typespec-core';
import { generateTs } from '@phaselock/typespec-ts';
import { resolvePath } from '@typespec/compiler';
import { createTester } from '@typespec/compiler/testing';
import { beforeAll, describe, expect, it } from 'vitest';

const base = fileURLToPath(new URL('../..', import.meta.url));
const Tester = createTester(resolvePath(base), { libraries: ['@phaselock/typespec-core'] })
  .import('@phaselock/typespec-core')
  .using('PhaseLock');

const SOURCE = `
  model PatronInfo { id: string; name: string; since: utcDateTime; }
  interface AdminQueries extends Queries {
    allPatrons(): PatronInfo[];
    patronsNamed(name: string, limit?: int32): PatronInfo[];
    patronsSince(when: utcDateTime): PatronInfo[];
  }
  interface UserQueries extends Queries {
    myPatron(id: string): PatronInfo;
  }
`;

/* Stand-in for the runtime skeleton: jsonTypeof and encodeProto behave like the real ones;
   RemoteQueries records what generated methods pass to the transport. */
const STUB_SKELETON = `
export function jsonTypeof(val: any): string {
  const t = typeof(val);
  if (t === "object") {
    if (val === null) return "null";
    if (Array.isArray(val)) return "array";
  }
  return t;
}

export function encodeProto(base: any): any {
  switch (typeof base) {
    case "boolean":
    case "bigint":
    case "number":
    case "string":
    case "undefined":
      return base;
    case "object":
      if (base === null) return base;
      break;
    default:
      throw new Error("type not handled by encodeProto: " + typeof base);
  }
  if (base.toJSON) return base.toJSON();
  if (Array.isArray(base)) return base.map(encodeProto);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, encodeProto(v)]));
}

export type QueryGenerator<T> = Generator<any, T, any>;
export type QueryFunction<QX, T> = (qx: QX) => QueryGenerator<T>;
export interface Query<T> {
  latest: T | undefined;
  subscribe(callback: (val: T) => void): () => void;
  close(): void;
}
export interface LocalQuery<T> extends Query<T> {
  awaitResult(): QueryGenerator<T>;
}

export class RemoteQueries {
  io: any;
  constructor(io: any) { this.io = io; }
  newQuery<T>(raw: any[], decoder: (result: any) => T): Query<T> {
    return this.io.createQuery(raw, decoder);
  }
}
`;

const ISO = '2024-01-02T03:04:05Z';

let text: string;
let M: any;

beforeAll(async () => {
  const [result, diagnostics] = await Tester.compileAndDiagnose(SOURCE);
  if (diagnostics.length > 0) {
    throw new Error(`compile diagnostics: ${diagnostics.map((d) => d.message).join('\n')}`);
  }
  text = generateTs(lowerProgram(result.program), STUB_SKELETON);

  const dir = resolvePath(base, 'tsp-output/.queries-test');
  mkdirSync(dir, { recursive: true });
  const file = resolvePath(dir, 'queries.gen.ts');
  writeFileSync(file, text);
  M = await import(file);
});

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

describe('wire ids', () => {
  it('are interface-qualified op names', () => {
    expect(M.AdminQueryIds).toEqual({
      allPatrons: 'AdminQueries.allPatrons',
      patronsNamed: 'AdminQueries.patronsNamed',
      patronsSince: 'AdminQueries.patronsSince',
    });
    expect(M.UserQueryIds).toEqual({ myPatron: 'UserQueries.myPatron' });
  });
});

describe('wire message checker', () => {
  it('accepts well-formed query messages', () => {
    ok(M.checkAdminQuery, ['AdminQueries.allPatrons']);
    ok(M.checkAdminQuery, ['AdminQueries.patronsNamed', 'bob', 3]);
    ok(M.checkAdminQuery, ['AdminQueries.patronsNamed', 'bob', null]);
    ok(M.checkAdminQuery, ['AdminQueries.patronsSince', ISO]);
    ok(M.checkUserQuery, ['UserQueries.myPatron', 'u1']);
  });

  it('rejects unknown ids, wrong arity, and wrong arg types', () => {
    fails(M.checkAdminQuery, ['AdminQueries.nope']);
    fails(M.checkAdminQuery, ['AdminQueries.patronsNamed', 'bob']);
    fails(M.checkAdminQuery, ['AdminQueries.patronsNamed', 5, 3]);
    fails(M.checkAdminQuery, ['AdminQueries.patronsSince', 'not a date'], 'invalid timestamp');
    fails(M.checkAdminQuery, 'AdminQueries.allPatrons');
    fails(M.checkUserQuery, ['UserQueries.myPatron']);
  });
});

describe('wire message decoder', () => {
  it('produces the typed tuple, reviving dates', () => {
    const decoded = M.decodeAdminQuery(['AdminQueries.patronsSince', ISO]);
    expect(decoded[0]).toBe('AdminQueries.patronsSince');
    expect(decoded[1]).toBeInstanceOf(Date);
    expect(decoded[1].toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });

  it('passes nullable args through', () => {
    expect(M.decodeAdminQuery(['AdminQueries.patronsNamed', 'bob', null])).toEqual([
      'AdminQueries.patronsNamed',
      'bob',
      null,
    ]);
  });
});

function fakeIo() {
  const calls: { raw: any[]; decoder: (v: any) => any }[] = [];
  return {
    calls,
    createQuery(raw: any[], decoder: (v: any) => any) {
      const call = { raw, decoder };
      calls.push(call);
      return call;
    },
  };
}

describe('remote provider', () => {
  it('encodes each call as [id, ...args]', () => {
    const io = fakeIo();
    const remote = new M.RemoteAdminQueries(io);
    remote.allPatrons();
    remote.patronsNamed('bob', 3);
    remote.patronsNamed('bob');
    remote.patronsSince(new Date(ISO));

    expect(io.calls.map((c) => c.raw)).toEqual([
      ['AdminQueries.allPatrons'],
      ['AdminQueries.patronsNamed', 'bob', 3],
      ['AdminQueries.patronsNamed', 'bob', null],
      ['AdminQueries.patronsSince', '2024-01-02T03:04:05.000Z'],
    ]);
  });

  it('every encoded call passes its own checker', () => {
    const io = fakeIo();
    const remote = new M.RemoteAdminQueries(io);
    remote.allPatrons();
    remote.patronsNamed('bob');
    remote.patronsSince(new Date(ISO));
    for (const call of io.calls) {
      ok(M.checkAdminQuery, JSON.parse(JSON.stringify(call.raw)));
    }
  });

  it("decodes results with the query's result decoder", () => {
    const io = fakeIo();
    const remote = new M.RemoteAdminQueries(io);
    remote.allPatrons();
    const decoded = io.calls[0].decoder([{ id: 'p1', name: 'n', since: ISO }]);
    expect(decoded[0].since).toBeInstanceOf(Date);
  });
});

describe('local provider', () => {
  it('curries call args into the defs body along with the query context', () => {
    const seen: any[] = [];
    /* eslint-disable require-yield -- stubs satisfy the generator-typed defs contract without touching store */
    const defs = {
      *allPatrons(qx: any) {
        seen.push(['allPatrons', qx]);
        return [];
      },
      *patronsNamed(qx: any, name: string, limit?: number) {
        seen.push(['patronsNamed', qx, name, limit]);
        return [];
      },
      *patronsSince(qx: any, when: Date) {
        seen.push(['patronsSince', qx, when]);
        return [];
      },
    };
    /* eslint-enable require-yield */
    const captured: any[] = [];
    const eng = {
      newQuery(fn: (qx: any) => Generator<any, any, any>) {
        captured.push(fn);
        return { latest: undefined, subscribe: () => () => {}, close: () => {} };
      },
    };

    const local = new M.LocalAdminQueries(eng, defs);
    local.patronsNamed('bob', 5);
    local.allPatrons();
    expect(captured).toHaveLength(2);
    for (const fn of captured) fn('QX').next();
    expect(seen).toEqual([
      ['patronsNamed', 'QX', 'bob', 5],
      ['allPatrons', 'QX'],
    ]);
  });
});

describe('dispatcher', () => {
  function fakeQueries() {
    const calls: any[][] = [];
    return {
      calls,
      allPatrons: (...args: any[]) => {
        calls.push(['allPatrons', ...args]);
        return 'q-all';
      },
      patronsNamed: (...args: any[]) => {
        calls.push(['patronsNamed', ...args]);
        return 'q-named';
      },
      patronsSince: (...args: any[]) => {
        calls.push(['patronsSince', ...args]);
        return 'q-since';
      },
    };
  }

  it('routes a decoded message to the matching provider method', () => {
    const queries = fakeQueries();
    const q1 = M.dispatchAdminQuery(queries, M.decodeAdminQuery(['AdminQueries.allPatrons']));
    const q2 = M.dispatchAdminQuery(
      queries,
      M.decodeAdminQuery(['AdminQueries.patronsNamed', 'bob', 3]),
    );
    expect(q1).toBe('q-all');
    expect(q2).toBe('q-named');
    expect(queries.calls).toEqual([['allPatrons'], ['patronsNamed', 'bob', 3]]);
  });

  it('passes nullable wire args as absent', () => {
    const queries = fakeQueries();
    M.dispatchAdminQuery(queries, M.decodeAdminQuery(['AdminQueries.patronsNamed', 'bob', null]));
    expect(queries.calls).toEqual([['patronsNamed', 'bob', undefined]]);
  });

  it('revived args arrive as their decoded types', () => {
    const queries = fakeQueries();
    M.dispatchAdminQuery(queries, M.decodeAdminQuery(['AdminQueries.patronsSince', ISO]));
    expect(queries.calls[0][1]).toBeInstanceOf(Date);
  });

  it('throws on an unknown id', () => {
    expect(() => M.dispatchAdminQuery(fakeQueries(), ['AdminQueries.nope'])).toThrow(
      'unexpected query ID: AdminQueries.nope',
    );
  });
});

describe('generated type surface', () => {
  it('declares the defs and provider interfaces', () => {
    expect(text).toContain('export interface AdminQueryDefs<QX> {');
    expect(text).toContain('allPatrons(qx: QX): QueryGenerator<PatronInfo[]>;');
    expect(text).toContain(
      'patronsNamed(qx: QX, name: string, limit?: number): QueryGenerator<PatronInfo[]>;',
    );
    expect(text).toContain('export interface AdminQueries {');
    expect(text).toContain('patronsNamed(name: string, limit?: number): Query<PatronInfo[]>;');
    expect(text).toContain('export type AdminQuery =');
    expect(text).toContain('export type UserQuery =');
    expect(text).toContain(
      'export class RemoteAdminQueries extends RemoteQueries implements AdminQueries {',
    );
    expect(text).toContain('export class LocalAdminQueries<QX> implements AdminQueries {');
    expect(text).toContain(
      'patronsNamed(name: string, limit?: number): LocalQuery<PatronInfo[]> {',
    );
    expect(text).toContain(
      'export function dispatchAdminQuery(queries: AdminQueries, query: AdminQuery): Query<any> {',
    );
    expect(text).toContain(
      'export function dispatchUserQuery(queries: UserQueries, query: UserQuery): Query<any> {',
    );
  });
});
