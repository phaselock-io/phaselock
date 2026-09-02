// utils //////////////////////////////////////////////////////////////////////

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

const copySym = Symbol();

export function deepCopy<T>(base: T): T {
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

  // handle read-only and proxy objects in an efficient way
  const copier = (base as any)[copySym];
  if (copier) return copier();

  // object handling
  if (Array.isArray(base)) return [...base].map(deepCopy) as T;
  if (base instanceof Map) {
    const out = new Map();
    for (const [k, v] of base) out.set(k, deepCopy(v));
    return out as T;
  }
  if (base instanceof Set) return new Set(base) as T; // object keys not allowed anyway
  if (base instanceof Date) return new Date(base) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, deepCopy(v)])) as T;
}

export function readOnly<T>(base: T): Readonly<T> {
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
  if (Array.isArray(base)) return readOnlyArray(base) as T;
  if (base instanceof Map) return readOnlyMap(base) as T;
  if (base instanceof Set) return readOnlySet(base) as T;
  if (base instanceof Date) return readOnlyDate(base) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return readOnlyObject(base as any) as T;
}

function throwReadOnlyError(): any {
  throw new Error('object is read-only and may not be modified');
}

function readOnlyObject<T>(base: Record<string, T>): Readonly<Record<string, T>> {
  const cache: Record<string, any> = {};

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,
    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop]);
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

      const ro = readOnly(value);
      cache[prop] = ro;
      return ro;
    },
  });
}

function readOnlyArray<T>(base: T[]): Readonly<T[]> {
  const cache = Array(base.length);
  let filled = false;

  function dirty1(n: number): T | undefined {
    if (Object.hasOwn(cache, n)) return cache[n];
    if (!Object.hasOwn(base, n)) return undefined;
    const ro = readOnly(base[n]);
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
    push: throwReadOnlyError,
    pop: throwReadOnlyError,
    shift: throwReadOnlyError,
    reverse: throwReadOnlyError,
    copyWithin: throwReadOnlyError,
    fill: throwReadOnlyError,
    sort: throwReadOnlyError,
    splice: throwReadOnlyError,
    unshift: throwReadOnlyError,
  };

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop]);
        cache[prop] = value;
        return value;
      }

      const method = roArrayMethods[prop];
      if (method) return method;

      return base[prop];
    },
  });
}

const roDatePrototype = {
  setDate: throwReadOnlyError,
  setFullYear: throwReadOnlyError,
  setHours: throwReadOnlyError,
  setMilliseconds: throwReadOnlyError,
  setMinutes: throwReadOnlyError,
  setMonth: throwReadOnlyError,
  setSeconds: throwReadOnlyError,
  setTime: throwReadOnlyError,
  setUTCDate: throwReadOnlyError,
  setUTCFullYear: throwReadOnlyError,
  setUTCHours: throwReadOnlyError,
  setUTCMilliseconds: throwReadOnlyError,
  setUTCMinutes: throwReadOnlyError,
  setUTCMonth: throwReadOnlyError,
  setUTCSeconds: throwReadOnlyError,
  setYear: throwReadOnlyError,
};
Object.setPrototypeOf(roDatePrototype, Date.prototype);

function readOnlyDate(base: Date): Readonly<Date> {
  // copy instead of proxy
  const out = new Date(base);
  Object.setPrototypeOf(out, roDatePrototype);
  return out;
}

function readOnlyMap<K, V>(base: Map<K, V>): Readonly<Map<K, Readonly<V>>> {
  const cache: Map<K, Readonly<V>> = new Map();
  let filled = false;

  function dirty1(k: K): V | undefined {
    if (filled || cache.has(k)) return cache.get(k);
    if (!base.has(k)) return undefined;
    const ro = readOnly(base.get(k)!);
    cache.set(k, ro);
    return ro;
  }

  function dirtyAll() {
    if (filled) return cache;
    filled = true;
    for (const k of base.keys()) {
      if (cache.has(k)) continue;
      cache.set(k, readOnly(base.get(k)!));
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
    clear: throwReadOnlyError,
    delete: throwReadOnlyError,
    getOrInsert: throwReadOnlyError,
    getOrInsertComputed: throwReadOnlyError,
    set: throwReadOnlyError,
  };
  Object.setPrototypeOf(roMapMethods, null);

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);
      const method = roMapMethods[prop];
      if (method) return method;

      return (base as any)[prop];
    },
  });
}

// no cache needed, since we don't support object keys and there are no values
function readOnlySet<K>(base: Set<K>): Readonly<Set<K>> {
  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      // just disallow mutations
      if (prop === 'add' || prop === 'delete' || prop === 'clear') return throwReadOnlyError;

      const value = (base as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(base, args);
      }
      return value;
    },
  });
}

export function copyOnWrite<T>(base: T, parent?: () => void): T {
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
      if (base instanceof Date) return new Date(base) as T; // trivial copy
      // general objects handled below
      break;

    case 'symbol':
    case 'function':
    default:
      throw new Error(`base of type "${typeof base}" not handled by copyOnWrite`);
  }

  // object handling
  if (Array.isArray(base)) return copyOnWriteArray(base, parent) as T;
  if (base instanceof Map) return copyOnWriteMap(base, parent) as T;
  if (base instanceof Set) return copyOnWriteSet(base, parent) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return copyOnWriteObject(base as any, parent) as T;
}

const recoverSym = Symbol();

export function recover<T>(base: T): T {
  switch (typeof base) {
    case 'boolean':
    case 'bigint':
    case 'number':
    case 'string':
    case 'undefined':
      // leaf type found; nothing was cow
      return base;

    case 'object':
      if (base === null) return base;
      if (base instanceof Date) return base;
      // general objects handled below
      break;

    case 'symbol':
    case 'function':
    default:
      throw new Error(`base of type "${typeof base}" not handled by recover`);
  }

  // check if object was returned by copyOnWrite; recover its inner value
  const rcvr: () => T = (base as any)[recoverSym];
  if (rcvr) return rcvr();

  // otherwise walk normal objects looking for anything that came out of a copyOnWrite.

  if (Array.isArray(base)) {
    for (const [i, item] of base.entries()) {
      const r = recover(item);
      if (r !== item) {
        base[i] = r;
      }
    }
    return base;
  }

  if (base instanceof Map) {
    for (const [key, value] of base.entries()) {
      const r = recover(value);
      if (r !== value) {
        base.set(key, r);
      }
    }
    return base;
  }

  // Set with non-primitive keys is not supported, so nothing to be checked
  if (base instanceof Set) return base;

  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  // plain objects
  for (const [key, value] of Object.entries(base)) {
    const r = recover(value);
    if (r !== value) {
      (base as any)[key] = r;
    }
  }
  return base as T;
}

const DELETED = Symbol('DELETED');

function copyOnWriteObject<T>(base: Record<string, T>, parent?: () => void): Record<string, T> {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache: Record<string, T | typeof DELETED> = {};
  let clean = true;
  const full = false;

  function mark() {
    if (clean) {
      clean = false;
      // dirty our parent too
      if (parent) parent();
    }
  }

  function copy() {
    if (clean) return deepCopy(base);
    const out: Record<string, T> = {};
    if (!full) {
      for (const [key, val] of Object.entries(base)) {
        if (!Object.hasOwn(cache, key)) out[key] = deepCopy(val);
      }
    }
    for (const [key, val] of Object.entries(cache)) {
      if (val !== DELETED) out[key] = deepCopy(val as T);
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    if (full) {
      const out: Record<string, T> = {};
      for (const [key, val] of Object.entries(cache)) {
        if (val !== DELETED) out[key] = recover(val);
      }
      return out;
    }
    // start with a shallow copy of base
    const out = { ...base };
    for (const [key, val] of Object.entries(cache)) {
      if (val === DELETED) {
        delete out[key];
      } else {
        out[key] = recover(val);
      }
    }
    return out;
  }

  return new Proxy(base, {
    defineProperty() {
      throw new Error('not supported by copyOnWrite');
    },

    deleteProperty(_, prop: any) {
      mark();
      cache[prop] = DELETED;
      return true;
    },

    getOwnPropertyDescriptor(_, prop: any) {
      if (cache[prop] === DELETED) return undefined;
      return (
        Object.getOwnPropertyDescriptor(cache, prop) ?? Object.getOwnPropertyDescriptor(base, prop)
      );
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      // lookup value in cache first
      if (Object.hasOwn(cache, prop)) {
        const value = cache[prop];
        return value !== DELETED ? value : undefined;
      }
      // then get cacheable value from base
      if (Object.hasOwn(base, prop)) {
        const value = copyOnWrite(base[prop], mark);
        cache[prop] = value;
        return value;
      }

      const value = base[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      if (Object.hasOwn(cache, prop)) return cache[prop] !== DELETED;
      return prop in base;
    },

    ownKeys() {
      const out = [];
      for (const key of Object.keys(base)) {
        if (cache[key] === DELETED) continue;
        out.push(key);
      }
      for (const key of Object.keys(cache)) {
        if (Object.hasOwn(base, key)) continue;
        if (cache[key] !== DELETED) out.push(key);
      }
      return out;
    },

    set(_, prop: any, value: T) {
      mark();
      cache[prop] = value;
      return true;
    },
  });
}

function copyOnWriteArray<T>(base: T[], parent?: () => void): T[] {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache = Array<T | typeof DELETED>(base.length);
  let clean = true;
  let full = false;

  function mark() {
    if (clean) {
      clean = false;
      if (parent) parent();
    }
  }

  function dirty1(n: number) {
    if (full) return cache[n];
    if (Object.hasOwn(cache, n)) {
      const out = cache[n];
      return out !== DELETED ? out : undefined;
    }
    if (!Object.hasOwn(base, n)) return undefined;
    const ro = copyOnWrite(base[n]);
    cache[n] = ro;
    return ro;
  }

  function dirtyAll() {
    if (full) return cache;
    full = true;
    // use Object.keys() instead of .keys() to preserve holes
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(cache, key)) {
        cache[key as any] = copyOnWrite(base[key as any], mark);
      }
    }
    // to make things like iteration easy, we remove DELETED after we iterate
    for (const [key, value] of Object.entries(cache)) {
      if (value === DELETED) delete cache[key as any];
    }
    return cache;
  }

  const cowArrayMethods: any = {
    // special
    at: (index: number) => dirty1(index > -1 ? index : base.length + index),
    push: (...args: any[]) => (mark(), cache.push(...args)),

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

    // mutators that require a dirtyAll() due to possible index changes
    pop: (...args: any) => (mark(), base.pop.apply(dirtyAll(), args)),
    reverse: (...args: any) => (mark(), base.reverse.apply(dirtyAll(), args)),
    copyWithin: (...args: any) => (mark(), base.copyWithin.apply(dirtyAll(), args)),
    fill: (...args: any) => (mark(), base.fill.apply(dirtyAll(), args)),
    sort: (...args: any) => (mark(), base.sort.apply(dirtyAll(), args)),
    splice: (...args: any) => (mark(), base.splice.apply(dirtyAll(), args)),
    shift: (...args: any) => (mark(), base.shift.apply(dirtyAll(), args)),
    unshift: (...args: any) => (mark(), base.unshift.apply(dirtyAll(), args)),

    // getters which don't HAVE to cowify the whole array, but would need something about as expensive
    toLocaleString: (...args: any) => base.toLocaleString.apply(dirtyAll(), args),
    toString: (...args: any) => base.toString.apply(dirtyAll(), args),
    join: (...args: any) => base.join.apply(dirtyAll(), args),

    // getters which work against cache as-is
    keys: () => cache.keys(),

    // getters which can operate on a frankenstein array where base is prototype of cache
    includes: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).includes(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
    indexOf: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).indexOf(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
    lastIndexOf: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).lastIndexOf(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
  };
  Object.setPrototypeOf(cowArrayMethods, null);

  function copy() {
    if (clean) return deepCopy(base);
    if (full) return deepCopy(cache);
    const out = Array(cache.length);
    for (const [key, value] of Object.entries(base)) {
      if (!Object.hasOwn(cache, key)) out[key as any] = deepCopy(value);
    }
    for (const [key, value] of Object.entries(cache)) {
      if (value !== DELETED) out[key as any] = deepCopy(value);
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    if (full) {
      const out = Array(cache.length);
      for (const [key, val] of Object.entries(cache)) {
        out[key as any] = recover(val);
      }
      return out;
    }
    const out = Array(cache.length);
    for (const [key, val] of Object.entries(base)) {
      if (!Object.hasOwn(cache, key)) out[key as any] = val;
    }
    for (const [key, val] of Object.entries(cache)) {
      if (val !== DELETED) out[key as any] = recover(val);
    }
    return out;
  }

  return new Proxy(base, {
    defineProperty() {
      throw new Error('not supported by copyOnWrite');
    },

    deleteProperty(_, prop: any) {
      if (full) {
        if (Object.hasOwn(base, prop)) mark();
        delete cache[prop];
        return true;
      }
      mark();
      cache[prop] = DELETED;
      return true;
    },

    getOwnPropertyDescriptor(_, prop: any) {
      if (full) return Object.getOwnPropertyDescriptor(cache, prop);
      if (cache[prop] === DELETED) return undefined;
      return (
        Object.getOwnPropertyDescriptor(cache, prop) ?? Object.getOwnPropertyDescriptor(base, prop)
      );
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      // special logic if we have no more DELETEDs in cache
      if (full) {
        if (Object.hasOwn(cache, prop)) {
          return cache[prop];
        }
        const method = cowArrayMethods[prop];
        if (method) return method;
        return cache[prop];
      }

      // lookup value in cache first
      if (Object.hasOwn(cache, prop)) {
        const value = cache[prop];
        return value !== DELETED ? value : undefined;
      }
      // then get cacheable value from base
      if (Object.hasOwn(base, prop)) {
        const value = copyOnWrite(base[prop], mark);
        cache[prop] = value;
        return value;
      }

      // get methods
      const method = cowArrayMethods[prop];
      if (method) return method;

      const value = base[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      if (full) return Object.hasOwn(cache, prop);
      if (Object.hasOwn(cache, prop)) return cache[prop] !== DELETED;
      return prop in base;
    },

    ownKeys() {
      if (full) return Object.getOwnPropertyNames(cache);
      const out = ['length'];
      for (const key of Object.keys(base)) {
        if (cache[key as any] === DELETED) continue;
        out.push(key);
      }
      for (const key of Object.keys(cache)) {
        if (Object.hasOwn(base, key)) continue;
        if (cache[key as any] !== DELETED) out.push(key);
      }
      return out;
    },

    set(_, prop: any, value: T) {
      mark();
      cache[prop] = value;
      return true;
    },
  });
}

function copyOnWriteMap<K, V>(base: Map<K, V>, parent?: () => void): Map<K, V> {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache: Map<K, V | typeof DELETED> = new Map();
  let clean = true;
  let full = false;
  let ndeletions = 0;
  let noverlap = 0;

  function size() {
    if (full) return cache.size;
    return base.size + cache.size - ndeletions - noverlap;
  }

  function mark() {
    if (clean) {
      clean = false;
      if (parent) parent();
    }
  }

  function dirty1(k: K) {
    if (full) return cache.get(k);
    if (cache.has(k)) {
      const out = cache.get(k);
      return out !== DELETED ? out : undefined;
    }
    if (!base.has(k)) return undefined;
    const cow = copyOnWrite(base.get(k)!, mark);
    cache.set(k, cow);
    noverlap++;
    return cow;
  }

  function dirtyAll() {
    if (full) return cache;
    full = true;
    const deleted = new Set<K>();
    for (const [k, v] of cache) {
      if (v === DELETED) deleted.add(k);
    }
    for (const [k, v] of base) {
      if (!cache.has(k)) {
        cache.set(k, copyOnWrite(v, mark));
      }
    }
    for (const k of deleted) {
      cache.delete(k);
    }
    ndeletions = 0;
    return cache;
  }

  function copy() {
    if (clean) return deepCopy(base);
    if (full) return deepCopy(cache);
    const out = new Map();
    for (const [key, value] of base.entries()) {
      if (!cache.has(key)) out.set(key, deepCopy(value));
    }
    for (const [key, value] of cache.entries()) {
      if (value !== DELETED) out.set(key, deepCopy(value));
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    // did we already copy all keys and eliminate deletions?
    if (full) {
      const out = new Map();
      for (const [k, v] of cache) {
        out.set(k, recover(v));
      }
      return out;
    }
    // start with a shallow copy
    const out = new Map(base);
    for (const [k, v] of cache) {
      if (v === DELETED) {
        out.delete(k);
      } else {
        out.set(k, recover(v));
      }
    }
    return out;
  }

  let proxy: Map<K, V>;

  // create a one-off methods object, since we have a lot of stuff to bind into it
  const cowMapMethods: any = {
    // special
    get: (key: K) => dirty1(key),
    has: (key: K) => {
      if (full) return cache.has(key);
      if (cache.has(key)) {
        return cache.get(key) !== DELETED;
      }
      return base.has(key);
    },
    clear() {
      mark();
      full = true;
      return cache.clear();
    },

    // requires dirtyAll
    keys: (...args: any) => base.keys.apply(dirtyAll(), args),
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // mutators
    delete: (key: K) => {
      mark();
      if (full) return cache.delete(key);
      const old = cache.get(key);
      if (old === DELETED) return false; // noop; already marked as deleted
      const incache = old !== undefined || cache.has(key);
      if (!base.has(key)) {
        // key not in base: is it newly added to cache, or totally missing?
        if (!incache) return false;
        cache.delete(key);
        return true;
      }
      // key is in base; add a new deletion marker
      cache.set(key, DELETED);
      ndeletions++;
      if (!incache) {
        noverlap++;
      }
      return true;
    },
    getOrInsert: (key: K, defaultValue: V) => {
      let old = cache.get(key);
      if (old === DELETED) {
        // undelete a deleted key
        cache.set(key, defaultValue);
        ndeletions--;
        return defaultValue;
      }
      if (old !== undefined || cache.has(key)) return old;
      // not in cache; check base
      old = base.get(key);
      if (old !== undefined || base.has(key)) return old;
      // not in base either; do an insert
      mark();
      cache.set(key, defaultValue);
      return defaultValue;
    },
    getOrInsertComputed: (key: K, callback: (key: K) => V) => {
      let old = cache.get(key);
      if (old === DELETED) {
        // undelete a deleted key
        const value = callback(key);
        cache.set(key, value);
        ndeletions--;
        return value;
      }
      if (old !== undefined || cache.has(key)) return old;
      // not in cache; check base
      old = base.get(key);
      if (old !== undefined || base.has(key)) return old;
      // not in base either; do an insert
      mark();
      const value = callback(key);
      cache.set(key, value);
      return value;
    },
    set: (key: K, value: V) => {
      mark();
      const old = cache.get(key);
      if (old === DELETED) ndeletions--;
      const incache = old !== undefined || cache.has(key);
      if (!incache && base.has(key)) noverlap++;
      cache.set(key, value);
      // don't return the cache or the base; return the copy-on-write proxy
      return proxy;
    },
  };
  Object.setPrototypeOf(cowMapMethods, null);

  proxy = new Proxy(base, {
    defineProperty() {
      throw new Error('not supported by copyOnWrite');
    },

    deleteProperty() {
      throw new Error('not supported by copyOnWriteMap');
    },

    getOwnPropertyDescriptor() {
      throw new Error('not supported by copyOnWriteMap');
    },

    set() {
      throw new Error('not supported by copyOnWriteMap');
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      if (prop === 'size') return size();

      // get methods
      const method = cowMapMethods[prop];
      if (method) return method;

      const value = (base as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      // we don't support custom own properties or prototypes, so this is sufficient
      return prop in cache;
    },

    ownKeys() {
      // we don't support custom own properties
      return [];
    },
  });

  return proxy;
}

function copyOnWriteSet<K>(base: Set<K>, parent?: () => void) {
  // since we have no child cow objects, as soon as we get an update we do a full copy and use that
  let cache: Set<K> | undefined = undefined;

  return new Proxy(base, {
    defineProperty() {
      throw new Error('not supported by copyOnWrite');
    },

    deleteProperty() {
      throw new Error('not supported by copyOnWriteSet');
    },

    getOwnPropertyDescriptor() {
      throw new Error('not supported by copyOnWriteSet');
    },

    set() {
      throw new Error('not supported by copyOnWriteSet');
    },

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(cache ?? base);
      if (prop === recoverSym) return () => cache ?? base;

      if (prop === 'add' || prop === 'delete' || prop === 'clear') {
        if (cache === undefined) {
          // break the glass
          cache = new Set(base);
          if (parent) parent();
        }
      }

      const value = ((cache ?? base) as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache ?? base, args);
      }
      return value;
    },

    has(_, prop: any) {
      // we don't support custom own properties or prototypes, so this is sufficient
      return prop in (base as any);
    },

    ownKeys(_) {
      // we don't support custom own properties
      return [];
    },
  });
}

// futures ////////////////////////////////////////////////////////////////////

/** A Future is a function that yields nothing, is woken up with nothing, and eventually returns T */
export type Future<T> = Generator<void, T, void>;

/** A FutureContext corresponds to the first generator in our callstack.  Though it may be delegating
    yields to some child generator through yield* statements, when a condition is met to wake up the
    child, the .next() has to be sent to the root generator, not the child (or grandchild).

    FutureContext makes that trivial. */
export class FutureContext {
  #coro: Generator;
  #awake: boolean = false;

  constructor(coro: Generator) {
    this.#coro = coro;
  }

  wakeup() {
    // disallow calls to the base wakeup from inside the base wakeup
    if (this.#awake) return;
    this.#awake = true;
    try {
      this.#coro.next();
    } finally {
      this.#awake = false;
    }
  }

  throw(e: Error) {
    // if we're actually inside the coro, throw the error now
    if (this.#awake) throw e;
    this.#awake = true;
    try {
      this.#coro.throw(e);
    } finally {
      this.#awake = false;
    }
  }
}

// store //////////////////////////////////////////////////////////////////////

// an indexeddb-compatible, transactional key-value store built around generators.
//
// A note about typing: the Store interface must receive a rich value with .set() and return the
// same rich value with .get().
// type value with .get().  It must not matter which implementation of Store is in use.  However,
// most of the access to the store is untyped.  So the store cannot get() and set() the real proto
// values.  Instead, a Store implementation which stores anywhere other than in-memory must do
// the type-to-store conversion internally.  Then any generated typed getters built around the
// Store interface shall be merely typecasting wrappers.

/** Store is the interface for creating read and write transasctions.  An implementation of Store
    is callback-based and should support multiple parallel gets and sets at the API level, even if
    they must be serialized internally.  The run{R,W}Txn functions are used to convert the callback
    interface of WTxn and RTxn to the StoreGenerator protocol.

    The store should accept rich values (including Date, Map, and Set) via .set() and it should
    return rich values with .get(), even if it can't store them.  For sets, encodeProto and
    protoStringify can help lower values to plain json objects or json string.  For gets, the
    generated decoder is passed along with each .get() that can lift values from plain json objects
    to rich objects. */
export interface Store {
  withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T>;
  withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T>;
}

export type StoreValue = { value: unknown } | { err: Error };
export type StoreDone = { value: true } | { err: Error };

/** Every .set can use the same encodeProto, but reads need to know what generated decoder to use.
    null means "identity" */
export type StoreDecoder = null | ((value: unknown) => unknown);

export interface WTxn {
  get(key: string, decoder: StoreDecoder, cb: (result: StoreValue) => void): void;
  set(key: string, value: unknown, cb: (result: StoreDone) => void): void;
  del(key: string, cb: (result: StoreDone) => void): void;
}

export interface RTxn {
  get(key: string, decoder: StoreDecoder, cb: (result: StoreValue) => void): void;
}

export type WStoreQuestion = {
  // keys to look up, plus the generated decoder to take them from plain json -> rich types
  get?: Record<string, StoreDecoder>;
  // key-values to set (no encoder needed; encodeProto or protoStringify work on all storable types)
  set?: Record<string, unknown>;
  // key-values to delete
  del?: Record<string, true>;
};

export type RStoreQuestion = {
  // keys to look up
  get?: Record<string, StoreDecoder>;
};

export type StoreAnswer = {
  // key-value lookup results
  get: Record<string, StoreValue>;
  // keys done setting
  set: Record<string, StoreDone>;
  // keys done deleting
  del: Record<string, StoreDone>;
};

export type WStoreGenerator<T> = Generator<WStoreQuestion, T, StoreAnswer>;
export type RStoreGenerator<T> = Generator<RStoreQuestion, T, StoreAnswer>;

/** function to interact with the StoreGenerator */
export function* txnGet(key: string, decoder: StoreDecoder): RStoreGenerator<unknown> {
  const ans = (yield { get: { [key]: decoder } }).get[key];
  if ('err' in ans) {
    throw ans.err;
  }
  return ans.value;
}

/** a function to interact with the StoreGenerator */
export function* txnSet(key: string, value: unknown): WStoreGenerator<void> {
  const ans = (yield { set: { [key]: value } }).set[key];
  if ('err' in ans) {
    throw ans.err;
  }
}

/** a function to interact with the StoreGenerator */
export function* txnDel(key: string): WStoreGenerator<void> {
  const ans = (yield { del: { [key]: true } }).del[key];
  if ('err' in ans) {
    throw ans.err;
  }
}

/** a function to hide some of the boilerplate of opening a WTxn */
export function* withWTxn<T>(fx: FutureContext, s: Store, fn: () => WStoreGenerator<T>): Future<T> {
  return yield* s.withWTxn(fx, function* (txn) {
    return yield* runWTxn(fx, txn, fn());
  });
}

/** a function to hide some of the boilerplate of opening a RTxn */
export function* withRTxn<T>(fx: FutureContext, s: Store, fn: () => RStoreGenerator<T>): Future<T> {
  return yield* s.withRTxn(fx, function* (txn) {
    return yield* runRTxn(fx, txn, fn());
  });
}

// run a StoreGenerator to completion, converting potentially many parallel callbacks into a
// generator interface.
function* runWTxn<T>(fx: FutureContext, txn: WTxn, g: WStoreGenerator<T>): Future<T> {
  // ignore late callbacks
  let valid = true;
  try {
    let ans: StoreAnswer = { get: {}, set: {}, del: {} };
    let ready = false;
    while (true) {
      const { value, done } = g.next(ans);
      if (done) return value;

      ans = { get: {}, set: {}, del: {} };
      ready = false;

      // start gets
      for (const [key, decoder] of Object.entries(value.get ?? {})) {
        txn.get(key, decoder, (result) => {
          if (!valid) return; // ignore late callback
          ans.get[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // start sets
      for (const [key, val] of Object.entries(value.set ?? {})) {
        txn.set(key, val, (result) => {
          if (!valid) return; // ignore late callback
          ans.set[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // start deletes
      for (const key of Object.keys(value.del ?? {})) {
        txn.del(key, (result) => {
          if (!valid) return; // ignore late callback
          ans.del[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // wait for a result
      while (!ready) yield;
    }
  } finally {
    valid = false;
  }
}

// run a StoreGenerator to completion, converting potentially many parallel callbacks into a
// generator interface.
function* runRTxn<T>(fx: FutureContext, txn: RTxn, g: RStoreGenerator<T>): Future<T> {
  // ignore late callbacks
  let valid = true;
  try {
    let ans: StoreAnswer = { get: {}, set: {}, del: {} };
    let ready = false;
    while (true) {
      const { value, done } = g.next(ans);
      if (done) return value;

      ans = { get: {}, set: {}, del: {} };
      ready = false;

      // start gets
      for (const [key, decoder] of Object.entries(value.get ?? {})) {
        txn.get(key, decoder, (result) => {
          if (!valid) return; // ignore late callback
          ans.get[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // wait for a result
      while (!ready) yield;
    }
  } finally {
    valid = false;
  }
}

export class IndexedDBStore {
  #db: IDBDatabase;
  #store: string;

  constructor(db: IDBDatabase, store: string) {
    this.#db = db;
    this.#store = store;
  }

  *#withTxn<T>(
    fx: FutureContext,
    mode: IDBTransactionMode,
    fn: (txn: WTxn) => Future<T>,
  ): Future<T> {
    // create the transaction
    let ready = false;
    const txn = this.#db.transaction([this.#store], mode);
    txn.onerror = (/*event*/) => {
      // nobody to send the error to, so just crash the coroutine
      fx.throw(new Error('txn failed'));
    };
    txn.onabort = (/*event*/) => {
      ready = true;
      fx.wakeup();
    };
    txn.oncomplete = (/*event*/) => {
      ready = true;
      fx.wakeup();
    };
    const store = txn.objectStore(this.#store);
    const indexedDBTxn = new IndexedDBTxn(store);

    // run the user function
    let result: T;
    try {
      result = yield* fn(indexedDBTxn);
    } catch (e: unknown) {
      txn.abort();
      while (!ready) yield;
      throw e;
    }
    txn.commit();
    while (!ready) yield;
    return result;
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, 'readwrite', fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, 'readonly', fn);
  }
}

class IndexedDBTxn {
  #store: IDBObjectStore;

  constructor(store: IDBObjectStore) {
    this.#store = store;
  }

  get(key: string, _decoder: StoreDecoder, cb: (result: StoreValue) => void): void {
    const req = this.#store.get(key);
    req.onsuccess = () => {
      // IndexedDB does not need decoding
      cb({ value: req.result });
    };
    req.onerror = () => {
      cb({ err: new Error(`failed to look up "${key}"`) });
    };
  }

  set(key: string, value: unknown, cb: (result: StoreDone) => void): void {
    // IndexedDB does not need encoding
    const req = this.#store.put(value, key);
    req.onsuccess = () => {
      cb({ value: true });
    };
    req.onerror = () => {
      cb({ err: new Error(`failed to set "${key}"`) });
    };
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    const req = this.#store.delete(key);
    req.onsuccess = () => {
      cb({ value: true });
    };
    req.onerror = () => {
      cb({ err: new Error(`failed to delete "${key}"`) });
    };
  }
}

export class InMemStore {
  #data: Record<string, unknown>;

  constructor(data?: Record<string, unknown>) {
    this.#data = data !== undefined ? data : {};
  }

  *#withTxn<T>(fn: (txn: WTxn) => Future<T>): Future<T> {
    const updates: Record<string, unknown> = {};
    const txn = new InMemTxn(this.#data, updates);
    // abort case is that we don't catch the exception here:
    const result = yield* fn(txn);
    // commit case
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) {
        delete this.#data[key];
      } else {
        this.#data[key] = val;
      }
    }
    return result;
  }

  *withWTxn<T>(_fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fn);
  }

  *withRTxn<T>(_fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fn);
  }
}

class InMemTxn {
  #data: Record<string, unknown>;
  #updates: Record<string, unknown>;

  constructor(data: Record<string, unknown>, updates: Record<string, unknown>) {
    this.#data = data;
    this.#updates = updates;
  }

  get(key: string, _decoder: StoreDecoder, cb: (result: StoreValue) => void): void {
    if (key in this.#updates) {
      cb({ value: this.#updates[key] });
    } else {
      cb({ value: this.#data[key] });
    }
  }

  set(key: string, value: unknown, cb: (result: StoreDone) => void): void {
    this.#updates[key] = value;
    cb({ value: true });
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    this.#updates[key] = undefined;
    cb({ value: true });
  }
}

export class OverlayStore {
  #base: Store;
  #data: Record<string, unknown> = {};

  constructor(base: Store) {
    this.#base = base;
  }

  keys(): string[] {
    return Object.keys(this.#data);
  }

  *#withTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
    const self = this;
    return yield* this.#base.withRTxn(fx, function* (baseTxn) {
      const updates: Record<string, unknown> = {};
      const txn = new OverlayTxn(baseTxn, self.#data, updates);
      // abort case is that we don't catch the exception here:
      const result = yield* fn(txn);
      // commit case
      for (const [key, val] of Object.entries(updates)) {
        // note: we must keep undefined values rather than propagate deletions to base
        self.#data[key] = val;
      }
      return result;
    });
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, fn);
  }
}

class OverlayTxn {
  #base: RTxn;
  #data: Record<string, unknown>;
  #updates: Record<string, unknown>;

  constructor(base: RTxn, data: Record<string, unknown>, updates: Record<string, unknown>) {
    this.#base = base;
    this.#data = data;
    this.#updates = updates;
  }

  get(key: string, decoder: StoreDecoder, cb: (result: StoreValue) => void): void {
    if (key in this.#updates) {
      cb({ value: this.#updates[key] });
    } else if (key in this.#data) {
      cb({ value: this.#data[key] });
    } else {
      this.#base.get(key, decoder, cb);
    }
  }

  set(key: string, value: unknown, cb: (result: StoreDone) => void): void {
    this.#updates[key] = value;
    cb({ value: true });
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    this.#updates[key] = undefined;
    cb({ value: true });
  }
}

//

type MaybePromise<T> = T | Promise<T>;

/** ExternalStoreTxn is part of ExternalStore. */
export interface ExternalStoreTxn {
  /** get gets a value (specific decoder is provided, if needed) */
  get(key: string, decoder: StoreDecoder): MaybePromise<unknown>;
  /** set sets a value (store backend may call encodeProto if needed) */
  set(key: string, value: unknown): MaybePromise<void>;
  /** del deletes a value */
  del(key: string): MaybePromise<void>;
  /** commit the transaction */
  commit(): MaybePromise<void>;
  /** abort the transaction.  You do not need to call abort() directly; it will be called
      automatically after any of the other methods fail (including if commit() fails). */
  abort(): MaybePromise<void>;
}

/** ExternalStore implements Store with automatic conversions between native return values and
    the generator-based reducers runtime */
export class ExternalStore {
  #txnFn: (writable: boolean) => MaybePromise<ExternalStoreTxn>;

  constructor(txnFn: (writable: boolean) => MaybePromise<ExternalStoreTxn>) {
    this.#txnFn = txnFn;
  }

  *#withTxn<T>(fx: FutureContext, writable: boolean, fn: (txn: WTxn) => Future<T>): Future<T> {
    const toPromise = <P>(p: MaybePromise<P>) => {
      if (p && typeof p === 'object' && 'then' in p && typeof p.then === 'function') {
        return p;
      }
      return {
        then(onFufilled: (result: P) => void) {
          onFufilled(p as P);
        },
      };
    };

    const resolve = function* <P>(p: MaybePromise<P>): Future<P> {
      let val: P;
      let ready = false;
      toPromise(p).then(
        (t) => {
          val = t;
          ready = true;
          fx.wakeup();
        },
        (e: unknown) => {
          fx.throw(e as Error);
        },
      );
      while (!ready) yield;
      return val!;
    };

    const userTxn = yield* resolve(this.#txnFn(writable));
    const txn: WTxn = {
      get: (key: string, decoder: StoreDecoder, cb: (result: StoreValue) => void) => {
        toPromise(userTxn.get(key, decoder)).then(
          (result) => cb({ value: result }),
          (e: unknown) => cb({ err: e as Error }),
        );
      },
      set: (key: string, value: unknown, cb: (result: StoreDone) => void) => {
        toPromise(userTxn.set(key, value)).then(
          () => cb({ value: true }),
          (e: unknown) => cb({ err: e as Error }),
        );
      },
      del: (key: string, cb: (result: StoreDone) => void) => {
        toPromise(userTxn.del(key)).then(
          () => cb({ value: true }),
          (e: unknown) => cb({ err: e as Error }),
        );
      },
    };

    let result: T;
    try {
      result = yield* fn(txn);
      // try to commit
      yield* resolve(userTxn.commit());
    } catch (e: unknown) {
      // abort and re-throw error
      yield* resolve(userTxn.abort());
      throw e;
    }

    return result;
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, true, fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, false, fn);
  }
}

// reducers /////////////////////////////////////////////////////////////////

export type ReducerQuestion = {
  // keys to look up
  old?: Record<string, StoreDecoder>;
  // keys to look up
  get?: Record<string, StoreDecoder>;
  // key-values to set
  set?: Record<string, unknown>;
  // key-values to delete
  del?: Record<string, true>;
};

export type ReducerAnswer = {
  old: Record<string, StoreValue>;
  // key-value lookup results
  get: Record<string, StoreValue>;
  // keys done setting
  set: Record<string, StoreDone>;
  // keys done deleting
  del: Record<string, StoreDone>;
};

export type Reducer<T> = Generator<ReducerQuestion, T, ReducerAnswer>;
// ReducerContext looks like:
// yield* rx.set.project(key, val): set new value (you only get to set it once per txn)
// yield* rx.get.project(key): get the current value for key, possibly setting it from old
// yield* rx.old.project(key): explicitly get the old value for key

/** wrap a Reducer so it acts like a WStoreGenerator, returning a set of updated keys */
export function* runReducer(
  g: Reducer<any[] | void>,
  simulate?: boolean,
): WStoreGenerator<{ updates: string[]; markedSent: any[] }> {
  // our cache of get's we've already completed
  const old: Record<string, unknown> = Object.create(null);
  // our planned sets and dels that we submit at the end
  const cur: Record<string, unknown> = Object.create(null);

  function* finish(retVal: any[]): WStoreGenerator<{ updates: string[]; markedSent: any[] }> {
    const updates = [];
    const question: WStoreQuestion = { get: {}, set: {}, del: {} };
    for (const [k, v] of Object.entries(cur)) {
      if (v === DELETED) {
        question.del![k] = true;
        updates.push(k);
      } else {
        // de-copyOnWrite-ify the value
        const r = recover(v);
        // get the old value
        const o = old[k];
        // detect noop
        if (r === o) continue;
        // otherwise write the value to the store
        updates.push(k);
        question.set![k] = r;
      }
    }
    // are there any store updates to make?
    if (updates.length === 0 || simulate) return { updates, markedSent: retVal };
    let nupdated = 0;
    while (nupdated < updates.length) {
      // actually yield the write request to the store
      const ans = yield question;
      // check every result
      for (const [k, v] of Object.entries(ans.set ?? {})) {
        if ('err' in v) throw new Error(`setting "${k}" after reducer: ${v.err}`);
        nupdated++;
      }
      for (const [k, v] of Object.entries(ans.del ?? {})) {
        if ('err' in v) throw new Error(`deleting "${k}" after reducer: ${v.err}`);
        nupdated++;
      }
    }
    return { updates, markedSent: retVal };
  }

  let ans: ReducerAnswer = { old: {}, get: {}, set: {}, del: {} };
  // inflight is for gets we have submitted but haven't received
  // (you can have many olds or gets in flight simultaneously, but only one set, and it cannot be
  //  simultaneous with any gets)
  const inflight: Record<string, true> = {};
  // pending is for answers we're trying to deliver
  // {key: pending_ops}
  const pending: Record<string, { old?: true; get?: true }> = {};
  let storeQuestion: WStoreQuestion = { get: {}, set: {}, del: {} };

  // run the reducer to completion
  while (true) {
    let ready = true;
    while (ready) {
      const { value, done } = g.next(ans);
      if (done) return yield* finish(value ?? []);

      ans = { old: {}, get: {}, set: {}, del: {} };
      ready = false;

      for (const [key, decoder] of Object.entries(value.old ?? {})) {
        if (key in old) {
          // we already know this one
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.old[key] = { value: old[key] };
          ready = true;
        } else if (!inflight[key]) {
          inflight[key] = true;
          storeQuestion.get![key] = decoder;
          setdefault(pending, key, {}).old = true;
        }
      }

      for (const [key, decoder] of Object.entries(value.get ?? {})) {
        if (key in cur) {
          // value was already set
          // TODO: let copyOnWrite() fork an existing copyOnWrite object, so we don't have to
          //       materialize the updated object until we call finish()
          const cached = cur[key];
          ans.get[key] = { value: recover(cached !== DELETED ? cached : undefined) };
          ready = true;
        } else if (key in old) {
          // we looked this up before
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.get[key] = { value: old[key] };
          ready = true;
        } else if (!inflight[key]) {
          inflight[key] = true;
          storeQuestion.get![key] = decoder;
          setdefault(pending, key, {}).get = true;
        }
      }

      for (const [key, val] of Object.entries(value.set ?? {})) {
        // just store this in memory for now
        cur[key] = val;
        ans.set[key] = { value: true };
        ready = true;
      }

      for (const key of Object.keys(value.del ?? {})) {
        // just store this in memory for now
        cur[key] = DELETED;
        ans.del[key] = { value: true };
        ready = true;
      }
    }

    // interact with the store until we have an answer to return to the reducers
    while (!ready) {
      const storeAnswer = yield storeQuestion;
      storeQuestion = { get: {}, set: {}, del: {} };

      for (const [key, val] of Object.entries(storeAnswer.get)) {
        // cache successful results
        if ('value' in val) old[key] = val.value;
        // done with this query
        delete inflight[key];
        const pnd = pending[key];
        // why did we need this again?
        if (pnd.old) {
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.old[key] = val;
          ready = true;
        }
        if (pnd.get) {
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.get[key] = val;
          ready = true;
        }
        delete pending[key];
      }
    }
  }
}

// queries ////////////////////////////////////////////////////////////////////

/* Example query for loading all comments in a topic:

      let myTopic = ...;
      const q = engine.newQuery(function*(qx: QX) => {
        const uuids = yield* qx.get.topicComments(myTopic);
        const comments = {};
        const toplevels = [];
        for (const uuid of uuids) {
          comments[uuid] = yield* qx.get.comments(uuid);
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
  /** close will stop the query from running again.
      Dependent queries which are not also closed will start crashing. */
  close(): void;
}

/** LocalQuery extends Query with the ability to compose queries by calling awaitResult() inside a
    QueryFunction body.  This isn't possible with typespec-defined Queries, which can only handle
    json-serializable args, not references to existing Query objects. */
export interface LocalQuery<T> extends Query<T> {
  /** awaitResult has no effect when executed outside of a query function */
  awaitResult(): QueryGenerator<T>;
}

export type QueryQuestion = {
  // which keys to look up in the store
  store?: Record<string, StoreDecoder>;
  // which query ids to await their result
  query?: Record<string, true>;
};

export type QueryAnswer = {
  // the value for each store lookup
  store: Record<string, StoreValue>;
  // the {result, dirty} for each asked query
  query: Record<string, { result: unknown; dirty: boolean }>;
};

export type QueryGenerator<T> = Generator<QueryQuestion, T, QueryAnswer>;

export type QueryFunction<QX, T> = (qx: QX) => QueryGenerator<T>;

// graph-facing api, which hides typing info from the graph
interface QueryWrapper<QX> {
  // the id of this query
  id: string;
  closed: boolean; // TODO: somehow use this to fail dependent queries after a query is closed
  // returns `{result, dirty}` indicating if the result and if it changed
  run(
    qx: QX,
    commitKeys: Record<string, true>,
  ): QueryGenerator<{ result: unknown; dirty: boolean }>;
  // call subscribers with the latest result
  notify(): void;
}

class QueryImpl<QX, T> {
  id: string;
  latest: T | undefined = undefined;
  closed: boolean = false;

  #subs: ((val: T) => void)[] = [];

  // {key: true}
  #keyDeps: Record<string, true> = {};
  // {query_id: true}
  #queryDeps: Record<string, true> = {};
  #runs: number = 0;
  #result: T | undefined = undefined;
  #fn: (qx: QX) => QueryGenerator<T>;

  constructor(id: string, fn: QueryFunction<QX, T>) {
    this.id = id;
    this.#fn = fn;
  }

  // part of public api
  *awaitResult(): QueryGenerator<T> {
    // don't try to coordinate our own #result vaule with the graph being executed; just use this as
    // an idiomatic way to ask the graph run for the result from our .id.
    const ans = yield { query: { [this.id]: true } };
    const { result } = ans.query[this.id];
    return result as T;
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

  *#shouldSkip(commitKeys: Record<string, true>): QueryGenerator<boolean> {
    if (this.#runs === 1) {
      // this is our first time; always run
      return false;
    }

    // check if a key dependency was updated
    for (const key of Object.keys(this.#keyDeps)) {
      if (key in commitKeys) return false;
    }

    // check if any query dependency changed its result
    for (const qid of Object.keys(this.#queryDeps)) {
      const ans = yield { query: { [qid]: true } };
      const { dirty } = ans['query'][qid];
      if (dirty) return false;
    }

    return true;
  }

  // part of graph api
  *run(
    qx: QX,
    commitKeys: Record<string, true>,
  ): QueryGenerator<{ result: unknown; dirty: boolean }> {
    // shift current values to old values
    const oldResult = this.#result;
    this.#runs++;

    if (yield* this.#shouldSkip(commitKeys)) {
      return { result: this.#result, dirty: false };
    }

    // rebuild deps
    this.#keyDeps = {};
    this.#queryDeps = {};

    const g = this.#fn(qx);
    let ans: QueryAnswer = { query: {}, store: {} };
    // run query function to completion
    while (true) {
      // pass the current answer to the coroutine
      const { value, done } = g.next(ans);
      if (done) {
        this.#result = value;
        const dirty = this.#runs === 1 || this.#result !== oldResult;
        return { result: this.#result, dirty };
      }
      // capture dependencies before yielding up to the graph for answers
      // {store: {store_key: true}, query: {query_id: true}}
      for (const key of Object.keys(value.store ?? {})) {
        this.#keyDeps[key] = true;
      }
      for (const qid of Object.keys(value.query ?? {})) {
        this.#queryDeps[qid] = true;
      }
      // let the graph provide answers
      ans = yield value;
    }
  }

  // part of graph api
  notify(): void {
    if (this.closed) return;
    for (const sub of this.#subs) {
      sub(this.#result!);
    }
    this.latest = this.#result;
  }
}

/* GraphRun represents one run of the QueryGraph.  Having it as a separate object rather than a
   single generator function (as it once was written) allows a graph to be extended if new queries
   arrive */
class GraphRun<QX> {
  #qx: QX;
  // {key: true}
  #commitKeys: Record<string, true>;

  // the {result, dirty} of queries which have ran
  // {query_id: {result, dirty}}
  #ran: Record<string, { result: unknown; dirty: boolean }> = {};

  constructor(qx: QX, commitKeys: Record<string, true>) {
    this.#qx = qx;
    this.#commitKeys = commitKeys;
  }

  // Run the query graph to completion.
  //
  // run() may be called once after construction against all existing queries, then may be called
  // additional times as new queries are added to the QueryGraph.
  // yields: list of keys, returns callback for users, receives: map of keys to values
  *run(queries: QueryWrapper<QX>[]): RStoreGenerator<() => void> {
    // freeze current query list, in case our caller ever gives us something they intend to mutate
    queries = [...queries];

    // every query which is currently running
    // {query_id: generator}
    const active: Record<string, QueryGenerator<{ result: unknown; dirty: boolean }>> = {};
    // a record of {query_id: answer} to feed to coroutines
    let runnable: Record<string, QueryAnswer> = {};
    // which queries are unblocked by a given answer
    // {answer_key: query_id[]}
    const wantAnswers: Record<string, [StoreDecoder, string[]]> = {};
    // which queries are unblocked by a given query result
    // {query_id: query_id[]}
    const wantResults: Record<string, string[]> = {};

    // start every query in parallel
    for (const q of queries) {
      const g = q.run(this.#qx, this.#commitKeys);
      active[q.id] = g;
      // provide a phony first answer to start the generator off
      runnable[q.id] = { store: {}, query: {} };
    }

    // run the graph to completion
    while (true) {
      // run runnables until we run out; each runnable may unlock other runnables
      while (true) {
        const answers = Object.entries(runnable);
        if (answers.length === 0) break;
        runnable = {};
        for (const [qid, ans] of answers) {
          const { value, done } = active[qid].next(ans);
          if (done) {
            // query finished
            delete active[qid];
            const result = value;
            this.#ran[qid] = result;
            // unblock anybody waiting for this result
            const waiting = wantResults[qid];
            if (waiting !== undefined) {
              delete wantResults[qid];
              for (const id of waiting) {
                setdefault(runnable, id, { query: {}, store: {} }).query[qid] = result;
              }
            }
            continue;
          }
          // query is blocked; handle its store and query questions
          for (const [key, decoder] of Object.entries(value.store ?? {})) {
            setdefault(wantAnswers, key, [decoder, []])[1].push(qid);
          }
          for (const id of Object.keys(value.query ?? {})) {
            // has this query ran yet?
            if (id in this.#ran) {
              // we already have this result
              setdefault(runnable, qid, { query: {}, store: {} }).query[id] = this.#ran[id];
            } else {
              // wake this query up when the other query finishes
              setdefault(wantResults, id, []).push(qid);
            }
          }
        }
      }

      // are we all done?
      if (Object.keys(active).length === 0) break;

      // send all pending questions to the store
      const gets: Record<string, StoreDecoder> = {};
      for (const [key, [decoder]] of Object.entries(wantAnswers)) {
        gets[key] = decoder;
      }
      const answers = (yield { get: gets }).get;

      // process answers
      const answerEntries = Object.entries(answers);
      if (answerEntries.length === 0) {
        throw new Error('empty answer');
      }
      for (const [key, value] of answerEntries) {
        for (const qid of wantAnswers[key][1]) {
          setdefault(runnable, qid, { query: {}, store: {} }).store[key] = value;
        }
        delete wantAnswers[key];
      }
    }

    // return a callback to notify query subscribers
    return () => {
      for (const q of queries) {
        const { dirty } = this.#ran[q.id];
        if (dirty) q.notify();
      }
    };
  }
}

/** QueryGraph is responsible for tracking queries generated by the UI and rerunning them when new
    data is present.  It tracks dependencies of a query function by injecting a query context, which
    provides the actual key-value lookup capability to the function.  It is informed of changes to
    the store by the Midend, such as some keys being updated by the UI, keys of an old overlay being
    discarded, or new forecast data from the UI itself. */
export class QueryGraph<QX> {
  #qx: QX;
  #dirty: Record<string, true> = {};
  #queries: Record<string, QueryWrapper<QX>> = {};
  #newQueries: QueryWrapper<QX>[] = [];
  #id: number = 1;

  #run: GraphRun<QX>;

  constructor(qx: QX) {
    this.#qx = qx;
    // start with an empty graphrun
    this.#run = new GraphRun(this.#qx, {});
  }

  newQuery<T>(fn: QueryFunction<QX, T>): LocalQuery<T> {
    const id = `${this.#id++}`;
    const q = new QueryImpl(id, fn);
    this.#queries[id] = q;
    this.#newQueries.push(q);
    return q;
  }

  dirty(keys: string[]): void {
    for (const key of keys) {
      this.#dirty[key] = true;
    }
  }

  *run(): RStoreGenerator<() => void> {
    // start a new graph run
    const commitKeys = this.#dirty;
    this.#dirty = {};
    this.#run = new GraphRun(this.#qx, commitKeys);

    // #newQueries are already in #queries, so they're no longer new
    this.#newQueries = [];

    // discard closed queries and run all the rest
    const queries: QueryWrapper<QX>[] = [];
    for (const [qid, q] of Object.entries(this.#queries)) {
      if (q.closed) {
        delete this.#queries[qid];
      } else {
        queries.push(q);
      }
    }
    return yield* this.#execute(queries);
  }

  *extend(): RStoreGenerator<() => void> {
    // extend an existing graph run with only new queries
    const queries = this.#newQueries;
    this.#newQueries = [];
    return yield* this.#execute(queries);
  }

  *#execute(queries: QueryWrapper<QX>[]): RStoreGenerator<() => void> {
    /* TODO: put a graph-wide store cache here.  We can keep a new cache and an old cache.  When
       the new cache is hit we return it immediately.  When the old cache is hit, we pop from old,
       place in new, then return.  When we start a new graph run we discard the old old, make the
       old new into the new old, and create a new, empty new.   We'll need something like the
       while loop in GraphRun to return partial answers until we are fully blocked.

       Additional ideas might be:
         - grant individual lookups a cache control flag (true/false/undefined)
         - allow configuring the graph-wide query default cache disposition (true/false)
         - maybe a frequent use cache mode, where we track stats of key lookup usage and cache
           the most frequently used keys
         - nah, just let the cache be a configurable extra layer.  Too many ways to do it.
         - probably force yourself to skip this for now.
    */
    return yield* this.#run.run(queries);
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

// engines ////////////////////////////////////////////////////////////////////

/** Identified wraps a proto type T with a client id.  An Identified event may have originated from
    KurrentDB, or it may have been emitted by a forecaster, or it may be a command we are about to
    send. */
export type Identified<T> = {
  id: string;
  data: T;
};

/** Committed extends Identified with stream position data that originates from KurrentDB. */
export type Committed<T> = Identified<T> & {
  position: number;
};

export function decodeIdentified<T>(val: any, subdecoder: (val: any) => T): Identified<T> {
  return { ...val, data: subdecoder(val.data) } as Identified<T>;
}

export function decodeCommitted<T>(val: any, subdecoder: (val: any) => T): Committed<T> {
  return { ...val, data: subdecoder(val.data) } as Committed<T>;
}

function matchSent<C>(tpl: any, cmd: C): boolean {
  if (typeof tpl !== typeof cmd) return false;
  switch (typeof tpl) {
    case 'boolean':
    case 'bigint':
    case 'number':
    case 'string':
    case 'undefined':
      return tpl === cmd;

    case 'function':
      return tpl(cmd);

    case 'object':
      // null handled here
      if (tpl === null) return cmd === null;
      // general objects handled below
      break;

    case 'symbol':
    default:
      throw new Error(`mark of type "${typeof tpl}" not handled by matchSent`);
  }

  if (Array.isArray(tpl)) {
    if (!Array.isArray(cmd)) return false;
    if (tpl.length !== cmd.length) return false;
    return tpl.every((v, i) => matchSent(v, cmd[i]));
  }

  if (tpl instanceof Map) {
    throw new Error(`mark of type Map not handled by matchSent`);
  }
  if (tpl instanceof Set) {
    throw new Error(`mark of type Set not handled by matchSent`);
  }

  return Object.entries(tpl).every(([k, v]) => matchSent(v, (cmd as Record<string, any>)[k]));
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
*/
export class Engine<QX, RX, E, C> {
  #rx: RX;
  #store: Store;
  #decodeEvent: (raw: any) => E;
  #decodeCommand: (raw: any) => Identified<C>;
  #migrate: null | ((rx: RX) => Reducer<void>);
  #reducer: (rx: RX, events: E[]) => Reducer<any[] | void>;
  #forecaster: null | ((commands: C) => E[]);
  #onCommands: null | ((commands: Identified<any>[]) => void);

  #live: boolean = false;
  #setLive: boolean = false;
  #overlay: OverlayStore;
  #graph: QueryGraph<QX>;
  #coro: Generator<void, void, void>;
  #fx: FutureContext;

  #scheduled: boolean = false;

  // #reconnects is a list of promise resolve functions
  #reconnects: ((value: {
    checkpoint: number | undefined;
    commands: Identified<any>[];
  }) => void)[] = [];
  #recvdEvents: Committed<E>[] = [];
  // commands that came to us from the client
  #sendCommands: C[] = [];
  // command ids the user explicitly marks as completed
  #roundTripped: string[] = [];
  // ordered map of command ids to the forecasted events from that command
  #unsent: Map<string, E[]> = new Map();
  // just a flag if new queries exist to be run; we don't store them here for typing purposes.
  #newQueries: boolean = false;
  #simulates: (() => Reducer<void>)[] = [];

  constructor(
    qx: QX,
    rx: RX,
    // if store is null, InMemStore is used
    store: Store | null,
    callbacks: {
      // injected by generated subclass: convert from json format to full type
      decodeEvent: (raw: any) => E;
      // injected by generated subclass: convert from store/wire format
      decodeCommand: (raw: any) => C;
      // optional: configure store before any events arrive
      migrate?: (rx: RX) => Reducer<void>;
      // required: reduce a batch of events into the read model
      reducer: (rx: RX, events: E[]) => Reducer<void | any[]>;
      // optional: forecast the events a server will send for a batch of commands
      forecaster?: (commands: C) => E[];
      // required if using sendCommands: receive events to send on the wire (in plain-json format)
      onCommands?: (commands: any[]) => void;
    },
  ) {
    this.#rx = rx;
    this.#store = store ?? new InMemStore();
    this.#decodeEvent = callbacks.decodeEvent;
    this.#decodeCommand = (value: any) => decodeIdentified(value, callbacks.decodeCommand);
    this.#migrate = callbacks.migrate ?? null;
    this.#reducer = callbacks.reducer;
    this.#forecaster = callbacks.forecaster ?? null;
    this.#onCommands = callbacks.onCommands ?? null;

    this.#overlay = new OverlayStore(this.#store);
    this.#graph = new QueryGraph(qx);

    this.#coro = this.#advancer();
    this.#fx = new FutureContext(this.#coro);
    // let the advancer begin initializing
    this.#fx.wakeup();
  }

  //// public api ////

  /** request info needed to resume a connection: last committed checkpoint and unsent commands */
  reconnect(
    cb: (result: { checkpoint: number | undefined; commands: Identified<any>[] }) => void,
  ): void {
    this.#reconnects.push(cb);
    this.#schedule();
  }

  /** New events from the wire come here.  They must be in plain json format (the decodeEvent
      callback from the constructor is applied universally to the raw incoming events). */
  recvEvents(raw: Committed<any>[]): void {
    for (const r of raw) {
      const event = decodeCommitted(r, this.#decodeEvent);
      this.#recvdEvents.push(event);
    }
    this.#schedule();
  }

  fellBehind(): void {
    this.#setLive = false;
    this.#schedule();
  }

  caughtUp(): void {
    this.#setLive = true;
    this.#schedule();
  }

  /** After forecasting and saving to the store, these will appear in an onCommands() callback.
      Note that the provided commands should be in rich format (Date, Maps, and Sets all intact),
      but they will be encoded to plain json for the onCommands() callback. */
  sendCommands(commands: C[]): void {
    if (!this.#onCommands) {
      throw new Error('if sendCommands() is used, the onCommands callback is required');
    }
    this.#sendCommands.push(...commands);
    this.#schedule();
  }

  /** normally forecasted events are discarded when the event id that was submitted is observed in
      recvEvents().  But if the command was rejected, then it may be necessary to explicitly flag the
      command as sent, so the forecasted events from that rejected command can be discarded. */
  markSent(...id: string[]): void {
    this.#roundTripped.push(...id);
    this.#schedule();
  }

  /** add a new Query to the graph */
  newQuery<T>(fn: QueryFunction<QX, T>): LocalQuery<T> {
    this.#newQueries = true;
    this.#schedule();
    return this.#graph.newQuery(fn);
  }

  /** simulate runs some events through the provided reducer-like function.  A temporary overlay is
      used and the real Storage is unaffected.  The events should be provided in plain-json format,
      the same as for recvEvents(). */
  simulate<T>(
    fn: (rx: RX, decodedEvents: E[]) => Reducer<T>,
    cb: (result: T) => void,
    undecodedEvents?: Identified<any>[],
  ): void {
    const self = this;
    this.#simulates.push(function* () {
      // unwrap and decode events
      const decoded = (undecodedEvents ?? []).map((u) => self.#decodeEvent(u.data));
      // run provided function
      const result = yield* fn(self.#rx, decoded);
      // send result
      cb(result);
    });
    this.#schedule();
  }

  //// end of public api ////

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.#fx.wakeup();
    });
  }

  *#initialize(): Generator<void, void, void> {
    const self = this;

    // run migration logic on the data store
    if (self.#migrate) {
      yield* withWTxn(this.#fx, this.#store, function* () {
        yield* runReducer(self.#migrate!(self.#rx));
        // ignore updated keys and don't trigger a run of the graph
      });
    }

    // load unsent commands from the store
    const encoded: Identified<any>[] = [];
    yield* withRTxn(this.#fx, this.#store, function* () {
      // no decoding needed for `string[]` of command ids
      const index = ((yield* txnGet('.commands', null)) as string[]) ?? [];
      for (const id of index) {
        // commands are stored in their plain json form, which needs no decoding (yet)
        const enc = (yield* txnGet(`.command-${id}`, null)) as Identified<any>;
        encoded.push(enc);
      }
    });
    if (encoded.length === 0) return;

    if (!this.#forecaster) {
      // reload just the list of unset event ids
      for (const enc of encoded) {
        this.#unsent.set(enc.id, []);
      }
      return;
    }

    // reload forecasted state

    const forecasts: E[] = [];
    for (const enc of encoded) {
      // at this point we must decode the commands (which we stored in encoded form)
      const command = this.#decodeCommand(enc);
      // note that since the store may be in-memory, we must take care to preserve command.data
      const c = copyOnWrite(command.data);
      const fs = recover(this.#forecaster(c));
      this.#unsent.set(command.id, fs);
      forecasts.push(...fs);
    }
    if (forecasts.length === 0) return;

    // populate the initial overlay
    yield* withWTxn(this.#fx, this.#overlay, function* () {
      yield* runReducer(self.#reducer(self.#rx, forecasts));
      // ignore updated keys and don't trigger a run of the graph
    });
  }

  // our main logic is implemented as a coroutine
  *#advancer(): Generator<void, void, void> {
    yield* this.#initialize();

    // what are the different things we can have to do?
    // - receive events,
    //     - then shape them,
    //     - then pass shaped events into reducers,
    //     - then commit that result along with the checkpoint,
    //     - then take the commit and pass it to the query graph
    // - recieve sentCommands and update commands in the store
    // - receive sendCommands
    //     - then commit them to the store,
    //         - then send those to onCommands hook
    //     - then forecast events,
    //     - then pass them to reducers,
    //     - then commit that result to the overlay
    //     - then pass that commit to the query graph
    // - recieve a new query
    //     - extend the graph
    // - recieve a reconnect request
    //     - then return the checkpoint in the store
    while (true) {
      if (this.#live && !this.#setLive) {
        // we fell behind; freeze graph and overlay, and when caughtUp() is called, we'll process
        // all changes from now until then with a single run of the graph
        this.#live = false;
      }

      if (this.#recvdEvents.length > 0) {
        yield* this.#onRecvEvents();
        continue;
      }

      if (this.#roundTripped.length > 0) {
        yield* this.#onRoundTripped();
        continue;
      }

      if (!this.#live && this.#setLive) {
        // we caught up and processed all recvdEvents(); time to restart the query graphs
        this.#live = true;
        yield* this.#rebuildOverlay();
        continue;
      }

      if (this.#sendCommands.length > 0) {
        yield* this.#onSendCommands();
        continue;
      }

      if (this.#newQueries && this.#live) {
        yield* this.#onNewQueries();
        continue;
      }

      if (this.#reconnects.length > 0) {
        yield* this.#onReconnects();
        continue;
      }

      if (this.#simulates.length > 0) {
        yield* this.#onSimulates();
        continue;
      }

      // if we got here we probably had a spurious wakeup, or perhaps a newQuery() while not #live
      yield;
    }
  }

  *#onRecvEvents(): Generator<void, void, void> {
    const self = this;
    // take events and latest checkpoint
    const events = this.#recvdEvents;
    const checkpoint = events.at(-1)!.position;
    this.#recvdEvents = [];

    // open a write txn to the real store
    const updates = yield* withWTxn(this.#fx, this.#store, function* () {
      // update our checkpoint when this txn finishes
      yield* txnSet('.checkpoint', checkpoint);

      // run the reducer with our new events
      const eventsData = events.map((event) => event.data);
      const { updates, markedSent } = yield* runReducer(self.#reducer(self.#rx, eventsData));

      // discard unsent commands that we now know are sent
      if (self.#unsent.size > 0) {
        // discard commands we observed round-trip by matching event ids
        for (const event of events) {
          if (self.#unsent.has(event.id)) {
            self.#roundTripped.push(event.id);
          }
        }
        // discard commands that match what the reducer says was sent
        if (markedSent.length > 0) {
          const toIgnore = self.#roundTripped.reduce(
            (acc, id) => ((acc[id] = true), acc),
            {} as Record<string, true>,
          );
          for (const id of self.#unsent.keys()) {
            if (id in toIgnore) continue;
            // commands are stored pre-encoded, so no decoder needed to load from store
            const enc = (yield* txnGet(`.command-${id}`, null)) as Identified<C>;
            for (const m of markedSent) {
              // but we need to decode it to run matchSent
              if (!matchSent(m, self.#decodeCommand(enc).data)) continue;
              self.#roundTripped.push(enc.id);
              break;
            }
          }
        }
      }
      // discard commands based on calls to Engine.markSent()
      yield* self.#discardRoundTripped();

      return updates;
    });
    this.#graph.dirty(updates);
    this.#roundTripped.map((id) => this.#unsent.delete(id));
    this.#roundTripped = [];

    if (this.#live) {
      yield* this.#rebuildOverlay();
    }
  }

  *#rebuildOverlay(): Generator<void, void, void> {
    const self = this;

    // discard old overlay, start a new one
    this.#graph.dirty(this.#overlay.keys());
    this.#overlay = new OverlayStore(this.#store);

    // rebuild overlay with current forecasts
    const forecasts = [...this.#unsent.values()].flat();
    if (forecasts.length > 0) {
      const { updates } = yield* withWTxn(this.#fx, this.#overlay, function* () {
        return yield* runReducer(self.#reducer(self.#rx, forecasts));
      });
      self.#graph.dirty(updates);
    }

    const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
      // this will run all queries, even new ones
      self.#newQueries = false;
      return yield* self.#graph.run();
    });
    cbs();
  }

  *#onSendCommands(): Generator<void, void, void> {
    const self = this;
    // generate a uuid now for each event
    const commands: Identified<C>[] = this.#sendCommands.map((c) => ({
      id: generateUuid(),
      data: c,
    }));
    this.#sendCommands = [];

    // encode once now for both storage and the onCommands callback
    const encoded = commands.map(encodeProto);

    // open a write txn to the real store
    yield* withWTxn(this.#fx, this.#store, function* () {
      const added = [];
      // write each command to the store
      for (const enc of encoded) {
        yield* txnSet(`.command-${enc.id}`, enc);
        added.push(enc.id);
      }
      // update the index (which needs no encoder)
      const index = ((yield* txnGet('.commands', null)) as string[]) ?? [];
      yield* txnSet('.commands', [...index, ...added]);
    });

    // schedule a callback for the user to know it is time to send these commands
    setTimeout(() => this.#onCommands!(deepCopy(encoded)));

    // store those commands as unsent

    // now forecast events based on those commands
    if (!this.#forecaster) {
      for (const command of commands) {
        this.#unsent.set(command.id, []);
      }
      return;
    }

    const forecasts: E[] = [];
    for (const command of commands) {
      const c = copyOnWrite(command.data);
      const fs = recover(this.#forecaster(c));
      this.#unsent.set(command.id, fs);
      forecasts.push(...fs);
    }

    if (forecasts.length === 0 || !this.#live) return;

    // open a write txn against the existing overlay
    const { updates } = yield* withWTxn(this.#fx, this.#overlay, function* () {
      return yield* runReducer(self.#reducer(self.#rx, forecasts));
    });
    this.#graph.dirty(updates);

    const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
      // this will run all queries, even new ones
      self.#newQueries = false;
      return yield* self.#graph.run();
    });
    cbs();
  }

  // discard this.#roundTripped within some externally-provided WTxn
  // (you'll have to erase this.#roundTripped after the txn commits)
  // return true if something was deleted (but it always processes this.#roundTripped)
  *#discardRoundTripped(): WStoreGenerator<boolean> {
    if (this.#roundTripped.length === 0) return false;
    const roundTripped: Record<string, true> = {};
    for (const id of this.#roundTripped) {
      roundTripped[id] = true;
    }
    // load the index of batches of commands
    const index = ((yield* txnGet('.commands', null)) as string[]) ?? [];
    // decide what to delete
    const toDelete = index.filter((id) => roundTripped[id]);
    if (toDelete.length === 0) return false;
    for (const id of toDelete) {
      yield* txnDel(`.command-${id}`);
    }
    // update the index
    const toKeep = index.filter((id) => !roundTripped[id]);
    yield* txnSet('.commands', toKeep);
    return true;
  }

  *#onRoundTripped(): Generator<void, void, void> {
    const self = this;
    const changed = yield* withWTxn(this.#fx, this.#store, function* () {
      return yield* self.#discardRoundTripped();
    });
    this.#roundTripped.map((id) => this.#unsent.delete(id));
    this.#roundTripped = [];
    if (changed && this.#live) {
      yield* this.#rebuildOverlay();
    }
  }

  *#onNewQueries(): Generator<void, void, void> {
    const self = this;
    const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
      self.#newQueries = false;
      return yield* self.#graph.extend();
    });
    cbs();
  }

  *#onReconnects(): Generator<void, void, void> {
    const { checkpoint, commands } = yield* withRTxn(this.#fx, this.#store, function* () {
      const checkpoint = (yield* txnGet('.checkpoint', null)) as number | undefined;
      const commands: Identified<any>[] = [];
      const index = ((yield* txnGet('.commands', null)) as string[]) ?? [];
      for (const id of index) {
        // commands are stored pre-encoded and need no decoder
        const enc = (yield* txnGet(`.command-${id}`, null)) as Identified<any>;
        commands.push(enc);
      }
      return { checkpoint, commands };
    });
    for (const resolve of this.#reconnects) {
      resolve({ checkpoint, commands: deepCopy(commands) });
    }
    this.#reconnects = [];
  }

  *#onSimulates(): Generator<void, void, void> {
    const simulates = this.#simulates;
    this.#simulates = [];
    // use a single read txn for all simulations, since runReducer() with simulate=true doesn't write
    yield* withRTxn(this.#fx, this.#store, function* () {
      for (const fn of simulates) {
        yield* runReducer(fn(), true);
      }
    });
  }
}

export class ReducerTester<RX, E, S> {
  #rx: RX;
  #reducer: (rx: RX, events: E[]) => Reducer<void | any[]>;
  #store: InMemStore;
  data: S;

  constructor(
    rx: RX,
    migrate: null | ((rx: RX) => Reducer<void>),
    reducer: (rx: RX, events: E[]) => Reducer<void | any[]>,
    store: InMemStore,
    testData: S,
  ) {
    this.#rx = rx;
    this.#reducer = reducer;
    this.#store = store;
    this.data = testData;

    if (migrate) {
      this.#run(migrate(rx));
    }
  }

  #run(g: Reducer<void | any[]>): { updates: string[]; markedSent: any[] } {
    // do the "FutureContext" dance.
    let fx: FutureContext;
    let result: { updates: string[]; markedSent: any[] } | undefined = undefined;
    const self = this;
    const coro = (function* () {
      result = yield* withWTxn(fx!, self.#store, function* () {
        return yield* runReducer(g, false);
      });
    })();
    fx = new FutureContext(coro);

    // with InMemStore, this should always be completed in a single shot
    fx.wakeup();
    if (!result) {
      throw new Error('expected test coroutine to complete in one shot');
    }
    return result;
  }

  /** run events against provided reducer */
  run(events: E[]): { updates: string[]; markedSent: any[] } {
    const g = this.#reducer(this.#rx, events);
    const { updates, markedSent } = this.#run(g);
    updates.sort();
    return { updates, markedSent };
  }
}

// end of skeleton ////////////////////////////////////////////////////////////
