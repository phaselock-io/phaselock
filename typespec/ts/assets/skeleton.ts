// utils //////////////////////////////////////////////////////////////////////

// the global's type, since the tooling has no Node types
declare const process: { env: Record<string, string | undefined> };

/** DEV is the switch every bundler and host honors.  Dev mode adds checks that catch app mistakes
    production would let pass, and never changes results.  Bundlers replace the expression at build
    time, Node reads the variable, and a host without `process` defines it before loading the
    bundle. */
export const DEV = process.env.NODE_ENV !== 'production';

/** jsonTypeof names a value's json type, which the generated dispatch over a union's members
    branches on when they differ by it */
export function jsonTypeof(val: any): string {
  const t = typeof val;
  if (t === 'object') {
    if (val === null) return 'null';
    if (Array.isArray(val)) return 'array';
  }
  return t;
}

export function setdefault<T>(obj: Record<string, T>, key: string, dfault: T): T {
  if (key in obj) {
    return obj[key];
  } else {
    obj[key] = dfault;
    return dfault;
  }
}

const NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

/** A cancellation signal, as the Engine and its connectors use one: whether it has fired and why,
    and a listener for when it does.  A browser's or Node's AbortSignal is one. */
export interface Signal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** what makes a Signal and fires it, as an AbortController does */
export type SignalController = { readonly signal: Signal; abort(reason?: unknown): void };

/** What the Engine needs from its host beyond ES2022, read from globalThis.  A browser and Node
    provide all of it.  A host embedding a JS engine (QuickJS, goja, JavaScriptCore) installs it:
    timers that run their callback on the JS thread; an AbortController whose signals, and those
    AbortSignal.any combines, are of the host's own kind, for its connectors to use as they are,
    each firing its abort listeners on the JS thread; and randomness for command ids and sessions,
    as crypto.getRandomValues or a generateUuid of its own.  An Engine checks for them when
    built. */
export type HostGlobals = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
  AbortController: new () => SignalController;
  AbortSignal: { any(signals: Signal[]): Signal };
  crypto?: { getRandomValues(bytes: Uint8Array): Uint8Array };
  generateUuid?: () => string;
};

const host = globalThis as unknown as HostGlobals;

// throw naming whatever of HostGlobals the host lacks
function checkHost(): void {
  const missing: string[] = [];
  if (typeof host.setTimeout !== 'function') missing.push('setTimeout');
  if (typeof host.clearTimeout !== 'function') missing.push('clearTimeout');
  if (typeof host.AbortController !== 'function') missing.push('AbortController');
  if (typeof host.AbortSignal?.any !== 'function') missing.push('AbortSignal.any');
  if (
    typeof host.generateUuid !== 'function' &&
    typeof host.crypto?.getRandomValues !== 'function'
  ) {
    missing.push('crypto.getRandomValues or generateUuid');
  }
  if (missing.length > 0) {
    throw new Error(`the host lacks what the Engine needs: ${missing.join(', ')}`);
  }
}

// a fresh command id: the host's own uuid when it mints them, else a version 4 uuid from its
// randomness; lower-case, as the id a connector decodes from an envelope is
function generateUuid(): string {
  if (host.generateUuid !== undefined) return host.generateUuid().toLowerCase();

  // 128 random bits, marked as RFC 4122 version 4
  const values = host.crypto!.getRandomValues(new Uint8Array(16));
  values[6] = 0x40 | (values[6] & 0x0f);
  values[8] = 0x80 | (values[8] & 0x3f);

  // in hex, grouped 8-4-4-4-12
  let out = '';
  values.forEach((x) => {
    out += NIBBLE[x >>> 4] + NIBBLE[x & 0x0f];
  });
  return [
    out.substring(0, 8),
    out.substring(8, 12),
    out.substring(12, 16),
    out.substring(16, 20),
    out.substring(20, 32),
  ].join('-');
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// a fresh session: 16 random bytes as 22 base64url characters, or the host's own uuid when it has
// no randomness to give
function generateSession(): string {
  if (host.crypto === undefined) return generateUuid();
  const values = host.crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let count = 0;
  let out = '';
  for (const x of values) {
    bits = (bits << 8) | x;
    count += 8;
    while (count >= 6) {
      count -= 6;
      out += BASE64URL[(bits >>> count) & 0x3f];
    }
  }
  return out + BASE64URL[(bits << (6 - count)) & 0x3f];
}

// a value is a tree, so nothing legitimate nests this deep
const MAX_DEPTH = 1000;

/** A copy that shares nothing with the original, for values in the registry's JS form: plain
    objects, arrays, Map, Set, Date, and byte arrays.  A cycle throws, and shared substructure is
    copied once per reference, as a msgpack round trip would. */
export function deepCopy<T>(base: T, depth = 0): T {
  switch (typeof base) {
    case 'boolean':
    case 'bigint':
    case 'number':
    case 'string':
    case 'undefined':
      // these types are already immutable
      return base;

    case 'object':
      // null handled here
      if (base === null) return base;
      // general objects handled below
      break;

    case 'symbol':
    case 'function':
    default:
      throw new Error(`base of type "${typeof base}" not handled by deepCopy`);
  }
  if (depth > MAX_DEPTH) throw new Error('deepCopy: value too deep, a cycle?');

  // object handling
  const d = depth + 1;
  if (Array.isArray(base)) return base.map((v) => deepCopy(v, d)) as T;
  if (base instanceof Map) {
    const out = new Map();
    for (const [k, v] of base) out.set(k, deepCopy(v, d));
    return out as T;
  }
  if (base instanceof Set) return new Set(base) as T; // object keys not allowed anyway
  if (base instanceof Date) return new Date(base) as T;
  if (ArrayBuffer.isView(base)) return (base as unknown as Uint8Array).slice() as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, deepCopy(v, d)])) as T;
}

// what a read-only proxy throws: the path names the value as the query saw it
function readOnlyError(label: string, op: string, prop?: PropertyKey): never {
  const at = prop === undefined ? label : `${label}.${String(prop)}`;
  throw new Error(`${at} is read-only: ${op}`);
}

/** A view of a value that throws on any mutation, naming the path from `label`.  Typed arrays are
    the one kind handed through as they are: nothing short of a Proxy catches a write to one, and a
    Proxy is not a typed array to native code, so a write to bytes goes uncaught. */
export function readOnly<T>(base: T, label = 'value'): Readonly<T> {
  switch (typeof base) {
    case 'boolean':
    case 'bigint':
    case 'number':
    case 'string':
    case 'undefined':
      // these types are already immutable
      return base;

    case 'object':
      // null handled here
      if (base === null) return base;
      // general objects handled below
      break;

    case 'symbol':
    case 'function':
    default:
      throw new Error(`base of type "${typeof base}" not handled by readOnly`);
  }

  // object handling
  if (Array.isArray(base)) return readOnlyArray(base, label) as T;
  if (base instanceof Map) return readOnlyMap(base, label) as T;
  if (base instanceof Set) return readOnlySet(base, label) as T;
  if (base instanceof Date) return readOnlyDate(base, label) as T;
  if (ArrayBuffer.isView(base)) return base;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return readOnlyObject(base as any, label) as T;
}

function readOnlyObject<T>(base: Record<string, T>, label: string): Readonly<Record<string, T>> {
  const cache: Record<string, any> = {};
  const at = (prop: PropertyKey) => `${label}.${String(prop)}`;

  return new Proxy(base, {
    defineProperty: (_, prop) => readOnlyError(label, 'defineProperty', prop),
    deleteProperty: (_, prop) => readOnlyError(label, 'delete', prop),
    set: (_, prop) => readOnlyError(label, 'set', prop),
    get(_, prop: any) {
      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop], at(prop));
        cache[prop] = value;
        return value;
      }

      const value = base[prop];

      if (value === undefined) {
        return value;
      }

      if (value instanceof Function) {
        return (...args: any[]) => value.apply(base, args);
      }

      const ro = readOnly(value, at(prop));
      cache[prop] = ro;
      return ro;
    },
  });
}

function readOnlyArray<T>(base: T[], label: string): Readonly<T[]> {
  const cache = Array(base.length);
  let filled = false;
  const at = (n: PropertyKey) => `${label}[${String(n)}]`;

  function dirty1(n: number): T | undefined {
    if (Object.hasOwn(cache, n)) return cache[n];
    if (!Object.hasOwn(base, n)) return undefined;
    const ro = readOnly(base[n], at(n));
    cache[n] = ro;
    return ro;
  }

  function dirtyAll() {
    // all items at once
    if (filled) return cache;
    filled = true;
    for (const n of base.keys()) dirty1(n);
    return cache;
  }

  const roArrayMethods: any = {
    // special
    at: (index: number) => dirty1(index > -1 ? index : base.length + index),

    // things which require dirtyAll(), then run against the full shallow copy
    concat: (...args: any) => base.concat.apply(dirtyAll(), args),
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    every: (...args: any) => base.every.apply(dirtyAll(), args),
    filter: (...args: any) => base.filter.apply(dirtyAll(), args),
    find: (...args: any) => base.find.apply(dirtyAll(), args),
    findIndex: (...args: any) => base.findIndex.apply(dirtyAll(), args),
    findLast: (...args: any) => (base as any).findLast.apply(dirtyAll(), args),
    findLastIndex: (...args: any) => (base as any).findLastIndex.apply(dirtyAll(), args),
    flat: (...args: any) => base.flat.apply(dirtyAll(), args),
    flatMap: (...args: any) => base.flatMap.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    map: (...args: any) => base.map.apply(dirtyAll(), args),
    reduce: (...args: any) => base.reduce.apply(dirtyAll(), args),
    reduceRight: (...args: any) => base.reduceRight.apply(dirtyAll(), args),
    slice: (...args: any) => base.slice.apply(dirtyAll(), args),
    some: (...args: any) => base.some.apply(dirtyAll(), args),
    toReversed: (...args: any) => (base as any).toReversed.apply(dirtyAll(), args),
    toSorted: (...args: any) => (base as any).toSorted.apply(dirtyAll(), args),
    toSpliced: (...args: any) => (base as any).toSpliced.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    with: (...args: any) => (base as any).with.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // safe getters
    indexOf: (...args: any) => (base as any).indexOf(...args),
    join: (...args: any) => (base as any).join(...args),
    keys: (...args: any) => (base as any).keys(...args),
    lastIndexOf: (...args: any) => (base as any).lastIndexOf(...args),
    toLocaleString: (...args: any) => (base as any).toLocaleString(...args),
    toString: (...args: any) => (base as any).toString(...args),

    // disallowed
    push: () => readOnlyError(label, 'push'),
    pop: () => readOnlyError(label, 'pop'),
    shift: () => readOnlyError(label, 'shift'),
    reverse: () => readOnlyError(label, 'reverse'),
    copyWithin: () => readOnlyError(label, 'copyWithin'),
    fill: () => readOnlyError(label, 'fill'),
    sort: () => readOnlyError(label, 'sort'),
    splice: () => readOnlyError(label, 'splice'),
    unshift: () => readOnlyError(label, 'unshift'),
  };

  return new Proxy(base, {
    defineProperty: (_, prop) => readOnlyError(label, 'defineProperty', prop),
    deleteProperty: (_, prop) => readOnlyError(label, 'delete', prop),
    set: (_, prop) => readOnlyError(label, 'set', prop),

    get(_, prop: any) {
      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop], at(prop));
        cache[prop] = value;
        return value;
      }

      const method = roArrayMethods[prop];
      if (method) return method;

      return base[prop];
    },
  });
}

// a read-only Date carries its label on itself, since the setters live on one shared prototype
const labelSym = Symbol();
const DATE_SETTERS = [
  'setDate',
  'setFullYear',
  'setHours',
  'setMilliseconds',
  'setMinutes',
  'setMonth',
  'setSeconds',
  'setTime',
  'setUTCDate',
  'setUTCFullYear',
  'setUTCHours',
  'setUTCMilliseconds',
  'setUTCMinutes',
  'setUTCMonth',
  'setUTCSeconds',
  'setYear',
];
const roDatePrototype: Record<string, unknown> = {};
for (const m of DATE_SETTERS) {
  roDatePrototype[m] = function (this: Record<symbol, string>) {
    return readOnlyError(this[labelSym], m);
  };
}
Object.setPrototypeOf(roDatePrototype, Date.prototype);

function readOnlyDate(base: Date, label: string): Readonly<Date> {
  // copy instead of proxy
  const out = new Date(base);
  Object.setPrototypeOf(out, roDatePrototype);
  (out as unknown as Record<symbol, string>)[labelSym] = label;
  return out;
}

function readOnlyMap<K, V>(base: Map<K, V>, label: string): Readonly<Map<K, Readonly<V>>> {
  const cache: Map<K, Readonly<V>> = new Map();
  let filled = false;
  const at = (k: K) => `${label}[${String(k)}]`;

  function dirty1(k: K): V | undefined {
    if (filled || cache.has(k)) return cache.get(k);
    if (!base.has(k)) return undefined;
    const ro = readOnly(base.get(k)!, at(k));
    cache.set(k, ro);
    return ro;
  }

  function dirtyAll() {
    if (filled) return cache;
    filled = true;
    for (const k of base.keys()) {
      if (cache.has(k)) continue;
      cache.set(k, readOnly(base.get(k)!, at(k)));
    }
    return cache;
  }

  const roMapMethods: any = {
    // special
    get: (key: any) => dirty1(key),

    // requires dirtyAll
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // passthru
    has: (...args: any[]) => (base as any).has(...args),
    keys: (...args: any[]) => (base as any).keys(...args),

    // mutators
    clear: () => readOnlyError(label, 'clear'),
    delete: () => readOnlyError(label, 'delete'),
    getOrInsert: () => readOnlyError(label, 'getOrInsert'),
    getOrInsertComputed: () => readOnlyError(label, 'getOrInsertComputed'),
    set: () => readOnlyError(label, 'set'),
  };
  Object.setPrototypeOf(roMapMethods, null);

  return new Proxy(base, {
    defineProperty: (_, prop) => readOnlyError(label, 'defineProperty', prop),
    deleteProperty: (_, prop) => readOnlyError(label, 'delete', prop),
    set: (_, prop) => readOnlyError(label, 'set', prop),

    get(_, prop: any) {
      const method = roMapMethods[prop];
      if (method) return method;

      return (base as any)[prop];
    },
  });
}

// no cache needed, since we don't support object keys and there are no values
function readOnlySet<K>(base: Set<K>, label: string): Readonly<Set<K>> {
  return new Proxy(base, {
    defineProperty: (_, prop) => readOnlyError(label, 'defineProperty', prop),
    deleteProperty: (_, prop) => readOnlyError(label, 'delete', prop),
    set: (_, prop) => readOnlyError(label, 'set', prop),

    get(_, prop: any) {
      // just disallow mutations
      if (prop === 'add' || prop === 'delete' || prop === 'clear') {
        return () => readOnlyError(label, prop);
      }

      const value = (base as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(base, args);
      }
      return value;
    },
  });
}

// store //////////////////////////////////////////////////////////////////////

/* A transactional key-value store, whose values travel in one of several representations, and a
   Registry that converts between them. */

/** The representations a value can be in: JS is the rich JS value, HOST the host language's,
    MSGPACK the bytes.  Every get names the one it wants and every set the one it gives; a store
    converts to what it keeps on the way in and to what was asked for on the way out. */
export const JS = 1;
export const HOST = 2;
export const MSGPACK = 3;
export type Rep = typeof JS | typeof HOST | typeof MSGPACK;

/** Registry converts between representations of typed values and names the types the store
    holds.  Types are model names from the TypeSpec, plus three reserved names: `.json` for the
    Engine's own shapes; `.command` for the outbox envelope, `{id, session, n, data}` with `data`
    already the command's wire bytes, so it needs no vocabulary to read; and `.event` for a parked
    event, the wire pair `[env, data]` in `msgpack` and a DbEvent in `js`, its `data` converted
    through the union of the stream's slice. */
export interface Registry {
  /** a value of type `type`, given in one representation, in another */
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown;
  /** the commands union this engine may submit */
  commands: string;
  /** a family, a stream name before its first ':', to the slice's events union */
  eventTypes: Record<string, string>;
  /** family/name, a key's family and its local key's name, to the store value's type */
  storeTypes: Record<string, string>;
}

/** One type of the model, as the generated registry describes it; children are indices into
    the same node table.  A struct lists its fields in declaration order, and names the one it
    writes first, the field a union tells it apart from its other members by, or -1; a union
    carries the solver's decision tree; an intake node names a field the database prepares for
    precommit, over the wire type a client sends.  The identities of a struct, record, array,
    tuple, or union are its name, or null when the type has none. */
export type SchemaNode =
  | ['null']
  | ['int']
  | ['str']
  | ['bool']
  | ['date']
  | ['json']
  | ['lit', string | number | boolean]
  | [
      'struct',
      string | null,
      [key: string, type: number, optional: boolean][],
      discriminator: number,
    ]
  | ['record', string | null, number]
  | ['array', string | null, number]
  | ['tuple', string | null, number[]]
  | ['union', string | null, SchemaSolution]
  | ['intake', string, number];

/** How a walk tells a union's members apart.  `match` names the member.  `jsontype` branches on
    the value's json type, `literal` on its value, `length` on an array's length with a default
    for any other, `index` descends into an array element, `field` tests a field of the object
    without descending, and `hasfield` picks the first of its keys present. */
export type SchemaSolution =
  | ['match', number]
  | ['jsontype', [string, SchemaSolution][]]
  | ['literal', [string | number | boolean, SchemaSolution][]]
  | ['length', [number, SchemaSolution][], SchemaSolution | null]
  | ['index', number, SchemaSolution]
  | ['field', string, SchemaSolution]
  | ['hasfield', [string, SchemaSolution][]];

/** The type registry as data, generated per engine and per database: the model's types as a
    node table, the type identities the Registry answers for and their nodes, and what the
    Registry's `commands`, `eventTypes`, and `storeTypes` are.  Every engine and database of one
    model shares one node table.  A host walks it to convert values; the reserved identities are
    the host's own. */
export type Schema = {
  nodes: SchemaNode[];
  ids: Record<string, number>;
  /** the commands union, or null for a database with no commands */
  commands: string | null;
  eventTypes: Record<string, string>;
  storeTypes: Record<string, string>;
};

/** the type of a store key's value, from the Registry's storeTypes; undefined for a key no slice
    declares */
export function storeTypeOf(reg: Registry, key: string): string | undefined {
  const bang = key.indexOf('!');
  if (bang < 0) throw new Error(`invalid key has no '!': ${key}`);
  const stream = key.slice(0, bang);
  const local = key.slice(bang + 1);
  const name = (x: string) => {
    const i = x.indexOf(':');
    return i < 0 ? x : x.slice(0, i);
  };
  return reg.storeTypes[`${name(stream)}/${name(local)}`]!;
}

/** Keys sort in code-point order, which is the order of their UTF-8 bytes, so a store comparing
    UTF-8 keys bytewise (SQLite, LMDB) walks in the same order as the in-memory layers.  JS's own
    string comparison is UTF-16 code-unit order, which differs in one place: a surrogate pair,
    encoding a code point above U+FFFF, sorts below U+E000-U+FFFF.  Keys are well-formed UTF-16,
    holding no lone surrogate. */
export function compareKeys(a: string, b: string): number {
  // find the first code unit that differs
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === n) return a.length - b.length;

  // if both units are at or above the surrogates, move the surrogates above U+E000-U+FFFF
  let x = a.charCodeAt(i);
  let y = b.charCodeAt(i);
  if (x >= 0xd800 && y >= 0xd800) {
    x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
  }
  return x - y;
}

// a code unit at or above the surrogates; the two orders agree on keys unless both hold one
const HIGH_UNIT = /[\uD800-\uFFFF]/;

// code-unit order, exact in code-point order against a key holding no high unit
const unitCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// sort keys in place in code-point order
function sortKeys(keys: string[]): string[] {
  // the native sort is already right unless keys hold high units, and leaves them nearly in order
  keys.sort();
  if (keys.some((k) => HIGH_UNIT.test(k))) keys.sort(compareKeys);
  return keys;
}

/** the exclusive upper bound of the keys sharing prefix, which is prefix with its last code
    point incremented; undefined when no key lies above them all, as for the empty prefix */
export function prefixEnd(prefix: string): string | undefined {
  // a trailing U+10FFFF has no successor, so the bound comes from the code point before it
  let end = prefix;
  while (end.endsWith('\u{10FFFF}')) end = end.slice(0, -2);
  if (end === '') return undefined;

  // increment the last code point, a surrogate pair or a single unit, stepping over the
  // surrogates
  const pair = end.length >= 2 && end.codePointAt(end.length - 2)! > 0xffff;
  const at = pair ? end.length - 2 : end.length - 1;
  const cp = end.codePointAt(at)!;
  return end.slice(0, at) + String.fromCodePoint(cp === 0xd7ff ? 0xe000 : cp + 1);
}

export interface RTxn {
  /** the value at key in a representation, converted by the store; undefined when the key is
      absent */
  get(key: string, type: string, rep: Rep): unknown;
  scan(req: ScanRequest): StoreScan;
}

export interface WTxn extends RTxn {
  /** persist the value, given in a representation, in the one the store keeps */
  set(key: string, type: string, rep: Rep, value: unknown): void;
  del(key: string): void;
  /** delete every key under prefix; returns the keys deleted */
  delPrefix(prefix: string): string[];
  /** rekey every key under src to dst, never decoding a value; returns the keys as they now
      exist.  Callers never rekey into the source range. */
  move(src: string, dst: string): string[];
}

/** Store is the interface for running read and write transactions.  It is synchronous: a
    transaction runs fn to completion, committing when fn returns and rolling back when it
    throws, and a transaction method answers when it returns and fails by throwing.  A store
    holds a Registry and does its own conversions, in the host language.  Values cross the
    boundary by copy: what a get or scan hands out is the caller's, and what set is given is the
    store's from that call on, converted or copied then. */
export interface Store {
  write<T>(fn: (txn: WTxn) => T): T;
  read<T>(fn: (txn: RTxn) => T): T;
}

// key patterns ///////////////////////////////////////////////////////////////

/** A match on one template parameter: exactly one value, a range of values, the values starting
    with a prefix, or null for any value.  Values compare in code-point order, as keys do. */
export type ParamMatch =
  | null
  | { eq: string }
  | { prefix: string }
  | { gte?: string; gt?: string; lte?: string; lt?: string };

/** A KeyPattern picks out keys of one key template by a match on each of its parameters.
    `stream` is one stream by name, the empty name being the Engine's own stream; or a family and a
    match per family parameter; or null for every stream.  `name` is the local template's name, with
    a match per local parameter in `local`, or null for every local key of the streams matched,
    which a scan reads keys only, since the values of different templates differ in type.  Each
    separator in a key sorts below every character the parameter before it may hold, so the keys a
    pattern picks out come in the order of their parameters, stream ones first. */
export type KeyPattern = {
  stream: string | { family: string; params: ParamMatch[] } | null;
  name: string | null;
  local: ParamMatch[];
};

/** A scan walks the keys a pattern picks out in code-point order, or reversed, one batch at a
    time, from the start or from just past the key `after`.  It is a walk, not a snapshot: a batch
    is a fresh seek from where the last one ended, so a key written ahead of the walk is visited
    and one written behind it is not. */
export type ScanRequest = {
  pattern: KeyPattern;
  reverse?: boolean;
  after?: string;
  // entries per batch, at least 1
  limit: number;
  // keys only, or values of this type in this representation
  values: false | { type: string; rep: Rep };
};

/** one batch; a keys-only scan carries undefined values; next is the batch's last key when more
    follow, to pass as `after`, and null when the walk is done */
export type StoreScan = { entries: [string, unknown][]; next: string | null };

/** every entry a scan picks out, batch by batch */
export function scanAll(txn: RTxn, req: ScanRequest): [string, unknown][] {
  const all: [string, unknown][] = [];
  let after = req.after;
  for (;;) {
    const { entries, next } = txn.scan({ ...req, after });
    for (const e of entries) all.push(e);
    if (next === null) return all;
    after = next;
  }
}

/* A pattern compiles to the text every key it picks out starts with, then its fields in key order:
   a value field per parameter, with its bounds and the separator that follows it ('' after the
   last one of a key), and between the stream's fields and the local ones a literal, the local
   template's name with the ':' that follows it when it has parameters.  The literal matches as
   text, not as an ordered value, since a name may hold characters that sort below ':'. */
type ValueField = {
  literal: false;
  lo: string | undefined;
  loOpen: boolean;
  hi: string | undefined;
  hiOpen: boolean;
  // a comparison exact against the bounds
  cmp: (a: string, b: string) => number;
  // whether the field admits one value only
  single: boolean;
  sep: string;
};
type LiteralField = { literal: true; text: string; whole: boolean };
type CompiledPattern = { head: string; fields: (ValueField | LiteralField)[] };

// a value field matching m, followed by sep
function valueField(m: ParamMatch, sep: string): ValueField {
  const f: ValueField = {
    literal: false,
    lo: undefined,
    loOpen: false,
    hi: undefined,
    hiOpen: false,
    cmp: unitCompare,
    single: false,
    sep,
  };

  // the bounds of each kind of match; a range keeps the tighter of each pair it gives
  if (m === null) return f;
  if ('eq' in m) {
    f.lo = f.hi = m.eq;
    f.single = true;
  } else if ('prefix' in m) {
    if (m.prefix === '') return f;
    f.lo = m.prefix;
    f.hi = prefixEnd(m.prefix);
    f.hiOpen = true;
  } else {
    f.lo = m.gte;
    if (m.gt !== undefined && (f.lo === undefined || compareKeys(m.gt, f.lo) >= 0)) {
      f.lo = m.gt;
      f.loOpen = true;
    }
    f.hi = m.lte;
    if (m.lt !== undefined && (f.hi === undefined || compareKeys(m.lt, f.hi) <= 0)) {
      f.hi = m.lt;
      f.hiOpen = true;
    }
  }
  f.cmp = exactFor([f.lo, f.hi]);
  return f;
}

function compilePattern(p: KeyPattern): CompiledPattern {
  const fields: CompiledPattern['fields'] = [];
  const s = p.stream;

  // every key
  if (s === null) {
    if (p.name !== null || p.local.length > 0) {
      throw new Error('a pattern over every stream picks out every local key');
    }
    return { head: '', fields };
  }

  // the streams: one by name, or a family's with a field per parameter
  let head: string;
  if (typeof s === 'string') {
    head = `${s}!`;
  } else if (s.params.length === 0) {
    head = `${s.family}!`;
  } else {
    head = `${s.family}:`;
    const n = s.params.length;
    s.params.forEach((m, i) => fields.push(valueField(m, i < n - 1 ? ',' : '!')));
  }

  // every local key of the streams, or one template's, its name a literal
  if (p.name === null) {
    if (p.local.length > 0) throw new Error('a pattern over every local key matches no parameter');
    return { head, fields };
  }
  const n = p.local.length;
  fields.push({ literal: true, text: n > 0 ? `${p.name}:` : p.name, whole: n === 0 });
  p.local.forEach((m, i) => fields.push(valueField(m, i < n - 1 ? ',' : '')));
  return { head, fields };
}

/** where a key stands against a pattern, for a walk one way: a match, a key to step past, the end
    of the walk, or the target of a seek to the next key that may match */
type Placement =
  { kind: 'match' | 'step' | 'done' } | { kind: 'seek'; target: string; strict: boolean };

const MATCH: Placement = { kind: 'match' };
const STEP: Placement = { kind: 'step' };
const DONE: Placement = { kind: 'done' };
const seekTo = (target: string, strict: boolean): Placement => ({ kind: 'seek', target, strict });

// the character just above a separator, so text ending in it sorts after every key that
// continues past the separator
const above = (sep: string) => String.fromCharCode(sep.charCodeAt(0) + 1);

/* Place a key the way a skip scan does.  The first field outside its match decides: a field short
   of its match seeks to where the match begins, and a field past it seeks past every key holding
   the value of the nearest field before it that admits more than one, or ends the walk when no
   such field does.  Seek targets are in walk order: a seek forward lands on the first key at or
   past its target, and one in reverse on the last key at or before it. */
function placeKey(c: CompiledPattern, key: string, reverse: boolean): Placement {
  if (!key.startsWith(c.head)) return DONE;

  // the end of each value field's text so far, by field
  const ends: number[] = [];

  // past every key holding the value of the nearest varying field before field i
  const skipBack = (i: number): Placement => {
    for (let j = i - 1; j >= 0; j--) {
      const f = c.fields[j];
      if (f.literal || f.single) continue;
      if (reverse) return seekTo(key.slice(0, ends[j] + 1), true);
      return seekTo(key.slice(0, ends[j]) + above(f.sep), false);
    }
    return DONE;
  };

  let pos = c.head.length;
  for (let i = 0; i < c.fields.length; i++) {
    const f = c.fields[i];

    // a literal: the template's keys start with it, or are it when it is a whole local key
    if (f.literal) {
      const has = key.startsWith(f.text, pos) && (!f.whole || key.length === pos + f.text.length);
      if (has) {
        pos += f.text.length;
        continue;
      }
      const at = key.slice(0, pos);
      if (unitCompare(key.slice(pos), f.text) < 0) {
        return reverse ? skipBack(i) : seekTo(at + f.text, false);
      }
      if (!reverse) return skipBack(i);
      return f.whole ? seekTo(at + f.text, false) : seekTo(at + prefixEnd(f.text)!, true);
    }

    // a value field: its text runs to its separator, or to the end for the last field
    let end = key.length;
    let short = false;
    if (f.sep !== '') {
      end = key.indexOf(f.sep, pos);
      if (end < 0) {
        end = key.length;
        short = true;
      }
    }
    const v = key.slice(pos, end);

    // is the value short of its match?
    if (f.lo !== undefined) {
      const d = f.cmp(v, f.lo);
      if (d < 0 || (d === 0 && f.loOpen)) {
        if (reverse) return skipBack(i);
        const at = key.slice(0, pos) + f.lo;
        if (!f.loOpen) return seekTo(at, false);
        return f.sep === '' ? seekTo(at, true) : seekTo(at + above(f.sep), false);
      }
    }

    // is it past its match?
    if (f.hi !== undefined) {
      const d = f.cmp(v, f.hi);
      if (d > 0 || (d === 0 && f.hiOpen)) {
        if (!reverse) return skipBack(i);
        const at = key.slice(0, pos) + f.hi;
        if (f.hiOpen) return seekTo(at, true);
        return f.sep === '' ? seekTo(at, false) : seekTo(at + above(f.sep), true);
      }
    }

    // inside its match, but a key that ends here holds none of the fields after it
    if (short) return STEP;
    ends[i] = end;
    pos = end + f.sep.length;
  }
  return MATCH;
}

function matchesPattern(c: CompiledPattern, key: string): boolean {
  return placeKey(c, key, false).kind === 'match';
}

/** A KeyCursor walks a store's keys one way.  A seek forward moves to the first key at or after
    its target, strictly after it when strict, or to the first key of all for a null target; a seek
    in reverse moves to the last key at or before it, or to the last key of all. */
interface KeyCursor {
  /** the key at the cursor, undefined past the end of the walk */
  key(): string | undefined;
  seek(target: string | null, strict: boolean): void;
  step(): void;
}

/* Walk the keys a pattern picks out, calling visit with each until it answers false.  Before a
   seek the walk steps up to budget keys toward the target, since a store whose seek costs more
   than a few steps does better stepping over the short gaps between matches. */
function walkPattern(
  c: CompiledPattern,
  cursor: KeyCursor,
  req: { reverse?: boolean; after?: string },
  budget: number,
  visit: (key: string) => boolean,
): void {
  const reverse = req.reverse === true;

  // start just past after, or at the pattern's first key in walk order
  if (req.after !== undefined) {
    cursor.seek(req.after, true);
  } else if (!reverse) {
    cursor.seek(c.head, false);
  } else {
    const end = prefixEnd(c.head);
    cursor.seek(end ?? null, end !== undefined);
  }

  for (;;) {
    const key = cursor.key();
    if (key === undefined) return;
    const p = placeKey(c, key, reverse);
    if (p.kind === 'done') return;
    if (p.kind === 'match' && !visit(key)) return;
    if (p.kind !== 'seek') {
      cursor.step();
      continue;
    }

    /* A target behind the key comes from a bound holding characters its parameter cannot, which
       orders differently against the separators; stepping is always safe. */
    const cmp = exactFor([p.target]);
    const past = (k: string) => {
      const d = reverse ? cmp(p.target, k) : cmp(k, p.target);
      return d > 0 || (d === 0 && !p.strict);
    };
    if (past(key)) {
      cursor.step();
      continue;
    }

    // step toward the target, then seek if it is still ahead
    let s = 0;
    for (; s < budget; s++) {
      cursor.step();
      const k = cursor.key();
      if (k === undefined) return;
      if (past(k)) break;
    }
    if (s === budget) cursor.seek(p.target, p.strict);
  }
}

/** what one scan batch read, for a query's dependencies: its pattern, and the stretch of keys its
    walk covered, from just past `from` or the walk's start to `to` or the walk's end */
type ScanSpan = {
  pattern: CompiledPattern;
  reverse: boolean;
  from: string | undefined;
  to: string | undefined;
};

// whether a key written lies inside what a scan batch read
function spanCovers(s: ScanSpan, key: string): boolean {
  if (s.from !== undefined) {
    const d = compareKeys(key, s.from);
    if (s.reverse ? d >= 0 : d <= 0) return false;
  }
  if (s.to !== undefined) {
    const d = compareKeys(key, s.to);
    if (s.reverse ? d < 0 : d > 0) return false;
  }
  return matchesPattern(s.pattern, key);
}

/** the read half of a transaction object, what a read transaction hands out */
function readHalf(txn: RTxn): WTxn {
  return { get: (...a) => txn.get(...a), scan: (...a) => txn.scan(...a) } as WTxn;
}

// in-memory layers /////////////////////////////////////////////////////////

/* The in-memory store and the overlay keep rich js values, converting through the Registry on the
   way in and out.  Each keeps a base map, and each transaction keeps a map of pending updates over
   it, in which undefined marks a deletion.  The store also keeps its keys in a KeyList, so a scan
   seeks to its first key and walks from there; the overlay holds only the few keys forecasts
   write, and sorts them for each scan. */

type Layer = Map<string, unknown>;

/* The in-memory layers hand values across their boundary by copy.  On the way in, a JS value the
   caller supplied is copied, and a conversion from another representation is already fresh; on
   the way out, a JS value is copied, and a conversion to another representation is fresh.
   copyValue is the one place to point at a host's own clone, should one measure faster. */
const copyValue = <T>(v: T): T => deepCopy(v);
function layerIn(reg: Registry, type: string, rep: Rep, value: unknown): unknown {
  return rep === JS ? copyValue(value) : reg.convert(type, value, rep, JS);
}
function layerOut(reg: Registry, type: string, js: unknown, rep: Rep): unknown {
  return rep === JS ? copyValue(js) : reg.convert(type, js, JS, rep);
}

// a comparison exact in code-point order whenever one side is one of keys
function exactFor(keys: (string | undefined)[]): (a: string, b: string) => number {
  return keys.some((k) => k !== undefined && HIGH_UNIT.test(k)) ? compareKeys : unitCompare;
}

// the live keys of layers that keep answers true for, sorted; the last layer holding a key decides
// whether it is live
function layerKeys(layers: Layer[], keep: (key: string) => boolean): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const [k, v] of layers[i]) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (v !== undefined && keep(k)) keys.push(k);
    }
  }
  return sortKeys(keys);
}

function layerGet(data: Layer, updates: Layer, key: string): unknown {
  return updates.has(key) ? updates.get(key) : data.get(key);
}

// the first index below n where before answers false, or n; before answers true, then false
function bisect(n: number, before: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(mid)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// a cursor over keys sorted in code-point order
function arrayCursor(keys: string[], reverse: boolean): KeyCursor {
  let j = 0;
  return {
    key: () => keys[j],
    seek(target, strict) {
      if (target === null) {
        j = reverse ? keys.length - 1 : 0;
        return;
      }

      // forward, the first key at or past target; reversed, the one before the first key past it
      const cmp = exactFor([target]);
      const before = (k: string) => {
        const d = cmp(k, target);
        return d < 0 || (d === 0 && strict !== reverse);
      };
      j = bisect(keys.length, (i) => before(keys[i])) - (reverse ? 1 : 0);
    },
    step() {
      j += reverse ? -1 : 1;
    },
  };
}

// a cursor that passes over the keys hide answers true for
function filterCursor(inner: KeyCursor, hide: (key: string) => boolean): KeyCursor {
  const skip = () => {
    for (let k = inner.key(); k !== undefined && hide(k); k = inner.key()) inner.step();
  };
  return {
    key: () => inner.key(),
    seek(target, strict) {
      inner.seek(target, strict);
      skip();
    },
    step() {
      inner.step();
      skip();
    },
  };
}

// a cursor over two cursors that hold no key in common, in walk order
function mergeCursors(a: KeyCursor, b: KeyCursor, reverse: boolean): KeyCursor {
  const key = () => {
    const ka = a.key();
    const kb = b.key();
    if (ka === undefined || kb === undefined) return ka ?? kb;
    const d = compareKeys(ka, kb);
    return (reverse ? d > 0 : d < 0) ? ka : kb;
  };
  return {
    key,
    seek(target, strict) {
      a.seek(target, strict);
      b.seek(target, strict);
    },
    step() {
      if (a.key() === key()) {
        a.step();
      } else {
        b.step();
      }
    },
  };
}

/* KeyList is a sorted list of distinct keys, cut into blocks that put end to end are the whole
   list.  A block holds at most 2 * BLOCK keys and, unless it is the only one, at least BLOCK / 4,
   so an insert or a removal splices one short array, and finding a position is a binary search over
   the blocks' last keys and then one inside a block.  A block is never empty. */
const BLOCK = 1024;

// the keys a scan of the in-memory store steps through before it seeks, which costs a search
const STEP_BUDGET = 8;

class KeyList {
  #blocks: string[][] = [];

  /** a list over keys that are already sorted and distinct, in blocks of even size */
  static of(sorted: string[]): KeyList {
    const list = new KeyList();
    if (sorted.length === 0) return list;
    const size = Math.ceil(sorted.length / Math.ceil(sorted.length / BLOCK));
    for (let i = 0; i < sorted.length; i += size) list.#blocks.push(sorted.slice(i, i + size));
    return list;
  }

  /** insert a key the list does not hold */
  add(key: string): void {
    const blocks = this.#blocks;
    if (blocks.length === 0) {
      blocks.push([key]);
      return;
    }

    // find its place; a key above every block's last key goes at the end of the last block
    let [b, i] = this.#seek(key, false, exactFor([key]));
    if (b === blocks.length) {
      b--;
      i = blocks[b].length;
    }
    const block = blocks[b];
    block.splice(i, 0, key);

    // a block grown too long splits in two
    if (block.length > 2 * BLOCK) blocks.splice(b + 1, 0, block.splice(block.length >> 1));
  }

  /** remove a key the list holds */
  remove(key: string): void {
    const blocks = this.#blocks;
    const [b, i] = this.#seek(key, false, exactFor([key]));
    if (blocks[b]?.[i] !== key) throw new Error(`KeyList holds no ${JSON.stringify(key)}`);
    const block = blocks[b];
    block.splice(i, 1);
    if (block.length >= BLOCK / 4) return;

    // the only block stays until it is empty
    if (blocks.length === 1) {
      if (block.length === 0) blocks.pop();
      return;
    }

    // otherwise a block grown too short joins a neighbour, splitting again if the pair is too long
    const x = b + 1 < blocks.length ? b : b - 1;
    const joined = blocks[x].concat(blocks[x + 1]);
    if (joined.length > 2 * BLOCK) {
      const half = joined.length >> 1;
      blocks.splice(x, 2, joined.slice(0, half), joined.slice(half));
    } else {
      blocks.splice(x, 2, joined);
    }
  }

  /** a cursor walking the list one way; the list holds still while it is in use */
  cursor(reverse: boolean): KeyCursor {
    const blocks = this.#blocks;

    // the cursor's position, a block and an index into it, the block off either end when the
    // walk is over
    let b = 0;
    let i = 0;
    const back = () => {
      if (i > 0) {
        i--;
        return;
      }
      b--;
      i = b >= 0 ? blocks[b].length - 1 : 0;
    };
    return {
      key: () => (b >= 0 && b < blocks.length ? blocks[b][i] : undefined),
      seek: (target, strict) => {
        // forward, the first key at or past target; reversed, the one before the first key past it
        if (target === null) {
          [b, i] = reverse ? [blocks.length, 0] : [0, 0];
        } else {
          [b, i] = this.#seek(target, strict !== reverse, exactFor([target]));
        }
        if (reverse) back();
      },
      step: () => {
        if (reverse) {
          back();
        } else if (++i === blocks[b].length) {
          b++;
          i = 0;
        }
      },
    };
  }

  // the position of the first key at or above key, or above it when strict, as a block and an
  // index into it; the block count when no key is
  #seek(key: string, strict: boolean, cmp: (a: string, b: string) => number): [number, number] {
    const before = (k: string) => {
      const c = cmp(k, key);
      return c < 0 || (strict && c === 0);
    };
    const blocks = this.#blocks;
    const b = bisect(blocks.length, (j) => before(blocks[j][blocks[j].length - 1]));
    if (b === blocks.length) return [b, 0];
    const block = blocks[b];
    return [b, bisect(block.length, (j) => before(block[j]))];
  }
}

/** InMemStore keeps values in their JS form in memory, with its keys in a sorted list, so a scan
    seeks to its first key rather than sorting.  Values cross the transaction boundary by copy. */
export class InMemStore implements Store {
  #reg: Registry;
  #values: Layer = new Map();
  #keys = new KeyList();

  constructor(reg: Registry) {
    this.#reg = reg;
  }

  #withTxn<T>(writable: boolean, fn: (txn: WTxn) => T): T {
    const updates: Layer = new Map();
    const txn = new InMemTxn(this.#reg, this.#values, this.#keys, updates);

    // a throw leaves the updates uncommitted, which is the rollback
    const result = fn(writable ? txn : readHalf(txn));
    this.#commit(updates);
    return result;
  }

  // apply a transaction's updates to the values, and to the key list the keys that appear or go
  #commit(updates: Layer): void {
    // apply the values, noting each key that appears or goes
    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, val] of updates) {
      if (val === undefined) {
        if (this.#values.delete(key)) removed.push(key);
      } else {
        if (!this.#values.has(key)) added.push(key);
        this.#values.set(key, val);
      }
    }

    // place the keys one by one, unless one sort of them all costs less
    if (added.length + removed.length > this.#values.size / 8) {
      this.#keys = KeyList.of(sortKeys([...this.#values.keys()]));
      return;
    }
    for (const key of removed) this.#keys.remove(key);
    for (const key of added) this.#keys.add(key);
  }

  write<T>(fn: (txn: WTxn) => T): T {
    return this.#withTxn(true, fn);
  }

  read<T>(fn: (txn: RTxn) => T): T {
    return this.#withTxn(false, fn);
  }
}

class InMemTxn implements WTxn {
  #reg: Registry;
  #values: Layer;
  #keys: KeyList;
  #updates: Layer;

  constructor(reg: Registry, values: Layer, keys: KeyList, updates: Layer) {
    this.#reg = reg;
    this.#values = values;
    this.#keys = keys;
    this.#updates = updates;
  }

  get(key: string, type: string, rep: Rep): unknown {
    const js = layerGet(this.#values, this.#updates, key);
    return js === undefined ? undefined : layerOut(this.#reg, type, js, rep);
  }

  set(key: string, type: string, rep: Rep, value: unknown): void {
    this.#updates.set(key, layerIn(this.#reg, type, rep, value));
  }

  del(key: string): void {
    this.#updates.set(key, undefined);
  }

  delPrefix(prefix: string): string[] {
    const keys = this.#keysUnder(prefix);
    for (const k of keys) this.#updates.set(k, undefined);
    return keys;
  }

  move(src: string, dst: string): string[] {
    const keys = this.#keysUnder(src);
    const moved: string[] = [];
    for (const k of keys) {
      const to = dst + k.slice(src.length);
      this.#updates.set(to, layerGet(this.#values, this.#updates, k));
      this.#updates.set(k, undefined);
      moved.push(to);
    }
    return moved;
  }

  scan(req: ScanRequest): StoreScan {
    const c = compilePattern(req.pattern);
    const v = req.values;
    if (v && req.pattern.name === null) {
      throw new Error('a scan of every local key reads keys only');
    }
    if (!(req.limit >= 1)) throw new RangeError("a scan's limit is at least 1");

    // walk one key past a batch, to tell whether more follow
    const keys: string[] = [];
    const cursor = this.#cursor(c.head, req.reverse === true);
    walkPattern(c, cursor, req, STEP_BUDGET, (k) => keys.push(k) <= req.limit);

    // the batch, its values copied or converted out
    const page = keys.slice(0, req.limit);
    const entries: [string, unknown][] = page.map((k) => {
      if (!v) return [k, undefined];
      return [k, layerOut(this.#reg, v.type, layerGet(this.#values, this.#updates, k), v.rep)];
    });
    return { entries, next: keys.length > req.limit ? page[page.length - 1] : null };
  }

  // a cursor over the live keys: the stored ones no update shadows, merged with the updates' live
  // keys under prefix
  #cursor(prefix: string, reverse: boolean): KeyCursor {
    const updates = this.#updates;
    const stored = this.#keys.cursor(reverse);
    if (updates.size === 0) return stored;
    const shown = filterCursor(stored, (k) => updates.has(k));
    const pending = layerKeys([updates], (k) => k.startsWith(prefix));
    if (pending.length === 0) return shown;
    return mergeCursors(shown, arrayCursor(pending, reverse), reverse);
  }

  // every live key under prefix, in order
  #keysUnder(prefix: string): string[] {
    const keys: string[] = [];
    const cursor = this.#cursor(prefix, false);
    cursor.seek(prefix, false);
    for (let k = cursor.key(); k?.startsWith(prefix); k = cursor.key()) {
      keys.push(k);
      cursor.step();
    }
    return keys;
  }
}

/** Overlay is the Engine's in-memory layer of forecasts over the base.  It is not a Store: each
    call takes a base read transaction the caller already holds, so one rebuild of the overlay, its
    forecasts and the graph run after them, reads one snapshot of the base. */
export class Overlay {
  #reg: Registry;
  #data: Layer = new Map();

  constructor(reg: Registry) {
    this.#reg = reg;
  }

  keys(): string[] {
    return [...this.#data.keys()];
  }

  /** run fn over a scratch layer on top of the overlay and base, keeping its writes when fn
      returns; a throw drops them */
  apply<T>(base: RTxn, fn: (txn: WTxn) => T): T {
    const updates: Layer = new Map();
    const result = fn(new OverlayTxn(this.#reg, base, this.#data, updates));

    // keep the scratch layer's writes in the overlay's own layer
    for (const [key, val] of updates) {
      // note: we must keep undefined values rather than propagate deletions to base
      this.#data.set(key, val);
    }
    return result;
  }

  /** the overlay over base, read-only */
  view(base: RTxn): RTxn {
    return readHalf(new OverlayTxn(this.#reg, base, this.#data, new Map()));
  }
}

/** OverlayTxn reads through its two in-memory layers to a base read transaction.  Range
    operations merge the layers with the base's answer: the base is walked in batches, and the
    layers' keys inside each batch's span are merged in, the layers winning. */
class OverlayTxn implements WTxn {
  #reg: Registry;
  #base: RTxn;
  #data: Layer;
  #updates: Layer;

  constructor(reg: Registry, base: RTxn, data: Layer, updates: Layer) {
    this.#reg = reg;
    this.#base = base;
    this.#data = data;
    this.#updates = updates;
  }

  #has(key: string): boolean {
    return this.#updates.has(key) || this.#data.has(key);
  }

  get(key: string, type: string, rep: Rep): unknown {
    if (!this.#has(key)) return this.#base.get(key, type, rep);
    const js = layerGet(this.#data, this.#updates, key);
    return js === undefined ? undefined : layerOut(this.#reg, type, js, rep);
  }

  set(key: string, type: string, rep: Rep, value: unknown): void {
    this.#updates.set(key, layerIn(this.#reg, type, rep, value));
  }

  del(key: string): void {
    this.#updates.set(key, undefined);
  }

  // every key of the stream a prefix `{stream}!` names, from the base and the layers, in order;
  // forecasts end whole streams, so the overlay deletes nothing narrower
  #keysUnder(prefix: string): string[] {
    if (prefix.indexOf('!') !== prefix.length - 1) {
      throw new Error(`the overlay deletes whole streams, not ${prefix}`);
    }
    const all = new Set<string>();
    const pattern: KeyPattern = { stream: prefix.slice(0, -1), name: null, local: [] };
    for (const [k] of scanAll(this.#base, { pattern, limit: 1000, values: false })) {
      if (!this.#has(k)) all.add(k);
    }
    const layers = [this.#data, this.#updates];
    for (const k of layerKeys(layers, (k) => k.startsWith(prefix))) all.add(k);
    return sortKeys([...all]);
  }

  delPrefix(prefix: string): string[] {
    const keys = this.#keysUnder(prefix);
    for (const k of keys) this.#updates.set(k, undefined);
    return keys;
  }

  /** forecasts never move keys, so the overlay does not */
  move(): string[] {
    throw new Error('the overlay does not move keys');
  }

  scan(req: ScanRequest): StoreScan {
    const result = this.#base.scan(req);

    // the stretch this batch covers: up to its last key when more follow, else to the walk's end
    const span: ScanSpan = {
      pattern: compilePattern(req.pattern),
      reverse: req.reverse === true,
      from: req.after,
      to: result.next ?? undefined,
    };

    // merge the layers' keys in the span over the base's; the base's answers are already the
    // caller's in the asked-for representation, and layer entries are copied and converted here
    const merged = new Map<string, unknown>();
    for (const [k, v] of result.entries) if (!this.#has(k)) merged.set(k, v);
    const v = req.values;
    for (const k of layerKeys([this.#data, this.#updates], (k) => spanCovers(span, k))) {
      const js = layerGet(this.#data, this.#updates, k);
      merged.set(k, v ? layerOut(this.#reg, v.type, js, v.rep) : undefined);
    }

    // cut the merged keys to one batch
    const keys = sortKeys([...merged.keys()]);
    if (req.reverse) keys.reverse();
    const page: StoreScan = {
      entries: keys.slice(0, req.limit).map((k) => [k, merged.get(k)]),
      next: keys.length > req.limit ? keys[req.limit - 1] : null,
    };

    // the base has more batches behind this span, so the walk resumes past it even if the merge fit
    if (page.next === null && result.next !== null) page.next = result.next;
    return page;
  }
}

// external stores ///////////////////////////////////////////////////////////

/** ExternalStoreTxn is one transaction of an ExternalStore, a WTxn that also commits and aborts.
    The store converts: it persists the representation it keeps and answers in the one asked for,
    undefined for an absent key.  It walks keys in code-point order, as a store comparing UTF-8
    keys bytewise does. */
export interface ExternalStoreTxn extends WTxn {
  commit(): void;
  /** abort the transaction.  ExternalStore calls it after any failure in the transaction,
      commit's included, so a host never calls it directly. */
  abort(): void;
}

/** ExternalStore implements Store over a host's own transactions, opened by txnFn.  A read
    transaction hands out only the read half of the host's transaction. */
export class ExternalStore implements Store {
  #txnFn: (writable: boolean) => ExternalStoreTxn;

  constructor(txnFn: (writable: boolean) => ExternalStoreTxn) {
    this.#txnFn = txnFn;
  }

  #withTxn<T>(writable: boolean, fn: (txn: WTxn) => T): T {
    const txn = this.#txnFn(writable);
    let result: T;
    try {
      result = fn(writable ? txn : readHalf(txn));
      txn.commit();
    } catch (e: unknown) {
      txn.abort();
      throw e;
    }
    return result;
  }

  write<T>(fn: (txn: WTxn) => T): T {
    return this.#withTxn(true, fn);
  }

  read<T>(fn: (txn: RTxn) => T): T {
    return this.#withTxn(false, fn);
  }
}

// reducers /////////////////////////////////////////////////////////////////

/** ReadTxn is what a query, a forecast, or precommit reads through: rich JS values by key and type,
    undefined for an absent key, and scans by pattern.  The database's own adds `emit`, which
    plugin code calls to add outputs to the atom being built, after the outputs emitted before them
    and ahead of what the running handler returns. */
export interface ReadTxn {
  get(key: string, type: string): unknown;
  scan(req: ReadScan): StoreScan;
  emit?(outputs: ForecastOutput[]): void;
}

/** a scan through a ReadTxn: its values are rich JS values of `type`, or keys only for false */
export type ReadScan = {
  pattern: KeyPattern;
  type: string | false;
  reverse?: boolean;
  after?: string;
  limit: number;
};

/** ReducerTxn is what a slice reducer reads and writes through, inside the Engine's transaction.
    Its keys are local to one stream: the Engine prefixes `{stream}!`, so a reducer cannot name a
    key outside its own stream.  A reducer owns what it gets, and what it sets is the store's from
    that call on. */
export interface ReducerTxn {
  get(key: string, type: string): unknown;
  set(key: string, type: string, value: unknown): void;
  del(key: string): void;
  /** One batch of the stream's keys of a local template, by a match per parameter, keyed
      locally, `after` included.  A scan sees the reducer's own writes, but it is a walk taken a
      batch at a time: a key written or deleted ahead of an unfinished scan, among the keys it
      picks out, is seen or not depending on whether its batch was already fetched, so the Engine
      and the database could fold such a reducer differently.  Write only behind a scan, or after
      it ends. */
  scan(req: LocalScan): StoreScan;
}

/** a scan through a ReducerTxn: a local template, or null for every local key, keys only */
export type LocalScan = Omit<ReadScan, 'pattern'> & { name: string | null; local: ParamMatch[] };

// the transactions a query or forecast read through that have returned, so a scan carried out of
// one throws rather than reading on
const closedTxns = new WeakSet<object>();

/** every entry a scan picks out, as the key's template parameters in order, stream ones first,
    and its value; batches are fetched as the walk goes, from 16 entries growing to 256 */
export function scanEach(
  txn: ReadTxn,
  req: Omit<ReadScan, 'after' | 'limit'>,
): IterableIterator<[string[], unknown]> {
  const p = req.pattern;
  const parse = (key: string) => {
    if (p.stream === null) return [key];
    const bang = key.indexOf('!');
    const stream =
      typeof p.stream === 'string' || p.stream.params.length === 0
        ? []
        : key.slice(p.stream.family.length + 1, bang).split(',');
    return [...stream, ...localParams(key.slice(bang + 1), p.name, p.local.length)];
  };
  return batches(txn, (after, limit) => txn.scan({ ...req, after, limit }), parse);
}

/** every entry a reducer's scan picks out, as scanEach yields them, of its own stream */
export function scanEachLocal(
  txn: ReducerTxn,
  req: Omit<LocalScan, 'after' | 'limit'>,
): IterableIterator<[string[], unknown]> {
  const parse = (key: string) => localParams(key, req.name, req.local.length);
  return batches(txn, (after, limit) => txn.scan({ ...req, after, limit }), parse);
}

// the parameters of a local key of the named template with n of them, or the key itself for
// every local key (a null name)
function localParams(local: string, name: string | null, n: number): string[] {
  if (name === null) return [local];
  if (n === 0) return [];
  const parts = local.slice(name.length + 1).split(',');
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(',')];
}

/* The entries of a walk, fetched in batches of growing size.  Over a query's transaction, the
   span its batch recorded is cut back to the last entry handed out, since the query has seen
   nothing past it, and runs to the walk's end only once the query has asked past the last entry
   there is.  A query that stops early then depends on what it took, not on what was fetched. */
function* batches(
  txn: object,
  fetch: (after: string | undefined, limit: number) => StoreScan,
  parse: (key: string) => string[],
): IterableIterator<[string[], unknown]> {
  const deps = queryDeps.get(txn);
  let after: string | undefined;
  let limit = 16;
  for (;;) {
    if (closedTxns.has(txn)) {
      throw new Error('a scan was used after its query or forecast returned');
    }

    // a batch, whose span the fetch just recorded or extended
    const { entries, next } = fetch(after, limit);
    const span = deps?.spans[deps.spans.length - 1];

    // each entry, the span reaching it as it is handed out
    for (const [key, value] of entries) {
      if (span !== undefined) span.to = key;
      yield [parse(key), value];
      if (closedTxns.has(txn)) {
        throw new Error('a scan was used after its query or forecast returned');
      }
    }

    // asked past the last entry there is, the query has seen the walk to its end
    if (next === null) {
      if (span !== undefined) span.to = undefined;
      return;
    }
    after = next;
    limit = Math.min(limit * 2, 256);
  }
}

// contexts //////////////////////////////////////////////////////////////////

/** the transaction a generated context reads through, as its holder last bound it */
export type TxnCell<T> = { txn: T };

/** A generated context that stays one object for its holder's lifetime.  `bind` points it at the
    transaction it reads through until the next bind, and answers it; a holder binds whenever the
    transaction it runs over changes, so no context is built per call. */
export type ContextBinding<X, T = ReadTxn> = { readonly ctx: X; bind(txn: T): X };

/** a cell that holds no transaction yet, throwing on any use of it */
export function unboundCell<T extends object>(): TxnCell<T> {
  const unbound = new Proxy(
    {},
    {
      get() {
        throw new Error('a context was used before it was bound to a transaction');
      },
    },
  );
  return { txn: unbound as T };
}

// typed scans ///////////////////////////////////////////////////////////////

/** a match on one parameter, as a generated scan accessor takes it: an exact value, a range, or a
    prefix; a parameter left out matches any value */
export type ScanMatch =
  string | { gte?: string; gt?: string; lte?: string; lt?: string } | { prefix: string };

/** A generated scan accessor over one key template.  P names the template's parameters that vary
    in its context, its family's then its own, and V is its value.  It walks the keys a match on
    those parameters picks out, in the order of the parameters, fetching as it goes, and yields
    each key's parameters by name with its value, or only the parameters with `keys: true`. */
export type ScanAccessor<P extends string, V> = {
  (
    match?: { [K in P]?: ScanMatch },
    options?: { reverse?: boolean; keys?: false },
  ): IterableIterator<[{ [K in P]: string }, V]>;
  (
    match: { [K in P]?: ScanMatch } | undefined,
    options: { reverse?: boolean; keys: true },
  ): IterableIterator<{ [K in P]: string }>;
};

/** what a generated scan accessor knows of its template: its own name for errors, its family and
    the family's parameters (none for a reducer's, whose stream is its own), the local template's
    name and parameters, and the type its values travel under */
export type ScanTemplate = {
  accessor: string;
  family: string;
  stream: string[];
  name: string;
  local: string[];
  type: string;
};

type ScanOptions = { reverse?: boolean; keys?: boolean };
type NamedMatch = Partial<Record<string, ScanMatch>>;

/** a scan accessor over a global context's read transaction, whichever the cell holds when it is
    called */
export function globalScan<P extends string, V>(
  cell: TxnCell<ReadTxn>,
  t: ScanTemplate,
): ScanAccessor<P, V> {
  const scan = (match: NamedMatch = {}, options: ScanOptions = {}) => {
    const n = t.stream.length;
    const params = t.stream.map((p, i) => {
      return paramMatch(t.accessor, p, match[p], i < n - 1 ? asSegment : asStreamRest);
    });
    const pattern: KeyPattern = {
      stream: { family: t.family, params },
      name: t.name,
      local: localMatches(t, match),
    };
    const type = options.keys === true ? false : t.type;
    const walk = scanEach(cell.txn, { pattern, type, reverse: options.reverse });
    return named(walk, [...t.stream, ...t.local], options.keys === true);
  };
  return scan as ScanAccessor<P, V>;
}

/** a scan accessor over a reducer's transaction, of its own stream, whichever the cell holds when
    it is called */
export function localScan<P extends string, V>(
  cell: TxnCell<ReducerTxn>,
  t: ScanTemplate,
): ScanAccessor<P, V> {
  const scan = (match: NamedMatch = {}, options: ScanOptions = {}) => {
    const local = localMatches(t, match);
    const type = options.keys === true ? false : t.type;
    const walk = scanEachLocal(cell.txn, { name: t.name, local, type, reverse: options.reverse });
    return named(walk, t.local, options.keys === true);
  };
  return scan as ScanAccessor<P, V>;
}

// a template's local parameters' matches; the last one may hold anything a key may
function localMatches(t: ScanTemplate, match: NamedMatch): ParamMatch[] {
  const n = t.local.length;
  return t.local.map((p, i) => paramMatch(t.accessor, p, match[p], i < n - 1 ? asSegment : null));
}

// a parameter's match as a pattern takes it: an exact value checked as its place in its template
// requires, unless check is null, and every value well-formed, since a lone surrogate orders
// differently in different stores
function paramMatch(
  accessor: string,
  param: string,
  m: ScanMatch | undefined,
  check: ((value: string, accessor: string, param: string) => string) | null,
): ParamMatch {
  const wellFormed = (v: string | undefined) => {
    if (v === undefined || !LONE_SURROGATE.test(v)) return;
    throw new Error(`${accessor}: ${param} ${JSON.stringify(v)} holds a lone surrogate`);
  };
  if (m === undefined) return null;
  if (typeof m === 'string') {
    wellFormed(m);
    return { eq: check === null ? m : check(m, accessor, param) };
  }
  for (const v of Object.values(m)) wellFormed(v);
  return m;
}

// a low surrogate at the start or after anything but a high one, or a high one before anything
// but a low one; no lookbehind, which not every engine a host embeds supports
const LONE_SURROGATE = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// a walk's entries with their parameters by name, or the parameters alone
function* named(
  walk: IterableIterator<[string[], unknown]>,
  names: string[],
  keysOnly: boolean,
): IterableIterator<unknown> {
  for (const [values, value] of walk) {
    const params = Object.fromEntries(names.map((name, i) => [name, values[i]]));
    yield keysOnly ? params : [params, value];
  }
}

// stream names and keys ////////////////////////////////////////////////////

/* A slice's family template and each of its key templates is a name, then, if it has parameters,
   `:{param}` and `,{param}` for each further one: `chat:{org},{channel}`, `post:{id}`, `meta`.  A
   parameter the template ends with is terminal and holds the rest of the string.  Every other
   parameter is a segment, a non-empty run of `A-Z a-z 0-9 _ -`, so `chat:acme,general` parses
   back as `chat:{org},{channel}` unambiguously and `chat:acme,*` covers one org's channels.  A
   stream name's terminal parameter is non-empty and may also hold `.` and `~`, the rest of the
   RFC 3986 unreserved set, since stream names appear in URLs.  A local key's terminal parameter
   may hold anything a key may, the empty string included.  No key holds a control character
   (U+0000-001F, U+007F-009F) or a lone surrogate; the database refuses a reducer's write of one.

   A store key is `{stream}!{local key}`, as in `chat:acme,general!reply:t1,m5`, and its stream is
   everything before its first `!`.  Keys sort in code-point order, and each separator after a
   parameter sorts below every character that parameter may hold: `,` below a segment's, and `!`
   below a stream name's.  So a walk of a family visits its streams in the order of their
   parameters, `gen` before `gen-2`, and a walk of a key template its keys likewise. */

const SEGMENT = '[A-Za-z0-9_-]+';
const STREAM_REST = '[A-Za-z0-9_.~-]+';
const SEGMENT_RE = new RegExp(`^${SEGMENT}$`);
const STREAM_REST_RE = new RegExp(`^${STREAM_REST}$`);
// the shape of a stream name of any family, for a family whose template is not at hand
const ANY_STREAM_RE = new RegExp(`^${SEGMENT}(:(${SEGMENT},)*${STREAM_REST})?$`);

/** a template parameter's value, other than a terminal one, checked; a generated accessor passes
    each of its parameters through this or asStreamRest before building a key */
export function asSegment(value: string, accessor: string, param: string): string {
  if (!SEGMENT_RE.test(value)) {
    const v = JSON.stringify(value);
    throw new Error(`${accessor}: ${param} ${v} is not a non-empty run of A-Z a-z 0-9 _ -`);
  }
  return value;
}

/** the value of a family template's terminal parameter, checked */
export function asStreamRest(value: string, accessor: string, param: string): string {
  if (!STREAM_REST_RE.test(value)) {
    const v = JSON.stringify(value);
    throw new Error(`${accessor}: ${param} ${v} is not a non-empty run of A-Z a-z 0-9 _ - . ~`);
  }
  return value;
}

// a family template as the pattern of the stream names that fill it
function streamPattern(tpl: string): RegExp {
  const [family, params] = tpl.split(':');
  if (params === undefined) return new RegExp(`^${family}$`);
  const n = params.split(',').length;
  const src = [...Array<string>(n - 1).fill(SEGMENT), STREAM_REST];
  return new RegExp(`^${family}:${src.join(',')}$`);
}

// a ReducerTxn over a store transaction for one stream's keys, marking every key it writes in
// updates
function reducerTxn(txn: WTxn, stream: string, updates: Record<string, true>): ReducerTxn {
  const prefix = `${stream}!`;
  return {
    get: (key, type) => txn.get(prefix + key, type, JS),
    set(key, type, value) {
      txn.set(prefix + key, type, JS, value);
      updates[prefix + key] = true;
    },
    del(key) {
      txn.del(prefix + key);
      updates[prefix + key] = true;
    },
    scan(req) {
      const pattern: KeyPattern = { stream, name: req.name, local: req.local };
      const values: ScanRequest['values'] =
        req.type === false ? false : { type: req.type, rep: JS };
      const after = req.after === undefined ? undefined : prefix + req.after;
      const { entries, next } = txn.scan({ ...req, pattern, values, after });
      return {
        entries: entries.map(([k, v]) => [k.slice(prefix.length), v]),
        next: next === null ? null : next.slice(prefix.length),
      };
    },
  };
}

/** apply fn to the value at a key in place and set it, answering what fn returns; an absent key
    throws, as a reducer does whenever the state is not what its event implies */
export function updateKey<T, R>(
  txn: ReducerTxn,
  key: string,
  type: string,
  fn: (value: T) => R,
): R {
  const value = txn.get(key, type) as T | undefined;
  if (value === undefined) throw new Error(`update of absent key ${key}`);
  const out = fn(value);
  txn.set(key, type, value);
  return out;
}

// mark every key a store operation reports in dirty
function markDirty(dirty: Record<string, true>, keys: string[]): void {
  for (const key of keys) dirty[key] = true;
}

// authorization //////////////////////////////////////////////////////////////

/** A precommit handler rejects a command by throwing a Reject, whose reason goes back to the
    client.  Any other throw is a bug, answered with a generic rejection. */
export class Reject extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Reject';
  }
}

/** who sent a command, as their token proves it; user is null for the anonymous principal */
export type Principal = { user: string | null };

/** Auth is what a precommit handler authorizes through.  Each call gets a fresh one, and the
    caller rejects a handler that returns without an authorization decision, so authorization
    fails closed.  It carries the principal, so precommit can hand it on wherever a Principal is
    wanted. */
export class Auth implements Principal {
  readonly user: string | null;
  #authorized: boolean = false;

  constructor(principal: Principal) {
    this.user = principal.user;
  }

  /** whether the call has been authorized so far */
  get authorized(): boolean {
    return this.#authorized;
  }

  /** authorize the call when the condition holds, and reject it otherwise */
  authorize(condition: boolean, reason: string = 'unauthorized'): void {
    if (!condition) throw new Reject(reason);
    this.#authorized = true;
  }

  /** authorize the call for anyone, anonymous included: the one unconditional decision, so an
      open command is visible in code */
  authorizeAnyone(): void {
    this.#authorized = true;
  }
}

/** Run one precommit handler with a fresh Auth, answering its outputs as a list, or the reason
    for a rejection.  A Reject is a rejection, and so is a handler that returns without an
    authorization decision, which in dev mode is an error naming the handler.  Any other throw
    is a bug, and goes to the host. */
export function runPrecommit(
  name: string,
  principal: Principal,
  handler: (auth: Auth) => unknown,
): string | ForecastOutput[] {
  const auth = new Auth(principal);
  let out: unknown;
  try {
    out = handler(auth);
  } catch (e: unknown) {
    if (e instanceof Reject) return e.message;
    throw e;
  }

  // authorization fails closed
  if (!auth.authorized) {
    if (DEV) {
      throw new Error(`precommit handler ${name} returned without an authorization decision`);
    }
    return 'unauthorized';
  }
  return outputList(out);
}

// the database bundle ////////////////////////////////////////////////////////

/** what an endpoint asks lookup about: a sign-in by identity, or a token's principal at refresh
    and on every check of its account's generation */
export type LookupIdent =
  | { kind: 'password'; identity: string }
  | { kind: 'refresh'; user: string }
  | { kind: 'token'; user: string };

/** an existing account: its user, the generation every token of it must carry, and the stored
    password hash a sign-in verifies against */
export type LookupResult = {
  user: string;
  generation?: number;
  secret?: string;
};

/** what the database hands bootstrap: emit appends an event to the seed atom, hashPassword makes
    a hash as intake would, and env reads a variable the operator named */
export type BootstrapContext = {
  emit: (stream: string, event: unknown) => void;
  hashPassword: (plain: string) => string;
  env: (name: string) => string;
};

/** Bundle is what a database runs: the app's handlers behind the generated wrappers, installed
    as `globalThis.__bundle`, and the registry the database converts and checks every value by.
    precommit, maySee, and lookup read global keys; each reducer reads and writes its own stream's
    keys.  precommit gets a command's data alone.  Values are rich JS values.  `plugins` are the
    database's installed plugins by name, as the host calls them.  `dev` is the bundle's DEV, so a
    host answers the errors of a dev bundle in full, and `mapStack` maps an error's stack through
    the bundle's source map. */
export type Bundle = {
  schema: Schema;
  precommit: (txn: ReadTxn, data: unknown, principal: Principal) => string | ForecastOutput[];
  reducers: Record<string, SliceReducer>;
  maySee: (txn: ReadTxn, principal: Principal) => string[];
  lookup: (txn: ReadTxn, ident: LookupIdent) => LookupResult | null;
  bootstrap?: (ctx: BootstrapContext) => void;
  plugins: Record<string, BundlePlugin>;
  dev: boolean;
  mapStack: typeof mapStack;
};

// plugins ///////////////////////////////////////////////////////////////////

/** A plugin as one database holds it: the name it is installed under, its request API, which app
    code calls as `txn.{name}`, bind, which points the plugin's own contexts at the transaction
    the database runs over, and, for a plugin with commands of its own, run, which handles one of
    them, a cron tick or a worker's result, and answers its outputs.  A built-in's config is what
    the host reads of it, by its install's kind. */
export interface Plugin<Api extends object = object> {
  readonly name: string;
  readonly api: Api;
  readonly config?: unknown;
  bind(txn: ReadTxn): void;
  run?(cmd: unknown): ForecastOutput[];
}

/** What a plugin's install answers and a plugin set lists: the plugin's kind, which prefixes its
    type identities, and create, which makes the plugin under the name a database installs it by.
    ctx is the database's context, the txn of the app's hooks: the plugin's own context offers
    each hook as a field whose wrapper calls the hook over ctx and emits what it returns, and only
    those wrappers hold ctx. */
export interface PluginInstall<Api extends object = object> {
  readonly kind: string;
  create(name: string, ctx: unknown): Plugin<Api>;
}

/** An installed plugin as a host sees it: its kind, by which the host recognizes a built-in, a
    built-in's config, and, for a plugin with commands of its own, run, which binds the database's
    context and every plugin to the transaction, as every entry into the bundle does, and hands
    the plugin one command. */
export type BundlePlugin = {
  readonly kind: string;
  readonly config?: unknown;
  readonly run?: (txn: ReadTxn, cmd: unknown) => ForecastOutput[];
};

/** the types a database hands a plugin's handlers: the txn they read through and the outputs they
    return */
export type DbTypes = { txn: unknown; output: unknown };

/** What ties an installed plugin to one database's types.  DB appears bare, so a plugin's install
    infers it from the slot it lands in, and an install for one database fits no other's. */
export type DbMarker<DB extends DbTypes> = { readonly db: (db: DB) => DB };

/** the request APIs of a plugin set, as the fields of a txn */
export type PluginApis<P> = { [K in keyof P]: P[K] extends PluginInstall<infer A> ? A : never };

/** the fields of a database context, which no plugin may be named after */
export type ContextField = 'get' | 'scan' | 'status';

/** the names no plugin may take: a context's fields, and __proto__, which an assignment would take
    as the object's prototype rather than a field */
export type ReservedPluginName = ContextField | '__proto__';
const RESERVED_PLUGIN_NAMES: readonly string[] = ['get', 'scan', 'status', '__proto__'];

// a plugin's name: a JS identifier without $, so it is also a stream name's text
const PLUGIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** a database's plugins slot: each plugin of the set P under its name, tied to the database's
    types DB */
export type PluginSlots<P, DB extends DbTypes> = {
  [K in keyof P]: K extends ReservedPluginName ? never : P[K] & DbMarker<DB>;
};

/** Install a database's plugins: create each under its name, which is checked, over the database
    context, and attach its request API to that context under its name.  Answers the plugins by
    name as a host calls them, and the bind a database runs on every entry, which points the
    context and every plugin at the transaction. */
export function installPlugins<X extends object>(
  b: ContextBinding<X>,
  installs: Record<string, PluginInstall>,
): { plugins: Record<string, BundlePlugin>; bind: (txn: ReadTxn) => X } {
  const all: Plugin[] = [];
  const bind = (txn: ReadTxn): X => {
    for (const plugin of all) plugin.bind(txn);
    return b.bind(txn);
  };

  // create each plugin, attach its API, and give a plugin with commands its entry
  const plugins: Record<string, BundlePlugin> = {};
  for (const [name, install] of Object.entries(installs)) {
    if (RESERVED_PLUGIN_NAMES.includes(name)) throw new Error(`a plugin may not be named ${name}`);
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(`plugin name ${JSON.stringify(name)} is not a JS identifier without $`);
    }
    const plugin = install.create(name, b.ctx);
    all.push(plugin);
    (b.ctx as Record<string, unknown>)[name] = plugin.api;
    const run = (txn: ReadTxn, cmd: unknown): ForecastOutput[] => {
      bind(txn);
      return plugin.run!(cmd);
    };
    plugins[name] = {
      kind: install.kind,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
      ...(plugin.run === undefined ? {} : { run }),
    };
  }
  return { plugins, bind };
}

// source maps ////////////////////////////////////////////////////////////////

/** a source map (ECMA-426), as far as mapStack reads it */
export type SourceMap = { sources: string[]; mappings: string };

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* One segment of a source map's mappings, decoded into its fields (ECMA-426, "Mappings
   structure").  Each field is a base64 VLQ: every digit carries 5 bits of the value, least
   significant first, and a sixth bit set when another digit follows.  The value's lowest bit is
   its sign. */
function segmentFields(segment: string): number[] {
  const fields: number[] = [];
  let value = 0;
  let scale = 1;
  for (const c of segment) {
    const digit = BASE64.indexOf(c);
    value += (digit & 31) * scale;
    if (digit & 32) {
      scale *= 32;
      continue;
    }
    const magnitude = Math.floor(value / 2);
    fields.push(value % 2 === 1 ? -magnitude : magnitude);
    value = 0;
    scale = 1;
  }
  return fields;
}

/* A source map's mappings, one array per generated line, each segment with its fields made
   absolute: the generated column, then the source index, original line, and original column when
   the segment maps to a source.  The generated column is relative within a line; the other fields
   accumulate across the whole of the mappings. */
function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let source = 0;
  let line = 0;
  let col = 0;
  for (const text of mappings.split(';')) {
    const segments: number[][] = [];
    let genCol = 0;
    for (const segment of text.split(',')) {
      if (segment === '') continue;
      const f = segmentFields(segment);
      genCol += f[0];
      if (f.length < 4) {
        segments.push([genCol]);
        continue;
      }
      source += f[1];
      line += f[2];
      col += f[3];
      segments.push([genCol, source, line, col]);
    }
    lines.push(segments);
  }
  return lines;
}

// each map's decoded mappings, decoded on its first use
const decodedMaps = new WeakMap<SourceMap, number[][][]>();

// a stack frame's location: `(file:line:col)`, line and column 1-based
const FRAME_LOCATION = /\(([^():\n]+):(\d+):(\d+)\)/g;

/** A stack with every location in `file` mapped through the file's source map to its source,
    line, and column.  A location in another file, or one the map does not cover, is left as it
    is.  Lines and columns are 1-based in a stack and 0-based in the map. */
export function mapStack(stack: string, file: string, map: SourceMap): string {
  let lines = decodedMaps.get(map);
  if (lines === undefined) {
    lines = decodeMappings(map.mappings);
    decodedMaps.set(map, lines);
  }
  const decoded = lines;
  return stack.replace(FRAME_LOCATION, (location, f: string, lineText: string, colText: string) => {
    if (f !== file) return location;

    // the last segment of the line that starts at or before the column
    const col = Number(colText) - 1;
    let found: number[] | undefined;
    for (const segment of decoded[Number(lineText) - 1] ?? []) {
      if (segment[0] > col) break;
      found = segment;
    }
    if (found === undefined || found.length < 4) return location;

    // its source, its leading `../` steps dropped, since sources are relative to the map
    let source = map.sources[found[1]] ?? '?';
    while (source.startsWith('../')) source = source.slice(3);
    return `(${source}:${found[2] + 1}:${found[3] + 1})`;
  });
}

// queries ////////////////////////////////////////////////////////////////////

/* Example query for loading all comments in a topic:

      let myTopic = ...;
      const q = engine.newQuery((qx: QX) => {
        const uuids = qx.get.topicComments(myTopic);
        const comments = {};
        const toplevels = [];
        for (const uuid of uuids) {
          comments[uuid] = qx.get.comments(uuid);
          if (!comment.parent) toplevels.push(uuid);
        }
        return {comments, toplevels};
      })
*/

/** user-facing query api */
export interface Query<T> {
  /** latest holds the most recent value passed to subscribe callback.  It is updated immediately
      after subscribe callbacks are made, on a per-Query basis. */
  latest: T | undefined;
  /** subscribe returns an unsubscribe function */
  subscribe(callback: (val: T) => void): () => void;
  /** close will stop the query from running again */
  close(): void;
}

/** A QueryFunction reads through its query context and returns its result.  It runs to completion
    in one call, so the graph records every key it reads, and runs it again only when one of those
    keys changes. */
export type QueryFunction<QX, T> = (qx: QX) => T;

/** what a query's run read: the keys it got, {key: true}, and what each walk of its scans
    covered, with the pattern of the last one as text to know the walk's next batch; held when
    a read was one the Engine holds (see Held) */
type ReadDeps = {
  keys: Record<string, true>;
  spans: ScanSpan[];
  last: string | null;
  held: boolean;
};

/** Thrown by a read the Engine holds: on first boot, until the first sync lands, a query may read
    only the Engine's status.  The query waits, with no result, and runs again with the graph. */
class Held extends Error {
  constructor() {
    super('the Engine holds this read until its first sync lands');
  }
}

// A ReadTxn over a store transaction, recording what it reads in deps when given.  In dev mode
// what it hands out is a read-only proxy, so a mutation of a result throws where it happens,
// naming the key; the JS representation is the one the app touches.
function readTxn(txn: RTxn, deps?: ReadDeps): ReadTxn {
  // a held read marks the run, so the query waits even when it catches the throw
  const read = <R>(fn: () => R): R => {
    try {
      return fn();
    } catch (e: unknown) {
      if (e instanceof Held && deps !== undefined) deps.held = true;
      throw e;
    }
  };
  const rtx: ReadTxn = {
    get(key, type) {
      if (deps !== undefined) deps.keys[key] = true;
      const value = read(() => txn.get(key, type, JS));
      return DEV ? readOnly(value, key) : value;
    },
    scan(req) {
      const values: ScanRequest['values'] =
        req.type === false ? false : { type: req.type, rep: JS };
      const result = read(() => txn.scan({ ...req, values }));
      if (deps !== undefined) record(deps, req, result.next);
      if (!DEV) return result;
      const entries: [string, unknown][] = result.entries.map(([k, v]) => [k, readOnly(v, k)]);
      return { entries, next: result.next };
    },
  };
  if (deps !== undefined) queryDeps.set(rtx, deps);
  return rtx;
}

// what each query transaction records its reads in, for its scans' walks to narrow
const queryDeps = new WeakMap<object, ReadDeps>();

// record what a scan batch walked; a batch resuming where the last span ends, under the same
// pattern, is the next batch of that walk and extends the span
function record(deps: ReadDeps, req: ReadScan, next: string | null): void {
  const reverse = req.reverse === true;
  const to = next ?? undefined;
  const text = JSON.stringify(req.pattern);

  // the next batch of the last span's walk extends it
  const last = deps.spans[deps.spans.length - 1];
  if (
    last?.to !== undefined &&
    last.to === req.after &&
    last.reverse === reverse &&
    deps.last === text
  ) {
    last.to = to;
    return;
  }

  // any other batch starts a span of its own
  deps.spans.push({ pattern: compilePattern(req.pattern), reverse, from: req.after, to });
  deps.last = text;
}

class QueryImpl<QX, T> {
  latest: T | undefined = undefined;
  closed: boolean = false;

  #subs: ((val: T) => void)[] = [];
  #fn: QueryFunction<QX, T>;
  // what the last run read
  #deps: ReadDeps = { keys: {}, spans: [], last: null, held: false };
  #runs: number = 0;
  #result: T | undefined = undefined;
  // the last run made a read the Engine held, so the next run goes ahead whatever changed
  #held: boolean = false;

  constructor(fn: QueryFunction<QX, T>) {
    this.#fn = fn;
  }

  // part of public api
  subscribe(callback: (val: T) => void): () => void {
    this.#subs.push(callback);
    // late subscribers get instant callback with the latest value
    if (this.#runs > 0) callback(this.latest as T);
    return () => {
      this.#subs = this.#subs.filter((x) => x !== callback);
    };
  }

  // part of public api
  close(): void {
    this.closed = true;
  }

  /** run against txn, unless it has run before and read nothing dirty changed; answers whether
      its result changed */
  run(txn: RTxn, context: (txn: ReadTxn) => QX, dirty: Record<string, true>): boolean {
    // a query that read nothing which changed keeps its result
    if (this.#runs > 0 && !this.#held && !this.#reads(dirty)) return false;

    // run it, recording what it reads; its transaction closes when it returns
    const deps: ReadDeps = { keys: {}, spans: [], last: null, held: false };
    const rtx = readTxn(txn, deps);
    let result: T;
    try {
      result = this.#fn(context(rtx));
    } catch (e: unknown) {
      if (!deps.held) throw e;
    } finally {
      closedTxns.add(rtx);
    }

    // a held read: the query keeps what it had and waits for the next run
    this.#held = deps.held;
    if (deps.held) return false;

    const old = this.#result;
    this.#result = result!;
    this.#deps = deps;
    this.#runs++;
    return this.#runs === 1 || this.#result !== old;
  }

  // whether the last run read a key in dirty, by getting it or by walking past where it lies
  #reads(dirty: Record<string, true>): boolean {
    const { keys, spans } = this.#deps;
    for (const k in dirty) {
      if (k in keys || spans.some((s) => spanCovers(s, k))) return true;
    }
    return false;
  }

  // call subscribers with the latest result
  notify(): void {
    if (this.closed) return;
    for (const sub of this.#subs) {
      sub(this.#result!);
    }
    this.latest = this.#result;
  }
}

/** QueryGraph tracks the app's queries and runs them again when keys they read change.  Each query
    runs over a read transaction that records its keys, through the query context the Engine's
    context factory builds over it.  The Engine tells it which keys changed: keys written by real
    events, keys of an overlay being discarded, and keys a new forecast wrote. */
export class QueryGraph<QX> {
  #context: (txn: ReadTxn) => QX;
  // the keys changed since the last run: {key: true}
  #dirty: Record<string, true> = {};
  #queries: QueryImpl<QX, unknown>[] = [];
  // queries added since the last run, which have never run
  #newQueries: QueryImpl<QX, unknown>[] = [];

  constructor(context: (txn: ReadTxn) => QX) {
    this.#context = context;
  }

  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    const q = new QueryImpl<QX, T>(fn);
    this.#queries.push(q as QueryImpl<QX, unknown>);
    this.#newQueries.push(q as QueryImpl<QX, unknown>);
    return q;
  }

  dirty(keys: Record<string, true>): void {
    Object.assign(this.#dirty, keys);
  }

  /** run every open query whose keys changed, and return a callback that notifies the subscribers
      of every query whose result changed */
  run(txn: RTxn): () => void {
    const dirty = this.#dirty;
    this.#dirty = {};

    // #newQueries are already in #queries, so they're no longer new
    this.#newQueries = [];

    // discard closed queries and run all the rest
    this.#queries = this.#queries.filter((q) => !q.closed);
    return this.#execute(txn, this.#queries, dirty);
  }

  /** run only the queries added since the last run */
  extend(txn: RTxn): () => void {
    // extend an existing run with only new queries
    const queries = this.#newQueries;
    this.#newQueries = [];
    return this.#execute(txn, queries, {});
  }

  #execute(txn: RTxn, queries: QueryImpl<QX, unknown>[], dirty: Record<string, true>): () => void {
    const changed = queries.filter((q) => q.run(txn, this.#context, dirty));
    return () => {
      for (const q of changed) q.notify();
    };
  }
}

class RemoteQuery<T> {
  latest: T | undefined = undefined;
  closed: boolean = false;
  #subs: ((val: T) => void)[] = [];

  #onClose: () => void;

  // RemoteQuery is passed a subcription factory.  The factory receives an onResults hook and
  // returns a closer function.  This dance avoids hardcoding things like "every subscription gets
  // a unique subId" since that is a wire protocol detail, not an API detail.
  constructor(subscriptionFactory: (onResult: (result: T) => void) => () => void) {
    this.#onClose = subscriptionFactory((result: T) => this.#onResult(result));
  }

  #onResult(result: T): void {
    if (this.closed) return;
    for (const sub of this.#subs) {
      sub(result!);
    }
    this.latest = result;
  }

  // part of public api
  subscribe(callback: (val: T) => void): () => void {
    this.#subs.push(callback);
    return () => {
      this.#subs = this.#subs.filter((x) => x !== callback);
    };
  }

  close(): void {
    if (this.closed) return;
    this.#onClose();
    this.closed = true;
  }
}

/** QueriesIO is implemented by the user and passed into the RemoteQueries subclass.  Only the user
    knows the transport over which query data should flow; what flows is msgpack: the encoded
    call one way, each encoded result the other. */
export interface QueriesIO {
  /** createQuery takes the encoded call and an onResult hook for each encoded result, and
      returns a closer function */
  createQuery(query: Uint8Array, onResult: (result: Uint8Array) => void): () => void;
}

/** RemoteQueries is the base class behind the generated, strongly-typed remote query interfaces.
    A call is `[id, ...args]`, converted through the Registry under the interface's wire type,
    and a result is converted under the query's id plus `#result`. */
export class RemoteQueries {
  #reg: Registry;
  #io: QueriesIO;

  constructor(reg: Registry, io: QueriesIO) {
    this.#reg = reg;
    this.#io = io;
  }

  newQuery<T>(wireType: string, call: unknown[], id: string): Query<T> {
    const query = this.#reg.convert(wireType, call, JS, MSGPACK) as Uint8Array;
    const resultType = `${id}#result`;
    return new RemoteQuery<T>((onResult: (result: T) => void) => {
      return this.#io.createQuery(query, (result: Uint8Array) => {
        onResult(this.#reg.convert(resultType, result, MSGPACK, JS) as T);
      });
    });
  }
}

// connectors ////////////////////////////////////////////////////////////////////

export type Backfill = {
  // what ref are we backfilling (stream name or prefix)
  ref: string;
  // the tail's exclusive upper bound: the cursor when this backfill started.  Anything at or
  // above it arrives on the live stream and is parked.  Retries keep the original value.
  until: number;
  // what a previous attempt got through, or null for a fresh backfill.  A finished half is
  // skipped outright.  Otherwise skipBytes > 0 resumes the blob download, and the header's
  // position must then equal position or the outcome is 'stale'; skipBytes === 0 fetches from
  // the start and accepts any position.  The tail starts at max(fromPosition, header position),
  // so a newer blob overrides the floor.  It reads forward, which may result in gaps if retention
  // pruning happens concurrently, so it must be checked for gaps just before landing.
  resume: null | {
    position: number;
    skipBytes: number;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  // cancels this backfill alone; the connector's own signal cancels everything
  signal: Signal;
  // one call per delivery, resolved once the Engine has committed it
  push(item: BackfillItem): Promise<void>;
};

/** One delivery of a backfill: the blob's whole length in bytes, when its response states one;
    the blob's header (its cut position and the seq of every stream in it); a batch of values with
    the byte offset after them; a page of tail events with the position its scan reached; or the
    end of either half.  The length and the scan feed the Engine's progress status alone. */
export type BackfillItem =
  | { length: number }
  | { header: { position: number; seqs: Record<string, number> } }
  | { values: [string, Uint8Array][]; skip: number }
  | { valuesDone: true }
  | { events: WireEvent[]; scanned: number }
  | { eventsDone: true };

/** What the database answers for a command.  `ok` means it was decided at or before position, so
    a client that has reduced that far can read the outcome from its state.  A reject's reason
    and a conflict's current seqs come only in the first answer to a decision, and a resend of
    either is answered `ok`. */
export type CommandResult =
  | { kind: 'ok'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, or a resumed fetch's PhaseLock-Position differs from
// resume.position; the Engine discards what it parked and starts over.  Any other failure rejects,
// and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connector {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and within a call, array order.  A call that fails also
  // fails every call behind it, unsent, and ends the connection, so the next connection's resend
  // keeps the Engine's order.  Retrying before giving up is the connector's choice.
  sendCommands(commands: Command<Uint8Array>[]): Promise<CommandResult[]>;
}

export interface ConnectorHooks {
  // first, once per connection, before any frame: from the response headers, the epoch, the log
  // every position on this connection belongs to, and the head, the log's position as the
  // connection opened
  onOpen(epoch: string, head: number): void;
  // the whole view: token is its hash, position the commit it is the view at, refs the set.
  // Sent first when the presented token was not current, and on every change, in stream order
  // ahead of the events it applies to.  The Engine diffs refs against what it holds.
  onView(token: string, position: number, refs: string[]): void;
  onEvents(events: WireEvent[]): void;
  // history done; live from here (sent once per connection)
  onLive(position: number): void;
  onVouch(position: number): void;
  onEnd(code: number, reason: string): void;
}

// One Connector per connection: calling the factory is the connect attempt, since is the
// Engine's checkpoint (-1 to bootstrap), and the connector reports exactly one onEnd.  The signal
// is its lifetime; aborting it ends the connection and rejects any backfill or send in flight.
export type ConnectorFactory = (
  since: number,
  view: string | null, // the Engine's stored view token; null to bootstrap
  wants: string[],
  signal: Signal,
  hooks: ConnectorHooks,
) => Connector;

// engines ////////////////////////////////////////////////////////////////////

/** Command wraps command data T with the client-minted id it will carry through the log, and
    the session and number the database dedups it by: a sender numbers its commands in a session
    it mints, and the database runs each number once.  A sessionless command has neither. */
export type Command<T> = {
  id: string;
  session: string | null;
  n: number | null;
  data: T;
};

/** DbEvent is event data T with the envelope the DB stamped on it when it was committed:
    [position, stream, seq, id, servertime] on the wire, the server time a msgpack timestamp.  The
    id is the command's. */
export type DbEvent<T> = {
  id: string;
  data: T;
  position: number;
  stream: string;
  seq: number;
  servertime: Date;
};

/** WireEvent is an event as a connector delivers it: the envelope decoded for routing, data as
    the bytes the server sent, and the whole wire pair `[env, data]` so if needs to be parked, the
    full msgpack format is readily available. */
export type WireEvent = DbEvent<Uint8Array> & { raw: Uint8Array };
/** one slice's reducer, keyed by stream prefix in the Engine's table.  The Engine calls it with a
    run of one stream's events, in order, inside the transaction that brings them in, through a
    ReducerTxn over that stream's own keys.  `pending` is true when the events are a forecast
    folded onto the overlay, and false for real events folded onto the base, so a reducer may mark
    what it writes as pending; the base, the only state ever stored or synced, is always folded
    with false.  `template` is the slice's family template and `keys` its key templates, as
    declared, which every stream name and every key the reducer writes must fill. */
export type SliceReducer = {
  reducer: (txn: ReducerTxn, events: unknown[], stream: string, pending: boolean) => void;
  template: string;
  keys: string[];
};

/** the view, as persisted at !view when a reconciliation commits */
export type ViewRecord = { token: string; position: number; refs: string[] };
/** the cursor, as persisted at !checkpoint with every batch, vouch, and live mark */
export type CheckpointRecord = { epoch: string; position: number; reduced: number };
/** a backfill in flight, as persisted at !backfill:{ref} */
export type BackfillRecord = {
  until: number;
  resume: Backfill['resume'];
  replacing: boolean;
  children: string[];
};
/** the in-memory side of a backfill: its record, written through, plus what the disk needs not */
type BackfillEntry = {
  record: BackfillRecord;
  controller: SignalController;
  status: 'downloading' | 'ready';
  parent: string | null;
  // failed attempts in a row, for backoff, and the retry waiting to run, due at retryAt
  attempts: number;
  retryTimer: unknown;
  retryAt: number | null;
  // the blob's length, when its response stated one, and how far the tail's scan has reached
  length: number | null;
  scanned: number;
};

// a backfill entry as it starts, with no attempt made
function newBackfillEntry(record: BackfillRecord, parent: string | null): BackfillEntry {
  return {
    record,
    controller: new host.AbortController(),
    status: 'downloading',
    parent,
    attempts: 0,
    retryTimer: null,
    retryAt: null,
    length: null,
    scanned: -1,
  };
}

// a backfill's status, from its record and what its connector has reported
function backfillStatus(ref: string, entry: BackfillEntry): BackfillStatus {
  const r = entry.record.resume;
  const snapshot = {
    bytes: r?.skipBytes ?? 0,
    length: entry.length,
    done: r?.snapshotDone ?? false,
  };
  const tail =
    r === null
      ? null
      : {
          cut: r.position,
          scanned: Math.max(r.fromPosition, entry.scanned),
          until: entry.record.until,
          done: r.tailDone,
        };
  const retryAt = entry.retryAt === null ? null : new Date(entry.retryAt);
  return { ref, replacing: entry.record.replacing, snapshot, tail, retryAt };
}

// a tail's share scanned: none before the blob's header gives its cut, and all once done
function tailShare(b: BackfillStatus): number {
  const t = b.tail;
  if (t === null) return 0;
  if (t.done || t.until <= t.cut) return 1;
  return Math.min(1, Math.max(0, (t.scanned - t.cut) / (t.until - t.cut)));
}

/** whether a wire ref covers a stream name or a narrower ref: a wildcard (`*`, `chat:*`,
    `chat:acme,*`) covers the names under the prefix before its star, and a name covers itself */
export function refCovers(ref: string, name: string): boolean {
  if (ref.endsWith('*')) return name.startsWith(ref.slice(0, -1));
  return name === ref;
}

/** one push from a backfill, queued for the advancer with the promise's resolvers */
type BackfillWork = {
  ref: string;
  item: BackfillItem;
  resolve: () => void;
  reject: (e: unknown) => void;
};

/** one command the app submitted: one for the outbox, or an @online one with its promise's
    resolvers */
type Submission<C, N> =
  | { outbox: C }
  | { online: N; resolve: (result: CommandResult) => void; reject: (e: unknown) => void };

/** an @online command handed to a connector and not yet settled: its promise's resolvers, the
    database's ok once it arrives, and whether an event carrying its id has been reduced */
type OnlineCommand = {
  resolve: (result: CommandResult) => void;
  reject: (e: unknown) => void;
  ack: { kind: 'ok'; position: number } | null;
  seen: boolean;
};

/** the store key prefix a ref covers: a wildcard's text before its star (`chat:`, `chat:acme,`,
    and the empty prefix for `*`), and `{stream}!` for a stream */
export function refPrefix(ref: string): string {
  if (ref.endsWith('*')) return ref.slice(0, -1);
  return `${ref}!`;
}

/** the delay before the n-th retry in a row: exponential from half a second, capped at half a
    minute, with jitter so a fleet does not retry in step */
export function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 10));
  return base / 2 + Math.random() * (base / 2);
}

/** the `$sys` of a birth or death event's data, null for an ordinary event */
export function sysOf(data: unknown): 'birth' | 'death' | null {
  if (data !== null && typeof data === 'object' && '$sys' in data) {
    const sys = (data as { $sys: unknown }).$sys;
    if (sys === 'birth' || sys === 'death') return sys;
  }
  return null;
}

/** the key of a parked event: its stream, then its seq zero-padded so a scan of the stream's
    prefix walks its chain in order; a re-parked event overwrites itself */
export function parkedEventKey(stream: string, seq: number): string {
  return `!park-ev:${stream}!${String(seq).padStart(20, '0')}`;
}

/** the key of an outbox command: its ordinal zero-padded so a scan walks the outbox in send
    order */
export function commandKey(ordinal: number): string {
  return `!command:${String(ordinal).padStart(20, '0')}`;
}

/** the pattern of the Engine's own keys of one template, by a match on its one parameter */
function engineKeys(name: string, match: ParamMatch = null): KeyPattern {
  return { stream: '', name, local: [match] };
}

/** the stream and seq a parked event key names */
export function parsePark(key: string): { stream: string; seq: number } {
  const at = '!park-ev:'.length;
  const bang = key.indexOf('!', at);
  return { stream: key.slice(at, bang), seq: Number(key.slice(bang + 1)) };
}

/** one thing a forecast emits: an event labelled with its stream, or the end of a stream */
export type ForecastOutput = { stream: string; event: unknown } | { stream: string; death: true };

/** a handler's typed output, which nests tuples and arrays of outputs, as the flat list of them */
export function outputList(out: unknown): ForecastOutput[] {
  return [out].flat(Infinity) as ForecastOutput[];
}

/** the app's forecast of what the database will do with a command, read through the forecast
    context over the overlay; a throw, a Reject included, forecasts nothing */
export type Forecaster<FX, C> = (fx: FX, command: C) => ForecastOutput[];

// status ////////////////////////////////////////////////////////////////////

/* Queries read the Engine's status like any state: where the connection stands, how far syncing
   has come, and the outbox.  Sync work comes in three kinds, which the Engine tells apart and the
   UI may treat differently.

   First boot.  The Engine has no base: nothing has been reduced yet, on a fresh store or on one
   whose first sync never landed.  The first view's grants download as replacing backfills and
   land together, so the first state queries see is complete.  Until then the Engine refuses every
   query that reads past the status: such a query waits with no result and answers once the base
   exists, while a query that reads only the status answers at once.  The UI shows a loading
   screen, with a bar from the estimate, while `hasBase` is false.

   Resync.  A connection replays history onto an existing base, from the checkpoint to the head,
   and queries see each batch as it lands, so the app zooms forward at catch-up speed.  Every
   state shown is a prefix of the log, consistent if stale.  The UI may let the zoom show, or
   cover it with a loading screen while `state` is `syncing`.  A gap partway through replaces its
   stream with a backfill and freezes the base until it lands; queries keep answering from the
   frozen base.

   Backfill.  Downloads on a live base: a new grant, or a gap's repair, and queries keep
   answering through both.  A new grant is additive: the base keeps moving while it downloads,
   and its streams appear when it lands.  A gap's repair is replacing: the base freezes until it
   lands, and queries answer from the frozen base meanwhile.  The UI may show progress or
   nothing.

   The estimate runs from 0 to 1 over one episode of work, and is null between episodes.  It
   weighs the stages of each kind:
     - first boot and backfill: 5% knowing every backfill and its size, 85% the downloads, and
       10% the land
     - resync: 5% the ref list confirmed, by any frame after the open, 20% backfills, and 75% the
       replay, the checkpoint's way from where the episode started to the head the server stated
       when the connection opened
   A download is half snapshot and half tail.  The snapshots are exact, bytes over lengths, while
   every backfill in flight has a length its response stated, and otherwise fall back to
   downloadCurve over the bytes downloaded.  A tail is the share of its span, from the blob's cut
   to until, that its scan has reached.  A resync never knows which backfills it will need, so its
   backfill share is half the held streams resolved, each when an event chains onto it, when its
   backfill lands, or when the replay reaches head, and half the download, which is whole until a
   backfill starts and then follows downloadCurve whatever lengths are known.

   The estimate never goes back.  Work found partway, such as a gap's backfill or a backfill whose
   size is unknown, pauses it until the work catches up, and a stage that finishes may jump it
   forward. */

/** Where the Engine's connection stands: `connecting` until the connection opens, `syncing`
    while it replays history, `live` past that, and `offline` between attempts, the next at
    `nextAttemptAt`.  `hasBase` is false until a first boot's sync lands, while queries may read
    only the status; `frozen` is true while a replacing backfill is in flight and the base waits
    for it. */
export type ConnectionStatus = {
  state: 'connecting' | 'syncing' | 'live' | 'offline';
  nextAttemptAt: Date | null;
  hasBase: boolean;
  frozen: boolean;
};

/** One backfill in flight.  The snapshot is in bytes: those committed, and the blob's length
    when its response states one.  The tail is in log positions, from the blob's cut to until,
    scanned up to `scanned`; it is null until the blob's header gives the cut. */
export type BackfillStatus = {
  ref: string;
  replacing: boolean;
  snapshot: { bytes: number; length: number | null; done: boolean };
  tail: { cut: number; scanned: number; until: number; done: boolean } | null;
  retryAt: Date | null;
};

/** How far syncing has come.  `estimate` runs from 0 to 1 over the work in progress and never
    goes back, and is null when nothing is in progress.  The log is in positions: where this
    connection started, the server's head as last known, the checkpoint, and how far the base
    has been reduced. */
export type ProgressStatus = {
  estimate: number | null;
  log: { since: number; head: number | null; committed: number; reduced: number };
  backfills: BackfillStatus[];
};

/** the outbox: commands the database has not acknowledged */
export type OutboxStatus = { unacknowledged: number };

/** The Engine's status, which a query reads like any state and runs again when it changes.
    Every value is the Engine's latest, replaced whole when it changes and never mutated. */
export type EngineStatus = {
  connection(): ConnectionStatus;
  progress(): ProgressStatus;
  outbox(): OutboxStatus;
};

// the keys the status is read at, which no store holds; the Engine answers them from memory
const STATUS_KEYS = {
  connection: '!status:connection',
  progress: '!status:progress',
  outbox: '!status:outbox',
} as const;

/** the status accessor of a query context, over the query's read transaction so its reads are
    recorded like any other */
export function engineStatus(cell: TxnCell<ReadTxn>): EngineStatus {
  return {
    connection: () => cell.txn.get(STATUS_KEYS.connection, '.json') as ConnectionStatus,
    progress: () => cell.txn.get(STATUS_KEYS.progress, '.json') as ProgressStatus,
    outbox: () => cell.txn.get(STATUS_KEYS.outbox, '.json') as OutboxStatus,
  };
}

// The read transaction queries run over: the status keys from the published status, every
// other read from txn.  While held, every other read throws Held.
function statusView(txn: RTxn, status: Map<string, unknown>, held: boolean): RTxn {
  return {
    get(key, type, rep) {
      if (status.has(key)) return status.get(key);
      if (held) throw new Held();
      return txn.get(key, type, rep);
    },
    scan(req) {
      if (held) throw new Held();
      return txn.scan(req);
    },
  };
}

/** The share of a download of unknown size that `bytes` is taken to be: the remaining share
    halves with every tenfold, so 1 MB is 19%, 10 MB 51%, and 100 MB 75% */
export function downloadCurve(bytes: number): number {
  return 1 - (1 + bytes / 1_000_000) ** -Math.log10(2);
}

/** one stretch of sync work, which the estimate measures; it keeps its kind until its work is
    done */
type Episode = {
  kind: 'boot' | 'resync' | 'backfill';
  // the most the estimate has shown, which it never goes below
  shown: number;
  // every backfill of the episode as last seen; one no longer in flight is complete
  backfills: Map<string, BackfillStatus>;
  // a resync's start: the checkpoint, and the streams held then, which each resolve when an event
  // chains onto one, when its backfill lands, or when the replay reaches head
  since: number;
  held: Set<string>;
  resolved: Set<string>;
  // a resync's connection has delivered a frame after it opened, which confirms the ref list
  confirmed: boolean;
};

/** what the connector delivered, in arrival order */
type Inbound =
  | { open: { epoch: string; head: number } }
  | { view: ViewRecord }
  | { events: WireEvent[] }
  | { vouch: number }
  | { live: number }
  | { end: { code: number; reason: string } };

/** Engine builds a sync engine out of a ConnectorFactory, a Store, a user's reducers, and
    optionally a user's forecasters.  The Engine is responsible for managing connection status, the
    synchronization protocol, and the flow of events and commands, ultimately keeping the Store as
    up-to-date with the PhaseLockDB server as possible.

    An application interacts with the Engine primarily through newQuery(), which returns a
    subscribable stream of results, and sendCommand(), which sends commands back to PhaseLockDB.
    If forecasters were provided, the Engine also provides optimistic updates.

    With forecasters and a persistent Store implementation, the Engine is the basis for a fully
    offline-capable application.

    Engine internals diagram:

        (* = owned by user)
         ______________________________________________________
        |  PWA                                                 |
        |    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
        |   | Engine                                        |  |
        |       ___________           __________________       |
        |   |  |           |       C |                  |   |  |
        |      | *reducers |<------->|  store + overlay |      |
        |   |  |___________|         |__________________|   |  |
        |         ^ B    ^              ^         |            |
        |   |     |      |              | H       | D       |  |
        |         |    __|___________   |   ______v______      |
        |   |     |   |              |  |  |             |  |  |
        |         |   | *forecasters |  |  | query graph |     |
        |   |     |   |______________|  |  |_____________|  |  |
        |         |               ^     |    _ _ _|_ _ _ _ _   |
        |   |     |               | G   |   |     | E          |
        |       __|__________     |     |       __v___         |
        |   |  |             | I  |     |   |  |      |        |
        |      |  connector  |<---+-----+------| *UI  |        |
        |   |  |_____________|            F |  |______|        |
        |           ^                                          |
        |   |_ _ _ _|_ _ _ _ _ _ _ _ _ _ _ _|                  |
        |___________|__________________________________________|
                    |
                    | A
               _____v_______
              |             |
              | PhaseLockDB |
              |_____________|

        A: connector talks to PhaseLockDB, reading events and writing commands

        B: events received by connector are passed to reducers

        C: reducers process incoming batches, updating store

        D: query graph wakes after store update and reruns queries whose dependencies have changed

        E: fresh query results are delivered to the UI

        F: UI submits new commands with Engine.sendCommand()

        G: new commands trigger forecaster; forecasted events are reduced onto storage overlay

        H: new commands are also stored in an outbox in the store

        I: new commands are also sent through the connector

    Engine-owned store keys.  Slice state lives at `{stream}!{local key}`; everything the Engine
    keeps for itself lives in the nameless stream, which no stream name can reach, so its keys
    start with `!`.  Its local keys follow the template grammar, and the parked keys' terminal
    parameter is itself a stream or ref, `!`, then the rest.  Each is stored as `.json` unless
    noted:

        !view                      ViewRecord: the view token, its position, and the refs granted
        !checkpoint                CheckpointRecord: the epoch of the log the cursor is in, the
                                   cursor, advanced with every batch, vouch, and live mark, and
                                   how far the base is reduced
        !seq:{stream}              the stream's last held seq, or 'backfill' while a backfill
                                   covering it is in flight
        !command:{ordinal}         Command<Uint8Array> (`.command`): the outbox, in send order,
                                   each command's data as its wire bytes, under the session and
                                   number it was minted with; ordinal zero-padded to 20 digits so
                                   a scan walks the outbox in order
        !backfill:{ref}            BackfillRecord: an in-flight backfill's until, resume, replacing,
                                   and children
        !backfill-seqs:{ref}       the backfill blob's header seqs, stream name to seq
        !park-ev:{stream}!{seq}    a parked event (`.event`), raw as delivered; seq zero-padded to
                                   20 digits so a stream's range walks its chain; a ref's key
                                   prefix after `!park-ev:` covers its streams' events
        !park-kv:{ref}!{key}       a slice value from the ref's backfill blob, typed as its key
                                   is, moved to {key} when the backfill lands
        !status:{part}             the Engine's status that queries read, its connection,
                                   progress, or outbox; no store holds it, since the Engine
                                   answers it from memory
*/
export class Engine<QX, FX, C, N = never> {
  #store: Store;
  #reg: Registry;
  #connect: ConnectorFactory;
  #reducers: Record<string, SliceReducer>;
  // the pattern of each reducer's stream names, by stream prefix
  #streamPatterns: Record<string, RegExp>;
  // runs against the overlay for every outbox command in order on every rebuild; a string is a
  // rejection and forecasts nothing
  #forecaster: null | Forecaster<FX, C>;
  #wants: string[];
  #signal: Signal;

  #overlay: Overlay;
  #graph: QueryGraph<QX>;
  #onError: (e: unknown) => void;
  #scheduled: boolean = false;
  // the persisted state is loaded, and the advancer takes work from here
  #initialized: boolean = false;
  // an advancer pass threw or the signal fired, so nothing runs again
  #ended: boolean = false;

  // the live connection: one connector per attempt, its lifetime (replaced as soon as it is
  // spent), and the backoff between attempts
  #connector: Connector | null = null;
  #connectorAbort: SignalController;
  #attempt: number = 0;
  #retryTimer: unknown = null;
  #nextAttemptAt: number | null = null;
  #connectNow: boolean = false;

  // the connection's checkpoint as it started, the server's head as last known, and whether a
  // frame after the open has confirmed the ref list
  #since: number = -1;
  #head: number | null = null;
  #confirmed: boolean = false;

  // the status queries read, by key, as last published, with each value's JSON to tell a change
  #status: Map<string, unknown> = new Map();
  #statusJson: Map<string, string> = new Map();
  // the sync work the progress estimate measures, if any is in progress
  #episode: Episode | null = null;

  // the persisted state, held in memory and written through
  #view: ViewRecord | null = null;
  #checkpoint: CheckpointRecord | null = null;
  // seq per held stream, or the marker for a stream under an in-flight ref; the marker is
  // persisted at !seq:{stream} on first sight during the backfill, in the transaction that parks
  #streams: Map<string, number | 'backfill'> = new Map();
  #backfills: Map<string, BackfillEntry> = new Map();
  // the outbox in send order: command id to its ordinal in !command:{ordinal}
  #outbox: Map<string, number> = new Map();
  #nextOrdinal: number = 0;
  // the session new commands are minted in, and the number the next one takes.  Neither touches
  // the disk: a stored outbox resends under the sessions it was minted in, and new commands go in
  // a session of this Engine's own, so two Engines over one copied store never share one.
  readonly #session: string;
  #nextN: number = 1;
  // outbox commands handed to the current connection with no outcome yet, and those acked, with
  // the position they landed at, waiting for the checkpoint to reach it
  #sent: Set<string> = new Set();
  #acked: Map<string, number> = new Map();
  // @online commands handed to a connector and not yet settled, by id
  #online: Map<string, OnlineCommand> = new Map();
  // set by a release inside a transaction, read by the refresh after its commit
  #outboxChanged: boolean = false;
  // how far the base has been reduced, -1 for never: the checkpoint, except while frozen, when it
  // stays at the last event that reduced.  Persisted in the checkpoint record.  An acked command
  // at or below it is in the base, events or none
  #reduced: number = -1;

  // the connector has delivered `live`
  #live: boolean = false;
  // the log this connection's positions belong to, from its first hook; null between connections
  #epoch: string | null = null;
  #replacing: number = 0;

  // work received from the connector, in arrival order
  #inbox: Inbound[] = [];
  // backfill progress from the connector's hooks; each item resolves its promise after commit
  #backfillWork: BackfillWork[] = [];
  // how each backfill() call ended, and on which connection
  #backfillOutcomes: {
    ref: string;
    outcome: BackfillOutcome | { failed: unknown };
    conn: SignalController;
  }[] = [];
  // how each sendCommands() call ended, with the ids it carried in order
  #commandOutcomes: { ids: string[]; results: CommandResult[] | { failed: unknown } }[] = [];
  // work received from the app
  #submitted: Submission<C, N>[] = [];
  #newQueries: boolean = false;
  // every new connection resends the outbox
  #resend: boolean = false;
  // builds the forecast context, handed to every forecast, over a read transaction
  #forecastContext: (txn: ReadTxn) => FX;

  constructor(
    // the context a query reads, the engine's slices and the Engine's status, and the context a
    // forecast reads, the slices alone; each over a read transaction
    queryContext: (txn: ReadTxn) => QX,
    forecastContext: (txn: ReadTxn) => FX,
    // if store is null, InMemStore is used
    store: Store | null,
    reg: Registry,
    connect: ConnectorFactory,
    callbacks: {
      // injected by generated subclass: each slice's reducer and scoped context, by stream prefix
      reducers: Record<string, SliceReducer>;
      // injected by generated subclass: the refs of the shards the engine declares
      wants: string[];
      // optional: forecast what the database will do with a command, reading the state the
      // earlier outbox commands leave
      forecaster?: Forecaster<FX, C>;
      // optional: ends the Engine, its connector, and every backfill
      signal?: Signal;
      // optional: receives the error that ended the Engine; without it the error is thrown out
      // of the timer callback that ran the advancer
      onError?: (e: unknown) => void;
    },
  ) {
    checkHost();
    this.#session = generateSession();
    this.#forecastContext = forecastContext;
    this.#store = store ?? new InMemStore(reg);
    this.#reg = reg;
    this.#connect = connect;
    this.#reducers = callbacks.reducers;
    this.#streamPatterns = {};
    for (const [family, slice] of Object.entries(callbacks.reducers)) {
      this.#streamPatterns[family] = streamPattern(slice.template);
    }
    this.#wants = callbacks.wants;
    this.#forecaster = callbacks.forecaster ?? null;
    this.#signal = callbacks.signal ?? new host.AbortController().signal;
    this.#connectorAbort = new host.AbortController();
    this.#onError =
      callbacks.onError ??
      ((e) => {
        throw e;
      });
    this.#signal.addEventListener('abort', () => this.#schedule(), { once: true });

    this.#overlay = new Overlay(reg);
    this.#graph = new QueryGraph(queryContext);

    // let the advancer begin initializing
    this.#run();
  }

  //// public api ////

  /** After forecasting and saving to the outbox, the command is sent through the connector, in
      order with every command submitted before it.  It is given in rich format (Date, Maps, and
      Sets intact). */
  sendCommand(command: C): void {
    this.#submitted.push({ outbox: command });
    this.#schedule();
  }

  /** Sends an @online command behind every command submitted before it, in the Engine's
      session, and settles with the database's answer.  A reject or a conflict settles at once.
      An ok settles on the round trip, once the queries have run over the base the position it
      names reached; it means the command was decided, so a resend of a rejected one settles ok
      too, and the app reads the outcome from state.  It rejects when there is no connection to
      send it on, when its call fails, and when the Engine ends.  It is never persisted or
      forecast, and the connector's retry of its call is the only resend. */
  sendOnlineCommand(command: N): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (this.#ended || this.#signal.aborted) {
        reject(new Error('engine ended'));
        return;
      }
      this.#submitted.push({ online: command, resolve, reject });
      this.#schedule();
    });
  }

  /** connect now rather than when the backoff timer fires */
  reconnectNow(): void {
    this.#connectNow = true;
    this.#schedule();
  }

  /** Add a new Query to the graph.  On first boot, until the first sync lands, it answers only if
      it reads the status alone. */
  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    this.#newQueries = true;
    this.#schedule();
    return this.#graph.newQuery(fn);
  }

  //// end of public api ////

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    host.setTimeout(() => {
      this.#scheduled = false;
      this.#run();
    }, 0);
  }

  // one run of the advancer; a throw out of it ends the Engine
  #run(): void {
    if (this.#ended) return;
    try {
      this.#advancer();
    } catch (e: unknown) {
      this.#ended = true;
      this.#rejectOnline(e);
      this.#onError(e);
    }
  }

  #initialize(): void {
    // load the persisted state into memory
    this.#store.read((txn) => {
      const checkpoint = txn.get('!checkpoint', '.json', JS) as CheckpointRecord | undefined;
      this.#checkpoint = checkpoint ?? null;
      this.#view = (txn.get('!view', '.json', JS) as ViewRecord | undefined) ?? null;

      // the streams table: seq per held stream, or the marker for a stream under a backfill
      const json = { type: '.json', rep: JS } as const;
      const seqRows = scanAll(txn, { pattern: engineKeys('seq'), limit: 1000, values: json });
      for (const [key, value] of seqRows) {
        this.#streams.set(key.slice('!seq:'.length), value as number | 'backfill');
      }

      // the outbox in ordinal order; the next ordinal continues from the last key
      const commandRows = scanAll(txn, {
        pattern: engineKeys('command'),
        limit: 1000,
        values: { type: '.command', rep: JS },
      });
      for (const [key, value] of commandRows) {
        const ordinal = Number(key.slice('!command:'.length));
        this.#outbox.set((value as Command<Uint8Array>).id, ordinal);
        this.#nextOrdinal = ordinal + 1;
      }

      // the backfills in flight, each with a fresh controller
      const backfillRows = scanAll(txn, {
        pattern: engineKeys('backfill'),
        limit: 1000,
        values: json,
      });
      for (const [key, value] of backfillRows) {
        const record = value as BackfillRecord;
        this.#backfills.set(key.slice('!backfill:'.length), newBackfillEntry(record, null));
        if (record.replacing) this.#replacing++;
      }
    });

    // a backfill whose download finished before the crash is ready to land
    for (const [ref, entry] of this.#backfills) {
      entry.parent = this.#parentOf(ref);
      const r = entry.record;
      if (r.resume?.snapshotDone && r.resume.tailDone) entry.status = 'ready';
    }
    this.#reduced = this.#checkpoint?.reduced ?? -1;

    // purge what this build does not want.  The wants are the refs this build can fold, and the
    // server cuts the view down to them, so a stream, a backfill, or a view ref outside the wants
    // is an earlier build's.  Every one goes now, so the view frame that answers our token finds
    // the base as this build would have made it.
    const wanted = (x: string) => this.#wants.some((w) => refCovers(w, x));
    const wasFrozen = this.#replacing > 0;
    const dirty: Record<string, true> = {};
    this.#store.write((txn) => {
      // every backfill outside the wants
      for (const ref of [...this.#backfills.keys()]) {
        if (!wanted(ref)) this.#dropBackfillIn(txn, ref);
      }

      // every stream outside the wants
      for (const stream of [...this.#streams.keys()]) {
        if (!wanted(stream)) this.#dropStreamIn(txn, stream, dirty);
      }

      // every view ref outside the wants, so the next frame grants what it covered afresh
      if (this.#view !== null && !this.#view.refs.every(wanted)) {
        this.#view = { ...this.#view, refs: this.#view.refs.filter(wanted) };
        txn.set('!view', '.json', JS, this.#view);
      }

      // did the purge end the last replacing backfill?  Then this is the unfreeze.  Either way,
      // whatever waits ready on disk lands now.
      if (wasFrozen && this.#replacing === 0) {
        this.#unfreezeIn(txn, dirty);
      } else {
        this.#tryLandIn(txn, dirty);
      }
    });

    // the first connection attempt
    this.#connectNow = true;

    // publish the status, and forecast every outbox command onto a fresh overlay
    this.#refresh({}, true);
  }

  // the most specific in-flight ref that covers ref, other than itself, so the parent of a child
  #parentOf(ref: string): string | null {
    let parent: string | null = null;
    for (const other of this.#backfills.keys()) {
      if (other === ref || !refCovers(other, ref)) continue;
      if (parent === null || other.length > parent.length) parent = other;
    }
    return parent;
  }

  /* Our main logic is a loop, run whenever work is scheduled until none is left.  Each pass takes
     one kind of work, does it in its own transactions, and starts over, so the order of the
     branches is the priority: what the user is waiting on first, the app's commands and queries,
     then the live stream, then the outcomes of our own calls, then background work that batches
     well and can wait, and a new connection last.

     Anything thrown out of a pass ends the Engine.  The transaction rolled back, so the store
     resumes from the same point on the next start, and memory changed inside a transaction is
     never read again.  Nothing catches and continues. */
  #advancer(): void {
    // the first run loads the persisted state
    if (!this.#initialized) {
      this.#initialize();
      this.#initialized = true;
    }

    while (true) {
      if (this.#signal.aborted) {
        // the app ended us: end the connector and every backfill, and nothing runs after that
        this.#shutdown();
        this.#ended = true;
        return;
      }

      if (this.#submitted.length > 0 || this.#resend) {
        // the tightest loop we serve: write to the outbox, forecast, and the UI sees the
        // optimistic update; then send through the connector in submission order
        this.#onSubmitted();
        continue;
      }

      if (this.#newQueries) {
        // a new page wants its first answer: run the graph, the app's new queries with it
        this.#refresh({});
        continue;
      }

      if (this.#inbox.length > 0) {
        // the stream, in arrival order: events reduce or park, and a view, vouch, live, or end
        // is handled alone
        this.#onInbox();
        continue;
      }

      if (this.#commandOutcomes.length > 0) {
        // ack, dup, reject, and conflict from sends: release the outbox and rebuild the overlay
        this.#onCommandOutcomes();
        continue;
      }

      if (this.#backfillOutcomes.length > 0) {
        // 'done', 'stale', or a rejection for a backfill: retries with resume, and downloads
        // that start over
        this.#onBackfillOutcomes();
        continue;
      }

      if (this.#backfillWork.length > 0) {
        // header, values, events, and done marks from in-flight backfills, parked in one
        // transaction that also lands whatever they completed, each resolving the connector's
        // promise after commit.  Background work: it orders against nothing above, and the
        // connector waits on it while the app is busy.
        this.#onBackfillWork();
        continue;
      }

      if (this.#connector === null && (this.#connectNow || this.#retryTimer === null)) {
        // one attempt: a new connector from the factory, or the next one after backoff
        this.#onConnect();
        continue;
      }

      // nothing to do: publish the status this run left, then wait for a hook, a timer, or the app
      this.#refresh({});
      return;
    }
  }

  /* The app's submissions, sent in submission order.  A new connection first resends every outbox
     command it has not been handed, in ordinal order, each under the session and number it was
     minted with.  Then each submission in turn takes the next number of the Engine's session: an
     outbox command goes into the outbox and joins the current call, and an @online command goes
     in a call of its own.  So numbers reach the database in the order they were minted, which is
     what lets it answer a number at or below one it decided as decided already.  The connector
     fails every call behind a failed one, which keeps that order.  Without a connector the outbox
     waits for the next connection, and every @online command rejects. */
  #onSubmitted(): void {
    const submitted = this.#submitted.splice(0);
    const connector = this.#connector;
    const resend = this.#resend && connector !== null;
    this.#resend = false;

    // the calls in order: runs of outbox commands, and each @online command alone between them
    const calls: { wire: Command<Uint8Array>[]; online: OnlineCommand | null }[] = [
      { wire: [], online: null },
    ];
    let fresh = false;
    try {
      this.#store.write((txn) => {
        // the resend goes first, rows on the wire as stored, whatever vocabulary wrote them
        if (resend) {
          const pending = [...this.#outbox]
            .filter(([id]) => !this.#sent.has(id) && !this.#acked.has(id))
            .sort((a, b) => a[1] - b[1]);
          for (const [, ordinal] of pending) {
            calls[0].wire.push(txn.get(commandKey(ordinal), '.command', JS) as Command<Uint8Array>);
          }
        }

        // each submission, converted to wire bytes here by the vocabulary that made it
        for (const s of submitted) {
          if ('online' in s) {
            const data = this.#reg.convert(this.#reg.commands, s.online, JS, MSGPACK) as Uint8Array;
            const online = { resolve: s.resolve, reject: s.reject, ack: null, seen: false };
            const command = { id: generateUuid(), session: this.#session, n: this.#nextN++, data };
            calls.push({ wire: [command], online }, { wire: [], online: null });
            continue;
          }

          // an outbox command takes the next ordinal
          const command: Command<Uint8Array> = {
            id: generateUuid(),
            session: this.#session,
            n: this.#nextN++,
            data: this.#reg.convert(this.#reg.commands, s.outbox, JS, MSGPACK) as Uint8Array,
          };
          const ordinal = this.#nextOrdinal++;
          txn.set(commandKey(ordinal), '.command', JS, command);
          this.#outbox.set(command.id, ordinal);
          calls[calls.length - 1].wire.push(command);
          fresh = true;
        }
      });
    } catch (e: unknown) {
      // the pass ends the Engine, and the @online commands taken from the queue reject with it
      for (const s of submitted) if ('online' in s) s.reject(e);
      throw e;
    }
    if (fresh) this.#outboxChanged = true;
    this.#refresh({});

    // no connection, so every @online command rejects at once
    if (connector === null) {
      const e = new Error('no connection');
      for (const { online } of calls) online?.reject(e);
      return;
    }

    // each call on this connection; the results come back through the outcomes
    for (const { wire, online } of calls) {
      if (wire.length === 0) continue;
      const ids = wire.map((c) => c.id);
      if (online !== null) {
        this.#online.set(ids[0], online);
      } else {
        for (const id of ids) this.#sent.add(id);
      }
      connector.sendCommands(wire).then(
        (results) => {
          this.#commandOutcomes.push({ ids, results });
          this.#schedule();
        },
        (e: unknown) => {
          this.#commandOutcomes.push({ ids, results: { failed: e } });
          this.#schedule();
        },
      );
    }
  }

  // a new connection restarts every backfill that is still downloading and is not waiting on its
  // own backoff timer, and resends the outbox
  #onConnect(): void {
    this.#connectNow = false;
    this.#nextAttemptAt = null;
    if (this.#retryTimer !== null) {
      host.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // hooks queue for the advancer; a hook from a connector we have since replaced is dropped
    const abort = this.#connectorAbort;
    const push = (item: Inbound) => {
      if (this.#connectorAbort !== abort) return;
      this.#inbox.push(item);
      this.#schedule();
    };
    this.#since = this.#checkpoint?.position ?? -1;
    this.#confirmed = false;
    this.#connector = this.#connect(
      this.#since,
      this.#view?.token ?? null,
      this.#wants,
      abort.signal,
      {
        onOpen: (epoch, head) => push({ open: { epoch, head } }),
        onView: (token, position, refs) => push({ view: { token, position, refs } }),
        onEvents: (events) => push({ events }),
        onLive: (position) => push({ live: position }),
        onVouch: (position) => push({ vouch: position }),
        onEnd: (code, reason) => push({ end: { code, reason } }),
      },
    );

    // restart the downloads; one in backoff starts when its timer fires
    for (const [ref, entry] of this.#backfills) {
      if (entry.status === 'downloading' && entry.retryTimer === null) this.#startBackfill(ref);
    }
    this.#resend = true;
  }

  /* every queued push in one transaction, and the land of whatever they completed; each connector
     promise resolves after the commit, which is the backpressure */
  #onBackfillWork(): void {
    const pushes: BackfillWork[] = [];
    const dirty: Record<string, true> = {};

    // a push for a backfill that was dropped while it was queued fails on its own
    while (this.#backfillWork.length > 0) {
      const work = this.#backfillWork.shift()!;
      if (this.#backfills.has(work.ref)) {
        pushes.push(work);
      } else {
        work.reject(new Error(`backfill ${work.ref} is no longer in flight`));
      }
    }
    if (pushes.length === 0) return;

    // park every push, land what completed, and settle every promise the way the transaction went
    try {
      this.#store.write((txn) => {
        for (const { ref, item } of pushes) this.#parkPushIn(txn, ref, item);
        this.#tryLandIn(txn, dirty);
      });
    } catch (e: unknown) {
      for (const { reject } of pushes) reject(e);
      throw e;
    }
    for (const { resolve } of pushes) resolve();
    this.#refresh(dirty);
  }

  /* one push of a backfill: what it delivered is parked, and the record carries the resume point
     it brought the download to.  The push that completes both halves makes the backfill ready, so
     it lands in this same transaction: complete on disk and landed commit together, or neither. */
  #parkPushIn(txn: WTxn, ref: string, item: BackfillItem): void {
    const entry = this.#backfills.get(ref)!;
    const record = entry.record;

    // the blob's length is for the status alone, and parks nothing
    if ('length' in item) {
      entry.length = item.length;
      return;
    }

    if ('header' in item) {
      // a fresh download: a resumed tail keeps its floor, and a newer blob overrides it
      const { position, seqs } = item.header;
      const fromPosition = Math.max(record.resume?.fromPosition ?? position, position);
      record.resume = {
        position,
        skipBytes: 0,
        fromPosition,
        snapshotDone: false,
        tailDone: false,
      };
      txn.set(`!backfill-seqs:${ref}`, '.json', JS, seqs);
    } else if ('values' in item) {
      // park each value under this backfill's own range, and mark its stream
      for (const [key, bytes] of item.values) {
        // a key no slice declares is from a newer vocabulary, so it is dropped
        const type = storeTypeOf(this.#reg, key);
        if (type === undefined) continue;
        txn.set(`!park-kv:${ref}!${key}`, type, MSGPACK, bytes);
        this.#maybeMarkBackfilling(txn, key.slice(0, key.indexOf('!')), record.replacing);
      }
      record.resume!.skipBytes = item.skip;
    } else if ('valuesDone' in item) {
      record.resume!.snapshotDone = true;
    } else if ('events' in item) {
      // park each event by stream and seq, and mark its stream
      for (const ev of item.events) {
        txn.set(parkedEventKey(ev.stream, ev.seq), '.event', MSGPACK, ev.raw);
        this.#maybeMarkBackfilling(txn, ev.stream, record.replacing);
        record.resume!.fromPosition = Math.max(record.resume!.fromPosition, ev.position);
      }
      entry.scanned = Math.max(entry.scanned, item.scanned);
    } else if ('eventsDone' in item) {
      record.resume!.tailDone = true;
    } else {
      throw new Error('unexpected backfill item');
    }

    if (record.resume!.snapshotDone && record.resume!.tailDone) entry.status = 'ready';
    txn.set(`!backfill:${ref}`, '.json', JS, record);
  }

  // an additive backfill leaves a held stream held and lands around it; a replacing one takes it
  #maybeMarkBackfilling(txn: WTxn, stream: string, replacing: boolean): void {
    const held = this.#streams.get(stream);
    if (held === 'backfill' || (typeof held === 'number' && !replacing)) return;
    this.#streams.set(stream, 'backfill');
    txn.set(`!seq:${stream}`, '.json', JS, 'backfill');
    this.#episode?.resolved.delete(stream);
  }

  /* every queued outcome in one transaction.  Completion is known from the pushes themselves, so
     a done outcome only clears the attempt count; stale and failure decide what downloads again. */
  #onBackfillOutcomes(): void {
    this.#store.write((txn) => {
      while (this.#backfillOutcomes.length > 0) {
        const { ref, outcome, conn } = this.#backfillOutcomes.shift()!;

        // an outcome from a connection that has ended means nothing; the next connection
        // restarts the download
        if (conn !== this.#connectorAbort) continue;

        // was the backfill dropped while its outcome was queued?
        const entry = this.#backfills.get(ref);
        if (entry === undefined) continue;

        if (outcome === 'done') {
          entry.attempts = 0;
        } else if (outcome === 'stale') {
          // the blob is gone: the parked values go, the parked events stay, and the download
          // starts over under the same until
          entry.attempts = 0;
          txn.delPrefix(`!park-kv:${ref}!`);
          const r = entry.record.resume;
          if (r !== null) entry.record.resume = { ...r, skipBytes: 0, snapshotDone: false };
          txn.set(`!backfill:${ref}`, '.json', JS, entry.record);
          this.#startBackfill(ref);
        } else {
          // a rejection: ours, if the entry's signal fired, else a failure to retry after backoff
          if (entry.controller.signal.aborted) continue;
          entry.status = 'downloading';
          const delay = backoffDelay(entry.attempts++);
          entry.retryAt = Date.now() + delay;
          entry.retryTimer = host.setTimeout(() => {
            entry.retryTimer = null;
            entry.retryAt = null;
            // the entry may have gone, or the Engine, while the timer ran
            if (this.#backfills.get(ref) === entry && !this.#signal.aborted) {
              this.#startBackfill(ref);
              this.#schedule();
            }
          }, delay);
        }
      }
    });
  }

  // one backfill() call on the current connector; its pushes and its outcome come back through
  // the advancer's queues.  Without a connector nothing starts, and the next connection restarts
  // every backfill that is still downloading.
  #startBackfill(ref: string): void {
    const entry = this.#backfills.get(ref)!;
    if (this.#connector === null) return;
    const conn = this.#connectorAbort;
    entry.status = 'downloading';

    // the connector's cancellation is ours or the connection's
    const backfill: Backfill = {
      ref,
      until: entry.record.until,
      resume: entry.record.resume,
      signal: host.AbortSignal.any([conn.signal, entry.controller.signal]),
      push: (item) =>
        new Promise<void>((resolve, reject) => {
          this.#backfillWork.push({ ref, item, resolve, reject });
          this.#schedule();
        }),
    };

    // the outcome is tagged with its connection, so a late one from an ended connection is known
    this.#connector.backfill(backfill).then(
      (outcome) => {
        this.#backfillOutcomes.push({ ref, outcome, conn });
        this.#schedule();
      },
      (e: unknown) => {
        this.#backfillOutcomes.push({ ref, outcome: { failed: e }, conn });
        this.#schedule();
      },
    );
  }

  /* Land what can land.  Chains are checked key-only before anything is written.  While a
     replacing backfill is in flight the base is frozen: nothing lands unless every replacing entry
     is in a landing subtree and the frozen events chain, and then the frozen events land with
     them, so this is the pass that unfreezes. */
  #tryLandIn(txn: WTxn, dirty: Record<string, true>): void {
    // the base is frozen while any replacing backfill is in flight
    const frozen = this.#replacing > 0;

    // check every ready child on its own, so a broken one restarts without waiting on its parent
    for (const ref of [...this.#backfills.keys()]) {
      const entry = this.#backfills.get(ref)!;
      if (entry.parent === null || entry.status !== 'ready') continue;
      const streams = this.#brokenStreamsIn(txn, ref);
      if (streams.length > 0) this.#repairIn(txn, ref, streams);
    }

    // check the frozen events; a break there is a gap on a held stream
    let frozenClean = true;
    if (frozen) {
      const streams = this.#brokenStreamsIn(txn, null);
      if (streams.length > 0) this.#repairIn(txn, null, streams);
      frozenClean = streams.length === 0;
    }

    // check every top-level ref whose whole subtree is ready
    const clean: string[] = [];
    for (const ref of [...this.#backfills.keys()]) {
      if (this.#backfills.get(ref)!.parent !== null || !this.#landable(ref)) continue;
      const streams = this.#brokenStreamsIn(txn, ref);
      if (streams.length > 0) {
        // a broken seq chain: a stream with an entry restarts, one without becomes a child
        this.#repairIn(txn, ref, streams);
      } else {
        clean.push(ref);
      }
    }

    // frozen, and some replacing backfill is not landing in this pass?
    if (frozen) {
      const landing = new Set(clean.flatMap((ref) => this.#subtree(ref)));
      const pending = [...this.#backfills].some(
        ([ref, e]) => e.record.replacing && !landing.has(ref),
      );
      // then nothing lands, or the base would show a partial replacement
      if (pending || !frozenClean) return;
    }

    // land every clean subtree
    for (const ref of clean) this.#landRefIn(txn, ref, dirty);

    // frozen, so this is the unfreeze: the frozen events land and the base catches up
    if (frozen) {
      this.#reduceParkedIn(txn, null, {}, dirty);
      this.#reducedTo(txn, this.#checkpoint?.position ?? -1);
    }
  }

  // a ref's children that are still in flight
  #childrenOf(ref: string): string[] {
    return this.#backfills.get(ref)!.record.children.filter((c) => this.#backfills.has(c));
  }

  // a ref and every descendant
  #subtree(ref: string): string[] {
    return [ref, ...this.#childrenOf(ref).flatMap((c) => this.#subtree(c))];
  }

  // whether a ref's whole subtree has finished downloading
  #landable(ref: string): boolean {
    return (
      this.#backfills.get(ref)!.status === 'ready' &&
      this.#childrenOf(ref).every((c) => this.#landable(c))
    );
  }

  // the parked event range of a ref, or of every stream for the frozen events (null)
  #parkRange(ref: string | null, values: ScanRequest['values']): ScanRequest {
    const match = ref === null ? null : { prefix: refPrefix(ref) };
    return { pattern: engineKeys('park-ev', match), limit: 1000, values };
  }

  // a ref's blob header: the seq of every stream in its blob at the cut
  #headerOf(txn: RTxn, ref: string): Record<string, number> {
    return (txn.get(`!backfill-seqs:${ref}`, '.json', JS) ?? {}) as Record<string, number>;
  }

  // a subtree's seqs at its cuts: the ref's header with each child's laid over it, deepest winning
  #mergedHeaderIn(txn: RTxn, ref: string): Record<string, number> {
    let header = this.#headerOf(txn, ref);
    for (const child of this.#childrenOf(ref)) {
      header = { ...header, ...this.#mergedHeaderIn(txn, child) };
    }
    return header;
  }

  /* The streams among a subtree's parked events, or among the frozen events (null), whose chain
     does not continue from the state that will be in place.  Key-only while a chain continues; a
     gap reads the stream's values once, since a reset after it mends it, and so does the cut for
     a stream no blob names. */
  #brokenStreamsIn(txn: RTxn, ref: string | null): string[] {
    const header = ref === null ? {} : this.#mergedHeaderIn(txn, ref);
    const broken: string[] = [];
    let range = this.#parkRange(ref, false);
    let stream = '';
    let last = 0;
    // whether the stream was judged at a gap, which settles the rest of its run
    let judged = false;

    // walk the parked keys in stream then seq order
    for (;;) {
      const { entries, next } = txn.scan(range);
      for (const [key] of entries) {
        const park = parsePark(key);
        const held = this.#streams.get(park.stream);

        // a stream under some other backfill is not ours to check
        if (ref === null && held === 'backfill') continue;

        // a new stream: its base is the newest state in place, the held seq or the cut
        if (park.stream !== stream) {
          stream = park.stream;
          last = Math.max(typeof held === 'number' ? held : 0, header[stream] ?? 0);
          judged = false;
        }

        // at or below the base, the snapshot covers this event
        if (judged || park.seq <= last) continue;

        // does the chain continue?
        if (park.seq === last + 1) {
          last = park.seq;
          continue;
        }

        // a gap: the run's values settle the stream, once
        judged = true;
        const cut = this.#cutOf(ref, header, stream);
        if (!this.#mendsIn(txn, stream, park.seq, cut)) broken.push(stream);
      }
      if (next === null) return broken;
      range = { ...range, after: next };
    }
  }

  /* Whether a stream's parked run holds past a gap at gapSeq, walking its values backwards from
     the newest: it does when a reset follows the gap and the events after that reset chain, since
     nothing before a reset is reduced, or when the whole run from the gap on lies at or below cut,
     which covers it. */
  #mendsIn(txn: RTxn, stream: string, gapSeq: number, cut: number | null): boolean {
    let range: ScanRequest = {
      pattern: engineKeys('park-ev', { prefix: `${stream}!` }),
      reverse: true,
      limit: 1000,
      values: { type: '.event', rep: JS },
    };
    // the seq the next event walked must have, and whether the newest lies at or below the cut
    let expected: number | null = null;
    let covered = false;
    for (;;) {
      const { entries, next } = txn.scan(range);
      for (const [, value] of entries) {
        const ev = value as DbEvent<unknown>;
        if (expected === null) {
          covered = cut !== null && ev.position <= cut;
        } else if (ev.seq !== expected) {
          return false;
        }
        expected = ev.seq - 1;
        if (sysOf(ev.data) !== null) return true;
        if (ev.seq === gapSeq) return covered;
      }
      if (next === null) return false;
      range = { ...range, after: next };
    }
  }

  /* The cut covering a stream that no blob of a subtree names: the newest among the subtree's
     entries whose ref covers it, each of which found the stream dead or unborn at its cut.  Null
     for a stream some blob names or that is held, whose seq is its base, and among the frozen
     events (null). */
  #cutOf(ref: string | null, header: Record<string, number>, stream: string): number | null {
    if (ref === null || stream in header) return null;
    if (typeof this.#streams.get(stream) === 'number') return null;
    let cut: number | null = null;
    for (const r of this.#subtree(ref)) {
      const position = this.#backfills.get(r)!.record.resume?.position;
      if (position === undefined || !refCovers(r, stream)) continue;
      if (cut === null || position > cut) cut = position;
    }
    return cut;
  }

  // a broken stream with an entry restarts it; the rest become children of the ref checked, or
  // top-level replacing backfills for a break among the frozen events (null), which is a gap on a
  // held stream
  #repairIn(txn: WTxn, ref: string | null, streams: string[]): void {
    const fresh: string[] = [];
    for (const stream of streams) {
      if (this.#backfills.has(stream)) {
        this.#restartIn(txn, stream);
      } else {
        fresh.push(stream);
      }
    }
    if (fresh.length > 0) {
      const replacing = ref === null || this.#backfills.get(ref)!.record.replacing;
      this.#spawnIn(txn, ref, fresh, this.#checkpoint?.position ?? 0, replacing);
    }
  }

  // a top-level ref's subtree lands as one
  #landRefIn(txn: WTxn, ref: string, dirty: Record<string, true>): void {
    const header = this.#mergedHeaderIn(txn, ref);
    const subtree = this.#subtree(ref);

    // per stream under the ref, the newest state wins
    const kept = new Set<string>();
    for (const [stream, held] of this.#streams) {
      if (!refCovers(ref, stream)) continue;
      if (typeof held === 'number' && held >= (header[stream] ?? 0)) {
        // a held stream at or past the cut keeps its state, and the blob values for it go
        kept.add(stream);
        delete header[stream];
        for (const r of subtree) txn.delPrefix(`!park-kv:${r}!${stream}!`);
      } else {
        // otherwise the stream loses its state to the blob
        markDirty(dirty, txn.delPrefix(`${stream}!`));
      }
    }

    // move the values in, reduce the parked events onto them, and forget the subtree
    this.#moveValuesIn(txn, ref, dirty, kept);
    this.#reduceParkedIn(txn, ref, header, dirty);
    this.#dropIn(txn, ref);
  }

  // a ref's parked values move into place, then each child's over them for the streams in the
  // child's blob, the deepest winning; a kept stream is never touched
  #moveValuesIn(txn: WTxn, ref: string, dirty: Record<string, true>, kept: Set<string>): void {
    markDirty(dirty, txn.move(`!park-kv:${ref}!`, ''));
    for (const child of this.#childrenOf(ref)) {
      // clear the parent's values for the child's streams, so a key the child's blob lacks goes too
      for (const stream of Object.keys(this.#headerOf(txn, child))) {
        if (!kept.has(stream)) markDirty(dirty, txn.delPrefix(`${stream}!`));
      }
      this.#moveValuesIn(txn, child, dirty, kept);
    }
  }

  // every in-flight top-level ref that a new ref covers becomes its child
  #adoptChildrenIn(txn: WTxn, ref: string): void {
    const entry = this.#backfills.get(ref)!;
    for (const [other, e] of this.#backfills) {
      if (other === ref || e.parent !== null || !refCovers(ref, other)) continue;
      e.parent = ref;
      entry.record.children.push(other);
    }
    txn.set(`!backfill:${ref}`, '.json', JS, entry.record);
  }

  // a replacing ref takes every held stream under it, so their events park from here
  #markUnderIn(txn: WTxn, ref: string): void {
    for (const [stream, held] of this.#streams) {
      if (typeof held === 'number' && refCovers(ref, stream)) {
        this.#maybeMarkBackfilling(txn, stream, true);
      }
    }
  }

  // a landed subtree's records and entries go
  #dropIn(txn: WTxn, ref: string): void {
    for (const child of this.#childrenOf(ref)) this.#dropIn(txn, child);
    txn.del(`!backfill:${ref}`);
    txn.del(`!backfill-seqs:${ref}`);
    const entry = this.#backfills.get(ref)!;
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;
  }

  /* Reduce the parked events of a subtree, or of every stream under no backfill for the frozen
     events (null), each stream's run in one reducer call, then clear each walked stream's range.
     Chains were checked before any write.  Every landed stream's seq is written once: the last
     walked for a stream with events, covered ones included, the cut's for a header stream
     without. */
  #reduceParkedIn(
    txn: WTxn,
    ref: string | null,
    header: Record<string, number>,
    dirty: Record<string, true>,
  ): void {
    // {stream: seq}, the header seqs, then the last seq walked
    const seqs = new Map(Object.entries(header));
    const walked: string[] = [];
    let range = this.#parkRange(ref, { type: '.event', rep: JS });
    let stream = '';
    let run: DbEvent<unknown>[] = [];
    // the cut covering the stream, for one no blob names
    let cut: number | null = null;

    // walk the parked events in stream then seq order, reducing each stream's run as it ends
    for (;;) {
      const { entries, next } = txn.scan(range);
      for (const [, value] of entries) {
        const ev = value as DbEvent<unknown>;
        const held = this.#streams.get(ev.stream);

        // a stream under some other backfill is not ours to land
        if (ref === null && held === 'backfill') continue;

        // a new stream: reduce the last run, and start from the newest state in place
        if (ev.stream !== stream) {
          if (run.length > 0) this.#reduceStreamIn(txn, stream, run, dirty);
          stream = ev.stream;
          run = [];
          walked.push(stream);
          seqs.set(stream, Math.max(typeof held === 'number' ? held : 0, seqs.get(stream) ?? 0));
          cut = this.#cutOf(ref, header, stream);
        }

        // at or below the base, the snapshot covers this event; so does the cut, for a stream no
        // blob names, and the stream is held at the covered seq
        if (ev.seq <= seqs.get(stream)!) continue;
        seqs.set(stream, ev.seq);
        if (cut !== null && ev.position <= cut) continue;
        run.push(ev);
      }
      if (next === null) break;
      range = { ...range, after: next };
    }
    if (run.length > 0) this.#reduceStreamIn(txn, stream, run, dirty);

    // clear only the streams walked; a skipped stream's events stay for its own backfill's land
    for (const name of walked) txn.delPrefix(`!park-ev:${name}!`);

    // hold every landed stream at its new seq
    for (const [name, seq] of seqs) {
      this.#streams.set(name, seq);
      txn.set(`!seq:${name}`, '.json', JS, seq);
      this.#resolve(name);
    }
  }

  /* One stream's run of events, in order, through its slice's reducer.  Births and deaths are the
     Engine's: either is a reset, after which the stream's state is empty whatever came before, so
     a reset drops the stream's keys, nothing before the run's last reset reaches a reducer, and
     the stream stays known so a rebirth chains.  This is where events enter the base, so an event
     carrying the id of an outbox or @online command is that command's round trip, whichever path
     parked or delivered it. */
  #reduceStreamIn(
    txn: WTxn,
    stream: string,
    events: DbEvent<unknown>[],
    dirty: Record<string, true>,
  ): void {
    // the server sends nothing outside the wants, and the wants are the families with reducers
    const slice = this.#reducers[stream.split(':')[0]];
    if (slice === undefined) throw new Error(`no reducer for ${stream}`);
    const data: unknown[] = [];

    // the run's last reset, if any
    let from = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (sysOf(events[i].data) !== null) {
        from = i;
        break;
      }
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];

      // our own command's event: the round trip is observed
      if (this.#outbox.has(ev.id)) this.#releaseIn(txn, [ev.id]);
      const online = this.#online.get(ev.id);
      if (online !== undefined) online.seen = true;

      if (i < from) continue;
      if (sysOf(ev.data) !== null) {
        // the last reset: the stream's state is empty from here
        markDirty(dirty, txn.delPrefix(`${stream}!`));
      } else {
        data.push(ev.data);
      }
    }
    if (data.length > 0) slice.reducer(reducerTxn(txn, stream, dirty), data, stream, false);
  }

  // a ref whose tail did not reach its parked live events downloads again from a fresh snapshot,
  // whose cut is past the gap; the parked events stay and chain from the live cut
  #restartIn(txn: WTxn, ref: string): void {
    const entry = this.#backfills.get(ref)!;
    txn.delPrefix(`!park-kv:${ref}!`);
    entry.record.resume = null;
    entry.status = 'downloading';
    entry.attempts = 0;
    txn.set(`!backfill:${ref}`, '.json', JS, entry.record);
    this.#startBackfill(ref);
  }

  // new backfills, each downloading at once into its own values range; with a parent they are
  // its children, and it lands when they have too
  #spawnIn(
    txn: WTxn,
    parent: string | null,
    refs: string[],
    until: number,
    replacing: boolean,
  ): void {
    for (const ref of refs) {
      const record: BackfillRecord = { until, resume: null, replacing, children: [] };
      txn.set(`!backfill:${ref}`, '.json', JS, record);
      this.#backfills.set(ref, newBackfillEntry(record, parent));
      if (replacing) this.#replacing++;

      // a stream ref is marked; a family has nothing to mark until its blob names its members
      if (!ref.endsWith('*')) this.#maybeMarkBackfilling(txn, ref, replacing);
      if (replacing) this.#markUnderIn(txn, ref);
      this.#startBackfill(ref);
    }

    if (parent !== null) {
      const p = this.#backfills.get(parent)!;
      p.record.children.push(...refs);
      txn.set(`!backfill:${parent}`, '.json', JS, p.record);
    }
  }

  // an in-flight backfill ends: its download is aborted, its values range and records go, and its
  // children carry on under the parent they have left, if any
  #dropBackfillIn(txn: WTxn, ref: string): void {
    const entry = this.#backfills.get(ref)!;
    entry.controller.abort();
    if (entry.retryTimer !== null) host.clearTimeout(entry.retryTimer);
    txn.delPrefix(`!park-kv:${ref}!`);
    txn.del(`!backfill:${ref}`);
    txn.del(`!backfill-seqs:${ref}`);
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;

    // leave the parent's children list
    if (entry.parent !== null) {
      const p = this.#backfills.get(entry.parent)!;
      p.record.children = p.record.children.filter((c) => c !== ref);
      txn.set(`!backfill:${entry.parent}`, '.json', JS, p.record);
    }

    // re-parent each child to the next covering entry, if any
    for (const child of entry.record.children) {
      const c = this.#backfills.get(child);
      if (c === undefined) continue;
      c.parent = this.#parentOf(child);
      if (c.parent === null) continue;
      const p = this.#backfills.get(c.parent)!;
      p.record.children.push(child);
      txn.set(`!backfill:${c.parent}`, '.json', JS, p.record);
    }
  }

  // a stream leaves the Engine: its state, its seq, and its parked events
  #dropStreamIn(txn: WTxn, stream: string, dirty: Record<string, true>): void {
    markDirty(dirty, txn.delPrefix(`${stream}!`));
    txn.del(`!seq:${stream}`);
    txn.delPrefix(`!park-ev:${stream}!`);
    this.#streams.delete(stream);
  }

  // every queued item, in arrival order, in one transaction; the connection's end is not a store
  // operation and is handled on its own
  #onInbox(): void {
    if ('end' in this.#inbox[0]) {
      this.#inbox.shift();
      this.#onEnd();
      return;
    }

    const dirty: Record<string, true> = {};
    let wentLive = false;
    let revoked = false;
    this.#store.write((txn) => {
      while (this.#inbox.length > 0 && !('end' in this.#inbox[0])) {
        const item = this.#inbox.shift()!;

        // any frame after the open confirms the ref list: a view replaces it, and any other
        // frame means the token presented was current
        if (!('open' in item)) this.#confirmed = true;

        if ('events' in item) {
          this.#onEventsIn(txn, item.events, dirty);
        } else if ('open' in item) {
          // a different epoch is a replaced log, where the positions we hold mean nothing.
          // Dropping everything and backfilling every ref is the answer, and until that exists
          // this ends.
          const { epoch, head } = item.open;
          if (this.#checkpoint !== null && this.#checkpoint.epoch !== epoch) {
            throw new Error(`epoch ${epoch}, checkpoint from ${this.#checkpoint.epoch}`);
          }
          this.#epoch = epoch;
          this.#head = head;
        } else if ('view' in item) {
          if (this.#onViewIn(txn, item.view, dirty)) revoked = true;
        } else if ('vouch' in item) {
          this.#onCursorIn(txn, item.vouch);
        } else if ('live' in item) {
          this.#onCursorIn(txn, item.live);
          wentLive = true;
        }
      }
    });

    // history is done: the backoff starts over, and the replay has proven every held stream that
    // no backfill has taken
    if (wentLive) {
      this.#live = true;
      this.#attempt = 0;
      for (const [stream, held] of this.#streams) {
        if (typeof held === 'number') this.#resolve(stream);
      }
    }

    // a revoke changes what queries may see, so the graph runs even while frozen: a new query
    // would otherwise disagree with the results already delivered
    this.#refresh(dirty, revoked);
  }

  // one atom's events; each event reduces or parks by a streams-table lookup
  #onEventsIn(txn: WTxn, events: WireEvent[], dirty: Record<string, true>): void {
    // {stream: seq} for every held stream that advanced, and {stream: events} to reduce
    const seqs = new Map<string, number>();
    const runs = new Map<string, DbEvent<unknown>[]>();
    // streams born in this atom: held ones are in seqs, parked ones here
    const born = new Set<string>();
    let reduced = this.#reduced;

    // route each event
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const held = this.#streams.get(ev.stream);
      let park = held === 'backfill';
      let decoded: DbEvent<unknown> | null = null;

      // an unknown stream?
      if (held === undefined && !seqs.has(ev.stream) && !born.has(ev.stream)) {
        const parent = this.#parentOf(ev.stream);
        if (parent !== null) {
          // under an in-flight ref, whose land will chain it: mark it and park
          const replacing = this.#backfills.get(parent)!.record.replacing;
          this.#maybeMarkBackfilling(txn, ev.stream, replacing);
          park = true;
        } else {
          // a reset starts the stream afresh below; any other event is one we missed the birth
          // of, so the stream is backfilled on its own, and the event parks
          decoded = this.#decode(ev);
          if (sysOf(decoded.data) === null) {
            this.#spawnIn(txn, null, [ev.stream], ev.position, false);
            park = true;
          }
        }
      }

      // frozen, so everything else parks too
      if (!park && this.#replacing > 0) {
        park = true;
        if (held === undefined) born.add(ev.stream);
      }

      // a held stream, or an unknown one's reset: does the event chain?
      if (!park) {
        const last = seqs.get(ev.stream) ?? (typeof held === 'number' ? held : 0);
        if (ev.seq <= last) continue;
        if (decoded === null) decoded = this.#decode(ev);

        /* The next event chains.  So does a reset at any seq above the last, since the stream's
           state is empty after it whatever was missed, and so does an event that a reset follows
           within this atom, since the run's reduction starts at its last reset.  The event joins
           the stream's run, and proves the stream needs no backfill. */
        if (ev.seq === last + 1 || sysOf(decoded.data) !== null || this.#resetAhead(events, i)) {
          seqs.set(ev.stream, ev.seq);
          this.#resolve(ev.stream);
          if (!runs.has(ev.stream)) runs.set(ev.stream, []);
          runs.get(ev.stream)!.push(decoded);
          reduced = ev.position;
          continue;
        }

        // a gap: replace the stream, under the in-flight ref covering it if any, and park
        this.#spawnIn(txn, this.#parentOf(ev.stream), [ev.stream], ev.position, true);
        seqs.delete(ev.stream);
        park = true;
      }

      txn.set(parkedEventKey(ev.stream, ev.seq), '.event', MSGPACK, ev.raw);
    }

    // reduce each stream's run and hold it at its new seq
    for (const [stream, run] of runs) this.#reduceStreamIn(txn, stream, run, dirty);
    for (const [stream, seq] of seqs) {
      this.#streams.set(stream, seq);
      txn.set(`!seq:${stream}`, '.json', JS, seq);
    }

    // an atom that froze part way reduced up to the event before the gap
    const last = events[events.length - 1].position;
    this.#reducedTo(txn, this.#replacing > 0 ? reduced : last);
    this.#advanceCursorIn(txn, last);
  }

  // whether a reset for the event's stream follows it within its atom
  #resetAhead(events: WireEvent[], i: number): boolean {
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j];
      if (e.stream === events[i].stream && sysOf(this.#decode(e).data) !== null) return true;
    }
    return false;
  }

  /* After a commit, the status is published and the graph learns what changed.  Base changes
     reach queries only when not frozen, outbox changes always, since forecasts are not base state;
     either rebuilds the overlay.  A changed status or a new query alone runs the graph over the
     overlay as it is.  Then each @online command whose round trip the queries now show settles. */
  #refresh(dirty: Record<string, true>, always = false): void {
    // the status first, so every query this pass runs sees the status that goes with its state
    const status = this.#publish();
    this.#graph.dirty(dirty);
    this.#graph.dirty(status);

    // rebuild the overlay, or run the graph over it as it is
    const outbox = this.#outboxChanged;
    this.#outboxChanged = false;
    const changed = Object.keys(dirty).length > 0;
    if (always || outbox || (changed && this.#replacing === 0)) {
      this.#rebuildOverlay();
    } else if (Object.keys(status).length > 0 || this.#newQueries) {
      this.#runGraph();
    }
    this.#settleOnline();
  }

  /* An acked @online command has made its round trip once an event carrying its id is reduced, or
     the base is reduced through its ack's position.  Queries show the base only when it exists and
     is not frozen, so it settles then. */
  #settleOnline(): void {
    if (this.#reduced < 0 || this.#replacing > 0) return;
    for (const [id, online] of this.#online) {
      if (online.ack === null) continue;
      if (!online.seen && online.ack.position > this.#reduced) continue;
      this.#online.delete(id);
      online.resolve(online.ack);
    }
  }

  // every @online command, queued or in flight, rejects with the reason the Engine ended
  #rejectOnline(reason: unknown): void {
    for (const s of this.#submitted) if ('online' in s) s.reject(reason);
    for (const online of this.#online.values()) online.reject(reason);
    this.#online.clear();
  }

  // a live event as the reducers see it; one that fails its schema is an error naming it, since
  // the client and the database can run different versions of the model
  #decode(ev: WireEvent): DbEvent<unknown> {
    try {
      return this.#reg.convert('.event', ev.raw, MSGPACK, JS) as DbEvent<unknown>;
    } catch (e: unknown) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`event ${ev.stream}@${ev.position}: ${why}`);
    }
  }

  // the checkpoint moves forward, never back, under the connection's epoch
  #advanceCursorIn(txn: WTxn, position: number): void {
    if (this.#epoch === null) throw new Error('cursor with no epoch');
    if (this.#checkpoint !== null && position <= this.#checkpoint.position) return;
    this.#checkpoint = { epoch: this.#epoch, position, reduced: this.#reduced };
    txn.set('!checkpoint', '.json', JS, this.#checkpoint);
  }

  // the base has been reduced through position, so every acked command at or below it is in the
  // base, events or none, and leaves the outbox
  #reducedTo(txn: WTxn, position: number): void {
    if (position <= this.#reduced) return;
    this.#reduced = position;
    if (this.#checkpoint !== null) {
      this.#checkpoint = { ...this.#checkpoint, reduced: position };
      txn.set('!checkpoint', '.json', JS, this.#checkpoint);
    }
    this.#releaseAckedIn(txn);
  }

  #releaseAckedIn(txn: WTxn): void {
    const done = [...this.#acked].filter(([, p]) => p <= this.#reduced).map(([id]) => id);
    this.#releaseIn(txn, done);
  }

  // commands leave the outbox
  #releaseIn(txn: WTxn, ids: string[]): void {
    for (const id of ids) {
      const ordinal = this.#outbox.get(id);
      if (ordinal === undefined) continue;
      txn.del(commandKey(ordinal));
      this.#outbox.delete(id);
      this.#sent.delete(id);
      this.#acked.delete(id);
      this.#outboxChanged = true;
    }
  }

  // a vouch, or the live mark: unless frozen, nothing below it was withheld, so the base is
  // reduced through it
  #onCursorIn(txn: WTxn, position: number): void {
    if (this.#replacing === 0) this.#reducedTo(txn, position);
    this.#advanceCursorIn(txn, position);
  }

  // every queued sendCommands result, and one release for all of them
  #onCommandOutcomes(): void {
    const drop: string[] = [];
    while (this.#commandOutcomes.length > 0) {
      const { ids, results } = this.#commandOutcomes.shift()!;

      /* A failed call rejects its @online command, which is never resent.  Its outbox commands
         wait for the connection's end, which a failed call brings, and the next connection resends
         them. */
      if ('failed' in results) {
        for (const id of ids) {
          const online = this.#online.get(id);
          if (online === undefined) continue;
          this.#online.delete(id);
          online.reject(results.failed);
        }
        continue;
      }

      // answers count from any connection, they are the server's
      results.forEach((r, i) => {
        const id = ids[i];

        // an @online command: a reject or a conflict settles it now, and an ok waits for the
        // round trip, which the refresh after this commit may already find
        const online = this.#online.get(id);
        if (online !== undefined) {
          if (r.kind === 'ok') {
            online.ack = r;
          } else {
            this.#online.delete(id);
            online.resolve(r);
          }
          return;
        }

        // a command already released, by its round trip or by an earlier answer to a resend
        if (!this.#outbox.has(id)) return;

        if (r.kind === 'ok') {
          // the command was decided by a position; it leaves once the base has reduced through it
          this.#acked.set(id, r.position);
          if (r.position <= this.#reduced) drop.push(id);
        } else {
          // a reject or a conflict is final
          drop.push(id);
        }
      });
    }

    this.#store.write((txn) => {
      this.#releaseIn(txn, drop);
    });
    this.#refresh({});
  }

  /* A view frame, reconciled against state.  Drops come first, then every ref of the new set that
     nothing accounts for starts a backfill, and the view is written with them.  Returns whether
     the drops removed state from the base. */
  #onViewIn(txn: WTxn, view: ViewRecord, dirty: Record<string, true>): boolean {
    const wasFrozen = this.#replacing > 0;
    // the keys this frame removes, apart from any that earlier items in the batch marked
    const removed: Record<string, true> = {};
    const covered = (refs: string[], x: string) => refs.some((r) => refCovers(r, x));
    const old = this.#view?.refs ?? [];
    const atStart = [...this.#backfills.keys()];

    // drop every in-flight ref the new set does not fully cover
    for (const ref of atStart) {
      if (!covered(view.refs, ref)) this.#dropBackfillIn(txn, ref);
    }

    // drop every stream the new set does not cover
    for (const stream of [...this.#streams.keys()]) {
      if (!covered(view.refs, stream)) this.#dropStreamIn(txn, stream, removed);
    }

    // grant, broadest first so a covered ref finds its cover.  The first view's grants replace
    // an empty base: frozen until they land as a group, so the first frame shown is complete.
    // Every later grant is additive.
    const bootstrap = this.#view === null;
    const refs = [...view.refs].sort((a, b) => refPrefix(a).length - refPrefix(b).length);
    for (const ref of refs) {
      // does an entry already cover it?
      const entries = [...this.#backfills.keys()];
      if (entries.some((e) => refCovers(e, ref))) continue;

      // is it held: covered by the old set, and by no entry at the start of the frame?
      const held = covered(old, ref) && !atStart.some((e) => refCovers(e, ref));
      if (held || typeof this.#streams.get(ref) === 'number') continue;

      // otherwise it is new: backfill it, adopting the in-flight refs it covers
      this.#spawnIn(txn, null, [ref], view.position, bootstrap);
      this.#adoptChildrenIn(txn, ref);
    }

    txn.set('!view', '.json', JS, view);
    this.#view = view;

    // did a drop end the last replacing backfill?  Then this is the unfreeze, and whatever
    // finished downloading during the freeze can land now
    if (wasFrozen && this.#replacing === 0) this.#unfreezeIn(txn, removed);
    Object.assign(dirty, removed);
    return Object.keys(removed).length > 0;
  }

  // the last replacing backfill is gone: the frozen events land, the reduced position catches up
  // to the checkpoint, and whatever finished downloading during the freeze lands
  #unfreezeIn(txn: WTxn, dirty: Record<string, true>): void {
    this.#reduceParkedIn(txn, null, {}, dirty);
    this.#reducedTo(txn, this.#checkpoint?.position ?? -1);
    this.#tryLandIn(txn, dirty);
  }

  // the connection ended.  Every call in flight on it is dead: backfills wait for the next
  // connection to restart them, and commands handed to it are unsent again for the next resend.
  #onEnd(): void {
    this.#connector = null;
    this.#connectorAbort.abort();
    this.#connectorAbort = new host.AbortController();
    this.#sent.clear();
    this.#live = false;
    this.#epoch = null;

    // the next attempt, after backoff
    const delay = backoffDelay(this.#attempt++);
    this.#nextAttemptAt = Date.now() + delay;
    this.#retryTimer = host.setTimeout(() => {
      this.#retryTimer = null;
      this.#schedule();
    }, delay);
  }

  // a fresh overlay over the base, every outbox command forecast onto it in order, and the graph
  // run on the result
  #rebuildOverlay(): void {
    const discarded: Record<string, true> = {};
    markDirty(discarded, this.#overlay.keys());
    this.#graph.dirty(discarded);
    this.#overlay = new Overlay(this.#reg);

    // one base read for the whole rebuild, so every forecast and every query sees one snapshot
    const cbs = this.#store.read((base) => {
      // forecast each outbox command, each seeing what the ones before it left
      const forecaster = this.#forecaster;
      if (forecaster !== null && this.#outbox.size > 0) {
        const rows = scanAll(base, {
          pattern: engineKeys('command'),
          limit: 1000,
          values: { type: '.command', rep: JS },
        });
        for (const [, value] of rows) {
          const command = value as Command<Uint8Array>;

          // a command this vocabulary cannot read is still sent; it just forecasts nothing
          const data = this.#commandData(command.data);
          if (data === undefined) continue;

          /* Each command forecasts in its own scratch layer, so a throw cancels its events alone.
             A throw from the forecast is its way of forecasting nothing; a reducer can also throw
             on correct code, when real events have moved the base underneath a forecast that no
             longer applies.  Either way the command is in flight and the server decides. */
          try {
            const dirty = this.#overlay.apply(base, (txn) =>
              this.#forecastIn(txn, forecaster, data),
            );
            this.#graph.dirty(dirty);
          } catch {
            continue;
          }
        }
      }

      // run the graph, new queries included
      this.#newQueries = false;
      return this.#graph.run(this.#queryView(base));
    });
    cbs();
  }

  // the graph run over the overlay as it is, new queries included
  #runGraph(): void {
    const cbs = this.#store.read((base) => {
      this.#newQueries = false;
      return this.#graph.run(this.#queryView(base));
    });
    cbs();
  }

  // what queries read: the status, and the overlay over the base, held until the base exists
  #queryView(base: RTxn): RTxn {
    return statusView(this.#overlay.view(base), this.#status, this.#reduced < 0);
  }

  // the status the Engine's state gives, with each part that changed published whole in place of
  // the last; returns the keys of the parts that changed
  #publish(): Record<string, true> {
    const parts: [string, unknown][] = [
      [STATUS_KEYS.connection, this.#connectionStatus()],
      [STATUS_KEYS.progress, this.#progressStatus()],
      [STATUS_KEYS.outbox, { unacknowledged: this.#outbox.size - this.#acked.size }],
    ];
    const changed: Record<string, true> = {};
    for (const [key, value] of parts) {
      const json = JSON.stringify(value);
      if (this.#statusJson.get(key) === json) continue;
      this.#status.set(key, value);
      this.#statusJson.set(key, json);
      changed[key] = true;
    }
    return changed;
  }

  #connectionStatus(): ConnectionStatus {
    // between attempts, opening, replaying history, or past it
    let state: ConnectionStatus['state'];
    if (this.#connector === null) {
      state = this.#connectNow ? 'connecting' : 'offline';
    } else if (this.#epoch === null) {
      state = 'connecting';
    } else {
      state = this.#live ? 'live' : 'syncing';
    }

    const next = this.#nextAttemptAt;
    return {
      state,
      nextAttemptAt: state === 'offline' && next !== null ? new Date(next) : null,
      hasBase: this.#reduced >= 0,
      frozen: this.#replacing > 0,
    };
  }

  #progressStatus(): ProgressStatus {
    const backfills = [...this.#backfills].map(([ref, entry]) => backfillStatus(ref, entry));
    const log = {
      since: this.#since,
      head: this.#head,
      committed: this.#checkpoint?.position ?? -1,
      reduced: this.#reduced,
    };
    return { estimate: this.#estimate(backfills), log, backfills };
  }

  // the estimate for the episode in progress, which starts and ends with the work
  #estimate(backfills: BackfillStatus[]): number | null {
    // end the episode whose work is done, and start one for any work in progress
    if (this.#episode !== null && this.#episodeDone(this.#episode)) this.#episode = null;
    this.#episode ??= this.#startEpisode();
    const e = this.#episode;
    if (e === null) return null;

    // every backfill of the episode as last seen
    for (const b of backfills) e.backfills.set(b.ref, b);
    const inFlight = new Set(backfills.map((b) => b.ref));
    e.confirmed ||= this.#confirmed;

    // the share done, held to what has been shown
    const share =
      e.kind === 'resync' ? this.#resyncShare(e, inFlight) : this.#downloadShare(e, inFlight);
    e.shown = Math.max(e.shown, Math.min(1, Math.max(0, share)));
    return e.shown;
  }

  // whether an episode's work is done: a boot's once the base exists, a resync's once the replay
  // has reached head and every backfill has landed, a backfill episode's once they have landed
  #episodeDone(e: Episode): boolean {
    if (e.kind === 'boot') return this.#reduced >= 0;
    if (e.kind === 'resync') return this.#live && this.#backfills.size === 0;
    return this.#backfills.size === 0;
  }

  // an episode for the work in progress, or null when there is none
  #startEpisode(): Episode | null {
    // no base yet, a connection replaying onto one, or downloads onto a live one?
    let kind: Episode['kind'];
    if (this.#reduced < 0) {
      kind = 'boot';
    } else if (this.#connector !== null && !this.#live) {
      kind = 'resync';
    } else if (this.#backfills.size > 0) {
      kind = 'backfill';
    } else {
      return null;
    }

    // a resync resolves the streams held as it starts
    const held = new Set<string>();
    if (kind === 'resync') {
      for (const [stream, seq] of this.#streams) if (typeof seq === 'number') held.add(stream);
    }
    return {
      kind,
      shown: 0,
      backfills: new Map(),
      since: this.#checkpoint?.position ?? -1,
      held,
      resolved: new Set(),
      confirmed: false,
    };
  }

  // a boot's or a backfill episode's share done
  #downloadShare(e: Episode, inFlight: Set<string>): number {
    // a boot before its first view knows of no work yet
    if (e.kind === 'boot' && this.#view === null) return 0;
    const landed = e.kind === 'boot' ? this.#reduced >= 0 : inFlight.size === 0;
    const all = [...e.backfills.values()];
    if (all.length === 0) return 0.9 + (landed ? 0.1 : 0);
    const going = (b: BackfillStatus) => inFlight.has(b.ref);

    // a size is known once the response states a length or the blob's header arrives
    const sized = all.filter((b) => !going(b) || b.snapshot.length !== null || b.tail !== null);

    // the snapshots: exact over their lengths while every one in flight has a length, else the
    // curve over the bytes downloaded; one no longer in flight is complete
    let snapshots: number;
    if (all.every((b) => !going(b) || b.snapshot.length !== null)) {
      let got = 0;
      let total = 0;
      for (const b of all) {
        const size = b.snapshot.length ?? b.snapshot.bytes;
        total += size;
        got += going(b) && !b.snapshot.done ? b.snapshot.bytes : size;
      }
      snapshots = total === 0 ? 1 : got / total;
    } else {
      snapshots = downloadCurve(all.reduce((n, b) => n + b.snapshot.bytes, 0));
    }

    // the tails: each one's share scanned, averaged
    let tails = 0;
    for (const b of all) tails += going(b) ? tailShare(b) : 1;
    tails /= all.length;

    const download = (snapshots + tails) / 2;
    return 0.05 * (sized.length / all.length) + 0.85 * download + 0.1 * (landed ? 1 : 0);
  }

  // a resync's share done
  #resyncShare(e: Episode, inFlight: Set<string>): number {
    // the backfills: the held streams resolved, and the download, whole until a backfill is in
    // flight and then the curve over every byte the episode's backfills have downloaded
    const resolved = e.held.size === 0 ? 1 : e.resolved.size / e.held.size;
    let downloaded = 1;
    if (inFlight.size > 0) {
      let bytes = 0;
      for (const b of e.backfills.values()) bytes += b.snapshot.bytes;
      downloaded = downloadCurve(bytes);
    }

    // the replay: whole once live, else the checkpoint's way from the start to the head
    const committed = this.#checkpoint?.position ?? -1;
    let replay = 0;
    if (this.#live) {
      replay = 1;
    } else if (this.#head !== null) {
      const head = Math.max(this.#head, committed);
      replay = head <= e.since ? 1 : (committed - e.since) / (head - e.since);
    }

    const backfill = (resolved + downloaded) / 2;
    return 0.05 * (e.confirmed ? 1 : 0) + 0.2 * backfill + 0.75 * replay;
  }

  // a held stream of a resync is proven to need no backfill
  #resolve(stream: string): void {
    const e = this.#episode;
    if (e?.kind === 'resync' && e.held.has(stream)) e.resolved.add(stream);
  }

  // a command's wire bytes as the forecaster sees them, or undefined when the current vocabulary
  // cannot read them, which is an outbox row written by an earlier build of the app
  #commandData(bytes: Uint8Array): C | undefined {
    try {
      return this.#reg.convert(this.#reg.commands, bytes, MSGPACK, JS) as C;
    } catch {
      return undefined;
    }
  }

  // one command's forecast folded onto the overlay: each run of consecutive events on one stream
  // goes through its slice's reducer as pending, and a death drops the stream's keys; returns the
  // keys it changed
  #forecastIn(txn: WTxn, forecaster: Forecaster<FX, C>, command: C): Record<string, true> {
    const dirty: Record<string, true> = {};
    let stream = '';
    let run: unknown[] = [];

    // reduce the pending run; a family with no reducer forecasts nothing
    const flush = () => {
      if (run.length === 0) return;
      const slice = this.#reducers[stream.split(':')[0]];
      if (slice !== undefined) slice.reducer(reducerTxn(txn, stream, dirty), run, stream, true);
      run = [];
    };

    // forecast over the overlay; the transaction closes when the forecaster returns
    const rtx = readTxn(txn);
    let outs: ForecastOutput[];
    try {
      outs = forecaster(this.#forecastContext(rtx), command);
    } finally {
      closedTxns.add(rtx);
    }

    for (const out of outs) {
      // the label fills its slice's family template, or has the shape of a stream name when this
      // Engine holds no slice of its family; an invalid one throws, forecasting nothing
      const pattern = this.#streamPatterns[out.stream.split(':')[0]] ?? ANY_STREAM_RE;
      const valid = pattern.test(out.stream);
      if (!valid) {
        throw new Error(`forecast labels an invalid stream ${JSON.stringify(out.stream)}`);
      }

      if (out.stream !== stream) {
        flush();
        stream = out.stream;
      }
      if ('death' in out) {
        flush();
        markDirty(dirty, txn.delPrefix(`${stream}!`));
      } else {
        run.push(out.event);
      }
    }
    flush();
    return dirty;
  }

  // ends everything the Engine drives; nothing is persisted, since the store is already consistent
  // at the last commit
  #shutdown(): void {
    if (this.#retryTimer !== null) {
      host.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // the connection, and with it every backfill call in flight
    this.#connectorAbort.abort();
    this.#connector = null;
    for (const entry of this.#backfills.values()) {
      if (entry.retryTimer !== null) host.clearTimeout(entry.retryTimer);
    }

    // the pushes waiting for a transaction they will never get
    const reason = new Error('engine shut down');
    for (const work of this.#backfillWork) work.reject(reason);
    this.#backfillWork = [];

    // the @online commands, which can never settle now
    this.#rejectOnline(reason);
  }
}

// end of skeleton ////////////////////////////////////////////////////////////
