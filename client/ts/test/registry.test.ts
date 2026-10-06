// The interpreted walk over the type registry: msgpack bytes to rich values and back, checked
// against the schema on both sides, plus the host's reserved identities.

import { decode, encode } from '@msgpack/msgpack';
import { describe, expect, test } from 'vitest';
import { JS, MSGPACK, type Schema, type SchemaNode } from '../src/contract.js';
import { buildRegistry, ConvertError } from '../src/registry.js';

// a schema shaped like the emitter's output for a small model: the catalog and inbox slices, the
// writer engine's commands, two prepared fields, and a query interface
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
const CatalogEvents = add([
  'union',
  'CatalogEvents',
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
const CommandAuthWire = add([
  'union',
  'CommandAuth',
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
const CommandAuth = add(['intake', 'CommandAuth', CommandAuthWire]);
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
    ['check', CommandAuth, false],
  ],
  0,
]);
const WriterCommands = add([
  'union',
  'WriterCommands',
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

const schema: Schema = {
  nodes,
  ids: {
    Item,
    Target,
    ItemAdded,
    ItemRemoved,
    Noted,
    CatalogEvents,
    Slot,
    'inbox/slots': Slots,
    Profile,
    AddItem,
    SignUp,
    Leave,
    WriterCommands,
    'PasswordHash': STR,
    'catalog/count': INT,
    PatronInfo,
    AdminQuery,
    'AdminQueries.allPatrons#result': Patrons,
    'AdminQueries.patronsSince#result': Patrons,
  },
  commands: 'WriterCommands',
  eventTypes: { catalog: 'CatalogEvents', inbox: 'CatalogEvents' },
  storeTypes: {
    'catalog/item': 'Item',
    'catalog/count': 'catalog/count',
    'inbox/profile': 'Profile',
    'inbox/slots': 'inbox/slots',
  },
};

const reg = buildRegistry(schema);

const added = new Date('2026-01-02T03:04:05.678Z');
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
    const bytes = toBytes('CatalogEvents', { id: 'i1', title: 'Dune', added, type: 'item-added' });
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

  test('are rejected for the commands identity, reading and writing', () => {
    rejects(() => toJs('WriterCommands', encode({ ...extra, type: 'add-item' })), '$.surprise');
    rejects(() => toBytes('WriterCommands', { ...extra, type: 'add-item' }), '$.surprise');
  });

  test('are dropped for every other identity, reading and writing', () => {
    expect(toJs('CatalogEvents', encode(extra))).toEqual(itemAdded);
    expect(toJs('Item', encode(extra))).toEqual({ id: 'i1', title: 'Dune', added });
    expect(plain(toBytes('CatalogEvents', extra))).toEqual(itemAdded);
    // nested too
    const nested = { ...itemAdded, type: 'item-removed', target: { book: 'b1', shelf: 3 } };
    const out = toJs('CatalogEvents', encode(nested)) as { target: unknown };
    expect(out.target).toEqual({ book: 'b1' });
  });
});

describe('unions', () => {
  test('dispatches on a literal field wherever it sits in the map', () => {
    const last = { id: 'n1', text: 'hi', note: 'n1', type: 'noted' };
    expect(toJs('CatalogEvents', encode(last))).toEqual({ type: 'noted', note: 'n1', text: 'hi' });
    rejects(() => toJs('CatalogEvents', encode({ type: 'bogus', id: 'x' })), 'bogus');
    rejects(() => toJs('CatalogEvents', encode({ id: 'x' })), 'type');
    rejects(() => toBytes('CatalogEvents', { type: 'bogus' }), 'bogus');
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
      () => toJs('inbox/slots', encode([slots[0], { ...slots[1], color: 'blue' }])),
      '$[1].color',
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
    expect(toJs('WriterCommands', toBytes('WriterCommands', signUp))).toEqual(signUp);
    rejects(() => toBytes('WriterCommands', { ...signUp, password: 7 }), '$.password');
    const leave = { type: 'leave', check: { kind: 'totp', code: '123456' } };
    expect(toJs('WriterCommands', toBytes('WriterCommands', leave))).toEqual(leave);
    rejects(
      () => toBytes('WriterCommands', { type: 'leave', check: { kind: 'password' } }),
      '$.check.password',
    );
  });
});

describe('the reserved identities', () => {
  test('.json and .command pass values through, bytes included', () => {
    const record = { epoch: 'e', position: 3, reduced: -1, when: added };
    expect(toJs('.json', toBytes('.json', record))).toEqual(record);
    const command = { id: 'c1', data: encode({ type: 'noted' }) };
    const back = toJs('.command', toBytes('.command', command)) as { id: string; data: Uint8Array };
    expect(back.id).toBe('c1');
    expect(decode(back.data)).toEqual({ type: 'noted' });
  });

  test(".event reads the wire pair into a DbEvent, typing its data by the stream's family", () => {
    const raw = encode([[7, 'catalog', 3, 'c1', added], { ...itemAdded }]);
    expect(toJs('.event', raw)).toEqual({
      position: 7,
      stream: 'catalog',
      seq: 3,
      id: 'c1',
      servertime: added,
      data: itemAdded,
    });
    // a family's parameters do not change its type
    const inbox = encode([
      [8, 'inbox:acme,u1', 1, 'c2', added],
      { type: 'noted', note: 'n', text: 't' },
    ]);
    expect((toJs('.event', inbox) as { data: unknown }).data).toEqual({
      type: 'noted',
      note: 'n',
      text: 't',
    });
  });

  test('.event writes a DbEvent back as the wire pair', () => {
    const ev = {
      position: 7,
      stream: 'catalog',
      seq: 3,
      id: 'c1',
      servertime: added,
      data: itemAdded,
    };
    expect(plain(toBytes('.event', ev))).toEqual([[7, 'catalog', 3, 'c1', added], itemAdded]);
  });

  test('.event skips envelope elements a later protocol appends', () => {
    const raw = encode([[7, 'catalog', 3, 'c1', added, 'newer', { x: 1 }], itemAdded]);
    expect((toJs('.event', raw) as { data: unknown }).data).toEqual(itemAdded);
  });

  test('.event passes system events through untyped', () => {
    const birth = encode([[1, 'catalog', 1, 'c1', added], { $sys: 'birth' }]);
    expect((toJs('.event', birth) as { data: unknown }).data).toEqual({ $sys: 'birth' });
  });

  test('.event rejects a bad envelope, data that fails its type, and an unknown family', () => {
    rejects(
      () => toJs('.event', encode([[7, 'catalog', 3, 'c1', 1700000000000], itemAdded])),
      'servertime',
    );
    rejects(
      () => toJs('.event', encode([[7, 'catalog', 3, 'c1', added], { type: 'bogus' }])),
      'bogus',
    );
    rejects(() => toJs('.event', encode([[7, 'nowhere:x', 3, 'c1', added], itemAdded])), 'nowhere');
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
