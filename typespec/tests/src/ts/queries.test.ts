/**
 * Behavioral test of the emitted query layer: the wire ids, the remote provider that encodes
 * each call and decodes each result through the host's Registry, the local provider, and the
 * dispatcher a serving side routes a decoded call through.  The Registry here records what the
 * generated code hands it, since the conversions themselves are the host's.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { JS, MSGPACK, type Registry, type Rep } from '../../../ts/assets/skeleton.ts';

import { emit, outDir } from './emit-harness.ts';

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

const ISO = '2024-01-02T03:04:05.000Z';

let text: string;
let M: any;

beforeAll(async () => {
  const out = await emit(SOURCE, outDir('queries-test'));
  text = out.text;
  M = await import(out.file);
}, 60_000);

const enc = new TextEncoder();
const dec = new TextDecoder();

/** a Registry whose bytes are JSON, recording the type each conversion was asked under */
function fakeRegistry(): Registry & { asked: [string, 'toBytes' | 'toJs'][] } {
  const asked: [string, 'toBytes' | 'toJs'][] = [];
  return {
    asked,
    mutations: '',
    ops() {
      throw new Error('queries apply no edits');
    },
    convert(type: string, value: unknown, from: Rep, to: Rep): unknown {
      if (from === JS && to === MSGPACK) {
        asked.push([type, 'toBytes']);
        return enc.encode(JSON.stringify(value));
      }
      asked.push([type, 'toJs']);
      return JSON.parse(dec.decode(value as Uint8Array));
    },
  };
}

function fakeIo() {
  const calls: { query: unknown; onResult: (bytes: Uint8Array) => void }[] = [];
  return {
    calls,
    createQuery(query: Uint8Array, onResult: (bytes: Uint8Array) => void) {
      calls.push({ query: JSON.parse(dec.decode(query)), onResult });
      return () => {};
    },
  };
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

describe('remote provider', () => {
  it("encodes each call as [id, ...args] through the registry, under the interface's wire type", () => {
    const reg = fakeRegistry();
    const io = fakeIo();
    const remote = new M.RemoteAdminQueries(reg, io);
    remote.allPatrons();
    remote.patronsNamed('bob', 3);
    remote.patronsNamed('bob');
    remote.patronsSince(new Date(ISO));

    expect(io.calls.map((c) => c.query)).toEqual([
      ['AdminQueries.allPatrons'],
      ['AdminQueries.patronsNamed', 'bob', 3],
      ['AdminQueries.patronsNamed', 'bob', null],
      ['AdminQueries.patronsSince', ISO],
    ]);
    expect(reg.asked).toEqual([
      ['AdminQuery', 'toBytes'],
      ['AdminQuery', 'toBytes'],
      ['AdminQuery', 'toBytes'],
      ['AdminQuery', 'toBytes'],
    ]);
  });

  it("decodes results through the registry, under the query's id plus #result", () => {
    const reg = fakeRegistry();
    const io = fakeIo();
    const remote = new M.RemoteAdminQueries(reg, io);
    const q = remote.allPatrons();
    const seen: unknown[] = [];
    q.subscribe((v: unknown) => seen.push(v));
    io.calls[0].onResult(enc.encode(JSON.stringify([{ id: 'p1', name: 'n', since: ISO }])));
    expect(seen).toEqual([[{ id: 'p1', name: 'n', since: ISO }]]);
    expect(reg.asked.at(-1)).toEqual(['AdminQueries.allPatrons#result', 'toJs']);
  });
});

describe('local provider', () => {
  it('curries call args into the defs body along with the query context', () => {
    const seen: any[] = [];
    const defs = {
      allPatrons(qx: any) {
        seen.push(['allPatrons', qx]);
        return [];
      },
      patronsNamed(qx: any, name: string, limit?: number) {
        seen.push(['patronsNamed', qx, name, limit]);
        return [];
      },
      patronsSince(qx: any, when: Date) {
        seen.push(['patronsSince', qx, when]);
        return [];
      },
    };
    const captured: any[] = [];
    const eng = {
      newQuery(fn: (qx: any) => any) {
        captured.push(fn);
        return { latest: undefined, subscribe: () => () => {}, close: () => {} };
      },
    };

    const local = new M.LocalAdminQueries(eng, defs);
    local.patronsNamed('bob', 5);
    local.allPatrons();
    expect(captured).toHaveLength(2);
    for (const fn of captured) fn('QX');
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

  it('routes a decoded call to the matching provider method', () => {
    const queries = fakeQueries();
    const q1 = M.dispatchAdminQuery(queries, ['AdminQueries.allPatrons']);
    const q2 = M.dispatchAdminQuery(queries, ['AdminQueries.patronsNamed', 'bob', 3]);
    expect(q1).toBe('q-all');
    expect(q2).toBe('q-named');
    expect(queries.calls).toEqual([['allPatrons'], ['patronsNamed', 'bob', 3]]);
  });

  it('passes nullable wire args as absent', () => {
    const queries = fakeQueries();
    M.dispatchAdminQuery(queries, ['AdminQueries.patronsNamed', 'bob', null]);
    expect(queries.calls).toEqual([['patronsNamed', 'bob', undefined]]);
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
    expect(text).toContain('allPatrons(qx: QX): PatronInfo[];');
    expect(text).toContain('patronsNamed(qx: QX, name: string, limit?: number): PatronInfo[];');
    expect(text).toContain('export interface AdminQueries {');
    expect(text).toContain('patronsNamed(name: string, limit?: number): Query<PatronInfo[]>;');
    expect(text).toContain('export type AdminQuery =');
    expect(text).toContain('export type UserQuery =');
    expect(text).toContain(
      'export class RemoteAdminQueries extends RemoteQueries implements AdminQueries {',
    );
    expect(text).toContain('export class LocalAdminQueries<QX> implements AdminQueries {');
    expect(text).toContain('patronsNamed(name: string, limit?: number): Query<PatronInfo[]> {');
    expect(text).toContain(
      'export function dispatchAdminQuery(queries: AdminQueries, query: AdminQuery): Query<any> {',
    );
    expect(text).toContain(
      'export function dispatchUserQuery(queries: UserQueries, query: UserQuery): Query<any> {',
    );
  });
});
