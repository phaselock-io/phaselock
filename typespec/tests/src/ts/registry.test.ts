/**
 * The type registry the TypeScript emitter generates: one table of nodes shared by every engine
 * and database, a map from type identity to node, and per engine and database the identities
 * the Registry answers for (its commands, eventTypes, and storeTypes).  Hosts walk this data to
 * convert values, so these tests pin its shape down.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { emit, outDir } from './emit-harness.ts';

const SOURCE = `
  alias Id = string;

  interface CatalogSlice extends Slice<"catalog", CatalogEvents, {
    "item.{item}": Item;
    "count": int32;
    "tags": string[];
  }> {}

  model Item { id: Id; title: string; added: utcDateTime; meta?: Record<int32>; }

  union CatalogEvents { ItemAdded, ItemRemoved, Noted }

  model ItemAdded { type: "item-added"; id: Id; title: string; added: utcDateTime; }
  model ItemRemoved { id: Id; target: Target; type: "item-removed"; }

  // a one-of union, a tuple union, a literal union, and a nullable
  union Target { ByBook, ByEdition }
  model ByBook { book: Id; }
  model ByEdition { edition: Id; }
  union Pair { [string, int32], [string, int32, boolean] }
  union Color { "red", "green" }
  model Slot { pair: Pair; color: Color; note: string | null; blob: unknown; }

  interface InboxSlice extends Slice<"inbox.{org}.{user}", InboxEvents, {
    "profile": Profile;
    "slot.{slot}": Slot;
  }> {}

  model Profile { name: string; }
  union InboxEvents { ProfileSet, Noted }
  model ProfileSet { type: "profile-set"; name: string; }

  @command(Noted)
  model Noted { type: "noted"; note: Id; text: string; }

  interface SecretSlice extends Slice<"secret.{user}", SecretSet, { "secret": PasswordHash }> {}
  model SecretSet { type: "secret-set"; password: PasswordHash; }

  @command(ItemAdded)
  model AddItem { type: "add-item"; id: Id; title: string; added: utcDateTime; }

  @command(ItemRemoved)
  model RemoveItem { type: "remove-item"; id: Id; target: Target; }

  @online
  @command([SecretSet, ProfileSet])
  model SignUp { type: "sign-up"; org: Id; user: Id; name: string; password: NewPassword; }

  @online
  @command([Death, ItemRemoved[]])
  model Leave { type: "leave"; check: CommandAuth; }

  interface ReaderEngine extends Engine<[CatalogSlice], AddItem> {}

  union WriterCommands { AddItem, RemoveItem, Noted, Leave }
  interface WriterEngine extends Engine<[CatalogSlice, InboxSlice], WriterCommands> {}

  interface AppDB extends Database<[ReaderEngine, WriterEngine], [SecretSlice], SignUp> {}

  model PatronInfo { id: string; since: utcDateTime; }
  interface AdminQueries extends Queries {
    allPatrons(): PatronInfo[];
    patronsSince(when: utcDateTime, limit?: int32): PatronInfo[];
  }
`;

let M: any;
let text: string;

beforeAll(async () => {
  const out = await emit(SOURCE, outDir('registry-test'));
  text = out.text;
  M = await import(out.file);
}, 60_000);

/** the node a type identity names, in a schema */
function node(schema: any, id: string): any[] {
  const i = schema.ids[id];
  expect(i, `no id ${id}`).toBeTypeOf('number');
  return schema.nodes[i];
}

/** the index of a scalar node */
function leaf(schema: any, kind: string): number {
  return schema.nodes.findIndex((n: any[]) => n.length === 1 && n[0] === kind);
}

/** the node a struct field holds */
function field(schema: any, struct: any[], key: string): any[] {
  const f = (struct[2] as [string, number, boolean][]).find(([k]) => k === key);
  expect(f, `no field ${key}`).toBeDefined();
  return schema.nodes[f![1]];
}

describe('the node table', () => {
  it('is one table shared by every engine and database schema', () => {
    expect(M.readerEngineSchema.nodes).toBe(M.writerEngineSchema.nodes);
    expect(M.appDBSchema.nodes).toBe(M.writerEngineSchema.nodes);
    expect(M.appDBSchema.ids).toBe(M.writerEngineSchema.ids);
  });

  it('references nodes by index, every index in range', () => {
    const { nodes, ids } = M.appDBSchema;
    const check = (i: unknown) => {
      expect(i).toBeTypeOf('number');
      expect(i as number).toBeGreaterThanOrEqual(0);
      expect(i as number).toBeLessThan(nodes.length);
    };
    const solution = (s: any[]): void => {
      switch (s[0]) {
        case 'match':
          return check(s[1]);
        case 'jsontype':
        case 'literal':
        case 'hasfield':
          for (const [, sub] of s[1]) solution(sub);
          return;
        case 'length':
          for (const [, sub] of s[1]) solution(sub);
          if (s[2] !== null) solution(s[2]);
          return;
        case 'index':
        case 'field':
          return solution(s[2]);
        default:
          throw new Error(`unknown solution ${s[0]}`);
      }
    };
    for (const n of nodes) {
      switch (n[0]) {
        case 'null':
        case 'int':
        case 'str':
        case 'bool':
        case 'date':
        case 'json':
        case 'lit':
          break;
        case 'struct':
          for (const [, t] of n[2]) check(t);
          break;
        case 'record':
        case 'array':
        case 'intake':
          check(n[2]);
          break;
        case 'tuple':
          for (const t of n[2]) check(t);
          break;
        case 'union':
          solution(n[2]);
          break;
        default:
          throw new Error(`unknown node ${n[0]}`);
      }
    }
    for (const i of Object.values(ids)) check(i);
  });

  it('describes scalars, literals, and dates', () => {
    const s = M.appDBSchema;
    const item = node(s, 'Item');
    expect(field(s, item, 'id')).toEqual(['str']);
    expect(field(s, item, 'added')).toEqual(['date']);
    expect(field(s, node(s, 'ItemAdded'), 'type')).toEqual(['lit', 'item-added']);
    expect(field(s, node(s, 'Slot'), 'blob')).toEqual(['json']);
    expect(node(s, 'catalog/count')).toEqual(['int']);
  });

  it("lists a struct's fields in declaration order with their optionality", () => {
    const item = node(M.appDBSchema, 'Item');
    expect(item[0]).toBe('struct');
    expect(item[1]).toBe('Item');
    expect(item[2].map(([k, , opt]: [string, number, boolean]) => [k, opt])).toEqual([
      ['id', false],
      ['title', false],
      ['added', false],
      ['meta', true],
    ]);
  });

  it('names the field a struct writes first: the one a union tells it apart by, or -1', () => {
    const s = M.appDBSchema;
    // told apart by a literal `type` field, its first
    expect(node(s, 'ItemAdded')[3]).toBe(0);
    expect(node(s, 'SignUp')[3]).toBe(0);
    // declared last, and still the one it writes first
    expect(node(s, 'ItemRemoved')[3]).toBe(2);
    // CommandAuth's anonymous members, told apart by `kind`
    const check = s.nodes[field(s, node(s, 'Leave'), 'check')[2]];
    const [, byKind] = check[2][1].find(([jt]: [string]) => jt === 'object');
    for (const [, m] of byKind[2][1]) expect(s.nodes[m[1]][3]).toBe(0);
    // in no union, or in one told apart by which fields are present
    expect(node(s, 'Item')[3]).toBe(-1);
    expect(node(s, 'ByBook')[3]).toBe(-1);
  });

  it('describes records, arrays, and tuples', () => {
    const s = M.appDBSchema;
    const meta = field(s, node(s, 'Item'), 'meta');
    expect(meta).toEqual(['record', null, s.ids['catalog/count']]);
    expect(node(s, 'catalog/tags')).toEqual(['array', null, leaf(s, 'str')]);
    const pair = node(s, 'Pair');
    expect(pair[0]).toBe('union');
    const two = pair[2][1].find(([jt]: [string]) => jt === 'array')[1];
    expect(two[0]).toBe('length');
    const first = s.nodes[two[1].find(([n]: [number]) => n === 2)[1][1]];
    expect(first[0]).toBe('tuple');
    expect(first[2].map((i: number) => s.nodes[i])).toEqual([['str'], ['int']]);
  });

  it("carries the solver's decision tree for each kind of union", () => {
    const s = M.appDBSchema;
    // discriminated by a literal field
    const events = node(s, 'CatalogEvents');
    expect(events[0]).toBe('union');
    expect(events[1]).toBe('CatalogEvents');
    const [, byType] = events[2][1].find(([jt]: [string]) => jt === 'object');
    expect(byType[0]).toBe('field');
    expect(byType[1]).toBe('type');
    expect(byType[2][0]).toBe('literal');
    expect(byType[2][1].map(([lit]: [string]) => lit).sort()).toEqual([
      'item-added',
      'item-removed',
      'noted',
    ]);
    expect(byType[2][1].find(([lit]: [string]) => lit === 'noted')[1]).toEqual([
      'match',
      s.ids['Noted'],
    ]);
    // one-of
    const [, hasField] = node(s, 'Target')[2][1].find(([jt]: [string]) => jt === 'object');
    expect(hasField[0]).toBe('hasfield');
    expect(hasField[1].map(([k]: [string]) => k)).toEqual(['book', 'edition']);
    // literals
    const [, lits] = node(s, 'Color')[2][1].find(([jt]: [string]) => jt === 'string');
    expect(lits[0]).toBe('literal');
    // a nullable, by json type
    const note = field(s, node(s, 'Slot'), 'note');
    expect(note[0]).toBe('union');
    expect(note[2][1].map(([jt]: [string]) => jt).sort()).toEqual(['null', 'string']);
  });

  it('describes a prepared field as an intake node over its wire type, and a result as its base', () => {
    const s = M.appDBSchema;
    const password = field(s, node(s, 'SignUp'), 'password');
    expect(password).toEqual(['intake', 'NewPassword', leaf(s, 'str')]);
    const check = field(s, node(s, 'Leave'), 'check');
    expect(check[0]).toBe('intake');
    expect(check[1]).toBe('CommandAuth');
    expect(s.nodes[check[2]][0]).toBe('union');
    // results travel as their base, under their vocabulary name
    expect(node(s, 'PasswordHash')).toEqual(['str']);
    expect(field(s, node(s, 'SecretSet'), 'password')).toEqual(['str']);
  });

  it("has no node for the reserved identities, which are the host's", () => {
    expect(M.appDBSchema.ids).not.toHaveProperty('.json');
    expect(M.appDBSchema.ids).not.toHaveProperty('.event');
    expect(M.appDBSchema.ids).not.toHaveProperty('.command');
  });
});

describe('the identities each registry answers for', () => {
  it("names an engine's commands union, or its one command", () => {
    expect(M.writerEngineSchema.commands).toBe('WriterCommands');
    expect(M.readerEngineSchema.commands).toBe('AddItem');
    expect(node(M.writerEngineSchema, 'WriterCommands')[0]).toBe('union');
    expect(node(M.readerEngineSchema, 'AddItem')[0]).toBe('struct');
  });

  it("names a database's commands, as its union when they are not already one", () => {
    expect(M.appDBSchema.commands).toBe('AppDBCommand');
    const union = node(M.appDBSchema, 'AppDBCommand');
    expect(union[0]).toBe('union');
    const [, byType] = union[2][1].find(([jt]: [string]) => jt === 'object');
    expect(byType[2][1].map(([lit]: [string]) => lit).sort()).toEqual([
      'add-item',
      'leave',
      'noted',
      'remove-item',
      'sign-up',
    ]);
  });

  it('maps each family to its events union, a one-event slice to that event', () => {
    expect(M.readerEngineSchema.eventTypes).toEqual({ catalog: 'CatalogEvents' });
    expect(M.writerEngineSchema.eventTypes).toEqual({
      catalog: 'CatalogEvents',
      inbox: 'InboxEvents',
    });
    expect(M.appDBSchema.eventTypes).toEqual({
      catalog: 'CatalogEvents',
      inbox: 'InboxEvents',
      secret: 'SecretSet',
    });
  });

  it("maps each slice's key templates to their value types, unnamed ones under family/name", () => {
    expect(M.writerEngineSchema.storeTypes).toEqual({
      'catalog/item': 'Item',
      'catalog/count': 'catalog/count',
      'catalog/tags': 'catalog/tags',
      'inbox/profile': 'Profile',
      'inbox/slot': 'Slot',
    });
    expect(M.appDBSchema.storeTypes).toMatchObject({ 'secret/secret': 'PasswordHash' });
    expect(M.readerEngineSchema.storeTypes).not.toHaveProperty('inbox/profile');
  });

  it('registers the query wire types and each result under the query id plus #result', () => {
    const s = M.appDBSchema;
    const wire = node(s, 'AdminQuery');
    expect(wire[0]).toBe('union');
    expect(node(s, 'AdminQueries.allPatrons#result')).toEqual(['array', null, s.ids['PatronInfo']]);
    expect(M.AdminQueryIds.patronsSince).toBe('AdminQueries.patronsSince');
  });
});

describe('what the registry replaces', () => {
  it('generates no decoders or checkers', () => {
    expect(text).not.toMatch(/export function decode[A-Z]/);
    expect(text).not.toMatch(/export function check[A-Z]/);
    expect(text).not.toContain('AllowedKeys');
  });

  it("puts the database's schema in its bundle", () => {
    const b = M.defineAppDB({
      reducers: {
        catalog: { itemAdded() {}, itemRemoved() {}, noted() {} },
        inbox: { profileSet() {}, noted() {} },
        secret: { secretSet() {} },
      },
      precommit: {
        addItem: () => [],
        removeItem: () => [],
        noted: () => [],
        signUp: () => [],
        leave: () => [],
      },
      maySee: () => [],
      lookup: () => null,
    });
    expect(b.schema).toBe(M.appDBSchema);
    expect(b).not.toHaveProperty('hashedFields');
    expect(b).not.toHaveProperty('checkCommand');
  });
});
