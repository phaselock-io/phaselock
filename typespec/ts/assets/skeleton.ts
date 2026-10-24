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

/** A cancellation signal, as the Engine and its connections use one: whether it has fired and why,
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
    AbortSignal.any combines, are of the host's own kind, for its transports to use as they are,
    each firing its abort listeners on the JS thread; and randomness for mutation ids and series,
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

// a fresh mutation id: the host's own uuid when it mints them, else a version 4 uuid from its
// randomness; lower-case, as the id a connection decodes from an envelope is
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

// a fresh series id: 16 random bytes as 22 base64url characters, or the host's own uuid when it
// has no randomness to give
function generateSeries(): string {
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

/** Registry converts between representations of typed values.  Types are model names from the
    TypeSpec, plus four reserved names.  `.json` is the Engine's own shapes.  `.mutation` is an
    outbox row, a Mutation<Uint8Array> whose `data` is already the mutation's wire bytes, so it
    needs no vocabulary to read.  `.edits` is a parked edit, the raw edit in `msgpack` and its
    EditEnvelope alone in `js`; it converts from `msgpack` only.  `.page` is a parked snapshot
    page, bytes that only a store's applySnapshot reads, which no Registry converts. */
export interface Registry {
  /** a value of type `type`, given in one representation, in another */
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown;
  /** The operations of a raw edit, its envelope skipped, or of a snapshot page, in order, for a
      JS-native store to apply: each a key and its value's bytes, sliced out undecoded, or
      undefined for a deletion.  An opcode it does not know throws. */
  ops(bytes: Uint8Array, edit: boolean): EditOp[];
  /** the mutations union this engine may send */
  mutations: string;
}

/** one operation of an edit or a snapshot page: a set, with its value's msgpack bytes, a nil
    setting null, or a deletion, with undefined */
export type EditOp = [key: string, value: Uint8Array | undefined];

/** One type of the model, as the generated registry describes it; children are indices into
    the same node table.  A struct lists its fields in declaration order, and names the one it
    writes first, the field a union tells it apart from its other members by, or -1; a union
    carries the solver's decision tree; an intake node names a field the database prepares for
    the decider, over the wire type a client sends.  The identities of a struct, record, array,
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
    Registry's `mutations` is.  Every engine and database of one model shares one node table.  A
    host walks it to convert values; the reserved identities are the host's own. */
export type Schema = {
  nodes: SchemaNode[];
  ids: Record<string, number>;
  /** the mutations union, or null for a database with no mutations */
  mutations: string | null;
};

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

/** A WTxn writes keys one by one, and applies edits and snapshot pages whole.  Applying an edit
    deletes every key under its slice first when its envelope marks a birth or a death, then
    carries out its payload's operations in order; a death carries none.  Each apply answers the
    keys it changed, which mark queries dirty.  Applied values are the bytes the edit or page
    carries, which the store keeps as they are or in its own form, and a read decodes with the
    reader's type; JS never sees a payload. */
export interface WTxn extends RTxn {
  /** persist the value, given in a representation, in the one the store keeps */
  set(key: string, type: string, rep: Rep, value: unknown): void;
  del(key: string): void;
  /** delete every key under prefix; returns the keys deleted */
  delPrefix(prefix: string): string[];
  /** apply live edits, in order */
  applyEdits(edits: WireEdit[]): string[];
  /** apply a slice's parked edits, `!park-edit:{slice}!{seq}` from fromSeq on, in seq order.
      The edits applied always form a contiguous range of seqs, through the slice's last parked
      one, and stay parked. */
  applyParked(slice: string, fromSeq: number): string[];
  /** apply a backfill's parked snapshot pages, `!park-snap:{selector}!{offset}`, in order, skipping
      every key of a slice in skip; the pages stay parked */
  applySnapshot(selector: string, skip: string[]): string[];
}

/** Store is the interface for running read and write transactions.  It is synchronous: a
    transaction runs fn to completion, committing when fn returns and rolling back when it
    throws, and a transaction method answers when it returns and fails by throwing.  A store
    holds a Registry and does its own conversions, in the host language.  Values cross the
    boundary by copy: what a get or scan hands out is the caller's, and what set is given is the
    store's from that call on, converted or copied then.  A value that fails to decode is an
    error in a dev bundle, and in production a read answers it as absent. */
export interface Store {
  write<T>(fn: (txn: WTxn) => T): T;
  read<T>(fn: (txn: RTxn) => T): T;
}

/** makes an Engine's store, once, from the Registry the Engine built for its model */
export type StoreFactory = (reg: Registry) => Store;

// key patterns ///////////////////////////////////////////////////////////////

/** A match on one template parameter: exactly one value, a range of values, the values starting
    with a prefix, or null for any value.  Values compare in code-point order, as keys do. */
export type ParamMatch =
  | null
  | { eq: string }
  | { prefix: string }
  | { gte?: string; gt?: string; lte?: string; lt?: string };

/** A KeyPattern picks out keys of one key template by a match on each of its parameters.
    `slice` is one slice by name, the empty name being the Engine's own slice; or a family and a
    match per family parameter; or null for every slice.  `name` is the local template's name, with
    a match per local parameter in `local`, or null for every local key of the slices matched,
    which a scan reads keys only, since the values of different templates differ in type.  Each
    separator in a key sorts below every character the parameter before it may hold, so the keys a
    pattern picks out come in the order of their parameters, slice ones first. */
export type KeyPattern = {
  slice: string | { family: string; params: ParamMatch[] } | null;
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
   last one of a key), and between the slice's fields and the local ones a literal, the local
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
  const s = p.slice;

  // every key
  if (s === null) {
    if (p.name !== null || p.local.length > 0) {
      throw new Error('a pattern over every slice picks out every local key');
    }
    return { head: '', fields };
  }

  // the slices: one by name, or a family's with a field per parameter
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

  // every local key of the slices, or one template's, its name a literal
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
   way in and out; the store also keeps bytes it was given, until a read decodes them.  Each keeps
   a base map, and each transaction keeps a map of pending updates over it, in which undefined
   marks a deletion.  The store also keeps its keys in a KeyList, so a scan seeks to its first key
   and walks from there; the overlay holds only the few keys predictions write, and sorts them for
   each scan. */

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

/** a value the in-memory store holds as the msgpack bytes it was given, until a read decodes it */
class Packed {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

// the reserved types whose bytes are the value itself, which a read never decodes in their place:
// a parked edit reads as its envelope, and a parked page is never read
const RAW_TYPES = new Set(['.edits', '.page']);

/* A stored value decoded with the reader's type.  One that fails to decode is a loud error in dev
   mode, and absent in production. */
function decodeStored(reg: Registry, key: string, type: string, bytes: Uint8Array): unknown {
  try {
    return reg.convert(type, bytes, MSGPACK, JS);
  } catch (e: unknown) {
    if (!DEV) return undefined;
    throw new Error(`${key}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// an edit as an error names it, by its lifecycle
const edit = (life: Lifecycle) => (life === 'normal' ? 'an edit' : `a ${life}`);

/** InMemStore keeps values in memory, with its keys in a sorted list, so a scan seeks to its
    first key rather than sorting.  A value given as bytes, as every value an edit or a snapshot
    applies is, stays bytes until its first read decodes it with the reader's type, and the
    decoded value takes their place.  Values cross the transaction boundary by copy. */
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
    return this.#out(key, type, rep);
  }

  set(key: string, type: string, rep: Rep, value: unknown): void {
    if (rep === MSGPACK) {
      this.#updates.set(key, new Packed((value as Uint8Array).slice()));
    } else {
      this.#updates.set(key, layerIn(this.#reg, type, rep, value));
    }
  }

  del(key: string): void {
    this.#updates.set(key, undefined);
  }

  delPrefix(prefix: string): string[] {
    const keys = this.#keysUnder(prefix);
    for (const k of keys) this.#updates.set(k, undefined);
    return keys;
  }

  applyEdits(edits: WireEdit[]): string[] {
    const changed = new Set<string>();
    for (const e of edits) this.#applyEdit(e.slice, e.lifecycle, e.raw as Uint8Array, changed);
    return [...changed];
  }

  applyParked(slice: string, fromSeq: number): string[] {
    const changed = new Set<string>();
    const from = parkedEditKey(slice, fromSeq);

    // the slice's parked edits from the seq on, each as its envelope says
    for (const key of this.#keysUnder(`!park-edit:${slice}!`)) {
      if (compareKeys(key, from) < 0) continue;
      const bytes = this.#bytes(key);
      const env = this.#reg.convert('.edits', bytes, MSGPACK, JS) as EditEnvelope;
      this.#applyEdit(slice, env.lifecycle, bytes, changed);
    }
    return [...changed];
  }

  applySnapshot(selector: string, skip: string[]): string[] {
    const changed = new Set<string>();
    const skipped = new Set(skip);
    const prefix = selectorPrefix(selector);

    // every page in order, each key under the selector, and none of a skipped slice
    for (const page of this.#keysUnder(`!park-snap:${selector}!`)) {
      for (const [key, value] of this.#reg.ops(this.#bytes(page), false)) {
        if (!key.startsWith(prefix)) {
          throw new Error(`the snapshot of ${selector} holds ${JSON.stringify(key)}`);
        }
        if (skipped.has(sliceOf(key))) continue;
        this.#write(key, value, changed);
      }
    }
    return [...changed];
  }

  // one edit: a birth or a death clears the slice's keys first, then the operations apply in
  // order, of which a death has none
  #applyEdit(slice: string, life: Lifecycle, bytes: Uint8Array, changed: Set<string>): void {
    if (life !== 'normal') for (const k of this.delPrefix(`${slice}!`)) changed.add(k);
    for (const [key, value] of this.#reg.ops(bytes, true)) {
      if (life === 'death' || sliceOf(key) !== slice) {
        throw new Error(`${edit(life)} of ${slice} writes ${JSON.stringify(key)}`);
      }
      this.#write(key, value, changed);
    }
  }

  // one operation: a set keeps a copy of its bytes, and a deletion marks the key
  #write(key: string, value: Uint8Array | undefined, changed: Set<string>): void {
    this.#updates.set(key, value === undefined ? undefined : new Packed(value.slice()));
    changed.add(key);
  }

  // the bytes a parked key holds
  #bytes(key: string): Uint8Array {
    const v = layerGet(this.#values, this.#updates, key);
    if (!(v instanceof Packed)) throw new Error(`${key} holds no bytes`);
    return v.bytes;
  }

  // the value at key in a representation, undefined when absent; bytes decode with the reader's
  // type, and the decoded value takes their place unless the bytes are the value itself
  #out(key: string, type: string, rep: Rep): unknown {
    const v = layerGet(this.#values, this.#updates, key);
    if (v === undefined) return undefined;
    if (!(v instanceof Packed)) return layerOut(this.#reg, type, v, rep);
    if (rep === MSGPACK) return v.bytes.slice();
    if (RAW_TYPES.has(type)) return this.#reg.convert(type, v.bytes, MSGPACK, rep);
    const js = decodeStored(this.#reg, key, type, v.bytes);
    if (js === undefined) return undefined;
    (this.#updates.has(key) ? this.#updates : this.#values).set(key, js);
    return layerOut(this.#reg, type, js, rep);
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

    // the batch, its values copied or converted out; a value that fails to decode is left out
    const page = keys.slice(0, req.limit);
    const entries: [string, unknown][] = [];
    for (const k of page) {
      const value = v ? this.#out(k, v.type, v.rep) : undefined;
      if (!v || value !== undefined) entries.push([k, value]);
    }
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

/** Overlay is the Engine's in-memory layer of predictions over the base.  It is not a Store: each
    call takes a base read transaction the caller already holds, so one rebuild of the overlay, its
    predictions and the graph run after them, reads one snapshot of the base. */
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
      returns, and answer the keys it wrote; a throw drops them */
  apply(base: RTxn, fn: (txn: WTxn) => void): string[] {
    const updates: Layer = new Map();
    fn(new OverlayTxn(this.#reg, base, this.#data, updates));

    // keep the scratch layer's writes in the overlay's own layer
    for (const [key, val] of updates) {
      // note: we must keep undefined values rather than propagate deletions to base
      this.#data.set(key, val);
    }
    return [...updates.keys()];
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

  // every key of the slice a prefix `{slice}!` names, from the base and the layers, in order;
  // predictions delete whole slices, so the overlay deletes nothing narrower
  #keysUnder(prefix: string): string[] {
    if (prefix.indexOf('!') !== prefix.length - 1) {
      throw new Error(`the overlay deletes whole slices, not ${prefix}`);
    }
    const all = new Set<string>();
    const pattern: KeyPattern = { slice: prefix.slice(0, -1), name: null, local: [] };
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

  /** predictions write keys one by one, so the overlay applies no edits or snapshots */
  applyEdits(): string[] {
    throw new Error('the overlay applies no edits');
  }

  applyParked(): string[] {
    throw new Error('the overlay applies no edits');
  }

  applySnapshot(): string[] {
    throw new Error('the overlay applies no snapshots');
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
    undefined for an absent key.  It applies edits and snapshot pages itself, in the host
    language, reading the bytes it parked.  It walks keys in code-point order, as a store comparing
    UTF-8 keys bytewise does. */
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

// transactions //////////////////////////////////////////////////////////////

/** ReadTxn is what a query, a grantor, or lookup reads through: rich JS values by key and type,
    undefined for an absent key, and scans by pattern. */
export interface ReadTxn {
  get(key: string, type: string): unknown;
  scan(req: ReadScan): StoreScan;
}

/** a scan through a ReadTxn: its values are rich JS values of `type`, or keys only for false */
export type ReadScan = {
  pattern: KeyPattern;
  type: string | false;
  reverse?: boolean;
  after?: string;
  limit: number;
};

/** WriteTxn is what a predictor and a decider read and write through.  The database's and the
    Engine's are one shape, so a decider can hand its own to a predictor.  On the database its
    writes become the mutation's edits, one per slice written; on an Engine they are the
    mutation's prediction, in the overlay.  A key's slice is everything before its first `!`, and
    every key written is under a well-formed slice name.  Reads see the transaction's own writes,
    and what a get hands out is the caller's, to change and set back. */
export interface WriteTxn extends ReadTxn {
  set(key: string, type: string, value: unknown): void;
  del(key: string): void;
  /** Delete a slice: every key under it goes, and on the database its edit is a death, or a
      birth when the writes that follow write to it again.  `erase` also drops the slice's
      history from the edit log, which means nothing on an Engine. */
  deleteSlice(slice: string, erase: boolean): void;
  /** One batch of the keys a pattern picks out.  A scan sees the transaction's own writes, but it
      is a walk taken a batch at a time: a key written or deleted ahead of an unfinished scan,
      among the keys it picks out, is seen or not depending on whether its batch was already
      fetched, so a predictor and the decider calling it could see different states.  Write only
      behind a scan, or after it ends. */
  scan(req: ReadScan): StoreScan;
}

/** how a generated deleteSlice accessor takes its options: `erase` also drops the slice's history
    from the database's edit log */
export type DeleteSliceOptions = { erase?: true };

/** a read transaction in the shape of a WriteTxn whose writes throw, so a database context serves
    the slots that only read */
export function readOnlyTxn(txn: ReadTxn): WriteTxn {
  const refuse = (): never => {
    throw new Error('this call reads only, and made a write');
  };
  return {
    get: (key, type) => txn.get(key, type),
    scan: (req) => txn.scan(req),
    set: refuse,
    del: refuse,
    deleteSlice: refuse,
  };
}

// the transactions a query or a prediction ran over that have returned, so a scan carried out of
// one throws rather than reading on
const closedTxns = new WeakSet<object>();

/** every entry a scan picks out, as the key's template parameters in order, slice ones first,
    and its value; batches are fetched as the walk goes, from 16 entries growing to 256 */
export function scanEach(
  txn: ReadTxn,
  req: Omit<ReadScan, 'after' | 'limit'>,
): IterableIterator<[string[], unknown]> {
  const p = req.pattern;
  const parse = (key: string) => {
    if (p.slice === null) return [key];
    const bang = key.indexOf('!');
    const slice =
      typeof p.slice === 'string' || p.slice.params.length === 0
        ? []
        : key.slice(p.slice.family.length + 1, bang).split(',');
    return [...slice, ...localParams(key.slice(bang + 1), p.name, p.local.length)];
  };
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
      throw new Error('a scan was used after its query or prediction returned');
    }

    // a batch, whose span the fetch just recorded or extended
    const { entries, next } = fetch(after, limit);
    const span = deps?.spans[deps.spans.length - 1];

    // each entry, the span reaching it as it is handed out
    for (const [key, value] of entries) {
      if (span !== undefined) span.to = key;
      yield [parse(key), value];
      if (closedTxns.has(txn)) {
        throw new Error('a scan was used after its query or prediction returned');
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

/* A generated context is built once, by its create function, which answers `{ ctx, $ref }`: the
   context, and the one box every accessor of it reads the transaction through when called.  Its
   holder binds it by assigning the transaction, `$ref.txn = txn`, whenever the transaction it
   runs over changes, so no context is built per call. */

/** a box that holds no transaction yet, throwing on any use of it */
export function unboundRef<T extends object>(): { txn: T } {
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
    the family's parameters, the local template's name and parameters, and the type its values
    travel under */
export type ScanTemplate = {
  accessor: string;
  family: string;
  slice: string[];
  name: string;
  local: string[];
  type: string;
};

type ScanOptions = { reverse?: boolean; keys?: boolean };
type NamedMatch = Partial<Record<string, ScanMatch>>;

/** A scan accessor over a global context's read transaction, whichever the box holds when it is
    called.  For generated code: no template parameter holds a `$`, so none can shadow it. */
export function $globalScan<P extends string, V>(
  ref: { txn: ReadTxn },
  t: ScanTemplate,
): ScanAccessor<P, V> {
  const scan = (match: NamedMatch = {}, options: ScanOptions = {}) => {
    const n = t.slice.length;
    const params = t.slice.map((p, i) => {
      return paramMatch(t.accessor, p, match[p], i < n - 1 ? $asSegment : $asSliceRest);
    });
    const pattern: KeyPattern = {
      slice: { family: t.family, params },
      name: t.name,
      local: localMatches(t, match),
    };
    const type = options.keys === true ? false : t.type;
    const walk = scanEach(ref.txn, { pattern, type, reverse: options.reverse });
    return named(walk, [...t.slice, ...t.local], options.keys === true);
  };
  return scan as ScanAccessor<P, V>;
}

// a template's local parameters' matches; the last one may hold anything a key may
function localMatches(t: ScanTemplate, match: NamedMatch): ParamMatch[] {
  const n = t.local.length;
  return t.local.map((p, i) => paramMatch(t.accessor, p, match[p], i < n - 1 ? $asSegment : null));
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

// slice names and keys /////////////////////////////////////////////////////

/* A slice type's family template and each of its key templates is a name, then, if it has
   parameters, `:{param}` and `,{param}` for each further one: `chat:{org},{channel}`, `post:{id}`,
   `meta`.  A parameter the template ends with is terminal and holds the rest of the string.  Every
   other parameter is a segment, a non-empty run of `A-Z a-z 0-9 _ -`, so `chat:acme,general`
   parses back as `chat:{org},{channel}` unambiguously and `chat:acme,*` covers one org's
   channels.  A slice name's terminal parameter is non-empty and may also hold `.` and `~`, the
   rest of the RFC 3986 unreserved set, since slice names appear in URLs.  A local key's terminal
   parameter may hold anything a key may, the empty string included.  No key holds a control
   character (U+0000-001F, U+007F-009F) or a lone surrogate; the database refuses a write of one.

   A store key is `{slice}!{local key}`, as in `chat:acme,general!reply:t1,m5`, and its slice is
   everything before its first `!`.  Keys sort in code-point order, and each separator after a
   parameter sorts below every character that parameter may hold: `,` below a segment's, and `!`
   below a slice name's.  So a walk of a family visits its slices in the order of their
   parameters, `gen` before `gen-2`, and a walk of a key template its keys likewise. */

const SEGMENT = '[A-Za-z0-9_-]+';
const SLICE_REST = '[A-Za-z0-9_.~-]+';
const SEGMENT_RE = new RegExp(`^${SEGMENT}$`);
const SLICE_REST_RE = new RegExp(`^${SLICE_REST}$`);

/** A template parameter's value, other than a terminal one, checked.  A generated accessor passes
    each of its parameters through this or $asSliceRest before building a key; no template
    parameter holds a `$`, so none can shadow it. */
export function $asSegment(value: string, accessor: string, param: string): string {
  if (!SEGMENT_RE.test(value)) {
    const v = JSON.stringify(value);
    throw new Error(`${accessor}: ${param} ${v} is not a non-empty run of A-Z a-z 0-9 _ -`);
  }
  return value;
}

/** The value of a family template's terminal parameter, checked.  For generated code: no template
    parameter holds a `$`, so none can shadow it. */
export function $asSliceRest(value: string, accessor: string, param: string): string {
  if (!SLICE_REST_RE.test(value)) {
    const v = JSON.stringify(value);
    throw new Error(`${accessor}: ${param} ${v} is not a non-empty run of A-Z a-z 0-9 _ - . ~`);
  }
  return value;
}

/** the slice a key belongs to: everything before its first `!` */
export function sliceOf(key: string): string {
  const bang = key.indexOf('!');
  if (bang < 0) throw new Error(`key ${JSON.stringify(key)} has no '!'`);
  return key.slice(0, bang);
}

/** Apply fn to the value at a key in place and set it, answering what fn returns; an absent key
    throws.  For generated code: no template parameter holds a `$`, so none can shadow it. */
export function $updateKey<T, R>(txn: WriteTxn, key: string, type: string, fn: (value: T) => R): R {
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

/** A decider rejects a mutation by throwing a Reject, whose reason goes back to the client.  Any
    other throw is a bug, answered with a generic rejection. */
export class Reject extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Reject';
  }
}

/** who sent a mutation, as their token proves it; user is null for the anonymous principal */
export type Principal = { user: string | null };

/** Auth is what a decider authorizes through.  Each call gets a fresh one, and the caller rejects
    a decider that returns without an authorization decision, so authorization fails closed.  It
    carries the principal, so a decider can hand it on wherever a Principal is wanted. */
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
      open mutation is visible in code */
  authorizeAnyone(): void {
    this.#authorized = true;
  }
}

/** Run one decider with a fresh Auth, answering null when it carried the mutation out, or the
    reason for a rejection.  A Reject is a rejection, and so is a decider that returns without an
    authorization decision, which in dev mode is an error naming the decider.  Any other throw is
    a bug, and goes to the host.  On a rejection or a throw the database discards the decider's
    writes. */
export function runDecider(
  name: string,
  principal: Principal,
  decider: (auth: Auth) => void,
): string | null {
  const auth = new Auth(principal);
  try {
    decider(auth);

    // authorization fails closed: a decider that made no decision is rejected, loudly in dev
    if (!auth.authorized) {
      if (DEV) throw new Error(`decider ${name} returned without an authorization decision`);
      throw new Reject('unauthorized');
    }
  } catch (e: unknown) {
    // every rejection reaches the host as its reason; anything else is a bug
    if (e instanceof Reject) return e.message;
    throw e;
  }
  return null;
}

/** The app's prediction of what the database will do with a mutation, made by writing through the
    transaction.  The Engine passes `pending` as true, and a decider calling the predictor leaves
    it out, so a predictor may mark what it writes as pending; branching on it for anything else
    makes the prediction and the decision diverge. */
export type Predictor<X, M> = (txn: X, mutation: M, pending?: true) => void;

/** The app's decision on a mutation, inside the database's serialized transaction: it rejects by
    throwing a Reject, or carries the mutation out by writing through the transaction, and must
    make an authorization decision either way. */
export type Decider<X, M> = (auth: Auth, txn: X, mutation: M) => void;

/** The selectors of the slices a principal may see: an exact selector, one slice by its name
    terminated, `name!`; or a prefix selector, a family's slices, `chat:*`, those under whole
    leading parameters, `chat:acme,*`, or every slice, `*`. */
export type Grantor<X> = (txn: X, principal: Principal) => string[];

// the database bundle ////////////////////////////////////////////////////////

/** What the database asks lookup about: a sign-in by identity, a token's principal at refresh,
    and a token's principal on every check of its account's generation and of an auth proof its
    mutations carry.  A proof is checked against the answer before its mutation reaches the
    writer, and the writer asks again in the mutation's turn: a proof whose answer changed
    meanwhile is checked again, so the answer for a token should change only when the account's
    credentials do. */
export type LookupIdent =
  | { kind: 'password'; identity: string }
  | { kind: 'refresh'; user: string }
  | { kind: 'token'; user: string };

/** an existing account: its user, the generation every token of it must carry, and the stored
    password hash a sign-in or a password proof verifies against */
export type LookupResult = {
  user: string;
  generation?: number;
  passwordHash?: string;
};

/** what the database hands bootstrap beside its transaction: hashPassword makes a hash as the
    database would prepare a new password, and env reads a variable the operator named */
export type BootstrapContext = {
  hashPassword: (plain: string) => string;
  env: (name: string) => string;
};

/** Bundle is what a database runs: the app's slots behind the generated wrappers, installed as
    `globalThis.__bundle`, and the registry the database converts and checks every value by.  Its
    contexts are built once, and the host binds them through two hooks.  bindWrite binds the
    read-write context of decide, bootstrap, and every plugin's run, and the plugins themselves,
    to a transaction whose writes, when decide answers null, are the mutation's edits.  bindRead
    binds the one context grant and lookup share, whose writes throw.  The entry points then run
    over whatever was bound last: decide gets the mutation's data alone, and bootstrap seeds an
    empty database by writing.  Values are rich JS values.  `plugins` are the database's
    installed plugins by name, as the host calls them.  `dev` is the bundle's DEV, so a host
    answers the errors of a dev bundle in full, and `mapStack` maps an error's stack through the
    bundle's source map. */
export type Bundle = {
  schema: Schema;
  bindWrite: (txn: WriteTxn) => void;
  bindRead: (txn: ReadTxn) => void;
  decide: (data: unknown, principal: Principal) => string | null;
  grant: (principal: Principal) => string[];
  lookup: (ident: LookupIdent) => LookupResult | null;
  bootstrap?: (ctx: BootstrapContext) => void;
  plugins: Record<string, BundlePlugin>;
  dev: boolean;
  mapStack: typeof mapStack;
};

// plugins ///////////////////////////////////////////////////////////////////

/** A plugin as one database holds it: the name it is installed under, its request API, which app
    code calls as `txn.{name}`, bind, which points the plugin's own contexts at the transaction
    the database binds its write context to, and, for a plugin with mutations of its own, run,
    which carries one of them out, a cron tick or a worker's result, by writing through that
    transaction.  A request is a write to the plugin's own slice, committed with the rest of the
    transaction's writes, which the host acts on after the commit.  A built-in's config is what
    the host reads of it, by its install's kind. */
export interface Plugin<Api extends object = object> {
  readonly name: string;
  readonly api: Api;
  readonly config?: unknown;
  bind(txn: WriteTxn): void;
  run?(mutation: unknown): void;
}

/** What a plugin's install answers and a plugin set lists: the plugin's kind, which prefixes its
    type identities, and create, which makes the plugin under the name a database installs it by.
    ctx is the database's context, the txn of the app's hooks: the plugin's own context offers
    each hook as a field whose wrapper calls the hook over ctx, and only those wrappers hold
    ctx. */
export interface PluginInstall<Api extends object = object> {
  readonly kind: string;
  create(name: string, ctx: unknown): Plugin<Api>;
}

/** An installed plugin as a host sees it: its kind, by which the host recognizes a built-in, a
    built-in's config, and, for a plugin with mutations of its own, run, which hands the plugin
    one mutation over the transaction the bundle's bindWrite bound. */
export type BundlePlugin = {
  readonly kind: string;
  readonly config?: unknown;
  readonly run?: (mutation: unknown) => void;
};

/** the types a database hands a plugin's hooks: the txn they read and write through */
export type DbTypes = { txn: unknown };

/** What ties an installed plugin to one database's types.  DB appears bare, so a plugin's install
    infers it from the slot it lands in, and an install for one database fits no other's. */
export type DbMarker<DB extends DbTypes> = { readonly db: (db: DB) => DB };

/** the request APIs of a plugin set, as the fields of a txn */
export type PluginApis<P> = { [K in keyof P]: P[K] extends PluginInstall<infer A> ? A : never };

/** the fields of a database context, which no plugin may be named after */
export type ContextField = 'get' | 'scan' | 'set' | 'del' | 'update' | 'deleteSlice' | 'status';

/** the names no plugin may take: a context's fields, and __proto__, which an assignment would take
    as the object's prototype rather than a field */
export type ReservedPluginName = ContextField | '__proto__';
const RESERVED_PLUGIN_NAMES: readonly string[] = [
  'get',
  'scan',
  'set',
  'del',
  'update',
  'deleteSlice',
  'status',
  '__proto__',
];

// a plugin's name: a JS identifier without $, so it is also a slice name's text
const PLUGIN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** a database's plugins slot: each plugin of the set P under its name, tied to the database's
    types DB */
export type PluginSlots<P, DB extends DbTypes> = {
  [K in keyof P]: K extends ReservedPluginName ? never : P[K] & DbMarker<DB>;
};

/** Install a database's plugins: create each under its name, which is checked, over the
    database's write context, and attach its request API to that context under its name.  Answers
    the plugins by name as a host calls them, and one bind that points every plugin at the
    transaction the context is bound to. */
export function installPlugins(
  ctx: object,
  installs: Record<string, PluginInstall>,
): { plugins: Record<string, BundlePlugin>; bind: (txn: WriteTxn) => void } {
  const all: Plugin[] = [];
  const bind = (txn: WriteTxn): void => {
    for (const plugin of all) plugin.bind(txn);
  };

  // create each plugin, attach its API, and give a plugin with mutations its entry
  const plugins: Record<string, BundlePlugin> = {};
  for (const [name, install] of Object.entries(installs)) {
    if (RESERVED_PLUGIN_NAMES.includes(name)) throw new Error(`a plugin may not be named ${name}`);
    if (!PLUGIN_NAME_RE.test(name)) {
      throw new Error(`plugin name ${JSON.stringify(name)} is not a JS identifier without $`);
    }
    const plugin = install.create(name, ctx);
    all.push(plugin);
    (ctx as Record<string, unknown>)[name] = plugin.api;
    const run = (mutation: unknown): void => plugin.run!(mutation);
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
    context factory builds over it.  The Engine tells it which keys changed: keys that applied
    edits and snapshots changed, keys of an overlay being discarded, and keys a new prediction
    wrote. */
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

// edits /////////////////////////////////////////////////////////////////////

/** Mutation wraps mutation data T with the client-minted id it will carry through the log, and
    the series and number the database dedups it by: an Engine numbers its mutations in a series
    it mints, and the database runs each number once.  An unnumbered mutation has neither. */
export type Mutation<T> = {
  id: string;
  series: string | null;
  n: number | null;
  data: T;
};

/** Bytes the Engine carries without reading them: a Uint8Array in a JS-native host, and in a
    quickjs-class host whatever handle its transport and its store agree on, so the bytes never
    enter the JS heap. */
export type RawBytes = unknown;

/** Where an edit stands in its slice's life.  A normal edit applies its writes.  A birth clears
    the slice, then applies its writes: it is the first edit to a slice that is unborn or deleted,
    and the edit of a mutation that deletes its slice and writes to it.  A death clears the slice
    and writes nothing: the slice is deleted, or erased, which the database alone tells apart.  A
    birth or a death is a reset, which a client chains on at any seq above its last. */
export type Lifecycle = 'normal' | 'birth' | 'death';

/** What the database stamped on an edit when it committed it: the log position of its mutation,
    the slice it edits and its seq there, the mutation's id, the server time, and where the edit
    stands in the slice's life.  A mutation that edits three slices makes three edits at one
    position. */
export type EditEnvelope = {
  position: number;
  slice: string;
  seq: number;
  id: string;
  servertime: Date;
  lifecycle: Lifecycle;
};

/* An edit on the wire is one msgpack array: its envelope, then its payload's items, flat.

     [[position, slice, seq, id, servertime, lifecycle, ...], 0, key, value, 1, key, ...]

   The envelope's id is the mutation's uuid as 16 bytes of bin, its servertime a msgpack
   timestamp, and lifecycle an integer, 0 for normal, 1 for birth, and 2 for death, any other
   value an error; elements a later protocol appends to the envelope are skipped.  The payload
   is a stream of operations, each a one-byte opcode and the items it fixes: `0, key, value` sets
   a key, a nil value setting null, and `1, key` deletes one.  A key written twice in one mutation
   appears once, with its last write.  A value is inline msgpack in the store format, which a host
   slices out as a byte span without decoding it.  An opcode a client does not know is an error,
   and the client crashes.  A snapshot page is a run of operations encoded as a payload is, all
   of them sets. */

/** WireEdit is an edit as a connection delivers it: the envelope decoded for routing, and the
    whole edit as it came, which the Engine parks or hands to its store to apply, never reading
    its payload. */
export type WireEdit = EditEnvelope & { raw: RawBytes };

// transports ////////////////////////////////////////////////////////////////////

export type Backfill = {
  // what selector are we backfilling (slice name or prefix)
  selector: string;
  /* The tail's exclusive upper bound, which retries keep: the tail delivers the positions below
     it, and the live connection those at or above it, which the Engine parks.  A view frame's
     position is the last position its connection sent under the previous view: everything the
     connection sends after the frame is filtered by the new view, and the new view's edits at or
     below the position are its backfills' to deliver, so a grant's backfill takes the position
     plus one.  A bootstrap's view frame, at V, is where its connection starts: once it is
     processed the cursor is V, the backfills cover every position at or below V, and the
     connection every position above it. */
  until: number;
  // what a previous attempt got through, or null for a fresh backfill.  A finished half is
  // skipped outright.  Otherwise skipBytes > 0 resumes the blob download, and the header's
  // position must then equal position or the outcome is 'stale'; skipBytes === 0 fetches from
  // the start and accepts any position.  Either way a blob from another log, its epoch not the
  // connection's, is 'stale'.  The tail starts at max(fromPosition, header position), so a newer
  // blob overrides the floor.  It reads forward, which may result in gaps if retention
  // pruning happens concurrently, so it must be checked for gaps just before landing.  The
  // checksum is the last parked page's, handed back so a resumed download continues its check;
  // it is '' when skipBytes is 0.  visible is the header's, kept for the land.
  resume: null | {
    position: number;
    visible: number;
    skipBytes: number;
    checksum: string;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  // cancels this backfill alone; the connection's own signal cancels everything
  signal: Signal;
  // one call per delivery, resolved once the Engine has committed it
  push(item: BackfillItem): Promise<void>;
};

/** One delivery of a backfill: the blob's whole length in bytes, when its response states one;
    the blob's header, its cut position, the seq of every slice in it, which names every slice
    the blob holds, and visible, the last position at or below the cut where any slice under the
    selector changed, a deleted one included; a page of the blob's set operations, whole ones,
    with the byte offset after it, to resume past, and the transport's running check over every
    page delivered so far; a run of tail edits with the position its scan reached; or the end of
    either half.  The length and
    the scan feed the Engine's progress status alone, and the checksum is opaque to it, kept only
    to hand back on a resume.  A download without a resume pushes its header before anything else
    but its length, since the header is what the rest is parked against. */
export type BackfillItem =
  | { length: number }
  | { header: { position: number; seqs: Record<string, number>; visible: number } }
  | { page: RawBytes; skip: number; checksum: string }
  | { pagesDone: true }
  | { edits: WireEdit[]; scanned: number }
  | { editsDone: true };

/** What the database answers for a mutation.  `ok` means it was decided at or before position,
    so a client that has applied that far can read the outcome from its state.  A reject's reason
    and a conflict's current seqs, by slice, come only in the first answer to a decision, and a
    resend of either is answered `ok`. */
export type MutationResult =
  | { kind: 'ok'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, when its epoch is not the connection's, or when a resumed
// fetch's PhaseLock-Position differs from resume.position; the Engine discards what it parked and
// starts over.  Any other failure rejects, and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connection {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and within a call, array order.  A call that fails also
  // fails every call behind it, unsent, and ends the connection, so the next connection's resend
  // keeps the Engine's order.  Retrying before giving up is the connection's choice.
  sendMutations(mutations: Mutation<Uint8Array>[]): Promise<MutationResult[]>;
}

export interface ConnectionHooks {
  // first, once per connection, before any frame: from the response headers, the epoch, the log
  // every position on this connection belongs to, and the head, the log's position as the
  // connection opened
  onOpen(epoch: string, head: number): void;
  // the whole view: token is its hash, position the commit it is the view at, selectors the set.
  // Sent first when the presented token was not current, and on every change, in log order
  // ahead of the edits it applies to.  The Engine diffs selectors against what it holds.
  onView(token: string, position: number, selectors: string[]): void;
  // the edits of one frame, in log order; a mutation's edits to the slices this connection holds
  // arrive in one frame
  onEdits(edits: WireEdit[]): void;
  // history done; live from here (sent once per connection)
  onLive(position: number): void;
  onVouch(position: number): void;
  // the connection is over; fatal is the error that ends the Engine, when no later connection
  // can succeed, such as the database refusing the session
  onEnd(code: number, reason: string, fatal?: unknown): void;
}

/** Who an Engine or a post speaks for: a signed-in user, as the host library that signed them in
    represents one.  The library owns its shape and keeps it current, refreshing its token in
    place, so everyone holding it sees the refresh; the Engine and the post never read a session,
    and only hand it back to the transport.  A host whose bridge into JS cannot carry an object of
    its own passes a handle instead, and maps it back. */
export type Session = object;

/** A Transport is how a host reaches one database: the host's Registry, built from generated
    registry data; one connection per connect attempt; and mutations posted outside any
    connection.  It keeps no identity: each call names the session it speaks for, or null for
    anonymous. */
export interface Transport {
  buildRegistry(schema: Schema): Registry;
  // One Connection per attempt: since is the Engine's checkpoint (-1 to bootstrap), and the
  // connection reports exactly one onEnd.  wants are the selectors of the Engine's slice types, one
  // each, which the database cuts the view down to.  The signal is its lifetime; aborting it ends
  // the connection and rejects any backfill or send in flight.
  connect(
    since: number,
    view: string | null, // the Engine's stored view token; null to bootstrap
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
    session: Session | null,
  ): Connection;
  // Mutations outside any connection, answered with their outcomes in order, in as many requests
  // as the database's limit on mutations per request calls for, one after another.  A transport
  // may retry a failed request when every mutation in it is numbered, since the database answers
  // a resend of one that landed as decided, and never retries one that is not.
  post(mutations: Mutation<Uint8Array>[], session?: Session | null): Promise<MutationResult[]>;
}

// each transport's Registry for each schema, built once and shared by every Engine and post
const registries = new WeakMap<Transport, WeakMap<Schema, Registry>>();

/** the transport's Registry for the schema, built on first use */
function registryFor(transport: Transport, schema: Schema): Registry {
  let bySchema = registries.get(transport);
  if (bySchema === undefined) {
    bySchema = new WeakMap();
    registries.set(transport, bySchema);
  }
  let reg = bySchema.get(schema);
  if (reg === undefined) {
    reg = transport.buildRegistry(schema);
    bySchema.set(schema, reg);
  }
  return reg;
}

// engines ////////////////////////////////////////////////////////////////////

/** the latest view the connection delivered, as persisted at !view when its frame arrives */
export type ViewRecord = { token: string; position: number; selectors: string[] };
/** The cursor, as persisted at !checkpoint: the epoch of the log it is in; position, the last
    position delivered, every edit at or below it applied or parked, which a reconnect resumes
    from; and applied, how far the base has been applied, which the cursor passes while frozen */
export type CheckpointRecord = { epoch: string; position: number; applied: number };
/** a backfill in flight, as persisted at !backfill:{selector} */
export type BackfillRecord = { until: number; resume: Backfill['resume'] };
/** the in-memory side of a backfill: its record, written through, plus what the disk needs not */
type BackfillEntry = {
  record: BackfillRecord;
  controller: SignalController;
  status: 'downloading' | 'ready';
  // failed attempts in a row, for backoff, and the retry waiting to run, due at retryAt
  attempts: number;
  retryTimer: unknown;
  retryAt: number | null;
  // the blob's length, when its response stated one, and how far the tail's scan has reached
  length: number | null;
  scanned: number;
};

// a backfill entry as it starts, with no attempt made
function newBackfillEntry(record: BackfillRecord): BackfillEntry {
  return {
    record,
    controller: new host.AbortController(),
    status: 'downloading',
    attempts: 0,
    retryTimer: null,
    retryAt: null,
    length: null,
    scanned: -1,
  };
}

// a backfill's status, from its record and what its connection has reported
function backfillStatus(selector: string, entry: BackfillEntry): BackfillStatus {
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
  return { selector, snapshot, tail, retryAt };
}

// a tail's share scanned: none before the blob's header gives its cut, and all once done
function tailShare(b: BackfillStatus): number {
  const t = b.tail;
  if (t === null) return 0;
  if (t.done || t.until <= t.cut) return 1;
  return Math.min(1, Math.max(0, (t.scanned - t.cut) / (t.until - t.cut)));
}

/** whether a selector covers a slice name or a narrower selector: a prefix selector (`*`,
    `chat:*`, `chat:acme,*`) covers the names under the prefix before its star, and an exact
    selector, a slice's name, covers itself */
export function selectorCovers(selector: string, name: string): boolean {
  if (selector.endsWith('*')) return name.startsWith(selector.slice(0, -1));
  return name === selector;
}

/** one push from a backfill, queued for the advancer with the promise's resolvers */
type BackfillWork = {
  selector: string;
  // the backfill the push belongs to, which a revoke and a regrant of the selector replace
  entry: BackfillEntry;
  item: BackfillItem;
  resolve: () => void;
  reject: (e: unknown) => void;
};

/** one mutation the app sent: one for the outbox, or an @online one with its promise's
    resolvers */
type Submission<M, N> =
  | { outbox: M }
  | { online: N; resolve: (result: MutationResult) => void; reject: (e: unknown) => void };

/** an @online mutation handed to a connection and not yet settled: its promise's resolvers, the
    database's ok once it arrives, and whether an edit carrying its id has been applied */
type OnlineMutation = {
  resolve: (result: MutationResult) => void;
  reject: (e: unknown) => void;
  ack: { kind: 'ok'; position: number } | null;
  seen: boolean;
};

/** the store key prefix a selector covers: a prefix selector's text before its star (`chat:`,
    `chat:acme,`, and the empty prefix for `*`), and `{slice}!` for an exact one */
export function selectorPrefix(selector: string): string {
  if (selector.endsWith('*')) return selector.slice(0, -1);
  return `${selector}!`;
}

/** the delay before the n-th retry in a row: exponential from half a second, capped at half a
    minute, with jitter so a fleet does not retry in step */
export function backoffDelay(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 10));
  return base / 2 + Math.random() * (base / 2);
}

/** the key of a parked edit: its slice, then its seq zero-padded so a scan of the slice's prefix
    walks its chain in order; a re-parked edit overwrites itself */
export function parkedEditKey(slice: string, seq: number): string {
  return `!park-edit:${slice}!${String(seq).padStart(20, '0')}`;
}

/** the key of a parked snapshot page: its backfill's selector, then the blob offset it starts at,
    zero-padded so a scan of the selector's prefix walks the pages in order */
export function parkedPageKey(selector: string, offset: number): string {
  return `!park-snap:${selector}!${String(offset).padStart(20, '0')}`;
}

/** the key of an outbox mutation: its ordinal zero-padded so a scan walks the outbox in send
    order */
export function mutationKey(ordinal: number): string {
  return `!mutation:${String(ordinal).padStart(20, '0')}`;
}

/** the pattern of the Engine's own keys of one template, by a match on its one parameter */
function engineKeys(name: string, match: ParamMatch = null): KeyPattern {
  return { slice: '', name, local: [match] };
}

/** the slice and seq a parked edit's key names */
export function parsePark(key: string): { slice: string; seq: number } {
  const at = '!park-edit:'.length;
  const bang = key.indexOf('!', at);
  return { slice: key.slice(at, bang), seq: Number(key.slice(bang + 1)) };
}

// status ////////////////////////////////////////////////////////////////////

/* Queries read the Engine's status like any state: where the connection stands, how far syncing
   has come, and the outbox.  Every state queries show of the base is the server's state at one
   position, restricted to the slices the Engine holds.  Sync work comes in three kinds, which the
   Engine tells apart and the UI may treat differently.

   First boot.  The Engine has no base: nothing has been applied yet, on a fresh store or on one
   whose first sync never landed.  The first view's grants download as backfills and land
   together, so the first state queries see is complete.  Until then the Engine refuses every
   query that reads past the status: such a query waits with no result and answers once the base
   exists, while a query that reads only the status answers at once.  The UI shows a loading
   screen, with a bar from the estimate, while `hasBase` is false, and `state` is `syncing` until
   the land.

   Resync.  A connection replays history onto an existing base, from the cursor to the head, and
   queries see each batch as it lands, so the app zooms forward at catch-up speed.  With a base,
   the UI may show what it has, the zoom included, under a syncing banner while `state` is
   `syncing`.

   Backfill.  Downloads for a new grant, or to repair a gap.  While any backfill is in flight the
   base is frozen: every edit delivered waits, queries answer from the frozen base, and `state` is
   `syncing`.  Once every backfill has downloaded and the connection has reached the newest
   snapshot's cut, the backfills and everything that waited land in one transaction, and the base
   moves to the connection's position.  A grant or a revoke that arrives meanwhile joins that land;
   a revoked slice stays in the frozen base until then.

   The estimate runs from 0 to 1 over one episode of work, and is null between episodes.  It
   weighs the stages of each kind:
     - first boot and backfill: 5% knowing every backfill and its size, 85% the downloads, and
       10% the land
     - resync: 5% the selector list confirmed, by any frame after the open, 20% backfills, and
       75% the replay, the checkpoint's way from where the episode started to the head the server
       stated when the connection opened
   A download is half snapshot and half tail.  The snapshots are exact, bytes over lengths, while
   every backfill in flight has a length its response stated, and otherwise fall back to
   downloadCurve over the bytes downloaded.  A tail is the share of its span, from the blob's cut
   to until, that its scan has reached.  A resync never knows which backfills it will need, so its
   backfill share is half the held slices resolved, each when an edit chains onto it, when its
   backfill lands, or when the replay reaches head, and half the download, which is whole until a
   backfill starts and then follows downloadCurve whatever lengths are known.

   The estimate never goes back.  Work found partway, such as a gap's backfill or a backfill whose
   size is unknown, pauses it until the work catches up, and a stage that finishes may jump it
   forward. */

/** Where the Engine stands: `connecting` until a connection opens, `syncing` while it replays
    history or a backfill is in flight, `live` once the replay is done and no backfill is in
    flight, so what queries show is current, and `offline` once a connection has failed or ended,
    until another opens.  The first attempt is `connecting`, and so is the Engine from a
    `reconnectNow` until a connection opens; a retry after backoff stays `offline`, so a
    connection that keeps failing never flickers to `connecting`.  `nextAttemptAt` is when the
    next retry is due, and null while one is trying.  `hasBase` is false until a first boot's
    sync lands, while queries may read only the status; `frozen` is true while a backfill is in
    flight and the base waits for it. */
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
  selector: string;
  snapshot: { bytes: number; length: number | null; done: boolean };
  tail: { cut: number; scanned: number; until: number; done: boolean } | null;
  retryAt: Date | null;
};

/** How far syncing has come.  `estimate` runs from 0 to 1 over the work in progress and never
    goes back, and is null when nothing is in progress.  The log is in positions: where this
    connection started, the server's head as last known, the checkpoint, and how far the base
    has been applied. */
export type ProgressStatus = {
  estimate: number | null;
  log: { since: number; head: number | null; committed: number; applied: number };
  backfills: BackfillStatus[];
};

/** the outbox: mutations the database has not acknowledged */
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

/** The status accessor of a query context, over the query's read transaction so its reads are
    recorded like any other.  For generated code: no template parameter holds a `$`, so none can
    shadow it. */
export function $engineStatus(ref: { txn: ReadTxn }): EngineStatus {
  return {
    connection: () => ref.txn.get(STATUS_KEYS.connection, '.json') as ConnectionStatus,
    progress: () => ref.txn.get(STATUS_KEYS.progress, '.json') as ProgressStatus,
    outbox: () => ref.txn.get(STATUS_KEYS.outbox, '.json') as OutboxStatus,
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
  // a resync's start: the checkpoint, and the slices held then, which each resolve when an edit
  // chains onto one, when its backfill lands, or when the replay reaches head
  since: number;
  held: Set<string>;
  resolved: Set<string>;
  // a resync's connection has delivered a frame after it opened, which confirms the selector list
  confirmed: boolean;
};

/** what the connection delivered, in arrival order */
type Inbound =
  | { open: { epoch: string; head: number } }
  | { view: ViewRecord }
  | { edits: WireEdit[] }
  | { vouch: number }
  | { live: number }
  | { end: { code: number; reason: string; fatal: unknown } };

/** Engine builds a sync engine out of a Transport, a Store, and optionally a user's predictors,
    syncing as one session or as anonymous for its whole life.  The Engine is responsible for
    managing connection status, the synchronization protocol, and the flow mutations, ultimately
    keeping the Store as up-to-date with the PhaseLockDB server as possible.

    An application interacts with the Engine primarily through newQuery(), which returns a
    subscribable stream of results, and sendMutation(), which sends mutations back to PhaseLockDB.
    If predictors were provided, the Engine also provides optimistic updates.

    With predictors and a persistent Store implementation, the Engine is the basis for a fully
    offline-capable application.

    Engine internals diagram:

        (* = owned by user)
         ______________________________________________________
        |  App                                                 |
        |    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
        |   | Engine                                        |  |
        |       ________________________________________       |
        |   |  |                                        |   |  |
        |      |              store + overlay           |      |
        |   |  |________________________________________|   |  |
        |         ^ B    ^              ^         |            |
        |   |     |      |              | G       | C       |  |
        |         |    __|__________    |   ______v______      |
        |   |     |   |             |   |  |             |  |  |
        |         |   | *predictors |   |  | query graph |     |
        |   |     |   |_____________|   |  |_____________|  |  |
        |         |               ^     |    _ _ _|_ _ _ _ _   |
        |   |     |               | F   |   |     | D          |
        |       __|__________     |     |       __v___         |
        |   |  |             | H  |     |   |  |      |        |
        |      |  transport  |<---+-----+------| *UI  |        |
        |   |  |_____________|            E |  |______|        |
        |           ^                                          |
        |   |_ _ _ _|_ _ _ _ _ _ _ _ _ _ _ _|                  |
        |___________|__________________________________________|
                    |
                    | A
               _____v_______
              |             |
              | PhaseLockDB |
              |_____________|

        A: Transport talks to PhaseLockDB, reading edits and writing mutations.

        B: Edits received by transport are applied to the store.

        C: Query graph wakes on store update and reruns queries whose dependencies have changed.

        D: Fresh query results are delivered to the UI.

        E: UI submits new mutations with Engine.sendMutation(), triggering F, G, and H:

        F: New mutations trigger predictor; predicted edits land in the storage overlay.

        G: New mutations are also stored in an outbox in the store.

        H: New mutations are also sent through the transport.

    Engine-owned store keys.  Slice state lives at `{slice}!{local key}`; everything the Engine
    keeps for itself lives in the nameless slice, which no slice name can reach, so its keys start
    with `!`.  Its local keys follow the template grammar, and the parked keys' terminal parameter
    is itself a slice or a selector, `!`, then the rest.  Each is stored as `.json` unless noted:

        !view                       ViewRecord: the latest view delivered, its token, its
                                    position, and the selectors granted
        !checkpoint                 CheckpointRecord: the epoch of the log the cursor is in, the
                                    cursor, set by a bootstrap's view frame and advanced with
                                    every batch, vouch, and live mark, and how far the base is
                                    applied
        !seq:{slice}                the held slice's last applied seq; deleted when the slice
                                    leaves the base
        !mutation:{ordinal}         Mutation<Uint8Array> (`.mutation`): the outbox, in send order,
                                    each mutation's data as its wire bytes, under the series and
                                    number it was minted with; ordinal zero-padded to 20 digits
                                    so a scan walks the outbox in order
        !backfill:{selector}        BackfillRecord: an in-flight backfill's until and resume
        !backfill-seqs:{selector}   the backfill blob's header seqs, slice name to seq
        !park-edit:{slice}!{seq}    an edit waiting for the land (`.edits`), raw as delivered by
                                    the connection while frozen or by a tail; seq zero-padded to
                                    20 digits so a slice's range walks its chain
        !park-snap:{selector}!{offset}
                                    a page of the selector's backfill blob (`.page`), raw: a run
                                    of its whole set operations, offset the byte it starts at in
                                    the blob, zero-padded to 20 digits so the pages walk in blob
                                    order; applied in place when the backfill lands, and deleted
                                    with the backfill
        !status:{part}              the Engine's status that queries read, its connection,
                                    progress, or outbox; no store holds it, since the Engine
                                    answers it from memory
*/
export class Engine<QX, PX, M, N = never> {
  #store: Store;
  #reg: Registry;
  #transport: Transport;
  // who the Engine syncs as, handed to every connection; null for anonymous
  #session: Session | null;
  // runs against the overlay for every outbox mutation in order on every rebuild
  #predictor: null | Predictor<PX, M>;
  // the selectors of the Engine's slice types, one each
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

  // the live connection: one connection per attempt, its lifetime (replaced as soon as it is
  // spent), and the backoff between attempts
  #connection: Connection | null = null;
  #connectionAbort: SignalController;
  #attempt: number = 0;
  #retryTimer: unknown = null;
  #nextAttemptAt: number | null = null;
  #connectNow: boolean = false;
  // an attempt is in flight that was asked for, the first or reconnectNow's, rather than a retry
  #asked: boolean = false;

  // the connection's checkpoint as it started, the server's head as last known, and whether a
  // frame after the open has confirmed the selector list
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
  // the last applied seq per held slice
  #slices: Map<string, number> = new Map();
  #backfills: Map<string, BackfillEntry> = new Map();
  // the outbox in send order: mutation id to its ordinal in !mutation:{ordinal}
  #outbox: Map<string, number> = new Map();
  #nextOrdinal: number = 0;
  // the series new mutations are numbered in, and the number the next one takes.  Neither touches
  // the disk: a stored outbox resends under the series it was numbered in, and new mutations go in
  // a series of this Engine's own, so two Engines over one copied store never share one.
  readonly #series: string;
  #nextN: number = 1;
  // outbox mutations handed to the current connection with no outcome yet, and those acked, with
  // the position they landed at, waiting for the checkpoint to reach it
  #sent: Set<string> = new Set();
  #acked: Map<string, number> = new Map();
  // @online mutations handed to a connection and not yet settled, by id
  #online: Map<string, OnlineMutation> = new Map();
  // set by a release inside a transaction, read by the refresh after its commit
  #outboxChanged: boolean = false;
  // how far the base has been applied, -1 for never: the cursor, except while frozen, when it stays
  // where the freeze began.  Persisted in the checkpoint record.  An acked mutation at or below it
  // is in the base, edits or none
  #applied: number = -1;

  // the connection has delivered `live`
  #live: boolean = false;
  // the log this connection's positions belong to, from its first hook; null between connections
  #epoch: string | null = null;

  // work received from the connection, in arrival order
  #inbox: Inbound[] = [];
  // backfill progress from the connection's hooks; each item resolves its promise after commit
  #backfillWork: BackfillWork[] = [];
  // how each backfill() call ended, and on which connection
  #backfillOutcomes: {
    selector: string;
    entry: BackfillEntry;
    outcome: BackfillOutcome | { failed: unknown };
    conn: SignalController;
  }[] = [];
  // how each sendMutations() call ended, with the ids it carried in order
  #mutationOutcomes: { ids: string[]; results: MutationResult[] | { failed: unknown } }[] = [];
  // work received from the app
  #submitted: Submission<M, N>[] = [];
  #newQueries: boolean = false;
  // every new connection resends the outbox
  #resend: boolean = false;
  // the predict context, handed to every predictor, and the box it reads its write transaction
  // through
  #predictions: { ctx: PX; $ref: { txn: WriteTxn } };

  constructor(
    // the context a query reads, the engine's slices and the Engine's status, and the context a
    // predictor reads and writes, the slices alone, each with the box its accessors read the
    // transaction through, which the Engine points at each store transaction it runs them over
    queries: { ctx: QX; $ref: { txn: ReadTxn } },
    predictions: { ctx: PX; $ref: { txn: WriteTxn } },
    // injected by generated subclass: the engine's registry data, which the transport builds the
    // Registry from
    schema: Schema,
    transport: Transport,
    options: {
      // who the Engine syncs as, or null for anonymous
      session: Session | null;
      // injected by generated subclass: the selectors of the engine's slice types, one each
      wants: string[];
      // optional: makes the Engine's store from its Registry; without it, an InMemStore
      store?: StoreFactory;
      // optional: predict what the database will do with a mutation, over the state the earlier
      // outbox mutations leave
      predictor?: Predictor<PX, M>;
      // optional: ends the Engine, its connection, and every backfill
      signal?: Signal;
      // optional: receives the error that ended the Engine; without it the error is thrown out
      // of the timer callback that ran the advancer
      onError?: (e: unknown) => void;
    },
  ) {
    checkHost();
    this.#series = generateSeries();
    this.#predictions = predictions;
    const reg = registryFor(transport, schema);
    this.#store = options.store === undefined ? new InMemStore(reg) : options.store(reg);
    this.#reg = reg;
    this.#transport = transport;
    this.#session = options.session;
    this.#wants = options.wants;
    this.#predictor = options.predictor ?? null;
    this.#signal = options.signal ?? new host.AbortController().signal;
    this.#connectionAbort = new host.AbortController();
    this.#onError =
      options.onError ??
      ((e) => {
        throw e;
      });
    this.#signal.addEventListener('abort', () => this.#schedule(), { once: true });

    this.#overlay = new Overlay(reg);
    this.#graph = new QueryGraph((txn) => {
      queries.$ref.txn = txn;
      return queries.ctx;
    });

    // let the advancer begin initializing
    this.#run();
  }

  //// public api ////

  /** After predicting and saving to the outbox, the mutation is sent through the connection, in
      order with every mutation sent before it.  It is given in rich format (Date, Maps, and Sets
      intact). */
  sendMutation(mutation: M): void {
    this.#submitted.push({ outbox: mutation });
    this.#schedule();
  }

  /** Sends an @online mutation behind every mutation sent before it, in the Engine's series, and
      settles with the database's answer.  A reject or a conflict settles at once.  An ok settles
      on the round trip, once the queries have run over the base the position it names reached;
      it means the mutation was decided, so a resend of a rejected one settles ok too, and the app
      reads the outcome from state.  It rejects when there is no connection to send it on, when
      its call fails, and when the Engine ends.  It is never persisted or predicted, and the
      connection's retry of its call is the only resend. */
  sendOnlineMutation(mutation: N): Promise<MutationResult> {
    return new Promise((resolve, reject) => {
      if (this.#ended || this.#signal.aborted) {
        reject(new Error('engine ended'));
        return;
      }
      this.#submitted.push({ online: mutation, resolve, reject });
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

  // the base is frozen while any backfill is in flight
  get #frozen(): boolean {
    return this.#backfills.size > 0;
  }

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

      // the slices table: seq per held slice
      const json = { type: '.json', rep: JS } as const;
      const seqRows = scanAll(txn, { pattern: engineKeys('seq'), limit: 1000, values: json });
      for (const [key, value] of seqRows) {
        this.#slices.set(key.slice('!seq:'.length), value as number);
      }

      // the outbox in ordinal order; the next ordinal continues from the last key
      const mutationRows = scanAll(txn, {
        pattern: engineKeys('mutation'),
        limit: 1000,
        values: { type: '.mutation', rep: JS },
      });
      for (const [key, value] of mutationRows) {
        const ordinal = Number(key.slice('!mutation:'.length));
        this.#outbox.set((value as Mutation<Uint8Array>).id, ordinal);
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
        this.#backfills.set(key.slice('!backfill:'.length), newBackfillEntry(record));
      }
    });

    // a backfill whose download finished before the crash is ready to land
    for (const entry of this.#backfills.values()) {
      const r = entry.record;
      if (r.resume?.snapshotDone && r.resume.tailDone) entry.status = 'ready';
    }
    this.#applied = this.#checkpoint?.applied ?? -1;

    // purge what this build does not want.  The wants are the selectors of this build's slice
    // types, and the server cuts the view down to them, so a slice, a backfill, or a view selector
    // outside the wants is an earlier build's.  Every one goes now, so the view frame that answers
    // our token finds the base as this build would have made it.
    const wanted = (x: string) => this.#wants.some((w) => selectorCovers(w, x));
    const wasFrozen = this.#frozen;
    const dirty: Record<string, true> = {};
    this.#store.write((txn) => {
      // every backfill outside the wants
      for (const selector of [...this.#backfills.keys()]) {
        if (!wanted(selector)) this.#dropBackfillIn(txn, selector);
      }

      // every slice outside the wants, and every parked edit of one, held or not
      for (const slice of [...this.#slices.keys()]) {
        if (!wanted(slice)) this.#dropSliceIn(txn, slice, dirty);
      }
      this.#dropParkedIn(txn, wanted);

      // every view selector outside the wants, so the next frame grants what it covered afresh
      if (this.#view !== null && !this.#view.selectors.every(wanted)) {
        this.#view = { ...this.#view, selectors: this.#view.selectors.filter(wanted) };
        txn.set('!view', '.json', JS, this.#view);
      }

      // whatever waits ready on disk lands now, and so does what waited for a backfill the purge
      // dropped
      if (wasFrozen) this.#tryLandIn(txn, dirty);
    });

    // the first connection attempt
    this.#connectNow = true;

    // publish the status, and predict every outbox mutation onto a fresh overlay
    this.#refresh({}, true);
  }

  /* Our main logic is a loop, run whenever work is scheduled until none is left.  Each pass takes
     one kind of work, does it in its own transactions, and starts over, so the order of the
     branches is the priority: what the user is waiting on first, the app's mutations and queries,
     then the live connection, then the outcomes of our own calls, then background work that
     batches well and can wait, and a new connection last.

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
        // the app ended us: end the connection and every backfill, and nothing runs after that
        this.#shutdown();
        this.#ended = true;
        return;
      }

      if (this.#submitted.length > 0 || this.#resend) {
        // the tightest loop we serve: write to the outbox, predict, and the UI sees the
        // optimistic update; then send through the connection in submission order
        this.#onSubmitted();
        continue;
      }

      if (this.#newQueries) {
        // a new page wants its first answer: run the graph, the app's new queries with it
        this.#refresh({});
        continue;
      }

      if (this.#inbox.length > 0) {
        // the connection's frames, in arrival order: edits apply or park, and a view, vouch,
        // live, or end is handled alone
        this.#onInbox();
        continue;
      }

      if (this.#mutationOutcomes.length > 0) {
        // ack, dup, reject, and conflict from sends: release the outbox and rebuild the overlay
        this.#onMutationOutcomes();
        continue;
      }

      if (this.#backfillOutcomes.length > 0) {
        // 'done', 'stale', or a rejection for a backfill: retries with resume, and downloads
        // that start over
        this.#onBackfillOutcomes();
        continue;
      }

      if (this.#backfillWork.length > 0) {
        // header, pages, edits, and done marks from in-flight backfills, parked in one
        // transaction that also lands whatever they completed, each resolving the connection's
        // promise after commit.  Background work: it orders against nothing above, and the
        // connection waits on it while the app is busy.
        this.#onBackfillWork();
        continue;
      }

      if (this.#connection === null && (this.#connectNow || this.#retryTimer === null)) {
        // one attempt: a new connection from the transport, or the next one after backoff
        this.#onConnect();
        continue;
      }

      // nothing to do: publish the status this run left, then wait for a hook, a timer, or the app
      this.#refresh({});
      return;
    }
  }

  /* The app's submissions, sent in submission order.  A new connection first resends every outbox
     mutation it has not been handed, in ordinal order, each under the series and number it was
     minted with.  Then each submission in turn takes the next number of the Engine's series: an
     outbox mutation goes into the outbox and joins the current call, and an @online mutation goes
     in a call of its own.  So numbers reach the database in the order they were minted, which is
     what lets it answer a number at or below one it decided as decided already.  The connection
     fails every call behind a failed one, which keeps that order.  Without a connection the outbox
     waits for the next connection, and every @online mutation rejects. */
  #onSubmitted(): void {
    const submitted = this.#submitted.splice(0);
    const connection = this.#connection;
    const resend = this.#resend && connection !== null;
    this.#resend = false;

    // the calls in order: runs of outbox mutations, and each @online mutation alone between them
    const calls: { wire: Mutation<Uint8Array>[]; online: OnlineMutation | null }[] = [
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
            const row = txn.get(mutationKey(ordinal), '.mutation', JS) as Mutation<Uint8Array>;
            calls[0].wire.push(row);
          }
        }

        // each submission, converted to wire bytes here by the vocabulary that made it
        for (const s of submitted) {
          if ('online' in s) {
            const data = this.#reg.convert(this.#reg.mutations, s.online, JS, MSGPACK);
            const online = { resolve: s.resolve, reject: s.reject, ack: null, seen: false };
            const mutation = {
              id: generateUuid(),
              series: this.#series,
              n: this.#nextN++,
              data: data as Uint8Array,
            };
            calls.push({ wire: [mutation], online }, { wire: [], online: null });
            continue;
          }

          // an outbox mutation takes the next ordinal
          const mutation: Mutation<Uint8Array> = {
            id: generateUuid(),
            series: this.#series,
            n: this.#nextN++,
            data: this.#reg.convert(this.#reg.mutations, s.outbox, JS, MSGPACK) as Uint8Array,
          };
          const ordinal = this.#nextOrdinal++;
          txn.set(mutationKey(ordinal), '.mutation', JS, mutation);
          this.#outbox.set(mutation.id, ordinal);
          calls[calls.length - 1].wire.push(mutation);
          fresh = true;
        }
      });
    } catch (e: unknown) {
      // the pass ends the Engine, and the @online mutations taken from the queue reject with it
      for (const s of submitted) if ('online' in s) s.reject(e);
      throw e;
    }
    if (fresh) this.#outboxChanged = true;
    this.#refresh({});

    // no connection, so every @online mutation rejects at once
    if (connection === null) {
      const e = new Error('no connection');
      for (const { online } of calls) online?.reject(e);
      return;
    }

    // each call on this connection; the results come back through the outcomes
    for (const { wire, online } of calls) {
      if (wire.length === 0) continue;
      const ids = wire.map((m) => m.id);
      if (online !== null) {
        this.#online.set(ids[0], online);
      } else {
        for (const id of ids) this.#sent.add(id);
      }
      connection.sendMutations(wire).then(
        (results) => {
          this.#mutationOutcomes.push({ ids, results });
          this.#schedule();
        },
        (e: unknown) => {
          this.#mutationOutcomes.push({ ids, results: { failed: e } });
          this.#schedule();
        },
      );
    }
  }

  // a new connection restarts every backfill that is still downloading and is not waiting on its
  // own backoff timer, and resends the outbox
  #onConnect(): void {
    this.#asked = this.#connectNow;
    this.#connectNow = false;
    this.#nextAttemptAt = null;
    if (this.#retryTimer !== null) {
      host.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // hooks queue for the advancer; a hook from a connection we have since replaced is dropped
    const abort = this.#connectionAbort;
    const push = (item: Inbound) => {
      if (this.#connectionAbort !== abort) return;
      this.#inbox.push(item);
      this.#schedule();
    };
    this.#since = this.#checkpoint?.position ?? -1;
    this.#confirmed = false;
    this.#connection = this.#transport.connect(
      this.#since,
      this.#view?.token ?? null,
      this.#wants,
      abort.signal,
      {
        onOpen: (epoch, head) => push({ open: { epoch, head } }),
        onView: (token, position, selectors) => push({ view: { token, position, selectors } }),
        onEdits: (edits) => push({ edits }),
        onLive: (position) => push({ live: position }),
        onVouch: (position) => push({ vouch: position }),
        onEnd: (code, reason, fatal) => push({ end: { code, reason, fatal } }),
      },
      this.#session,
    );

    // restart the downloads; one in backoff starts when its timer fires
    for (const [selector, entry] of this.#backfills) {
      if (entry.status === 'downloading' && entry.retryTimer === null) {
        this.#startBackfill(selector);
      }
    }
    this.#resend = true;
  }

  /* every queued push in one transaction, and the land of whatever they completed; each connection
     promise resolves after the commit, which is the backpressure */
  #onBackfillWork(): void {
    const pushes: BackfillWork[] = [];
    const dirty: Record<string, true> = {};

    // a push for a backfill that was dropped while it was queued fails on its own, even when a
    // regrant has since made a new backfill of the same selector
    while (this.#backfillWork.length > 0) {
      const work = this.#backfillWork.shift()!;
      if (this.#backfills.get(work.selector) === work.entry) {
        pushes.push(work);
      } else {
        work.reject(new Error(`backfill ${work.selector} is no longer in flight`));
      }
    }
    if (pushes.length === 0) return;

    // park every push, land what completed, and settle every promise the way the transaction went
    try {
      this.#store.write((txn) => {
        for (const { selector, item } of pushes) this.#parkPushIn(txn, selector, item);
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
  #parkPushIn(txn: WTxn, selector: string, item: BackfillItem): void {
    const entry = this.#backfills.get(selector)!;
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
        visible: item.header.visible,
        skipBytes: 0,
        checksum: '',
        fromPosition,
        snapshotDone: false,
        tailDone: false,
      };
      txn.set(`!backfill-seqs:${selector}`, '.json', JS, seqs);
    } else if ('page' in item) {
      // park the page raw, keyed by the offset it starts at
      txn.set(parkedPageKey(selector, record.resume!.skipBytes), '.page', MSGPACK, item.page);
      record.resume!.skipBytes = item.skip;
      record.resume!.checksum = item.checksum;
    } else if ('pagesDone' in item) {
      record.resume!.snapshotDone = true;
    } else if ('edits' in item) {
      // park each edit by slice and seq
      for (const e of item.edits) {
        txn.set(parkedEditKey(e.slice, e.seq), '.edits', MSGPACK, e.raw);
        record.resume!.fromPosition = Math.max(record.resume!.fromPosition, e.position);
      }
      entry.scanned = Math.max(entry.scanned, item.scanned);
    } else if ('editsDone' in item) {
      record.resume!.tailDone = true;
    } else {
      throw new Error('unexpected backfill item');
    }

    if (record.resume!.snapshotDone && record.resume!.tailDone) entry.status = 'ready';
    txn.set(`!backfill:${selector}`, '.json', JS, record);
  }

  /* every queued outcome in one transaction.  Completion is known from the pushes themselves, so
     a done outcome only clears the attempt count; stale and failure decide what downloads again. */
  #onBackfillOutcomes(): void {
    this.#store.write((txn) => {
      while (this.#backfillOutcomes.length > 0) {
        const { selector, entry, outcome, conn } = this.#backfillOutcomes.shift()!;

        // an outcome from a connection that has ended means nothing; the next connection
        // restarts the download
        if (conn !== this.#connectionAbort) continue;

        // was the backfill dropped while its outcome was queued, and perhaps granted anew?
        if (this.#backfills.get(selector) !== entry) continue;

        if (outcome === 'done') {
          entry.attempts = 0;
        } else if (outcome === 'stale') {
          /* The blob is gone: the parked pages go, the parked edits stay, and the download
             starts over under the same until.  Both halves start over, the tail from the new
             snapshot's position or from where the parked tail reached, whichever is later. */
          entry.attempts = 0;
          txn.delPrefix(`!park-snap:${selector}!`);
          const r = entry.record.resume;
          if (r !== null) {
            entry.record.resume = {
              ...r,
              skipBytes: 0,
              checksum: '',
              snapshotDone: false,
              tailDone: false,
            };
          }
          txn.set(`!backfill:${selector}`, '.json', JS, entry.record);
          this.#startBackfill(selector);
        } else {
          // a rejection: ours, if the entry's signal fired, else a failure to retry after backoff;
          // one after both halves were in leaves the backfill ready to land
          if (entry.controller.signal.aborted || entry.status === 'ready') continue;
          const delay = backoffDelay(entry.attempts++);
          entry.retryAt = Date.now() + delay;
          entry.retryTimer = host.setTimeout(() => {
            entry.retryTimer = null;
            entry.retryAt = null;
            // the entry may have gone, or the Engine, while the timer ran
            if (this.#backfills.get(selector) === entry && !this.#signal.aborted) {
              this.#startBackfill(selector);
              this.#schedule();
            }
          }, delay);
        }
      }
    });
  }

  // one backfill() call on the current connection; its pushes and its outcome come back through
  // the advancer's queues.  Without a connection nothing starts, and the next connection restarts
  // every backfill that is still downloading.
  #startBackfill(selector: string): void {
    const entry = this.#backfills.get(selector)!;
    if (this.#connection === null) return;
    const conn = this.#connectionAbort;
    entry.status = 'downloading';

    // the backfill's cancellation is its own or the connection's
    const backfill: Backfill = {
      selector,
      until: entry.record.until,
      resume: entry.record.resume === null ? null : { ...entry.record.resume },
      signal: host.AbortSignal.any([conn.signal, entry.controller.signal]),
      push: (item) =>
        new Promise<void>((resolve, reject) => {
          this.#backfillWork.push({ selector, entry, item, resolve, reject });
          this.#schedule();
        }),
    };

    // the outcome is tagged with its backfill and its connection, so a late one from a dropped
    // backfill or an ended connection is known
    this.#connection.backfill(backfill).then(
      (outcome) => {
        this.#backfillOutcomes.push({ selector, entry, outcome, conn });
        this.#schedule();
      },
      (e: unknown) => {
        this.#backfillOutcomes.push({ selector, entry, outcome: { failed: e }, conn });
        this.#schedule();
      },
    );
  }

  /* Land once nothing waits: every backfill downloaded, and the cursor at or past each one's
     visible, the last position where any slice under its selector changed.  No blob's slices have
     changed since the cursor, so each blob is as the slices were there, and the slices they bring
     and the slices the connection kept delivering reach the cursor together. */
  #tryLandIn(txn: WTxn, dirty: Record<string, true>): void {
    const cursor = this.#checkpoint?.position ?? -1;
    for (const entry of this.#backfills.values()) {
      if (entry.status !== 'ready' || entry.record.resume!.visible > cursor) return;
    }
    this.#landIn(txn, dirty);
  }

  /* The land, in one transaction: every backfill's blob, then every parked edit, then the view's
     drops, and the base is applied through the cursor.  Per slice, the covering blob with the
     newest cut wins, and one that does not name the slice found it deleted or unborn there; a
     slice held at or past the winning blob's seq keeps its own state.  A slice's parked run
     applies onto its base: edits at or below the winning cut skip, and the rest chain, the next
     seq or a reset above the last.  A run that does not chain, a gap or a
     missed birth, lands nothing: its slice backfills by its exact selector, and the land waits. */
  #landIn(txn: WTxn, dirty: Record<string, true>): void {
    const cursor = this.#checkpoint?.position ?? -1;
    const selectors = this.#view?.selectors ?? [];
    const inView = (slice: string) => selectors.some((r) => selectorCovers(r, slice));

    // each blob's cut and header, and the blob that wins a slice
    const blobs = [...this.#backfills].map(([selector, entry]) => ({
      selector,
      cut: entry.record.resume!.position,
      header: this.#headerOf(txn, selector),
    }));
    const winner = (slice: string) => {
      let best: (typeof blobs)[number] | null = null;
      for (const b of blobs) {
        if (selectorCovers(b.selector, slice) && (best === null || b.cut > best.cut)) best = b;
      }
      return best;
    };

    // every parked edit's envelope, by slice in seq order
    const parked = new Map<string, EditEnvelope[]>();
    const rows = scanAll(txn, {
      pattern: engineKeys('park-edit'),
      limit: 1000,
      values: { type: '.edits', rep: JS },
    });
    for (const [, value] of rows) {
      const env = value as EditEnvelope;
      if (!parked.has(env.slice)) parked.set(env.slice, []);
      parked.get(env.slice)!.push(env);
    }

    // a tail edit past the cursor, which a blob cut below the view's position brings, waits for
    // the connection to reach it, so the land stays at one position
    for (const run of parked.values()) {
      if (run.some((env) => env.position > cursor)) return;
    }

    // every slice the land touches: the blobs' slices, the held slices they cover, and every slice
    // with parked edits
    const touched = new Set<string>(parked.keys());
    for (const b of blobs) for (const slice of Object.keys(b.header)) touched.add(slice);
    for (const slice of this.#slices.keys()) if (winner(slice) !== null) touched.add(slice);

    // plan each slice in the view: its base, and the run that applies onto it
    type Plan = { blob: boolean; seq: number | null; run: EditEnvelope[] };
    const plans = new Map<string, Plan>();
    const broken: string[] = [];
    for (const slice of touched) {
      if (!inView(slice)) continue;

      // the base: the winning blob's state, or the held state, which a slice held at or past the
      // blob's seq keeps
      const w = winner(slice);
      const held = this.#slices.get(slice) ?? null;
      const named = w === null ? null : (w.header[slice] ?? null);
      const blob = w !== null && !(named !== null && held !== null && held >= named);
      const cut = blob ? w!.cut : -1;
      let last: number | null = blob ? named : held;
      const seq = last;

      // the run: from its last reset, or the first edit past the base, and broken by a gap that no
      // later reset mends
      let run: EditEnvelope[] = [];
      let gap = false;
      for (const env of parked.get(slice) ?? []) {
        if (env.position <= cut || (last !== null && env.seq <= last)) continue;
        if (env.lifecycle !== 'normal') {
          run = [env];
          gap = false;
        } else if (gap || last === null || env.seq !== last + 1) {
          run = [];
          gap = true;
        } else {
          run.push(env);
        }
        last = env.seq;
      }
      if (gap) broken.push(slice);
      plans.set(slice, { blob, seq, run });
    }

    // a broken slice downloads afresh, past its break, and the land waits for it
    if (broken.length > 0) {
      for (const slice of broken) {
        if (this.#backfills.has(slice)) {
          this.#restartIn(txn, slice);
        } else {
          this.#spawnIn(txn, slice, cursor + 1);
        }
      }
      return;
    }

    // every slice a blob wins starts from that blob alone
    for (const [slice, plan] of plans) {
      if (plan.blob) markDirty(dirty, txn.delPrefix(`${slice}!`));
    }
    for (const b of blobs) {
      const skip = Object.keys(b.header).filter(
        (slice) => winner(slice) !== b || plans.get(slice)?.blob !== true,
      );
      markDirty(dirty, txn.applySnapshot(b.selector, skip));
    }

    // then its run, and the slice is held at the run's last seq, or forgotten when it ends dead
    for (const [slice, plan] of plans) {
      const end = plan.run[plan.run.length - 1];
      if (end !== undefined) {
        markDirty(dirty, txn.applyParked(slice, plan.run[0].seq));
        for (const env of plan.run) this.#roundTrip(txn, env.id);
      }
      const seq = end === undefined ? plan.seq : end.lifecycle === 'death' ? null : end.seq;
      if (seq === null) {
        this.#forgetIn(txn, slice);
      } else {
        this.#slices.set(slice, seq);
        txn.set(`!seq:${slice}`, '.json', JS, seq);
      }
      this.#resolve(slice);
    }

    // the view's drops, then nothing parked or in flight is left, and the base reaches the cursor
    for (const slice of [...this.#slices.keys()]) {
      if (!inView(slice)) this.#dropSliceIn(txn, slice, dirty);
    }
    txn.delPrefix('!park-edit:');
    for (const selector of [...this.#backfills.keys()]) this.#dropBackfillIn(txn, selector);
    this.#appliedTo(txn, cursor);
  }

  // a blob's header: the seq of every slice in it at the cut
  #headerOf(txn: RTxn, selector: string): Record<string, number> {
    return (txn.get(`!backfill-seqs:${selector}`, '.json', JS) ?? {}) as Record<string, number>;
  }

  // a dead slice leaves the slices table, so a birth chains on it from empty and any other edit
  // is a missed birth
  #forgetIn(txn: WTxn, slice: string): void {
    this.#slices.delete(slice);
    txn.del(`!seq:${slice}`);
  }

  /* An edit entering the base, live or parked: one carrying the id of an outbox or @online
     mutation is that mutation's round trip, whichever path delivered it. */
  #roundTrip(txn: WTxn, id: string): void {
    if (this.#outbox.has(id)) this.#releaseIn(txn, [id]);
    const online = this.#online.get(id);
    if (online !== undefined) online.seen = true;
  }

  // a backfill whose run broke downloads again from a fresh snapshot, whose cut is past the break
  #restartIn(txn: WTxn, selector: string): void {
    const entry = this.#backfills.get(selector)!;
    txn.delPrefix(`!park-snap:${selector}!`);
    entry.record.resume = null;
    entry.status = 'downloading';
    entry.attempts = 0;
    txn.set(`!backfill:${selector}`, '.json', JS, entry.record);
    this.#startBackfill(selector);
  }

  // a new backfill, downloading at once into its own parked range; the base is frozen from here
  // until it lands
  #spawnIn(txn: WTxn, selector: string, until: number): void {
    const record: BackfillRecord = { until, resume: null };
    txn.set(`!backfill:${selector}`, '.json', JS, record);
    this.#backfills.set(selector, newBackfillEntry(record));
    this.#startBackfill(selector);
  }

  // an in-flight backfill ends: its download is aborted, and its parked pages and records go
  #dropBackfillIn(txn: WTxn, selector: string): void {
    const entry = this.#backfills.get(selector)!;
    entry.controller.abort();
    if (entry.retryTimer !== null) host.clearTimeout(entry.retryTimer);
    txn.delPrefix(`!park-snap:${selector}!`);
    txn.del(`!backfill:${selector}`);
    txn.del(`!backfill-seqs:${selector}`);
    this.#backfills.delete(selector);
  }

  // the parked edits of every slice outside keep go, found by a key-only walk of every parked edit
  #dropParkedIn(txn: WTxn, keep: (slice: string) => boolean): void {
    const gone = new Set<string>();
    const range = { pattern: engineKeys('park-edit'), limit: 1000, values: false } as const;
    for (const [key] of scanAll(txn, range)) {
      const { slice } = parsePark(key);
      if (!keep(slice)) gone.add(slice);
    }
    for (const slice of gone) txn.delPrefix(`!park-edit:${slice}!`);
  }

  // a slice leaves the Engine: its state, its seq, and its parked edits
  #dropSliceIn(txn: WTxn, slice: string, dirty: Record<string, true>): void {
    markDirty(dirty, txn.delPrefix(`${slice}!`));
    txn.del(`!seq:${slice}`);
    txn.delPrefix(`!park-edit:${slice}!`);
    this.#slices.delete(slice);
  }

  // every queued item, in arrival order, in one transaction; the connection's end is not a store
  // operation and is handled on its own
  #onInbox(): void {
    if ('end' in this.#inbox[0]) {
      const { end } = this.#inbox.shift() as { end: { fatal: unknown } };

      // an end no reconnect can mend, such as a refused session, ends the Engine with its error
      if (end.fatal !== undefined) throw end.fatal;
      this.#onEnd();
      return;
    }

    const dirty: Record<string, true> = {};
    let wentLive = false;
    this.#store.write((txn) => {
      while (this.#inbox.length > 0 && !('end' in this.#inbox[0])) {
        const item = this.#inbox.shift()!;

        // any frame after the open confirms the selector list: a view replaces it, and any other
        // frame means the token presented was current
        if (!('open' in item)) this.#confirmed = true;

        if ('edits' in item) {
          this.#onEditsIn(txn, item.edits, dirty);
        } else if ('open' in item) {
          // a different epoch is a replaced log, where the positions we hold mean nothing.
          // Dropping everything and backfilling every selector is the answer, and until that exists
          // this ends.
          const { epoch, head } = item.open;
          if (this.#checkpoint !== null && this.#checkpoint.epoch !== epoch) {
            throw new Error(`epoch ${epoch}, checkpoint from ${this.#checkpoint.epoch}`);
          }
          this.#epoch = epoch;
          this.#head = head;
        } else if ('view' in item) {
          this.#onViewIn(txn, item.view, dirty);
        } else if ('vouch' in item) {
          this.#onCursorIn(txn, item.vouch);
        } else if ('live' in item) {
          this.#onCursorIn(txn, item.live);
          wentLive = true;
        }
      }

      // the cursor may have reached the cut a frozen base waits for
      if (this.#frozen) this.#tryLandIn(txn, dirty);
    });

    // history is done: the backoff starts over, and the replay has proven every held slice
    if (wentLive) {
      this.#live = true;
      this.#attempt = 0;
      for (const slice of this.#slices.keys()) this.#resolve(slice);
    }
    this.#refresh(dirty);
  }

  /* One frame's edits, which apply whole or not at all.  While frozen they park.  Otherwise each
     must chain on its slice, the next seq or a reset above the last.  A gap on a held slice, or a
     normal edit of a slice the Engine does not hold, whose birth it missed, backfills that slice
     by its exact selector, and the frame parks with the base frozen behind it. */
  #onEditsIn(txn: WTxn, edits: WireEdit[], dirty: Record<string, true>): void {
    const last = edits[edits.length - 1].position;

    // does every edit chain?  The edits to apply, each slice's seq as the frame leaves it, null
    // for one that dies, and the edits that break
    const apply: WireEdit[] = [];
    const seqs = new Map<string, number | null>();
    const breaks: WireEdit[] = [];
    if (!this.#frozen) {
      for (const e of edits) {
        const held = seqs.has(e.slice) ? seqs.get(e.slice)! : (this.#slices.get(e.slice) ?? null);
        if (held !== null && e.seq <= held) continue;
        if (e.lifecycle === 'normal' && (held === null || e.seq !== held + 1)) {
          breaks.push(e);
          continue;
        }
        apply.push(e);
        seqs.set(e.slice, e.lifecycle === 'death' ? null : e.seq);
      }
    }

    // a frame that does not apply whole parks, and each slice it breaks backfills
    if (this.#frozen || breaks.length > 0) {
      for (const e of breaks) {
        if (!this.#backfills.has(e.slice)) this.#spawnIn(txn, e.slice, e.position);
      }
      for (const e of edits) txn.set(parkedEditKey(e.slice, e.seq), '.edits', MSGPACK, e.raw);
      this.#advanceCursorIn(txn, last);
      return;
    }

    // apply the frame, each edit its mutation's round trip, and hold each slice at its new seq
    for (const e of apply) {
      this.#roundTrip(txn, e.id);
      this.#resolve(e.slice);
    }
    if (apply.length > 0) markDirty(dirty, txn.applyEdits(apply));
    for (const [slice, seq] of seqs) {
      if (seq === null) {
        this.#forgetIn(txn, slice);
      } else {
        this.#slices.set(slice, seq);
        txn.set(`!seq:${slice}`, '.json', JS, seq);
      }
    }
    this.#appliedTo(txn, last);
    this.#advanceCursorIn(txn, last);
  }

  /* After a commit, the status is published and the graph learns what changed.  A base change or
     an outbox change rebuilds the overlay, so every prediction stands on the base it is shown
     over.  A changed status or a new query alone runs the graph over
     the overlay as it is.  Then each @online mutation whose round trip the queries now show
     settles. */
  #refresh(dirty: Record<string, true>, always = false): void {
    // the status first, so every query this pass runs sees the status that goes with its state
    const status = this.#publish();
    this.#graph.dirty(dirty);
    this.#graph.dirty(status);

    // rebuild the overlay, or run the graph over it as it is
    const outbox = this.#outboxChanged;
    this.#outboxChanged = false;
    const changed = Object.keys(dirty).length > 0;
    if (always || outbox || changed) {
      this.#rebuildOverlay();
    } else if (Object.keys(status).length > 0 || this.#newQueries) {
      this.#runGraph();
    }
    this.#settleOnline();
  }

  /* An acked @online mutation has made its round trip once an edit carrying its id is applied, or
     the base is applied through its ack's position.  Queries show the base only when it exists
     and is not frozen, so it settles then. */
  #settleOnline(): void {
    if (this.#applied < 0 || this.#frozen) return;
    for (const [id, online] of this.#online) {
      if (online.ack === null) continue;
      if (!online.seen && online.ack.position > this.#applied) continue;
      this.#online.delete(id);
      online.resolve(online.ack);
    }
  }

  // every @online mutation, queued or in flight, rejects with the reason the Engine ended
  #rejectOnline(reason: unknown): void {
    for (const s of this.#submitted) if ('online' in s) s.reject(reason);
    for (const online of this.#online.values()) online.reject(reason);
    this.#online.clear();
  }

  // the checkpoint moves forward, never back, under the connection's epoch
  #advanceCursorIn(txn: WTxn, position: number): void {
    if (this.#epoch === null) throw new Error('cursor with no epoch');
    if (this.#checkpoint !== null && position <= this.#checkpoint.position) return;
    this.#checkpoint = { epoch: this.#epoch, position, applied: this.#applied };
    txn.set('!checkpoint', '.json', JS, this.#checkpoint);
  }

  // the base has been applied through position, so every acked mutation at or below it is in the
  // base, edits or none, and leaves the outbox
  #appliedTo(txn: WTxn, position: number): void {
    if (position <= this.#applied) return;
    this.#applied = position;
    if (this.#checkpoint !== null) {
      this.#checkpoint = { ...this.#checkpoint, applied: position };
      txn.set('!checkpoint', '.json', JS, this.#checkpoint);
    }
    const done = [...this.#acked].filter(([, p]) => p <= this.#applied).map(([id]) => id);
    this.#releaseIn(txn, done);
  }

  // mutations leave the outbox
  #releaseIn(txn: WTxn, ids: string[]): void {
    for (const id of ids) {
      const ordinal = this.#outbox.get(id);
      if (ordinal === undefined) continue;
      txn.del(mutationKey(ordinal));
      this.#outbox.delete(id);
      this.#sent.delete(id);
      this.#acked.delete(id);
      this.#outboxChanged = true;
    }
  }

  // a vouch, or the live mark: unless frozen, nothing below it was withheld, so the base is
  // applied through it
  #onCursorIn(txn: WTxn, position: number): void {
    if (!this.#frozen) this.#appliedTo(txn, position);
    this.#advanceCursorIn(txn, position);
  }

  // every queued sendMutations result, and one release for all of them
  #onMutationOutcomes(): void {
    const drop: string[] = [];
    while (this.#mutationOutcomes.length > 0) {
      const { ids, results } = this.#mutationOutcomes.shift()!;

      /* A failed call rejects its @online mutation, which is never resent.  Its outbox mutations
         wait for the connection's end, which a failed call brings, and the next connection
         resends them. */
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

        // an @online mutation: a reject or a conflict settles it now, and an ok waits for the
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

        // a mutation already released, by its round trip or by an earlier answer to a resend
        if (!this.#outbox.has(id)) return;

        if (r.kind === 'ok') {
          // the mutation was decided by a position; it leaves once the base has applied through it
          this.#acked.set(id, r.position);
          if (r.position <= this.#applied) drop.push(id);
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

  /* A view frame, read as it arrives.  Every in-flight backfill the new set does not wholly cover
     is canceled, and every selector of the new set that nothing accounts for starts a backfill,
     its tail through the frame's position.  The view is written at once, so a reconnect presents
     its token.  Its drops wait while the base is frozen, for the land, which drops whatever the
     view of that moment does not cover; unfrozen, they happen now. */
  #onViewIn(txn: WTxn, view: ViewRecord, dirty: Record<string, true>): void {
    const covered = (selectors: string[], x: string) => selectors.some((r) => selectorCovers(r, x));
    const old = this.#view?.selectors ?? [];
    const atStart = [...this.#backfills.keys()];
    const wasFrozen = this.#frozen;

    // cancel every in-flight backfill the new set does not wholly cover
    for (const selector of atStart) {
      if (!covered(view.selectors, selector)) this.#dropBackfillIn(txn, selector);
    }

    // grant, broadest first so a covered selector finds its cover
    const selectors = [...view.selectors].sort(
      (a, b) => selectorPrefix(a).length - selectorPrefix(b).length,
    );
    for (const selector of selectors) {
      // does an in-flight backfill already cover it?
      if ([...this.#backfills.keys()].some((e) => selectorCovers(e, selector))) continue;

      // is it held: covered by the old set, and by no backfill at the start of the frame?
      const held = covered(old, selector) && !atStart.some((e) => selectorCovers(e, selector));
      if (held) continue;

      // otherwise it is new: backfill it, its tail through the frame's position
      this.#spawnIn(txn, selector, view.position + 1);
    }

    txn.set('!view', '.json', JS, view);
    this.#view = view;

    // if this is a bootstrap's view frame, with no cursor yet, its position is the cursor: the
    // backfills cover every position at or below it, and the connection every one above
    if (this.#checkpoint === null) this.#advanceCursorIn(txn, view.position);

    // frozen, the drops wait for the land; a cancel that ended the freeze lands what waited, the
    // drops with it; and unfrozen, they happen now
    if (this.#frozen) return;
    if (wasFrozen) {
      this.#landIn(txn, dirty);
      return;
    }
    for (const slice of [...this.#slices.keys()]) {
      if (!covered(view.selectors, slice)) this.#dropSliceIn(txn, slice, dirty);
    }
  }

  // the connection ended.  Every call in flight on it is dead: backfills wait for the next
  // connection to restart them, and mutations handed to it are unsent again for the next resend.
  #onEnd(): void {
    this.#connection = null;
    this.#asked = false;
    this.#connectionAbort.abort();
    this.#connectionAbort = new host.AbortController();
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

  // a fresh overlay over the base, every outbox mutation predicted onto it in order, and the graph
  // run on the result
  #rebuildOverlay(): void {
    const discarded: Record<string, true> = {};
    markDirty(discarded, this.#overlay.keys());
    this.#graph.dirty(discarded);
    this.#overlay = new Overlay(this.#reg);

    // one base read for the whole rebuild, so every prediction and every query sees one snapshot
    const cbs = this.#store.read((base) => {
      // predict each outbox mutation, each seeing what the ones before it left
      const predictor = this.#predictor;
      if (predictor !== null && this.#outbox.size > 0) {
        const rows = scanAll(base, {
          pattern: engineKeys('mutation'),
          limit: 1000,
          values: { type: '.mutation', rep: JS },
        });
        for (const [, value] of rows) {
          const mutation = value as Mutation<Uint8Array>;

          // a mutation this vocabulary cannot read is still sent; it just predicts nothing
          const data = this.#mutationData(mutation.data);
          if (data === undefined) continue;

          /* Each mutation predicts in its own scratch layer, so a throw cancels its writes alone.
             A throw from the predictor is its way of predicting nothing, and it can also throw on
             correct code, when real edits have moved the base underneath a prediction that no
             longer applies.  Either way the mutation is in flight and the server decides. */
          try {
            const written = this.#overlay.apply(base, (txn) =>
              this.#predictIn(txn, predictor, data),
            );
            const dirty: Record<string, true> = {};
            markDirty(dirty, written);
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
    return statusView(this.#overlay.view(base), this.#status, this.#applied < 0);
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
    // between attempts, opening (offline still, for a retry no one has asked for), replaying
    // history, or past it
    let state: ConnectionStatus['state'];
    if (this.#connection === null) {
      state = this.#connectNow ? 'connecting' : 'offline';
    } else if (this.#epoch === null) {
      state = this.#asked || this.#connectNow ? 'connecting' : 'offline';
    } else {
      // what queries show is current once the replay is done and no backfill is in flight
      state = this.#live && !this.#frozen ? 'live' : 'syncing';
    }

    const next = this.#nextAttemptAt;
    return {
      state,
      nextAttemptAt: state === 'offline' && next !== null ? new Date(next) : null,
      hasBase: this.#applied >= 0,
      frozen: this.#frozen,
    };
  }

  #progressStatus(): ProgressStatus {
    const backfills = [...this.#backfills].map(([selector, entry]) =>
      backfillStatus(selector, entry),
    );
    const log = {
      since: this.#since,
      head: this.#head,
      committed: this.#checkpoint?.position ?? -1,
      applied: this.#applied,
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
    for (const b of backfills) e.backfills.set(b.selector, b);
    const inFlight = new Set(backfills.map((b) => b.selector));
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
    if (e.kind === 'boot') return this.#applied >= 0;
    if (e.kind === 'resync') return this.#live && this.#backfills.size === 0;
    return this.#backfills.size === 0;
  }

  // an episode for the work in progress, or null when there is none
  #startEpisode(): Episode | null {
    // no base yet, a connection replaying onto one, or downloads onto a live one?
    let kind: Episode['kind'];
    if (this.#applied < 0) {
      kind = 'boot';
    } else if (this.#connection !== null && !this.#live) {
      kind = 'resync';
    } else if (this.#backfills.size > 0) {
      kind = 'backfill';
    } else {
      return null;
    }

    // a resync resolves the slices held as it starts
    const held = new Set<string>();
    if (kind === 'resync') {
      for (const slice of this.#slices.keys()) held.add(slice);
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
    const landed = e.kind === 'boot' ? this.#applied >= 0 : inFlight.size === 0;
    const all = [...e.backfills.values()];
    if (all.length === 0) return 0.9 + (landed ? 0.1 : 0);
    const going = (b: BackfillStatus) => inFlight.has(b.selector);

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
    // the backfills: the held slices resolved, and the download, whole until a backfill is in
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

  // a held slice of a resync is proven to need no backfill
  #resolve(slice: string): void {
    const e = this.#episode;
    if (e?.kind === 'resync' && e.held.has(slice)) e.resolved.add(slice);
  }

  // a mutation's wire bytes as the predictor sees them, or undefined when the current vocabulary
  // cannot read them, which is an outbox row written by an earlier build of the app
  #mutationData(bytes: Uint8Array): M | undefined {
    try {
      return this.#reg.convert(this.#reg.mutations, bytes, MSGPACK, JS) as M;
    } catch {
      return undefined;
    }
  }

  /* One mutation's prediction, written onto the overlay's scratch layer through a WriteTxn.
     Deleting a slice deletes its keys in the overlay. */
  #predictIn(txn: WTxn, predictor: Predictor<PX, M>, mutation: M): void {
    // the predictor's transaction: its reads are its own to change
    const wtx: WriteTxn = {
      get: (key, type) => txn.get(key, type, JS),
      scan(req) {
        const values: ScanRequest['values'] =
          req.type === false ? false : { type: req.type, rep: JS };
        return txn.scan({ ...req, values });
      },
      set(key, type, value) {
        txn.set(key, type, JS, value);
      },
      del(key) {
        txn.del(key);
      },
      deleteSlice(slice) {
        txn.delPrefix(`${slice}!`);
      },
    };

    // predict over the overlay; the transaction closes when the predictor returns
    this.#predictions.$ref.txn = wtx;
    try {
      predictor(this.#predictions.ctx, mutation, true);
    } finally {
      closedTxns.add(wtx);
    }
  }

  // ends everything the Engine drives; nothing is persisted, since the store is already consistent
  // at the last commit
  #shutdown(): void {
    if (this.#retryTimer !== null) {
      host.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // the connection, and with it every backfill call in flight
    this.#connectionAbort.abort();
    this.#connection = null;
    for (const entry of this.#backfills.values()) {
      if (entry.retryTimer !== null) host.clearTimeout(entry.retryTimer);
    }

    // the pushes waiting for a transaction they will never get
    const reason = new Error('engine shut down');
    for (const work of this.#backfillWork) work.reject(reason);
    this.#backfillWork = [];

    // the @online mutations, which can never settle now
    this.#rejectOnline(reason);
  }
}

/** Posts one mutation of a database outside any Engine, given in rich format (Date, Maps, and
    Sets intact), as the session or as anonymous, and answers with the database's outcome.  The
    mutation is numbered in a series of its own, so the transport may retry a failed request, and
    the database answers a resend of one that landed as decided.  A request that fails for good
    rejects, and the mutation may or may not have run.  Generated code calls it as
    post{Database}Mutation, with the database's registry data. */
export async function postWithSchema(
  schema: Schema,
  transport: Transport,
  mutation: unknown,
  options: { session?: Session | null },
): Promise<MutationResult> {
  checkHost();
  const reg = registryFor(transport, schema);
  const data = reg.convert(reg.mutations, mutation, JS, MSGPACK) as Uint8Array;
  const wire = { id: generateUuid(), series: generateSeries(), n: 1, data };
  const [result] = await transport.post([wire], options.session ?? null);
  return result;
}

// end of skeleton ////////////////////////////////////////////////////////////
