// utils //////////////////////////////////////////////////////////////////////

// the global's type, since the tooling has no Node types
declare const process: { env: Record<string, string | undefined> };

/** DEV is the switch every bundler and host honors.  Dev mode adds checks that catch app mistakes
    production would let pass, and never changes results.  Bundlers replace the expression at build
    time, Node reads the variable, and a host without `process` defines it before loading the
    bundle. */
export const DEV = process.env.NODE_ENV !== 'production';

/** jsonTypeof returns the json type of a value that came out of parsing json
    (so 'undefined' is not handled, since it isn't allowed in json) */
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

// generateUuid is either injected into the environment or we expect to use crypto.getRandomValues()
if (!(globalThis as any).generateUuid) {
  // eslint-disable-next-line no-var -- we mean to mutate the global state in an if statement
  var generateUuid = function (): string {
    let out = '';

    // Get 128 bits of randomness.
    const values = new Uint8Array(16);
    crypto.getRandomValues(values);

    // rfc4122 compliance: type 4 uuid
    values[6] = 0x40 | (values[6] & 0x0f);
    values[8] = 0x80 | (values[8] & 0x3f);

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
  };
}

/** protoJSONReplacer is a JSON.stringify() replacer; it is more efficient than encodeProto because
    JSON.stringify() doesn't have to recreate the whole tree of an object like encodeProto does.
    But encodeProto is more like an inverse operation of the decode* family of functions. */
export function protoJSONReplacer(_k: string, v: any): any {
  if (v instanceof Map) return [...v.entries()];
  if (v instanceof Set) return [...v.keys()];
  // all other types naturally stringify correctly, e.g. Date
  return v;
}

/** protoStringify is like JSON.stringify(), but it handles Map and Set */
export function protoStringify(obj: any): any {
  return JSON.stringify(obj, protoJSONReplacer);
}

export function encodeProto(base: any): any {
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
      throw new Error(`base of type "${typeof base}" not handled by encodeProto`);
  }

  // check if object has toJSON()
  if (base.toJSON) return base.toJSON();

  if (Array.isArray(base)) return base.map(encodeProto);
  if (base instanceof Map) return [...base.entries()].map(encodeProto);
  if (base instanceof Set) return [...base.keys()]; // object keys not supported
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, encodeProto(v)]));
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

/* A transactional key-value store, with values that travel as bundles of representations and a
   Registry that converts between them. */

/** The representations a value can be in: JS is the rich JS value, HOST the host language's,
    MSGPACK the bytes.  They are bits, so a Wants is a mask of them: what an ask wants back, and
    a store produces every wanted one it does not already hold, in one read.  0 means "as held",
    which only move uses. */
export const JS = 1;
export const HOST = 2;
export const MSGPACK = 4;
export type Wants = number;

/** A StoreValue is a value keyed by representation, in one, or in several when several were
    wanted.  What arrives may not be what a caller asked for; a store converts to what it keeps
    on the way in and to what was wanted on the way out. */
export type StoreValue = { [JS]: unknown } | { [HOST]: unknown } | { [MSGPACK]: Uint8Array };

/** Registry converts between representations of typed values and names the types the store
    holds.  Types are model names from the TypeSpec, plus three reserved names: `.json` for the
    Engine's own shapes; `.command` for the outbox envelope, `{id, data}` with `data` already the
    command's wire bytes, so it needs no vocabulary to read; and `.event` for a parked event, the
    wire pair `[env, data]` in `msgpack` and a DbEvent in `js`, its `data` converted through the
    union of the stream's slice. */
export interface Registry {
  /** the value of type `type` carrying every representation in `want`: present ones are kept,
      the rest produced in one pass */
  convert(type: string, value: StoreValue, want: Wants): StoreValue;
  /** the commands union this engine may submit */
  commands: string;
  /** stream prefix (before the first dot) to the slice's events union */
  eventTypes: Record<string, string>;
  /** slicePrefix/subkeyPrefix (each before its first dot) to the store value's type */
  storeTypes: Record<string, string>;
}

/** the type of a store key's value, from the Registry's storeTypes; undefined for a key no slice
    declares */
export function storeTypeOf(reg: Registry, key: string): string | undefined {
  const slash = key.indexOf('/');
  if (slash < 0) throw new Error(`invalid key has no '/': ${key}`);
  const slice = key.slice(0, slash);
  const sub = key.slice(slash + 1);
  const dot = (x: string) => {
    const i = x.indexOf('.');
    return i < 0 ? x : x.slice(0, i);
  };
  return reg.storeTypes[`${dot(slice)}/${dot(sub)}`]!;
}

/** A scan walks keys in code-unit order between a lower and an upper bound, either open or
    closed, one batch at a time.  It is a walk, not a snapshot: a batch is a fresh seek from the
    resume key, so a key written above the cursor inside the range is visited and one written
    below is not.  A scan may therefore write anywhere except above its own cursor inside its
    range. */
export type StoreRange = {
  gte?: string;
  gt?: string;
  lt?: string;
  lte?: string;
  reverse?: boolean;
  // entries per batch
  limit: number;
  // keys only, or values of this type in the wanted representation
  values: false | { type: string; want: Wants };
};
/** one batch; a keys-only scan carries undefined values; next is the key to resume from (gt, or
    lt when reversed), null when the range is done */
export type StoreScan = { entries: [string, StoreValue | undefined][]; next: string | null };

/** the exclusive upper bound of the keys sharing prefix; undefined for the empty prefix */
export function prefixEnd(prefix: string): string | undefined {
  if (prefix === '') return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** the range covering every key under a prefix */
export function prefixRange(
  prefix: string,
  limit: number,
  values: StoreRange['values'],
): StoreRange {
  const end = prefixEnd(prefix);
  if (end === undefined) return { gte: prefix, limit, values };
  return { gte: prefix, lt: end, limit, values };
}

export interface RTxn {
  /** the value at key in the wanted representation, converted by the store; undefined when the
      key is absent */
  get(key: string, type: string, want: Wants): StoreValue | undefined;
  scan(range: StoreRange): StoreScan;
}

export interface WTxn extends RTxn {
  /** persist the value in the representation the store keeps, converting from the one given */
  set(key: string, type: string, value: StoreValue): void;
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

/** the value at key in the one wanted representation, undefined when absent */
export function txnGet(txn: RTxn, key: string, type: string, want: Wants = JS): unknown {
  const value = txn.get(key, type, want);
  return value === undefined ? undefined : (value as Record<number, unknown>)[want];
}

/** every entry of a range, batch by batch */
export function txnScanAll(txn: RTxn, range: StoreRange): [string, StoreValue | undefined][] {
  const all: [string, StoreValue | undefined][] = [];
  let r = range;
  for (;;) {
    const { entries, next } = txn.scan(r);
    all.push(...entries);
    if (next === null) return all;
    r = resumeRange(r, next);
  }
}

/** the range to resume a scan from after a batch */
export function resumeRange(range: StoreRange, next: string): StoreRange {
  const r = { ...range };
  if (range.reverse) {
    delete r.lte;
    r.lt = next;
  } else {
    delete r.gte;
    r.gt = next;
  }
  return r;
}

/** the read half of a transaction object, what a read transaction hands out */
function readHalf(txn: RTxn): WTxn {
  return { get: (...a) => txn.get(...a), scan: (...a) => txn.scan(...a) } as WTxn;
}

// in-memory layers /////////////////////////////////////////////////////////

/* The in-memory and overlay stores keep rich js values, converting through the Registry on the
   way in and out, in a base map plus a map of pending updates (undefined marks a deletion), and
   answer range operations by sorting keys. */

type Layer = Record<string, unknown>;

// the js value to keep for a set, and the wanted representation of a kept value
function toJs(reg: Registry, type: string, value: StoreValue): unknown {
  return (reg.convert(type, value, JS) as Record<number, unknown>)[JS];
}
function fromJs(reg: Registry, type: string, js: unknown, want: Wants): StoreValue {
  return reg.convert(type, { [JS]: js }, want);
}

/* The in-memory layers hand values across their boundary by copy.  On the way in, a JS value the
   caller supplied is copied, and a conversion from another representation is already fresh; on
   the way out, the kept value is copied before it is converted to the want.  copyValue is the one
   place to point at a host's own clone, should one measure faster. */
const copyValue = <T>(v: T): T => deepCopy(v);
function layerIn(reg: Registry, type: string, value: StoreValue): unknown {
  const js = toJs(reg, type, value);
  return JS in value ? copyValue(js) : js;
}
function layerOut(reg: Registry, type: string, js: unknown, want: Wants): StoreValue {
  return fromJs(reg, type, copyValue(js), want);
}

function inRange(key: string, r: StoreRange): boolean {
  if (r.gte !== undefined && key < r.gte) return false;
  if (r.gt !== undefined && key <= r.gt) return false;
  if (r.lte !== undefined && key > r.lte) return false;
  if (r.lt !== undefined && key >= r.lt) return false;
  return true;
}

// the live keys of updates over data, sorted in walk order, restricted to a range
function layerKeys(data: Layer, updates: Layer, r: StoreRange): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(data)) {
    if (!(k in updates) && data[k] !== undefined && inRange(k, r)) keys.push(k);
  }
  for (const k of Object.keys(updates)) {
    if (updates[k] !== undefined && inRange(k, r)) keys.push(k);
  }
  keys.sort();
  if (r.reverse) keys.reverse();
  return keys;
}

function layerGet(data: Layer, updates: Layer, key: string): unknown {
  return key in updates ? updates[key] : data[key];
}

// one batch over sorted keys: cut to the limit, and name the resume key when more remain
function batch(
  reg: Registry,
  keys: string[],
  r: StoreRange,
  get: (key: string) => unknown,
): StoreScan {
  const page = keys.slice(0, r.limit);
  const v = r.values;
  const entries: [string, StoreValue | undefined][] = page.map((k) => [
    k,
    v ? fromJs(reg, v.type, get(k), v.want) : undefined,
  ]);
  const next = keys.length > r.limit ? page[page.length - 1] : null;
  return { entries, next };
}

function layerDelPrefix(data: Layer, updates: Layer, prefix: string): string[] {
  const keys = layerKeys(data, updates, prefixRange(prefix, Infinity, false));
  for (const k of keys) updates[k] = undefined;
  return keys;
}

function layerMove(data: Layer, updates: Layer, src: string, dst: string): string[] {
  const keys = layerKeys(data, updates, prefixRange(src, Infinity, false));
  const moved: string[] = [];
  for (const k of keys) {
    const to = dst + k.slice(src.length);
    updates[to] = layerGet(data, updates, k);
    updates[k] = undefined;
    moved.push(to);
  }
  return moved;
}

/** InMemStore keeps values in their JS form in one object, the one given to the constructor if
    any, so a test can seed the store and read it back through that object.  Values cross the
    transaction boundary by copy; the constructor's object is the store's memory itself. */
export class InMemStore implements Store {
  #reg: Registry;
  #data: Layer;

  constructor(reg: Registry, data?: Record<string, unknown>) {
    this.#reg = reg;
    this.#data = data !== undefined ? data : {};
  }

  #withTxn<T>(writable: boolean, fn: (txn: WTxn) => T): T {
    const updates: Layer = {};
    const txn = new InMemTxn(this.#reg, this.#data, updates);

    // a throw leaves the updates uncommitted, which is the rollback
    const result = fn(writable ? txn : readHalf(txn));

    // commit the updates
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) {
        delete this.#data[key];
      } else {
        this.#data[key] = val;
      }
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

class InMemTxn implements WTxn {
  #reg: Registry;
  #data: Layer;
  #updates: Layer;

  constructor(reg: Registry, data: Layer, updates: Layer) {
    this.#reg = reg;
    this.#data = data;
    this.#updates = updates;
  }

  get(key: string, type: string, want: Wants): StoreValue | undefined {
    const js = layerGet(this.#data, this.#updates, key);
    return js === undefined ? undefined : layerOut(this.#reg, type, js, want);
  }

  set(key: string, type: string, value: StoreValue): void {
    this.#updates[key] = layerIn(this.#reg, type, value);
  }

  del(key: string): void {
    this.#updates[key] = undefined;
  }

  delPrefix(prefix: string): string[] {
    return layerDelPrefix(this.#data, this.#updates, prefix);
  }

  move(src: string, dst: string): string[] {
    return layerMove(this.#data, this.#updates, src, dst);
  }

  scan(range: StoreRange): StoreScan {
    const keys = layerKeys(this.#data, this.#updates, range);
    const get = (k: string) => copyValue(layerGet(this.#data, this.#updates, k));
    return batch(this.#reg, keys, range, get);
  }
}

export class OverlayStore implements Store {
  #base: Store;
  #reg: Registry;
  #data: Layer = {};

  constructor(base: Store, reg: Registry) {
    this.#base = base;
    this.#reg = reg;
  }

  keys(): string[] {
    return Object.keys(this.#data);
  }

  #withTxn<T>(writable: boolean, fn: (txn: WTxn) => T): T {
    // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
    return this.#base.read((baseTxn) => {
      const updates: Layer = {};
      const txn = new OverlayTxn(this.#reg, baseTxn, this.#data, updates);

      // a throw leaves the updates uncommitted, which is the rollback
      const result = fn(writable ? txn : readHalf(txn));

      // commit the updates into the overlay's own layer
      for (const [key, val] of Object.entries(updates)) {
        // note: we must keep undefined values rather than propagate deletions to base
        this.#data[key] = val;
      }
      return result;
    });
  }

  write<T>(fn: (txn: WTxn) => T): T {
    return this.#withTxn(true, fn);
  }

  read<T>(fn: (txn: RTxn) => T): T {
    return this.#withTxn(false, fn);
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
    return key in this.#updates || key in this.#data;
  }

  get(key: string, type: string, want: Wants): StoreValue | undefined {
    if (!this.#has(key)) return this.#base.get(key, type, want);
    const js = layerGet(this.#data, this.#updates, key);
    return js === undefined ? undefined : layerOut(this.#reg, type, js, want);
  }

  set(key: string, type: string, value: StoreValue): void {
    this.#updates[key] = layerIn(this.#reg, type, value);
  }

  del(key: string): void {
    this.#updates[key] = undefined;
  }

  // every key under prefix, from the base and the layers, in walk order
  #keysUnder(prefix: string): string[] {
    const all = new Set<string>();
    for (const [k] of txnScanAll(this.#base, prefixRange(prefix, 1000, false))) {
      if (!this.#has(k)) all.add(k);
    }
    const layer = layerKeys(this.#data, this.#updates, prefixRange(prefix, Infinity, false));
    for (const k of layer) all.add(k);
    return [...all].sort();
  }

  delPrefix(prefix: string): string[] {
    const keys = this.#keysUnder(prefix);
    for (const k of keys) this.#updates[k] = undefined;
    return keys;
  }

  move(src: string, dst: string): string[] {
    const moved: string[] = [];
    for (const k of this.#keysUnder(src)) {
      const to = dst + k.slice(src.length);
      moved.push(to);

      // a layer key moves within the layer
      if (this.#has(k)) {
        this.#updates[to] = layerGet(this.#data, this.#updates, k);
        this.#updates[k] = undefined;
        continue;
      }

      // a base key: copy its value up into the layer under the new name, as the base holds it
      const held = this.#base.get(k, '', 0);
      this.#updates[to] = held === undefined ? undefined : Object.values(held)[0];
      this.#updates[k] = undefined;
    }
    return moved;
  }

  scan(range: StoreRange): StoreScan {
    const result = this.#base.scan(range);

    // the span this batch covers is up to its last key when more follow, else the whole range
    const span: StoreRange = { ...range, limit: Infinity };
    if (result.next !== null) {
      if (range.reverse) {
        span.gte = result.next;
      } else {
        span.lte = result.next;
      }
    }

    // merge the layers' keys in the span over the base's; the base's answers are already the
    // caller's in the wanted representation, and layer entries are copied and converted here
    const merged = new Map<string, StoreValue | undefined>();
    for (const [k, v] of result.entries) if (!this.#has(k)) merged.set(k, v);
    const v = range.values;
    for (const k of layerKeys(this.#data, this.#updates, span)) {
      const js = layerGet(this.#data, this.#updates, k);
      merged.set(k, v ? layerOut(this.#reg, v.type, js, v.want) : undefined);
    }

    // cut the merged keys to one batch
    const keys = [...merged.keys()].sort();
    if (range.reverse) keys.reverse();
    const page: StoreScan = {
      entries: keys.slice(0, range.limit).map((k) => [k, merged.get(k)]),
      next: keys.length > range.limit ? keys[range.limit - 1] : null,
    };

    // the base has more batches behind this span, so the walk resumes even if the merge fit
    if (page.next === null && result.next !== null) {
      page.next = page.entries[page.entries.length - 1][0];
    }
    return page;
  }
}

// external stores ///////////////////////////////////////////////////////////

/** ExternalStoreTxn is one transaction of an ExternalStore, a WTxn that also commits and aborts.
    The store converts: it persists the representation it keeps and answers in the one wanted,
    undefined for an absent key. */
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
    undefined for an absent key. */
export interface ReadTxn {
  get(key: string, type: string): unknown;
}

/** ReducerTxn is what a slice reducer reads and writes through, inside the Engine's transaction.
    Its keys are local to one stream: the Engine prefixes `{stream}/`, so a reducer cannot name a
    key outside its own stream.  A reducer owns what it gets, and what it sets is the store's from
    that call on. */
export interface ReducerTxn extends ReadTxn {
  set(key: string, type: string, value: unknown): void;
  del(key: string): void;
}

// a ReducerTxn over a store transaction for one stream's keys, marking every key it writes in
// updates
function reducerTxn(txn: WTxn, stream: string, updates: Record<string, true>): ReducerTxn {
  const prefix = `${stream}/`;
  return {
    get: (key, type) => txnGet(txn, prefix + key, type),
    set(key, type, value) {
      txn.set(prefix + key, type, { [JS]: value });
      updates[prefix + key] = true;
    },
    del(key) {
      txn.del(prefix + key);
      updates[prefix + key] = true;
    },
  };
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
export type Principal = { user: string | null; traits: string[] };

/** Auth is what a precommit handler authorizes through.  Each call gets a fresh one, and the
    caller rejects a handler that returns without an authorization decision, so authorization fails
    closed.  It carries the principal, so precommit can hand it on wherever a Principal is wanted. */
export class Auth implements Principal {
  readonly user: string | null;
  readonly traits: string[];
  #authorized: boolean = false;

  constructor(principal: Principal) {
    this.user = principal.user;
    this.traits = principal.traits;
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

// A ReadTxn over a store transaction, adding every key it reads to keys when given.  In dev mode
// what it hands out is a read-only proxy, so a mutation of a result throws where it happens,
// naming the key; the JS representation is the one the app touches.
function readTxn(txn: RTxn, keys?: Record<string, true>): ReadTxn {
  return {
    get(key, type) {
      if (keys !== undefined) keys[key] = true;
      const value = txnGet(txn, key, type);
      return DEV ? readOnly(value, key) : value;
    },
  };
}

class QueryImpl<QX, T> {
  latest: T | undefined = undefined;
  closed: boolean = false;

  #subs: ((val: T) => void)[] = [];
  #fn: QueryFunction<QX, T>;
  // the keys the last run read: {key: true}
  #keyDeps: Record<string, true> = {};
  #runs: number = 0;
  #result: T | undefined = undefined;

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

  /** run against txn, unless it has run before and read no key in dirty; answers whether its
      result changed */
  run(txn: RTxn, context: (txn: ReadTxn) => QX, dirty: Record<string, true>): boolean {
    // a query that read nothing which changed keeps its result
    if (this.#runs > 0 && !Object.keys(this.#keyDeps).some((k) => k in dirty)) return false;

    // run it, recording the keys it reads
    const keys: Record<string, true> = {};
    const old = this.#result;
    this.#result = this.#fn(context(readTxn(txn, keys)));
    this.#keyDeps = keys;
    this.#runs++;
    return this.#runs === 1 || this.#result !== old;
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
    knows the transport over which query data should flow. */
export interface QueriesIO {
  /** createQuery takes, query id, args, and an onResults hook, returning a closer function */
  createQuery(raw: any[], onResult: (result: any) => void): () => void;
}

/** RemoteQueries is the base class behind the generated, strongly-typed remote query interfaces. */
export class RemoteQueries {
  #io: QueriesIO;

  constructor(io: QueriesIO) {
    this.#io = io;
  }

  newQuery<T>(raw: any[], decoder: (result: any) => T): Query<T> {
    return new RemoteQuery<T>((onResult: (result: T) => void) => {
      return this.#io.createQuery(raw, (result: any) => onResult(decoder(result)));
    });
  }
}

// connectors ////////////////////////////////////////////////////////////////////

/*
  Questions:
  - who handles reconnects?  Is that transport-specific, or does it require some state? Or both?
*/

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
  // so a newer blob overrides the floor.
  resume: null | {
    position: number;
    skipBytes: number;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  // cancels this backfill alone; the connector's own signal cancels everything
  signal: AbortSignal;
  // one call per delivery, resolved once the Engine has committed it
  push(item: BackfillItem): Promise<void>;
};

/** one delivery of a backfill: the blob's header (its cut position and the seq of every stream
    in it), a batch of values with the byte offset after them, a page of tail events, or the end
    of either half */
export type BackfillItem =
  | { header: { position: number; seqs: Record<string, number> } }
  | { values: [string, Uint8Array][]; skip: number }
  | { valuesDone: true }
  | { events: WireEvent[] }
  | { eventsDone: true };

export type CommandResult =
  | { kind: 'ack'; position: number }
  | { kind: 'dup'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, or a resumed fetch's PhaseLock-Position differs from
// resume.position; the Engine discards what it parked and starts over.  Any other failure rejects,
// and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connector {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and a call that fails also fails every call behind it,
  // unsent, so the Engine's outbox order survives a retry.  Within a call, array order.
  sendCommand(commands: Command<Uint8Array>[]): Promise<CommandResult[]>;
}

export interface ConnectorHooks {
  // first, once per connection, before any frame: the epoch from the response headers, the log
  // every position on this connection belongs to
  onOpen(epoch: string): void;
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
  signal: AbortSignal,
  hooks: ConnectorHooks,
) => Connector;

// engines ////////////////////////////////////////////////////////////////////

/** Command wraps command data T with the client-minted id it will carry through the log. */
export type Command<T> = {
  id: string;
  data: T;
};

/** DbEvent is event data T with the envelope the DB stamped on it when it was committed:
    [position, stream, seq, id, servertime] on the wire.  The id is the command's. */
export type DbEvent<T> = {
  id: string;
  data: T;
  position: number;
  stream: string;
  seq: number;
  servertime: number;
};

/** WireEvent is an event as a connector delivers it: the envelope decoded for routing, data as
    the bytes the server sent, and the whole wire pair `[env, data]` so if needs to be parked, the
    full msgpack format is readily available. */
export type WireEvent = DbEvent<Uint8Array> & { raw: Uint8Array };

export function decodeDbEvent<T>(val: any, subdecoder: (val: any) => T): DbEvent<T> {
  return { ...val, data: subdecoder(val.data) } as DbEvent<T>;
}

/** Engine builds a sync engine out of a Store implementation and a reducer to process incoming
   events.

   Optionally, it also receives the following user configurations:
     - a migrate function, to prepare the Store on startup
     - an onCommands hook and a forecaster, to enable optimistic updates, such as for a UI.

   When provided with onCommands, forecaster, and a persistent Store implementation, Engine forms
   the core of a fully offline-capable application.

   Engine internals diagram:

       (* = owned by user)
        ______________________________________________________
       |  PWA                                                 |
       |    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
       |   | engine                                        |  |
       |       ___________           __________________       |
       |   |  |           |       C |                  |   |  |
       |      | *reducers |<------->| *store + overlay |      |
       |   |  |___________|         |__________________|   |  |
       |         ^ B    ^              ^         |            |
       |   |     |      |              |         | D       |  |
       |         |     _|___________   |   ______v______      |
       |   |     |    |             |  |  |             |  |  |
       |         |    |*forecasters |  |  | query graph |     |
       |   |     |    |_____________|  |  |_____________|  |  |
       |         |             ^ G     |         |            |
       |   |     |         I   |     H |         |         |  |
       |         |       +-----+-------+         |            |
       |   |_ _ _|_ _ _ _|_ _ _^_ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
       |         |       |     |                 | E          |
       |       __|_______v__   |              ___v__          |
       |      |             |  | F           |      |         |
       |      | *transport  |  +-------------| *UI  |         |
       |      |_____________|                |______|         |
       |            ^ A                                       |
       |____________|_________________________________________|
                    |
               _____v______
              |            |
              |   *relay   |
              |____________|
                    ^
                    |
               _____v______
              |            |
              | KurrentDB  |
              |____________|

       A: transport talks to relay, reading events, writing commands, and handling disconnects

       B: transport calls Engine.recvEvents() on new events, which triggers reducers

       C: reducers process incoming batches, updating store

       D: query graph wakes after store update and reruns queries whose dependencies have changed

       E: fresh query results are delivered to the UI

       F: UI submits new commands with Engine.sendCommands()

       G: new commands trigger forecaster; forecasted events are reduced onto storage overlay

       H: new commands are also stored in an outbox in the store

       I: new commands also trigger the user's onCommands() hook so they can be sent over transport

   Engine-owned store keys.  Slice state lives at `{stream}/{local key}`; everything the Engine
   keeps for itself starts with a slash, and the registry types it as `.json` unless noted:

       /view                      ViewRecord: the view token, its position, and the refs granted
       /checkpoint                CheckpointRecord: the cursor, advanced with every batch and
                                  vouch, and how far the base is reduced
       /seq.{stream}              the stream's last held seq, or 'backfill' while a backfill
                                  covering it is in flight
       /command.{ordinal}         Command<Uint8Array> (`.command`): the outbox, in send order,
                                  each command's data as its wire bytes
       /backfill.{ref}            BackfillRecord: an in-flight backfill's until, resume, replacing,
                                  and children
       /backfill-seqs.{ref}       the backfill blob's header seqs, stream name to seq
       /park.ev.{stream}/{seq}    a parked event (`.event`), raw as delivered; seq zero-padded to
                                  20 digits so a stream's range walks its chain
       /park.kv.{ref}/{key}       a slice value from the ref's backfill blob, typed as its key
                                  is, moved to {key} when the backfill lands
*/
/** one slice's reducer, keyed by stream prefix in the Engine's table.  The Engine calls it with a
    run of one stream's events, in order, inside the transaction that brings them in, through a
    ReducerTxn over that stream's own keys.  `pending` is true when the events are a forecast
    folded onto the overlay, and false for real events folded onto the base, so a reducer may mark
    what it writes as pending; the base, the only state ever stored or synced, is always folded
    with false. */
export type SliceReducer = {
  reducer: (txn: ReducerTxn, events: unknown[], stream: string, pending: boolean) => void;
};

/** the view, as persisted at /view when a reconciliation commits */
export type ViewRecord = { token: string; position: number; refs: string[] };
/** the cursor, as persisted at /checkpoint with every batch and vouch */
export type CheckpointRecord = { epoch: string; position: number; reduced: number };
/** a backfill in flight, as persisted at /backfill.{ref} */
export type BackfillRecord = {
  until: number;
  resume: Backfill['resume'];
  replacing: boolean;
  children: string[];
};
/** the in-memory side of a backfill: its record, written through, plus what the disk needs not */
type BackfillEntry = {
  record: BackfillRecord;
  controller: AbortController;
  status: 'downloading' | 'ready';
  parent: string | null;
  // failed attempts in a row, for backoff, and the retry waiting to run
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};
/** whether a wire ref covers a stream name or a narrower ref: `*` covers everything, `family.*`
    covers names under `family.`, and a name covers itself */
export function refCovers(ref: string, name: string): boolean {
  if (ref === '*') return true;
  if (ref.endsWith('.*')) return name.startsWith(ref.slice(0, -1));
  return name === ref;
}

/** one push from a backfill, queued for the advancer with the promise's resolvers */
type BackfillWork = {
  ref: string;
  item: BackfillItem;
  resolve: () => void;
  reject: (e: unknown) => void;
};

/** the store key prefix a ref covers: everything for `*`, `family.` for a family, and the
    stream's own keys for a stream */
export function refPrefix(ref: string): string {
  if (ref === '*') return '';
  if (ref.endsWith('.*')) return ref.slice(0, -1);
  return `${ref}/`;
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
  return `/park.ev.${stream}/${String(seq).padStart(20, '0')}`;
}

/** the key of an outbox command: its ordinal zero-padded so a scan walks the outbox in send
    order */
export function commandKey(ordinal: number): string {
  return `/command.${String(ordinal).padStart(20, '0')}`;
}

/** the stream and seq a parked event key names */
export function parsePark(key: string): { stream: string; seq: number } {
  const slash = key.lastIndexOf('/');
  return { stream: key.slice('/park.ev.'.length, slash), seq: Number(key.slice(slash + 1)) };
}

/** one thing a forecast emits: an event labelled with its stream, or the end of a stream */
export type ForecastOutput = { stream: string; event: unknown } | { stream: string; death: true };

/** the app's forecast of what the database will do with a command, read through the query context
    over the overlay; a throw, a Reject included, forecasts nothing */
export type Forecaster<QX, C> = (qx: QX, command: C) => ForecastOutput[];

/** what the connector delivered, in arrival order */
type Inbound =
  | { open: string }
  | { view: ViewRecord }
  | { events: WireEvent[] }
  | { vouch: number }
  | { live: number }
  | { end: { code: number; reason: string } };

export class Engine<QX, C> {
  #store: Store;
  #reg: Registry;
  #connect: ConnectorFactory;
  #reducers: Record<string, SliceReducer>;
  // runs against the overlay for every outbox command in order on every rebuild; a string is a
  // rejection and forecasts nothing
  #forecaster: null | Forecaster<QX, C>;
  #wants: string[];
  #signal: AbortSignal;

  #overlay: OverlayStore;
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
  #connectorAbort: AbortController = new AbortController();
  #attempt: number = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #connectNow: boolean = false;

  // the persisted state, held in memory and written through
  #view: ViewRecord | null = null;
  #checkpoint: CheckpointRecord | null = null;
  // seq per held stream, or the marker for a stream under an in-flight ref; the marker is
  // persisted at /seq.{stream} on first sight during the backfill, in the transaction that parks
  #streams: Map<string, number | 'backfill'> = new Map();
  #backfills: Map<string, BackfillEntry> = new Map();
  // the outbox in send order: command id to its ordinal in /command.{ordinal}
  #outbox: Map<string, number> = new Map();
  #nextOrdinal: number = 0;
  // outbox commands handed to the current connection with no outcome yet, and those acked, with
  // the position they landed at, waiting for the checkpoint to reach it
  #sent: Set<string> = new Set();
  #acked: Map<string, number> = new Map();
  // set by a release inside a transaction, read by the refresh after its commit
  #outboxChanged: boolean = false;
  // how far the base has been reduced, -1 for never: the checkpoint, except while frozen, when it
  // stays at the last event that reduced.  Persisted in the checkpoint record.  An acked command
  // at or below it is in the base, events or none
  #reduced: number = -1;

  // liveness: the connector has delivered `live`, and no replacing backfill is in flight
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
    conn: AbortController;
  }[] = [];
  // how each sendCommand() call ended, with the ids it carried in order, and on which connection
  #commandOutcomes: {
    ids: string[];
    results: CommandResult[] | { failed: unknown };
    conn: AbortController;
  }[] = [];
  // work received from the app
  #sendCommands: C[] = [];
  #newQueries: boolean = false;
  // every new connection resends the outbox
  #resend: boolean = false;
  // builds the query context, handed to every query and every forecast, over a read transaction
  #context: (txn: ReadTxn) => QX;

  constructor(
    context: (txn: ReadTxn) => QX,
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
      forecaster?: Forecaster<QX, C>;
      // optional: ends the Engine, its connector, and every backfill
      signal?: AbortSignal;
      // optional: receives the error that ended the Engine; without it the error is thrown out
      // of the timer callback that ran the advancer
      onError?: (e: unknown) => void;
    },
  ) {
    this.#context = context;
    this.#store = store ?? new InMemStore(reg);
    this.#reg = reg;
    this.#connect = connect;
    this.#reducers = callbacks.reducers;
    this.#wants = callbacks.wants;
    this.#forecaster = callbacks.forecaster ?? null;
    this.#signal = callbacks.signal ?? new AbortController().signal;
    this.#onError =
      callbacks.onError ??
      ((e) => {
        throw e;
      });
    this.#signal.addEventListener('abort', () => this.#schedule(), { once: true });

    this.#overlay = new OverlayStore(this.#store, reg);
    this.#graph = new QueryGraph(context);

    // let the advancer begin initializing
    this.#run();
  }

  //// public api ////

  /** After forecasting and saving to the outbox, commands are sent through the connector in
      order.  Commands are given in rich format (Date, Maps, and Sets intact). */
  sendCommands(commands: C[]): void {
    this.#sendCommands.push(...commands);
    this.#schedule();
  }

  /** connect now rather than when the backoff timer fires */
  reconnectNow(): void {
    this.#connectNow = true;
    this.#schedule();
  }

  /** add a new Query to the graph */
  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    this.#newQueries = true;
    this.#schedule();
    return this.#graph.newQuery(fn);
  }

  //// end of public api ////

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.#run();
    });
  }

  // one run of the advancer; a throw out of it ends the Engine
  #run(): void {
    if (this.#ended) return;
    try {
      this.#advancer();
    } catch (e: unknown) {
      this.#ended = true;
      this.#onError(e);
    }
  }

  #initialize(): void {
    const js = (v: StoreValue) => (v as Record<number, unknown>)[JS];

    // load the persisted state into memory
    this.#store.read((txn) => {
      const checkpoint = txnGet(txn, '/checkpoint', '.json') as CheckpointRecord | undefined;
      this.#checkpoint = checkpoint ?? null;
      this.#view = (txnGet(txn, '/view', '.json') as ViewRecord | undefined) ?? null;

      // the streams table: seq per held stream, or the marker for a stream under a backfill
      const seqRows = txnScanAll(txn, prefixRange('/seq.', 1000, { type: '.json', want: JS }));
      for (const [key, value] of seqRows) {
        this.#streams.set(key.slice('/seq.'.length), js(value!) as number | 'backfill');
      }

      // the outbox in ordinal order; the next ordinal continues from the last key
      const commandRows = txnScanAll(
        txn,
        prefixRange('/command.', 1000, { type: '.command', want: JS }),
      );
      for (const [key, value] of commandRows) {
        const ordinal = Number(key.slice('/command.'.length));
        this.#outbox.set((js(value!) as Command<Uint8Array>).id, ordinal);
        this.#nextOrdinal = ordinal + 1;
      }

      // the backfills in flight, each with a fresh controller
      const backfillRows = txnScanAll(
        txn,
        prefixRange('/backfill.', 1000, { type: '.json', want: JS }),
      );
      for (const [key, value] of backfillRows) {
        const record = js(value!) as BackfillRecord;
        this.#backfills.set(key.slice('/backfill.'.length), {
          record,
          controller: new AbortController(),
          status: 'downloading',
          parent: null,
          attempts: 0,
          retryTimer: null,
        });
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
        txn.set('/view', '.json', { [JS]: this.#view });
      }

      // did the purge end the last replacing backfill?  Then this is the unfreeze.  Either way,
      // whatever waits ready on disk lands now.
      if (wasFrozen && this.#replacing === 0) {
        this.#unfreezeIn(txn, dirty);
      } else {
        this.#tryLandIn(txn, dirty);
      }
    });

    // forecast every outbox command onto a fresh overlay
    this.#rebuildOverlay();

    // the first connection attempt
    this.#connectNow = true;
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

      if (this.#sendCommands.length > 0 || this.#resend) {
        // the tightest loop we serve: write to the outbox, forecast, and the UI sees the
        // optimistic update; then send through the connector in order
        this.#onSendCommands();
        continue;
      }

      if (this.#newQueries && this.#live) {
        // a new page wants its first answer: extend the graph with the app's new queries
        this.#onNewQueries();
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

      // nothing to do: wait for a hook, a timer, or the app
      return;
    }
  }

  // the app's new commands go into the outbox, and every outbox command not yet handed to this
  // connection is sent in ordinal order
  #onSendCommands(): void {
    const fresh = this.#sendCommands.splice(0);
    const connector = this.#connector;
    this.#resend = false;

    const wire = this.#store.write((txn) => {
      // new commands are converted to wire bytes here, by the vocabulary that made them, and take
      // the next ordinals
      for (const data of fresh) {
        const bytes = this.#reg.convert(this.#reg.commands, { [JS]: data }, MSGPACK);
        const command: Command<Uint8Array> = {
          id: generateUuid(),
          data: (bytes as Record<number, unknown>)[MSGPACK] as Uint8Array,
        };
        const ordinal = this.#nextOrdinal++;
        txn.set(commandKey(ordinal), '.command', { [JS]: command });
        this.#outbox.set(command.id, ordinal);
      }

      // without a connector, the next connection resends
      if (connector === null) return [];
      const pending = [...this.#outbox]
        .filter(([id]) => !this.#sent.has(id) && !this.#acked.has(id))
        .sort((a, b) => a[1] - b[1]);

      // rows go on the wire as stored, whatever vocabulary wrote them
      const out: Command<Uint8Array>[] = [];
      for (const [, ordinal] of pending) {
        out.push(txnGet(txn, commandKey(ordinal), '.command') as Command<Uint8Array>);
      }
      return out;
    });
    if (fresh.length > 0) this.#outboxChanged = true;
    this.#refresh({});
    if (wire.length === 0) return;

    // the results come back through the outcomes, tagged with this connection
    const ids = wire.map((c) => c.id);
    const conn = this.#connectorAbort;
    for (const id of ids) this.#sent.add(id);
    connector!.sendCommand(wire).then(
      (results) => {
        this.#commandOutcomes.push({ ids, results, conn });
        this.#schedule();
      },
      (e: unknown) => {
        this.#commandOutcomes.push({ ids, results: { failed: e }, conn });
        this.#schedule();
      },
    );
  }

  #onNewQueries(): void {
    const cbs = this.#overlay.read((txn) => {
      this.#newQueries = false;
      return this.#graph.extend(txn);
    });
    cbs();
  }

  // a new connection restarts every backfill that is still downloading and is not waiting on its
  // own backoff timer, and resends the outbox
  #onConnect(): void {
    this.#connectNow = false;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // hooks queue for the advancer; a hook from a connector we have since replaced is dropped
    const abort = this.#connectorAbort;
    const push = (item: Inbound) => {
      if (this.#connectorAbort !== abort) return;
      this.#inbox.push(item);
      this.#schedule();
    };
    this.#connector = this.#connect(
      this.#checkpoint?.position ?? -1,
      this.#view?.token ?? null,
      this.#wants,
      abort.signal,
      {
        onOpen: (epoch) => push({ open: epoch }),
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
      txn.set(`/backfill-seqs.${ref}`, '.json', { [JS]: seqs });
    } else if ('values' in item) {
      // park each value under this backfill's own range, and mark its stream
      for (const [key, bytes] of item.values) {
        // a key no slice declares is from a newer vocabulary, so it is dropped
        const type = storeTypeOf(this.#reg, key);
        if (type === undefined) continue;
        txn.set(`/park.kv.${ref}/${key}`, type, { [MSGPACK]: bytes });
        this.#maybeMarkBackfilling(txn, key.slice(0, key.indexOf('/')), record.replacing);
      }
      record.resume!.skipBytes = item.skip;
    } else if ('valuesDone' in item) {
      record.resume!.snapshotDone = true;
    } else if ('events' in item) {
      // park each event by stream and seq, and mark its stream
      for (const ev of item.events) {
        txn.set(parkedEventKey(ev.stream, ev.seq), '.event', { [MSGPACK]: ev.raw });
        this.#maybeMarkBackfilling(txn, ev.stream, record.replacing);
        record.resume!.fromPosition = Math.max(record.resume!.fromPosition, ev.position);
      }
    } else if ('eventsDone' in item) {
      record.resume!.tailDone = true;
    } else {
      throw new Error('unexpected backfill item');
    }

    if (record.resume!.snapshotDone && record.resume!.tailDone) entry.status = 'ready';
    txn.set(`/backfill.${ref}`, '.json', { [JS]: record });
  }

  // an additive backfill leaves a held stream held and lands around it; a replacing one takes it
  #maybeMarkBackfilling(txn: WTxn, stream: string, replacing: boolean): void {
    const held = this.#streams.get(stream);
    if (held === 'backfill' || (typeof held === 'number' && !replacing)) return;
    this.#streams.set(stream, 'backfill');
    txn.set(`/seq.${stream}`, '.json', { [JS]: 'backfill' });
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
          txn.delPrefix(`/park.kv.${ref}/`);
          const r = entry.record.resume;
          if (r !== null) entry.record.resume = { ...r, skipBytes: 0, snapshotDone: false };
          txn.set(`/backfill.${ref}`, '.json', { [JS]: entry.record });
          this.#startBackfill(ref);
        } else {
          // a rejection: ours, if the entry's signal fired, else a failure to retry after backoff
          if (entry.controller.signal.aborted) continue;
          entry.status = 'downloading';
          const delay = backoffDelay(entry.attempts++);
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            // the entry may have gone, or the Engine, while the timer ran
            if (this.#backfills.get(ref) === entry && !this.#signal.aborted) {
              this.#startBackfill(ref);
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
      signal: AbortSignal.any([conn.signal, entry.controller.signal]),
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
        ([ref, e]) => e.record.replacing && !landing.has(ref)
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
      this.#backfills.get(ref)!.status === 'ready'
      && this.#childrenOf(ref).every((c) => this.#landable(c))
    );
  }

  // the parked event range of a ref, or of every stream for the frozen events (null)
  #parkRange(ref: string | null, values: StoreRange['values']): StoreRange {
    return prefixRange(`/park.ev.${ref === null ? '' : refPrefix(ref)}`, 1000, values);
  }

  // a ref's blob header: the seq of every stream in its blob at the cut
  #headerOf(txn: RTxn, ref: string): Record<string, number> {
    return (txnGet(txn, `/backfill-seqs.${ref}`, '.json') ?? {}) as Record<string, number>;
  }

  // a subtree's seqs at its cuts: the ref's header with each child's laid over it, deepest winning
  #mergedHeaderIn(txn: RTxn, ref: string): Record<string, number> {
    let header = this.#headerOf(txn, ref);
    for (const child of this.#childrenOf(ref)) {
      header = { ...header, ...this.#mergedHeaderIn(txn, child) };
    }
    return header;
  }

  // the streams among a subtree's parked events, or among the frozen events (null), whose chain
  // does not continue from the state that will be in place; key-only
  #brokenStreamsIn(txn: RTxn, ref: string | null): string[] {
    const header = ref === null ? {} : this.#mergedHeaderIn(txn, ref);
    const broken: string[] = [];
    let range = this.#parkRange(ref, false);
    let stream = '';
    let last = 0;

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
        }

        // at or below the base, the snapshot covers this event
        if (park.seq <= last) continue;

        // does the chain continue?
        if (park.seq !== last + 1) {
          if (!broken.includes(stream)) broken.push(stream);
          continue;
        }
        last = park.seq;
      }
      if (next === null) return broken;
      range = resumeRange(range, next);
    }
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
        for (const r of subtree) txn.delPrefix(`/park.kv.${r}/${stream}/`);
      } else {
        // otherwise the stream loses its state to the blob
        markDirty(dirty, txn.delPrefix(`${stream}/`));
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
    markDirty(dirty, txn.move(`/park.kv.${ref}/`, ''));
    for (const child of this.#childrenOf(ref)) {
      // clear the parent's values for the child's streams, so a key the child's blob lacks goes too
      for (const stream of Object.keys(this.#headerOf(txn, child))) {
        if (!kept.has(stream)) markDirty(dirty, txn.delPrefix(`${stream}/`));
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
    txn.set(`/backfill.${ref}`, '.json', { [JS]: entry.record });
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
    txn.del(`/backfill.${ref}`);
    txn.del(`/backfill-seqs.${ref}`);
    const entry = this.#backfills.get(ref)!;
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;
  }

  /* Reduce the parked events of a subtree, or of every stream under no backfill for the frozen
     events (null), each stream's run in one reducer call, then clear each walked stream's range.
     Chains were checked before any write.  Every landed stream's seq is written once: the last
     walked for a stream with events, the cut's for a header stream without. */
  #reduceParkedIn(
    txn: WTxn,
    ref: string | null,
    header: Record<string, number>,
    dirty: Record<string, true>,
  ): void {
    // {stream: seq}, the header seqs, then the last seq walked
    const seqs = new Map(Object.entries(header));
    const walked: string[] = [];
    let range = this.#parkRange(ref, { type: '.event', want: JS });
    let stream = '';
    let run: DbEvent<unknown>[] = [];

    // walk the parked events in stream then seq order, reducing each stream's run as it ends
    for (;;) {
      const { entries, next } = txn.scan(range);
      for (const [, value] of entries) {
        const ev = (value as Record<number, unknown>)[JS] as DbEvent<unknown>;
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
        }

        // at or below the base, the snapshot covers this event
        if (ev.seq <= seqs.get(stream)!) continue;
        seqs.set(stream, ev.seq);
        run.push(ev);
      }
      if (next === null) break;
      range = resumeRange(range, next);
    }
    if (run.length > 0) this.#reduceStreamIn(txn, stream, run, dirty);

    // clear only the streams walked; a skipped stream's events stay for its own backfill's land
    for (const name of walked) txn.delPrefix(`/park.ev.${name}/`);

    // hold every landed stream at its new seq
    for (const [name, seq] of seqs) {
      this.#streams.set(name, seq);
      txn.set(`/seq.${name}`, '.json', { [JS]: seq });
    }
  }

  /* One stream's run of events, in order, through its slice's reducer.  Births and deaths are the
     Engine's: a death drops the stream's keys, the stream stays known so a rebirth chains, and
     neither reaches a reducer.  This is where events enter the base, so an event carrying an
     outbox command's id is that command's round trip, whichever path parked or delivered it. */
  #reduceStreamIn(
    txn: WTxn,
    stream: string,
    events: DbEvent<unknown>[],
    dirty: Record<string, true>,
  ): void {
    // the server sends nothing outside the wants, and the wants are the families with reducers
    const slice = this.#reducers[stream.split('.')[0]];
    if (slice === undefined) throw new Error(`no reducer for ${stream}`);
    let data: unknown[] = [];

    // reduce the pending events, if any
    const reduce = () => {
      if (data.length === 0) return;
      slice.reducer(reducerTxn(txn, stream, dirty), data, stream, false);
      data = [];
    };

    for (const ev of events) {
      // our own command's event: the round trip is observed
      if (this.#outbox.has(ev.id)) this.#releaseIn(txn, [ev.id]);

      const sys = sysOf(ev.data);
      if (sys === 'death') {
        // the stream died: reduce what came before, then drop its state
        reduce();
        markDirty(dirty, txn.delPrefix(`${stream}/`));
      } else if (sys === null) {
        data.push(ev.data);
      }
    }
    reduce();
  }

  // a ref whose tail did not reach its parked live events downloads again from a fresh snapshot,
  // whose cut is past the gap; the parked events stay and chain from the live cut
  #restartIn(txn: WTxn, ref: string): void {
    const entry = this.#backfills.get(ref)!;
    txn.delPrefix(`/park.kv.${ref}/`);
    entry.record.resume = null;
    entry.status = 'downloading';
    entry.attempts = 0;
    txn.set(`/backfill.${ref}`, '.json', { [JS]: entry.record });
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
      txn.set(`/backfill.${ref}`, '.json', { [JS]: record });
      this.#backfills.set(ref, {
        record,
        controller: new AbortController(),
        status: 'downloading',
        parent,
        attempts: 0,
        retryTimer: null,
      });
      if (replacing) this.#replacing++;

      // a stream ref is marked; a family has nothing to mark until its blob names its members
      if (!ref.endsWith('*')) this.#maybeMarkBackfilling(txn, ref, replacing);
      if (replacing) this.#markUnderIn(txn, ref);
      this.#startBackfill(ref);
    }

    if (parent !== null) {
      const p = this.#backfills.get(parent)!;
      p.record.children.push(...refs);
      txn.set(`/backfill.${parent}`, '.json', { [JS]: p.record });
    }
  }

  // an in-flight backfill ends: its download is aborted, its values range and records go, and its
  // children carry on under the parent they have left, if any
  #dropBackfillIn(txn: WTxn, ref: string): void {
    const entry = this.#backfills.get(ref)!;
    entry.controller.abort();
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    txn.delPrefix(`/park.kv.${ref}/`);
    txn.del(`/backfill.${ref}`);
    txn.del(`/backfill-seqs.${ref}`);
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;

    // leave the parent's children list
    if (entry.parent !== null) {
      const p = this.#backfills.get(entry.parent)!;
      p.record.children = p.record.children.filter((c) => c !== ref);
      txn.set(`/backfill.${entry.parent}`, '.json', { [JS]: p.record });
    }

    // re-parent each child to the next covering entry, if any
    for (const child of entry.record.children) {
      const c = this.#backfills.get(child);
      if (c === undefined) continue;
      c.parent = this.#parentOf(child);
      if (c.parent === null) continue;
      const p = this.#backfills.get(c.parent)!;
      p.record.children.push(child);
      txn.set(`/backfill.${c.parent}`, '.json', { [JS]: p.record });
    }
  }

  // a stream leaves the Engine: its state, its seq, and its parked events
  #dropStreamIn(txn: WTxn, stream: string, dirty: Record<string, true>): void {
    markDirty(dirty, txn.delPrefix(`${stream}/`));
    txn.del(`/seq.${stream}`);
    txn.delPrefix(`/park.ev.${stream}/`);
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
        if ('events' in item) {
          this.#onEventsIn(txn, item.events, dirty);
        } else if ('open' in item) {
          // a different epoch is a replaced log, where the positions we hold mean nothing.
          // Dropping everything and backfilling every ref is the answer, and until that exists
          // this ends.
          if (this.#checkpoint !== null && this.#checkpoint.epoch !== item.open) {
            throw new Error(`epoch ${item.open}, checkpoint from ${this.#checkpoint.epoch}`);
          }
          this.#epoch = item.open;
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

    // history is done: the graph runs once, unless frozen
    if (wentLive) {
      this.#live = true;
      this.#attempt = 0;
    }

    // a revoke changes what queries may see, so the graph runs even while frozen: a new query
    // would otherwise disagree with the results already delivered
    this.#refresh(dirty, revoked || (wentLive && this.#replacing === 0));
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
    for (const ev of events) {
      const held = this.#streams.get(ev.stream);
      let park = held === 'backfill';

      // an unknown stream?
      if (held === undefined && !seqs.has(ev.stream) && !born.has(ev.stream)) {
        const parent = this.#parentOf(ev.stream);
        if (parent !== null) {
          // under an in-flight ref, whose land will chain it: mark it and park
          const replacing = this.#backfills.get(parent)!.record.replacing;
          this.#maybeMarkBackfilling(txn, ev.stream, replacing);
          park = true;
        } else if (sysOf(this.#decode(ev).data) !== 'birth') {
          // a stream we missed the birth of: backfill it on its own, and park
          this.#spawnIn(txn, null, [ev.stream], ev.position, false);
          park = true;
        }
      }

      // frozen, so everything else parks too
      if (!park && this.#replacing > 0) {
        park = true;
        if (held === undefined) born.add(ev.stream);
      }

      // a held stream, or a birth: does the event chain?
      if (!park) {
        const last = seqs.get(ev.stream) ?? (typeof held === 'number' ? held : 0);
        if (ev.seq <= last) continue;
        if (ev.seq === last + 1) {
          // the next event: it joins the stream's run
          seqs.set(ev.stream, ev.seq);
          if (!runs.has(ev.stream)) runs.set(ev.stream, []);
          runs.get(ev.stream)!.push(this.#decode(ev));
          reduced = ev.position;
          continue;
        }

        // a gap: replace the stream, under the in-flight ref covering it if any, and park
        this.#spawnIn(txn, this.#parentOf(ev.stream), [ev.stream], ev.position, true);
        seqs.delete(ev.stream);
        park = true;
      }

      txn.set(parkedEventKey(ev.stream, ev.seq), '.event', { [MSGPACK]: ev.raw });
    }

    // reduce each stream's run and hold it at its new seq
    for (const [stream, run] of runs) this.#reduceStreamIn(txn, stream, run, dirty);
    for (const [stream, seq] of seqs) {
      this.#streams.set(stream, seq);
      txn.set(`/seq.${stream}`, '.json', { [JS]: seq });
    }

    // an atom that froze part way reduced up to the event before the gap
    const last = events[events.length - 1].position;
    this.#reducedTo(txn, this.#replacing > 0 ? reduced : last);
    this.#advanceCursorIn(txn, last);
  }

  // after a commit, the graph learns what changed and runs when live; base changes reach queries
  // only when not frozen, outbox changes always, since forecasts are not base state
  #refresh(dirty: Record<string, true>, always = false): void {
    this.#graph.dirty(dirty);
    const outbox = this.#outboxChanged;
    this.#outboxChanged = false;
    const changed = Object.keys(dirty).length > 0;
    if (this.#live && (always || outbox || (changed && this.#replacing === 0))) {
      this.#rebuildOverlay();
    }
  }

  // a live event as the reducers see it
  #decode(ev: WireEvent): DbEvent<unknown> {
    const v = this.#reg.convert('.event', { [MSGPACK]: ev.raw }, JS);
    return (v as Record<number, unknown>)[JS] as DbEvent<unknown>;
  }

  // the checkpoint moves forward, never back, under the connection's epoch
  #advanceCursorIn(txn: WTxn, position: number): void {
    if (this.#epoch === null) throw new Error('cursor with no epoch');
    if (this.#checkpoint !== null && position <= this.#checkpoint.position) return;
    this.#checkpoint = { epoch: this.#epoch, position, reduced: this.#reduced };
    txn.set('/checkpoint', '.json', { [JS]: this.#checkpoint });
  }

  // the base has been reduced through position, so every acked command at or below it is in the
  // base, events or none, and leaves the outbox
  #reducedTo(txn: WTxn, position: number): void {
    if (position <= this.#reduced) return;
    this.#reduced = position;
    if (this.#checkpoint !== null) {
      this.#checkpoint = { ...this.#checkpoint, reduced: position };
      txn.set('/checkpoint', '.json', { [JS]: this.#checkpoint });
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

  // every queued sendCommand result, and one release for all of them
  #onCommandOutcomes(): void {
    const drop: string[] = [];
    while (this.#commandOutcomes.length > 0) {
      const { ids, results, conn } = this.#commandOutcomes.shift()!;

      // a failed call leaves its commands unsent for the next resend, unless the connection it
      // was on has already ended, which resent them
      if ('failed' in results) {
        if (conn === this.#connectorAbort) {
          for (const id of ids) this.#sent.delete(id);
        }
        continue;
      }

      // answers count from any connection, they are the server's
      results.forEach((r, i) => {
        const id = ids[i];

        // a command already released, by its round trip or by an earlier answer to a resend
        if (!this.#outbox.has(id)) return;

        if (r.kind === 'ack' || r.kind === 'dup') {
          // the command landed at a position; it leaves once the base has reduced through it
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

    txn.set('/view', '.json', { [JS]: view });
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
    this.#connectorAbort = new AbortController();
    this.#sent.clear();
    this.#live = false;
    this.#epoch = null;

    // the next attempt, after backoff
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#schedule();
    }, backoffDelay(this.#attempt++));
  }

  // a fresh overlay over the base, every outbox command forecast onto it in order, and the graph
  // run on the result
  #rebuildOverlay(): void {
    const discarded: Record<string, true> = {};
    markDirty(discarded, this.#overlay.keys());
    this.#graph.dirty(discarded);
    this.#overlay = new OverlayStore(this.#store, this.#reg);

    // forecast each outbox command, each seeing what the ones before it left
    const forecaster = this.#forecaster;
    if (forecaster !== null && this.#outbox.size > 0) {
      const rows = this.#store.read((txn) =>
        txnScanAll(txn, prefixRange('/command.', 1000, { type: '.command', want: JS })),
      );
      for (const [, value] of rows) {
        const command = (value as Record<number, unknown>)[JS] as Command<Uint8Array>;

        // a command this vocabulary cannot read is still sent; it just forecasts nothing
        const data = this.#commandData(command.data);
        if (data === undefined) continue;

        /* Each command forecasts in its own overlay transaction, so a throw cancels its events
           alone.  A throw from the forecast is its way of forecasting nothing; a reducer can also
           throw on correct code, when real events have moved the base underneath a forecast that
           no longer applies.  Either way the command is in flight and the server decides. */
        try {
          this.#graph.dirty(this.#overlay.write((txn) => this.#forecastIn(txn, forecaster, data)));
        } catch {
          continue;
        }
      }
    }

    // run the graph, new queries included
    const cbs = this.#overlay.read((txn) => {
      this.#newQueries = false;
      return this.#graph.run(txn);
    });
    cbs();
  }

  // a command's wire bytes as the forecaster sees them, or undefined when the current vocabulary
  // cannot read them, which is an outbox row written by an earlier build of the app
  #commandData(bytes: Uint8Array): C | undefined {
    try {
      const v = this.#reg.convert(this.#reg.commands, { [MSGPACK]: bytes }, JS);
      return (v as Record<number, unknown>)[JS] as C;
    } catch {
      return undefined;
    }
  }

  // one command's forecast folded onto the overlay: each run of consecutive events on one stream
  // goes through its slice's reducer as pending, and a death drops the stream's keys; returns the
  // keys it changed
  #forecastIn(txn: WTxn, forecaster: Forecaster<QX, C>, command: C): Record<string, true> {
    const dirty: Record<string, true> = {};
    let stream = '';
    let run: unknown[] = [];

    // reduce the pending run; a family with no reducer forecasts nothing
    const flush = () => {
      if (run.length === 0) return;
      const slice = this.#reducers[stream.split('.')[0]];
      if (slice !== undefined) slice.reducer(reducerTxn(txn, stream, dirty), run, stream, true);
      run = [];
    };

    for (const out of forecaster(this.#context(readTxn(txn)), command)) {
      if (out.stream !== stream) {
        flush();
        stream = out.stream;
      }
      if ('death' in out) {
        flush();
        markDirty(dirty, txn.delPrefix(`${stream}/`));
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
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }

    // the connection, and with it every backfill call in flight
    this.#connectorAbort.abort();
    this.#connector = null;
    for (const entry of this.#backfills.values()) {
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    }

    // the pushes waiting for a transaction they will never get
    const reason = new Error('engine shut down');
    for (const work of this.#backfillWork) work.reject(reason);
    this.#backfillWork = [];
  }
}

// end of skeleton ////////////////////////////////////////////////////////////
