// The interpreted walk over the type registry: msgpack bytes to rich values and back, checked
// against the schema on both sides, plus the host's reserved identities.

import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, test } from 'vitest';
import { JS, MSGPACK, type Mutation, type Schema, type SchemaNode } from '../src/contract.js';
import { buildRegistry, ConvertError } from '../src/registry.js';
import { uuidBytes } from '../src/uuid.js';

// a schema shaped like the emitter's output for a small model: the values of the catalog and inbox
// slices, the writer engine's mutations, two prepared fields, and a query interface
const nodes: SchemaNode[] = [];
const add = (n: SchemaNode): number => nodes.push(n) - 1;
const STR = add(['str']);
const INT = add(['int']);
const BOOL = add(['bool']);
const DATE = add(['date']);
const NULL = add(['null']);
const ANY = add(['json']);
const ITEM_ADDED = add(['lit', 'item-added']);
const ITEM_REMOVED = add(['lit', 'item-removed']);
const NOTED = add(['lit', 'noted']);
const META = add(['record', null, INT]);
const Item = add([
  'struct',
  'Item',
  [
    ['id', STR, false],
    ['title', STR, false],
    ['added', DATE, false],
    ['meta', META, true],
  ],
  -1,
]);
const ByBook = add(['struct', 'ByBook', [['book', STR, false]], -1]);
const ByEdition = add(['struct', 'ByEdition', [['edition', STR, false]], -1]);
const Target = add([
  'union',
  'Target',
  [
    'jsontype',
    [
      [
        'object',
        [
          'hasfield',
          [
            ['book', ['match', ByBook]],
            ['edition', ['match', ByEdition]],
          ],
        ],
      ],
    ],
  ],
]);
const ItemAdded = add([
  'struct',
  'ItemAdded',
  [
    ['id', STR, false],
    ['title', STR, false],
    ['added', DATE, false],
    ['type', ITEM_ADDED, false],
  ],
  3,
]);
const ItemRemoved = add([
  'struct',
  'ItemRemoved',
  [
    ['type', ITEM_REMOVED, false],
    ['id', STR, false],
    ['target', Target, false],
  ],
  0,
]);
const Noted = add([
  'struct',
  'Noted',
  [
    ['type', NOTED, false],
    ['note', STR, false],
    ['text', STR, false],
  ],
  0,
]);
const CatalogEntry = add([
  'union',
  'CatalogEntry',
  [
    'jsontype',
    [
      [
        'object',
        [
          'field',
          'type',
          [
            'literal',
            [
              ['item-added', ['match', ItemAdded]],
              ['item-removed', ['match', ItemRemoved]],
              ['noted', ['match', Noted]],
            ],
          ],
        ],
      ],
    ],
  ],
]);
const Pair2 = add(['tuple', null, [STR, INT]]);
const Pair3 = add(['tuple', null, [STR, INT, BOOL]]);
const Pair = add([
  'union',
  'Pair',
  [
    'jsontype',
    [
      [
        'array',
        [
          'length',
          [
            [2, ['match', Pair2]],
            [3, ['match', Pair3]],
          ],
          null,
        ],
      ],
    ],
  ],
]);
const RED = add(['lit', 'red']);
const GREEN = add(['lit', 'green']);
const Color = add([
  'union',
  'Color',
  [
    'jsontype',
    [
      [
        'string',
        [
          'literal',
          [
            ['red', ['match', RED]],
            ['green', ['match', GREEN]],
          ],
        ],
      ],
    ],
  ],
]);
const ONE = add(['lit', 1]);
const TWO = add(['lit', 2]);
const Level = add([
  'union',
  'Level',
  [
    'jsontype',
    [
      [
        'int',
        [
          'literal',
          [
            [1, ['match', ONE]],
            [2, ['match', TWO]],
          ],
        ],
      ],
    ],
  ],
]);
const MaybeStr = add([
  'union',
  null,
  [
    'jsontype',
    [
      ['null', ['match', NULL]],
      ['string', ['match', STR]],
    ],
  ],
]);
const Slot = add([
  'struct',
  'Slot',
  [
    ['pair', Pair, false],
    ['color', Color, false],
    ['level', Level, false],
    ['note', MaybeStr, false],
    ['blob', ANY, false],
  ],
  -1,
]);
const Slots = add(['array', null, Slot]);
const Profile = add(['struct', 'Profile', [['name', STR, false]], -1]);
const NewPassword = add(['intake', 'NewPassword', STR]);
const PW_KIND = add(['lit', 'password']);
const TOTP_KIND = add(['lit', 'totp']);
const AuthPassword = add([
  'struct',
  null,
  [
    ['kind', PW_KIND, false],
    ['password', STR, false],
  ],
  0,
]);
const AuthTotp = add([
  'struct',
  null,
  [
    ['kind', TOTP_KIND, false],
    ['code', STR, false],
  ],
  0,
]);
const MutationAuthWire = add([
  'union',
  'MutationAuth',
  [
    'jsontype',
    [
      [
        'object',
        [
          'field',
          'kind',
          [
            'literal',
            [
              ['password', ['match', AuthPassword]],
              ['totp', ['match', AuthTotp]],
            ],
          ],
        ],
      ],
    ],
  ],
]);
const MutationAuth = add(['intake', 'MutationAuth', MutationAuthWire]);
const ADD_ITEM = add(['lit', 'add-item']);
const SIGN_UP = add(['lit', 'sign-up']);
const LEAVE = add(['lit', 'leave']);
const AddItem = add([
  'struct',
  'AddItem',
  [
    ['type', ADD_ITEM, false],
    ['id', STR, false],
    ['title', STR, false],
    ['added', DATE, false],
    ['color', Color, true],
  ],
  0,
]);
const SignUp = add([
  'struct',
  'SignUp',
  [
    ['type', SIGN_UP, false],
    ['user', STR, false],
    ['password', NewPassword, false],
  ],
  0,
]);
const Leave = add([
  'struct',
  'Leave',
  [
    ['type', LEAVE, false],
    ['check', MutationAuth, false],
  ],
  0,
]);
const WriterMutations = add([
  'union',
  'WriterMutations',
  [
    'jsontype',
    [
      [
        'object',
        [
          'field',
          'type',
          [
            'literal',
            [
              ['add-item', ['match', AddItem]],
              ['noted', ['match', Noted]],
              ['sign-up', ['match', SignUp]],
              ['leave', ['match', Leave]],
            ],
          ],
        ],
      ],
    ],
  ],
]);
const PatronInfo = add([
  'struct',
  'PatronInfo',
  [
    ['id', STR, false],
    ['since', DATE, false],
  ],
  -1,
]);
const Patrons = add(['array', null, PatronInfo]);
const ALL = add(['lit', 'AdminQueries.allPatrons']);
const SINCE = add(['lit', 'AdminQueries.patronsSince']);
const MaybeInt = add([
  'union',
  null,
  [
    'jsontype',
    [
      ['null', ['match', NULL]],
      ['int', ['match', INT]],
    ],
  ],
]);
const AllQuery = add(['tuple', null, [ALL]]);
const SinceQuery = add(['tuple', null, [SINCE, DATE, MaybeInt]]);
const AdminQuery = add([
  'union',
  'AdminQuery',
  [
    'jsontype',
    [
      [
        'array',
        [
          'length',
          [
            [1, ['match', AllQuery]],
            [3, ['match', SinceQuery]],
          ],
          null,
        ],
      ],
    ],
  ],
]);

const Targets = add(['array', null, Target]);
const TargetsByName = add(['record', null, Target]);
const Located = add(['tuple', null, [STR, Target]]);
const Shelf = add([
  'struct',
  'Shelf',
  [
    ['id', STR, false],
    ['main', Target, false],
    ['target', Target, true],
    ['color', Color, true],
    ['targets', Targets, true],
    ['byName', TargetsByName, true],
    ['located', Located, true],
  ],
  -1,
]);

const schema: Schema = {
  nodes,
  ids: {
    Item,
    Target,
    ItemAdded,
    ItemRemoved,
    Noted,
    CatalogEntry,
    Slot,
    'inbox/slots': Slots,
    Profile,
    AddItem,
    SignUp,
    Leave,
    WriterMutations,
    'PasswordHash': STR,
    'catalog/count': INT,
    PatronInfo,
    AdminQuery,
    'AdminQueries.allPatrons#result': Patrons,
    'AdminQueries.patronsSince#result': Patrons,
    Shelf,
  },
  mutations: 'WriterMutations',
};

const reg = buildRegistry(schema);

const added = new Date('2026-01-02T03:04:05.678Z');
// a mutation id as the Engine holds it, and as an envelope carries it
const C1 = '00000000-0000-0000-0000-0000000000c1';
const c1 = uuidBytes(C1);
const itemAdded = { type: 'item-added', id: 'i1', title: 'Dune', added };

/** bytes to the rich value of a type */
function toJs(type: string, bytes: Uint8Array): unknown {
  return reg.convert(type, bytes, MSGPACK, JS);
}

/** a rich value of a type to bytes */
function toBytes(type: string, value: unknown): Uint8Array {
  return reg.convert(type, value, JS, MSGPACK) as Uint8Array;
}

/** the bytes a value takes, decoded by the library as plain data */
const plain = (bytes: Uint8Array): unknown => decode(bytes);

/** assert a conversion fails with a ConvertError naming the path and the problem */
function rejects(fn: () => unknown, message: string | RegExp): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e: unknown) {
    error = e;
  }
  expect(error).toBeInstanceOf(ConvertError);
  if (typeof message === 'string') expect((error as Error).message).toContain(message);
  else expect((error as Error).message).toMatch(message);
}

describe('the schema', () => {
  test('a kind of node this library does not know refuses to build', () => {
    const bad = { ...schema, nodes: [...schema.nodes, ['decimal'] as unknown as SchemaNode] };
    expect(() => buildRegistry(bad)).toThrow('schema: unknown node kind "decimal"');
  });
});

describe('scalars', () => {
  test('strings, ints of every width, bools, and literals round-trip', () => {
    const ints = [0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32, 2 ** 53 - 1];
    const negs = [-1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1];
    for (const n of [...ints, ...negs]) {
      expect(toJs('catalog/count', encode(n))).toBe(n);
      expect(plain(toBytes('catalog/count', n))).toBe(n);
    }
    expect(toJs('PasswordHash', encode('héllo'))).toBe('héllo');
    expect(plain(toBytes('PasswordHash', 'x'.repeat(300)))).toBe('x'.repeat(300));
    expect(toJs('Profile', encode({ name: 'a'.repeat(70000) }))).toEqual({
      name: 'a'.repeat(70000),
    });
  });

  test('a date travels as the timestamp extension, at millisecond precision', () => {
    const bytes = toBytes('Item', itemAdded);
    expect(plain(bytes)).toEqual({ id: 'i1', title: 'Dune', added }); // the library's Date
    expect(toJs('Item', bytes)).toEqual({ id: 'i1', title: 'Dune', added });
    // the three sizes of the extension, and a date before 1970
    const whole = new Date('2026-01-02T03:04:05Z');
    expect((toJs('Item', encode({ ...itemAdded, added: whole })) as { added: Date }).added).toEqual(
      whole,
    );
    const old = new Date('1960-06-07T08:09:10.123Z');
    expect(
      (toJs('Item', toBytes('Item', { ...itemAdded, added: old })) as { added: Date }).added,
    ).toEqual(old);
    expect(toBytes('Item', { ...itemAdded, added: whole }).length).toBeLessThan(
      toBytes('Item', itemAdded).length,
    );
  });

  test('a string where a date belongs is rejected, naming the path', () => {
    rejects(() => toJs('Item', encode({ ...itemAdded, added: added.toISOString() })), '$.added');
    rejects(() => toBytes('Item', { ...itemAdded, added: added.toISOString() }), '$.added');
    rejects(() => toBytes('Item', { ...itemAdded, added: new Date(NaN) }), '$.added');
  });

  test('ints: an integral float reads as an int; fractions and unsafe values are rejected', () => {
    expect(toJs('catalog/count', Uint8Array.of(0xcb, 0x40, 0x08, 0, 0, 0, 0, 0, 0))).toBe(3);
    rejects(() => toJs('catalog/count', encode(1.5)), 'expected an int');
    rejects(
      () => toJs('catalog/count', Uint8Array.of(0xcf, 0x10, 0, 0, 0, 0, 0, 0, 0)),
      'expected an int',
    );
    rejects(() => toBytes('catalog/count', 1.5), 'expected an int');
    rejects(() => toBytes('catalog/count', 2 ** 53), 'expected an int');
    rejects(() => toBytes('catalog/count', '3'), 'expected an int');
  });
});

describe('structs', () => {
  test('writes fields in declaration order, whatever order the object has', () => {
    const bytes = toBytes('Item', { title: 'Dune', added, id: 'i1' });
    expect(Object.keys(plain(bytes) as object)).toEqual(['id', 'title', 'added']);
  });

  test("writes a union member's discriminator first", () => {
    const bytes = toBytes('CatalogEntry', { id: 'i1', title: 'Dune', added, type: 'item-added' });
    expect(Object.keys(plain(bytes) as object)[0]).toBe('type');
    // and directly, under the member's own identity
    expect(
      Object.keys(
        plain(
          toBytes('ItemAdded', { id: 'i1', title: 'Dune', added, type: 'item-added' }),
        ) as object,
      )[0],
    ).toBe('type');
  });

  test('an optional field may be absent, and an undefined property is absent', () => {
    expect(toJs('Item', encode({ id: 'i1', title: 'T', added }))).toEqual({
      id: 'i1',
      title: 'T',
      added,
    });
    const withMeta = { id: 'i1', title: 'T', added, meta: { a: 1 } };
    expect(toJs('Item', toBytes('Item', withMeta))).toEqual(withMeta);
    expect(plain(toBytes('Item', { ...itemAdded, meta: undefined }))).toEqual({
      id: 'i1',
      title: 'Dune',
      added,
    });
  });

  test('a missing required field is rejected with its path', () => {
    rejects(() => toJs('Item', encode({ id: 'i1', added })), '$.title');
    rejects(() => toBytes('Item', { id: 'i1', added }), '$.title');
  });

  test('a repeated key is rejected', () => {
    // a map with the same key twice, built by hand
    const w = [0x82, ...encode('book'), ...encode('x'), ...encode('book'), ...encode('y')];
    rejects(() => toJs('Target', new Uint8Array(w)), 'repeated');
  });

  test('a non-object where a struct belongs is rejected', () => {
    rejects(() => toJs('Item', encode([1, 2])), 'expected an object');
    rejects(() => toBytes('Item', 'nope'), 'expected an object');
    rejects(() => toBytes('Item', null), 'expected an object');
  });
});

describe('unknown fields', () => {
  const extra = { ...itemAdded, surprise: true };

  test('are rejected for the mutations identity, reading and writing', () => {
    rejects(() => toJs('WriterMutations', encode({ ...extra, type: 'add-item' })), '$.surprise');
    rejects(() => toBytes('WriterMutations', { ...extra, type: 'add-item' }), '$.surprise');
  });

  test('are dropped for every other identity, reading and writing', () => {
    expect(toJs('CatalogEntry', encode(extra))).toEqual(itemAdded);
    expect(toJs('Item', encode(extra))).toEqual({ id: 'i1', title: 'Dune', added });
    expect(plain(toBytes('CatalogEntry', extra))).toEqual(itemAdded);
    // nested too
    const nested = { ...itemAdded, type: 'item-removed', target: { book: 'b1', shelf: 3 } };
    const out = toJs('CatalogEntry', encode(nested)) as { target: unknown };
    expect(out.target).toEqual({ book: 'b1' });
  });
});

describe('unions', () => {
  test('dispatches on a literal field wherever it sits in the map', () => {
    const last = { id: 'n1', text: 'hi', note: 'n1', type: 'noted' };
    expect(toJs('CatalogEntry', encode(last))).toEqual({ type: 'noted', note: 'n1', text: 'hi' });
    rejects(() => toJs('CatalogEntry', encode({ type: 'bogus', id: 'x' })), 'bogus');
    rejects(() => toJs('CatalogEntry', encode({ id: 'x' })), 'type');
    rejects(() => toBytes('CatalogEntry', { type: 'bogus' }), 'bogus');
  });

  test('dispatches a one-of on the field present', () => {
    expect(toJs('Target', encode({ edition: 'e1' }))).toEqual({ edition: 'e1' });
    expect(plain(toBytes('Target', { book: 'b1' }))).toEqual({ book: 'b1' });
    rejects(() => toJs('Target', encode({ isbn: 'x' })), 'book, edition');
    rejects(() => toBytes('Target', {}), 'book, edition');
  });

  test('dispatches tuples on their length, literals on their value, and a nullable on null', () => {
    const slot = { pair: ['a', 1, true], color: 'green', level: 2, note: null, blob: { x: [1] } };
    expect(toJs('Slot', toBytes('Slot', slot))).toEqual(slot);
    const two = { ...slot, pair: ['a', 1], note: 'n' };
    expect(toJs('Slot', encode(two))).toEqual(two);
    rejects(() => toJs('Slot', encode({ ...slot, pair: ['a'] })), '$.pair');
    rejects(() => toJs('Slot', encode({ ...slot, color: 'blue' })), '$.color');
    rejects(() => toJs('Slot', encode({ ...slot, level: 3 })), '$.level');
    rejects(() => toJs('Slot', encode({ ...slot, note: 7 })), '$.note');
    rejects(() => toBytes('Slot', { ...slot, pair: ['a', 'b'] }), '$.pair[1]');
  });

  test('a json field passes anything through, dates included', () => {
    const slot = {
      pair: ['a', 1],
      color: 'red',
      level: 1,
      note: null,
      blob: [{ at: added }, 1, 'x', null],
    };
    expect(toJs('Slot', toBytes('Slot', slot))).toEqual(slot);
  });
});

describe('containers', () => {
  test('arrays type their items and name the index of a bad one', () => {
    const slots = [
      { pair: ['a', 1], color: 'red', level: 1, note: null, blob: null },
      { pair: ['b', 2], color: 'green', level: 2, note: 'n', blob: 1 },
    ];
    expect(toJs('inbox/slots', toBytes('inbox/slots', slots))).toEqual(slots);
    rejects(
      () => toJs('inbox/slots', encode([slots[0], { ...slots[1], pair: ['b', 'two'] }])),
      '$[1].pair[1]',
    );
    rejects(() => toBytes('inbox/slots', 'nope'), 'expected an array');
  });

  test('records keep their keys in order and type their values', () => {
    const item = { ...itemAdded, meta: { z: 1, a: 2 } };
    const out = toJs('Item', toBytes('Item', item)) as { meta: Record<string, number> };
    expect(Object.keys(out.meta)).toEqual(['z', 'a']);
    rejects(() => toJs('Item', encode({ ...item, meta: { z: 'one' } })), '$.meta.z');
  });

  test('accepts the wider container headers some writers use', () => {
    // a map16 header for a one-entry map, and an array16 header for a two-item tuple
    const map16 = new Uint8Array([0xde, 0, 1, ...encode('book'), ...encode('b1')]);
    expect(toJs('Target', map16)).toEqual({ book: 'b1' });
    const slot = { pair: ['a', 1], color: 'red', level: 1, note: null, blob: null };
    const bytes = encode(slot);
    const i = bytes.indexOf(0x92);
    const arr16 = new Uint8Array([...bytes.subarray(0, i), 0xdc, 0, 2, ...bytes.subarray(i + 1)]);
    expect((toJs('Slot', arr16) as { pair: unknown }).pair).toEqual(['a', 1]);
  });
});

describe('the whole value', () => {
  test('trailing bytes and truncated input are rejected', () => {
    const bytes = encode({ book: 'b1' });
    rejects(() => toJs('Target', new Uint8Array([...bytes, 0xc0])), 'trailing');
    rejects(() => toJs('Target', bytes.subarray(0, bytes.length - 1)), /truncated/);
  });

  test('an unknown type identity throws', () => {
    expect(() => toJs('Nope', encode(1))).toThrow(/Nope/);
  });

  test('convert answers a value in the same representation as it is', () => {
    const bytes = encode({ book: 'b1' });
    expect(reg.convert('Target', bytes, MSGPACK, MSGPACK)).toBe(bytes);
  });
});

describe('prepared fields', () => {
  test('an intake node is transparent: the client reads and writes its wire type', () => {
    const signUp = { type: 'sign-up', user: 'u1', password: 'hunter2' };
    expect(toJs('WriterMutations', toBytes('WriterMutations', signUp))).toEqual(signUp);
    rejects(() => toBytes('WriterMutations', { ...signUp, password: 7 }), '$.password');
    const leave = { type: 'leave', check: { kind: 'totp', code: '123456' } };
    expect(toJs('WriterMutations', toBytes('WriterMutations', leave))).toEqual(leave);
    rejects(
      () => toBytes('WriterMutations', { type: 'leave', check: { kind: 'password' } }),
      '$.check.password',
    );
  });
});

describe('the reserved identities', () => {
  test('.json and .mutation pass values through, bytes included', () => {
    const record = { epoch: 'e', position: 3, applied: -1, when: added };
    expect(toJs('.json', toBytes('.json', record))).toEqual(record);
    const mutation = { id: C1, series: 's1', n: 2, data: encode({ type: 'noted' }) };
    const back = toJs('.mutation', toBytes('.mutation', mutation)) as Mutation<Uint8Array>;
    expect([back.id, back.series, back.n]).toEqual([C1, 's1', 2]);
    expect(decode(back.data)).toEqual({ type: 'noted' });
    const unnumbered = { ...mutation, series: null, n: null };
    const again = toJs('.mutation', toBytes('.mutation', unnumbered)) as Mutation<Uint8Array>;
    expect([again.series, again.n]).toEqual([null, null]);
  });

  test('.edits reads a raw edit as its envelope alone, its payload unread', () => {
    const raw = encode([[7, 'catalog', 3, c1, added, 1], 0, 'catalog!item:i1', itemAdded]);
    expect(toJs('.edits', raw)).toEqual({
      position: 7,
      slice: 'catalog',
      seq: 3,
      id: C1,
      servertime: added,
      lifecycle: 'birth',
    });
    // a payload the envelope's reader never looks at, opcodes and all
    const odd = encode([[8, 'inbox:acme,u1', 1, c1, added, 2], 9, 'nonsense']);
    expect((toJs('.edits', odd) as { lifecycle: string }).lifecycle).toBe('death');
  });

  test('.edits skips envelope elements a later protocol appends', () => {
    const raw = encode([[7, 'catalog', 3, c1, added, 0, 'newer', { x: 1 }], 1, 'catalog!k']);
    expect((toJs('.edits', raw) as { seq: number }).seq).toBe(3);
  });

  test('.edits rejects a bad envelope', () => {
    rejects(() => toJs('.edits', encode([[7, 'catalog', 3, c1, 1700000000000, 0]])), 'timestamp');
    rejects(() => toJs('.edits', encode([[7, 'catalog', 3, 'c1', added, 0]])), 'bin');
    rejects(() => toJs('.edits', encode([[7, 'catalog', 3, c1, added, 3]])), 'lifecycle 3');
    rejects(() => toJs('.edits', encode([[7, 'catalog', 3, c1, added]])), 'short envelope');
  });

  test('.edits converts from msgpack only, and a .page never converts', () => {
    const env = { position: 7, slice: 'catalog', seq: 3, id: C1, servertime: added };
    rejects(() => toBytes('.edits', { ...env, lifecycle: 'normal' }), 'msgpack only');
    const page = encode(0);
    rejects(() => toJs('.page', page), 'never converted');
    rejects(() => toBytes('.page', page), 'never converted');
    expect(reg.convert('.page', page, MSGPACK, MSGPACK)).toBe(page);
  });
});

describe('the operations of edits and pages', () => {
  const cat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

  test("an edit's operations follow its envelope: sets with their values undecoded, and deletions", () => {
    const raw = encode([
      [7, 'catalog', 3, c1, added, 0],
      0,
      'catalog!item:i1',
      itemAdded,
      1,
      'catalog!item:i0',
      0,
      'catalog!count',
      null,
    ]);
    const ops = reg.ops(raw, true);
    expect(ops.map(([k, v]) => [k, v === undefined ? undefined : decode(v)])).toEqual([
      ['catalog!item:i1', itemAdded],
      ['catalog!item:i0', undefined],
      ['catalog!count', null],
    ]);
    // each value is its bytes as the edit holds them, the item's map included
    expect(ops[0][1]).toEqual(encode(itemAdded));
    expect(ops[2][1]).toEqual(Uint8Array.of(0xc0));
  });

  test('an edit with no operations, as a death has, answers none', () => {
    expect(reg.ops(encode([[7, 'catalog', 3, c1, added, 2]]), true)).toEqual([]);
  });

  test("a page's operations run to the end of its bytes, with no envelope", () => {
    const page = cat(
      encode(0),
      encode('catalog!a'),
      encode({ x: [1, 2] }),
      encode(0),
      encode('catalog!b'),
      encode('two'),
    );
    const ops = reg.ops(page, false);
    expect(ops.map(([k, v]) => [k, decode(v!)])).toEqual([
      ['catalog!a', { x: [1, 2] }],
      ['catalog!b', 'two'],
    ]);
    expect(reg.ops(new Uint8Array(0), false)).toEqual([]);
  });

  test('an unknown opcode, or an operation cut short, throws', () => {
    expect(() => reg.ops(encode([[7, 'c', 3, c1, added, 0], 2, 'c!k']), true)).toThrow(
      'unknown opcode 2',
    );
    expect(() => reg.ops(encode([[7, 'c', 3, c1, added, 0], 0, 'c!k']), true)).toThrow(/truncated/);
    expect(() => reg.ops(cat(encode(0), encode('c!k')), false)).toThrow(/truncated/);
    expect(() => reg.ops(cat(encode(5), encode('c!k')), false)).toThrow('unknown opcode 5');
  });
});

describe('values from a newer schema', () => {
  const shelf = { id: 's1', main: { book: 'b1' } };

  test('an unknown member in an optional field reads as absent', () => {
    expect(toJs('Shelf', encode({ ...shelf, target: { isbn: 'x' }, color: 'blue' }))).toEqual(
      shelf,
    );
    // a tuple holding one fails, and so does the optional field holding the tuple
    expect(toJs('Shelf', encode({ ...shelf, located: ['a', { isbn: 'x' }] }))).toEqual(shelf);
    expect(toJs('Shelf', encode({ ...shelf, located: ['a', { book: 'b' }] }))).toEqual({
      ...shelf,
      located: ['a', { book: 'b' }],
    });
  });

  test("an unknown member in an array's or a record's element drops the element", () => {
    const targets = [{ book: 'b1' }, { isbn: 'x' }, { edition: 'e1' }];
    const byName = { a: { book: 'b1' }, b: { isbn: 'x' }, c: { edition: 'e1' } };
    expect(toJs('Shelf', encode({ ...shelf, targets, byName }))).toEqual({
      ...shelf,
      targets: [{ book: 'b1' }, { edition: 'e1' }],
      byName: { a: { book: 'b1' }, c: { edition: 'e1' } },
    });
    // a member's failure in a required field bubbles up to the element that holds it
    const slot = { pair: ['a', 1], color: 'red', level: 1, note: null, blob: null };
    expect(toJs('inbox/slots', encode([slot, { ...slot, color: 'blue' }, slot]))).toEqual([
      slot,
      slot,
    ]);
  });

  test('an unknown member in a required field fails the whole value', () => {
    rejects(() => toJs('Shelf', encode({ ...shelf, main: { isbn: 'x' } })), '$.main');
    rejects(() => toJs('Target', encode({ isbn: 'x' })), 'book, edition');
  });

  test('a known field that fails to decode is an error, even in an optional field', () => {
    rejects(() => toJs('Shelf', encode({ ...shelf, target: { book: 7 } })), '$.target.book');
    rejects(() => toJs('Shelf', encode({ ...shelf, targets: [{ book: 7 }] })), '$.targets[0].book');
  });

  test("a mutation's unknown member is an error wherever it sits", () => {
    const addItem = { type: 'add-item', id: 'i1', title: 'Dune', added };
    expect(toJs('WriterMutations', encode({ ...addItem, color: 'red' }))).toEqual({
      ...addItem,
      color: 'red',
    });
    rejects(() => toJs('WriterMutations', encode({ ...addItem, color: 'blue' })), '$.color');
    rejects(() => toBytes('WriterMutations', { ...addItem, color: 'blue' }), '$.color');
  });
});

describe('queries', () => {
  test('a query call and its result go through the registry like any value', () => {
    const call = ['AdminQueries.patronsSince', added, null];
    expect(toJs('AdminQuery', toBytes('AdminQuery', call))).toEqual(call);
    expect(toJs('AdminQuery', encode(['AdminQueries.allPatrons']))).toEqual([
      'AdminQueries.allPatrons',
    ]);
    rejects(() => toJs('AdminQuery', encode(['AdminQueries.nope'])), 'nope');
    const result = [{ id: 'p1', since: added }];
    expect(
      toJs('AdminQueries.allPatrons#result', toBytes('AdminQueries.allPatrons#result', result)),
    ).toEqual(result);
  });
});
