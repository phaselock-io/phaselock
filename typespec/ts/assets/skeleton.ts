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

// A transactional key-value store built around generators, with values that travel as bundles
// of representations and a Registry that converts between them.

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
    Engine's own shapes; `.command` for the outbox envelope, its `data` converted through the
    commands union; and `.event` for a parked event, the wire pair `[env, data]` in `msgpack` and a
    DbEvent in `js`, its `data` converted through the union of the stream's slice. */
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

export type StoreResult = { value: StoreValue | undefined } | { err: Error };
export type StoreDone = { value: true } | { err: Error };
// the keys a prefix operation touched, for query invalidation
export type StoreKeys = { keys: string[] } | { err: Error };

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
export type StoreScan =
  | { entries: [string, StoreValue | undefined][]; next: string | null }
  | { err: Error };

/** the exclusive upper bound of the keys sharing prefix; undefined for the empty prefix */
export function prefixEnd(prefix: string): string | undefined {
  if (prefix === '') return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/** the range covering every key under a prefix */
export function prefixRange(prefix: string, limit: number, values: StoreRange['values']): StoreRange {
  const end = prefixEnd(prefix);
  return end === undefined ? { gte: prefix, limit, values } : { gte: prefix, lt: end, limit, values };
}

export interface RTxn {
  /** the value at key in the wanted representation, converted by the store */
  get(key: string, type: string, want: Wants, cb: (result: StoreResult) => void): void;
  scan(range: StoreRange, cb: (result: StoreScan) => void): void;
}

export interface WTxn extends RTxn {
  /** persist the value in the representation the store keeps, converting from the one given */
  set(key: string, type: string, value: StoreValue, cb: (result: StoreDone) => void): void;
  del(key: string, cb: (result: StoreDone) => void): void;
  /** delete every key under prefix; reports the keys deleted */
  delPrefix(prefix: string, cb: (result: StoreKeys) => void): void;
  /** rekey every key under src to dst, never decoding a value; reports the keys as they now
      exist.  Callers never rekey into the source range. */
  move(src: string, dst: string, cb: (result: StoreKeys) => void): void;
}

/** Store is the interface for creating read and write transactions.  An implementation is
    callback-based and should support multiple parallel operations at the API level, even if it
    must serialize them internally.  A store holds a Registry and does its own conversions, in
    the host language.  The runTxn function converts the callback interface of WTxn and RTxn to
    the StoreGenerator protocol. */
export interface Store {
  withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T>;
  withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T>;
}

export type RStoreQuestion = {
  // keys to look up: their type, and the representation wanted back
  get?: Record<string, { type: string; want: Wants }>;
  // ranges to walk, one batch each
  scan?: Record<string, StoreRange>;
};

export type WStoreQuestion = RStoreQuestion & {
  // key-values to set, with their type; any corner is accepted
  set?: Record<string, { type: string; value: StoreValue }>;
  // keys to delete
  del?: Record<string, true>;
  // prefixes to delete
  delPrefix?: Record<string, true>;
  // prefixes to rekey: src -> dst
  move?: Record<string, string>;
};

export type StoreAnswer = {
  // key-value lookup results, in the wanted representation
  get: Record<string, StoreResult>;
  // keys done setting
  set: Record<string, StoreDone>;
  // keys done deleting
  del: Record<string, StoreDone>;
  // prefixes deleted, with the keys that went
  delPrefix: Record<string, StoreKeys>;
  // prefixes moved, keyed by src, with the keys as they now exist under dst
  move: Record<string, StoreKeys>;
  // one batch per asked range
  scan: Record<string, StoreScan>;
};

const emptyAnswer = (): StoreAnswer => ({ get: {}, set: {}, del: {}, delPrefix: {}, move: {}, scan: {} });

export type WStoreGenerator<T> = Generator<WStoreQuestion, T, StoreAnswer>;
export type RStoreGenerator<T> = Generator<RStoreQuestion, T, StoreAnswer>;

/** the value at key in the one wanted representation, undefined when absent */
export function* txnGet(key: string, type: string, want: Wants = JS): RStoreGenerator<unknown> {
  const ans = (yield { get: { [key]: { type, want } } }).get[key];
  if ('err' in ans) throw ans.err;
  return ans.value === undefined ? undefined : (ans.value as Record<number, unknown>)[want];
}

export function* txnSet(key: string, type: string, value: StoreValue): WStoreGenerator<void> {
  const ans = (yield { set: { [key]: { type, value } } }).set[key];
  if ('err' in ans) throw ans.err;
}

export function* txnDel(key: string): WStoreGenerator<void> {
  const ans = (yield { del: { [key]: true } }).del[key];
  if ('err' in ans) throw ans.err;
}

/** delete every key under prefix; returns the keys deleted */
export function* txnDelPrefix(prefix: string): WStoreGenerator<string[]> {
  const ans = (yield { delPrefix: { [prefix]: true } }).delPrefix[prefix];
  if ('err' in ans) throw ans.err;
  return ans.keys;
}

/** rekey every key under src to dst; returns the keys as they now exist */
export function* txnMove(src: string, dst: string): WStoreGenerator<string[]> {
  const ans = (yield { move: { [src]: dst } }).move[src];
  if ('err' in ans) throw ans.err;
  return ans.keys;
}

/** one batch of a scan.  Callers loop: resume with `gt: next` (or `lt: next` when reversed)
    until next is null. */
export function* txnScan(
  range: StoreRange,
): RStoreGenerator<{ entries: [string, StoreValue | undefined][]; next: string | null }> {
  const ans = (yield { scan: { s: range } }).scan.s;
  if ('err' in ans) throw ans.err;
  return ans;
}

/** every entry of a range, batch by batch */
export function* txnScanAll(range: StoreRange): RStoreGenerator<[string, StoreValue | undefined][]> {
  const all: [string, StoreValue | undefined][] = [];
  let r = range;
  for (;;) {
    const { entries, next } = yield* txnScan(r);
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

/** a function to hide some of the boilerplate of opening a WTxn */
export function* withWTxn<T>(fx: FutureContext, s: Store, fn: () => WStoreGenerator<T>): Future<T> {
  return yield* s.withWTxn(fx, function* (txn) {
    return yield* runTxn(fx, txn, fn());
  });
}

/** a function to hide some of the boilerplate of opening a RTxn */
export function* withRTxn<T>(fx: FutureContext, s: Store, fn: () => RStoreGenerator<T>): Future<T> {
  return yield* s.withRTxn(fx, function* (txn) {
    return yield* runTxn(fx, txn, fn());
  });
}

const writeOps = ['set', 'del', 'delPrefix', 'move'] as const;

// run a StoreGenerator to completion, converting potentially many parallel callbacks into a
// generator interface.  Write questions require a transaction with write methods.
function* runTxn<T>(fx: FutureContext, txn: RTxn, g: WStoreGenerator<T>): Future<T> {
  // ignore late callbacks
  let valid = true;
  try {
    let ans = emptyAnswer();
    let ready = false;
    const done = () => {
      ready = true;
      fx.wakeup();
    };
    while (true) {
      const { value, done: finished } = g.next(ans);
      if (finished) return value;

      ans = emptyAnswer();
      ready = false;

      for (const op of writeOps) {
        if (value[op] !== undefined && !(op in txn)) {
          throw new Error(`${op} in a read transaction`);
        }
      }
      const wtxn = txn as WTxn;

      for (const [key, { type, want }] of Object.entries(value.get ?? {})) {
        txn.get(key, type, want, (result) => {
          if (!valid) return;
          ans.get[key] = result;
          done();
        });
      }
      for (const [key, { type, value: val }] of Object.entries(value.set ?? {})) {
        wtxn.set(key, type, val, (result) => {
          if (!valid) return;
          ans.set[key] = result;
          done();
        });
      }
      for (const key of Object.keys(value.del ?? {})) {
        wtxn.del(key, (result) => {
          if (!valid) return;
          ans.del[key] = result;
          done();
        });
      }
      for (const prefix of Object.keys(value.delPrefix ?? {})) {
        wtxn.delPrefix(prefix, (result) => {
          if (!valid) return;
          ans.delPrefix[prefix] = result;
          done();
        });
      }
      for (const [src, dst] of Object.entries(value.move ?? {})) {
        wtxn.move(src, dst, (result) => {
          if (!valid) return;
          ans.move[src] = result;
          done();
        });
      }
      for (const [id, range] of Object.entries(value.scan ?? {})) {
        txn.scan(range, (result) => {
          if (!valid) return;
          ans.scan[id] = result;
          done();
        });
      }

      // wait for a result
      while (!ready) yield;
    }
  } finally {
    valid = false;
  }
}

// in-memory layers /////////////////////////////////////////////////////////

// The in-memory and overlay stores keep rich js values, converting through the Registry on the
// way in and out, in a base map plus a map of pending updates (undefined marks a deletion), and
// answer range operations by sorting keys.

type Layer = Record<string, unknown>;

/** the read half of a transaction object, what a read transaction hands out */
function readHalf(txn: RTxn): RTxn {
  return { get: (...a) => txn.get(...a), scan: (...a) => txn.scan(...a) };
}

// the js value to keep for a set, and the wanted representation of a kept value
function toJs(reg: Registry, type: string, value: StoreValue): unknown {
  return (reg.convert(type, value, JS) as Record<number, unknown>)[JS];
}
function fromJs(reg: Registry, type: string, js: unknown, want: Wants): StoreValue {
  return reg.convert(type, { [JS]: js }, want);
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

export class InMemStore {
  #reg: Registry;
  #data: Layer;

  constructor(reg: Registry, data?: Record<string, unknown>) {
    this.#reg = reg;
    this.#data = data !== undefined ? data : {};
  }

  *#withTxn<T>(writable: boolean, fn: (txn: WTxn) => Future<T>): Future<T> {
    const updates: Layer = {};
    const txn = new InMemTxn(this.#reg, this.#data, updates);
    // abort case is that we don't catch the exception here:
    const result = yield* fn(writable ? txn : (readHalf(txn) as WTxn));
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
    return yield* this.#withTxn(true, fn);
  }

  *withRTxn<T>(_fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(false, fn);
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

  get(key: string, type: string, want: Wants, cb: (result: StoreResult) => void): void {
    const js = layerGet(this.#data, this.#updates, key);
    cb({ value: js === undefined ? undefined : fromJs(this.#reg, type, js, want) });
  }

  set(key: string, type: string, value: StoreValue, cb: (result: StoreDone) => void): void {
    this.#updates[key] = toJs(this.#reg, type, value);
    cb({ value: true });
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    this.#updates[key] = undefined;
    cb({ value: true });
  }

  delPrefix(prefix: string, cb: (result: StoreKeys) => void): void {
    cb({ keys: layerDelPrefix(this.#data, this.#updates, prefix) });
  }

  move(src: string, dst: string, cb: (result: StoreKeys) => void): void {
    try {
      cb({ keys: layerMove(this.#data, this.#updates, src, dst) });
    } catch (e: unknown) {
      cb({ err: e as Error });
    }
  }

  scan(range: StoreRange, cb: (result: StoreScan) => void): void {
    const keys = layerKeys(this.#data, this.#updates, range);
    cb(batch(this.#reg, keys, range, (k) => layerGet(this.#data, this.#updates, k)));
  }
}

export class OverlayStore {
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

  *#withTxn<T>(fx: FutureContext, writable: boolean, fn: (txn: WTxn) => Future<T>): Future<T> {
    // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
    const self = this;
    return yield* this.#base.withRTxn(fx, function* (baseTxn) {
      const updates: Layer = {};
      const txn = new OverlayTxn(self.#reg, baseTxn, self.#data, updates);
      // abort case is that we don't catch the exception here:
      const result = yield* fn(writable ? txn : (readHalf(txn) as WTxn));
      // commit case
      for (const [key, val] of Object.entries(updates)) {
        // note: we must keep undefined values rather than propagate deletions to base
        self.#data[key] = val;
      }
      return result;
    });
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, true, fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, false, fn);
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

  get(key: string, type: string, want: Wants, cb: (result: StoreResult) => void): void {
    if (this.#has(key)) {
      const js = layerGet(this.#data, this.#updates, key);
      cb({ value: js === undefined ? undefined : fromJs(this.#reg, type, js, want) });
    } else {
      this.#base.get(key, type, want, cb);
    }
  }

  set(key: string, type: string, value: StoreValue, cb: (result: StoreDone) => void): void {
    this.#updates[key] = toJs(this.#reg, type, value);
    cb({ value: true });
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    this.#updates[key] = undefined;
    cb({ value: true });
  }

  // every key under prefix, from the base and the layers, in walk order
  #keysUnder(prefix: string, cb: (keys: string[] | Error) => void): void {
    const all = new Set<string>();
    const walk = (range: StoreRange) => {
      this.#base.scan(range, (result) => {
        if ('err' in result) return cb(result.err);
        for (const [k] of result.entries) if (!this.#has(k)) all.add(k);
        if (result.next !== null) return walk(resumeRange(range, result.next));
        for (const k of layerKeys(this.#data, this.#updates, prefixRange(prefix, Infinity, false))) all.add(k);
        cb([...all].sort());
      });
    };
    walk(prefixRange(prefix, 1000, false));
  }

  delPrefix(prefix: string, cb: (result: StoreKeys) => void): void {
    this.#keysUnder(prefix, (keys) => {
      if (keys instanceof Error) return cb({ err: keys });
      for (const k of keys) this.#updates[k] = undefined;
      cb({ keys });
    });
  }

  move(src: string, dst: string, cb: (result: StoreKeys) => void): void {
    this.#keysUnder(src, (keys) => {
      if (keys instanceof Error) return cb({ err: keys });
      const moved: string[] = [];
      let pending = 0;
      let failed = false;
      const finish = () => {
        if (pending === 0 && !failed) cb({ keys: moved });
      };
      for (const k of keys) {
        const to = dst + k.slice(src.length);
        moved.push(to);
        if (this.#has(k)) {
          this.#updates[to] = layerGet(this.#data, this.#updates, k);
          this.#updates[k] = undefined;
          continue;
        }
        // a base key: copy its value up into the layer under the new name, as the base holds it
        pending++;
        this.#base.get(k, '', 0, (result) => {
          pending--;
          if ('err' in result) {
            failed = true;
            return cb(result);
          }
          this.#updates[to] = result.value === undefined ? undefined : Object.values(result.value)[0];
          this.#updates[k] = undefined;
          finish();
        });
      }
      finish();
    });
  }

  scan(range: StoreRange, cb: (result: StoreScan) => void): void {
    this.#base.scan(range, (result) => {
      if ('err' in result) return cb(result);
      // the span this batch covers: up to its last key when more follow, else the whole range
      const span: StoreRange = { ...range, limit: Infinity };
      if (result.next !== null) {
        if (range.reverse) {
          span.gte = result.next;
        } else {
          span.lte = result.next;
        }
      }
      // the base answers in the wanted representation; layer entries convert here
      const merged = new Map<string, StoreValue | undefined>();
      for (const [k, v] of result.entries) if (!this.#has(k)) merged.set(k, v);
      const v = range.values;
      for (const k of layerKeys(this.#data, this.#updates, span)) {
        const js = layerGet(this.#data, this.#updates, k);
        merged.set(k, v ? fromJs(this.#reg, v.type, js, v.want) : undefined);
      }
      const keys = [...merged.keys()].sort();
      if (range.reverse) keys.reverse();
      const page: StoreScan = {
        entries: keys.slice(0, range.limit).map((k) => [k, merged.get(k)]),
        next: keys.length > range.limit ? keys[range.limit - 1] : null,
      };
      if (!('err' in page) && page.next === null && result.next !== null) page.next = page.entries[page.entries.length - 1][0];
      cb(page);
    });
  }
}

// IndexedDB /////////////////////////////////////////////////////////////////

export class IndexedDBStore {
  #db: IDBDatabase;
  #store: string;
  #reg: Registry;

  constructor(db: IDBDatabase, store: string, reg: Registry) {
    this.#db = db;
    this.#store = store;
    this.#reg = reg;
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
    const indexedDBTxn = new IndexedDBTxn(this.#reg, store);

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

// the IDBKeyRange for a StoreRange, undefined when unbounded
function keyRange(r: StoreRange): IDBKeyRange | undefined {
  const lower = r.gte ?? r.gt;
  const upper = r.lte ?? r.lt;
  const lowerOpen = r.gte === undefined && r.gt !== undefined;
  const upperOpen = r.lte === undefined && r.lt !== undefined;
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return undefined;
}

/** IndexedDBTxn keeps rich js values: structured clone preserves Date, Map, and Set, so the
    store's representation is `js` and it converts only when asked for another. */
class IndexedDBTxn implements WTxn {
  #reg: Registry;
  #store: IDBObjectStore;

  constructor(reg: Registry, store: IDBObjectStore) {
    this.#reg = reg;
    this.#store = store;
  }

  get(key: string, type: string, want: Wants, cb: (result: StoreResult) => void): void {
    const req = this.#store.get(key);
    req.onsuccess = () =>
      cb({ value: req.result === undefined ? undefined : fromJs(this.#reg, type, req.result, want) });
    req.onerror = () => cb({ err: new Error(`failed to look up "${key}"`) });
  }

  set(key: string, type: string, value: StoreValue, cb: (result: StoreDone) => void): void {
    const req = this.#store.put(toJs(this.#reg, type, value), key);
    req.onsuccess = () => cb({ value: true });
    req.onerror = () => cb({ err: new Error(`failed to set "${key}"`) });
  }

  del(key: string, cb: (result: StoreDone) => void): void {
    const req = this.#store.delete(key);
    req.onsuccess = () => cb({ value: true });
    req.onerror = () => cb({ err: new Error(`failed to delete "${key}"`) });
  }

  // walk a range with a cursor; each returns false to stop
  #cursor(
    range: StoreRange,
    each: (cursor: IDBCursorWithValue) => boolean,
    end: (err?: Error) => void,
  ): void {
    const req = this.#store.openCursor(keyRange(range), range.reverse ? 'prev' : 'next');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return end();
      if (each(cursor)) {
        cursor.continue();
      } else {
        end();
      }
    };
    req.onerror = () => end(new Error('cursor failed'));
  }

  delPrefix(prefix: string, cb: (result: StoreKeys) => void): void {
    const keys: string[] = [];
    this.#cursor(
      prefixRange(prefix, Infinity, false),
      (cursor) => {
        keys.push(cursor.key as string);
        cursor.delete();
        return true;
      },
      (err) => cb(err ? { err } : { keys }),
    );
  }

  move(src: string, dst: string, cb: (result: StoreKeys) => void): void {
    const keys: string[] = [];
    this.#cursor(
      prefixRange(src, Infinity, false),
      (cursor) => {
        const to = dst + (cursor.key as string).slice(src.length);
        this.#store.put(cursor.value, to);
        cursor.delete();
        keys.push(to);
        return true;
      },
      (err) => cb(err ? { err } : { keys }),
    );
  }

  scan(range: StoreRange, cb: (result: StoreScan) => void): void {
    const entries: [string, StoreValue | undefined][] = [];
    const v = range.values;
    this.#cursor(
      range,
      (cursor) => {
        entries.push([cursor.key as string, v ? fromJs(this.#reg, v.type, cursor.value, v.want) : undefined]);
        return entries.length < range.limit;
      },
      (err) => {
        if (err) return cb({ err });
        // a full batch may have more behind it; the next batch says if it did
        const next = entries.length === range.limit ? entries[entries.length - 1][0] : null;
        cb({ entries, next });
      },
    );
  }
}

// external stores ///////////////////////////////////////////////////////////

type MaybePromise<T> = T | Promise<T>;

/** ExternalStoreTxn is one transaction of an ExternalStore.  The store converts: it persists
    the representation it keeps and answers in the one wanted, undefined for an absent key. */
export interface ExternalStoreTxn {
  get(key: string, type: string, want: Wants): MaybePromise<StoreValue | undefined>;
  set(key: string, type: string, value: StoreValue): MaybePromise<void>;
  del(key: string): MaybePromise<void>;
  /** delete every key under prefix; returns the keys deleted */
  delPrefix(prefix: string): MaybePromise<string[]>;
  /** rekey every key under src to dst; returns the keys as they now exist */
  move(src: string, dst: string): MaybePromise<string[]>;
  /** one batch of a range walk */
  scan(
    range: StoreRange,
  ): MaybePromise<{ entries: [string, StoreValue | undefined][]; next: string | null }>;
  /** commit the transaction */
  commit(): MaybePromise<void>;
  /** abort the transaction.  You do not need to call abort() directly; it will be called
      automatically after any of the other methods fail (including if commit() fails). */
  abort(): MaybePromise<void>;
}

/** ExternalStore implements Store with automatic conversions between native return values and
    the generator-based store protocol */
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
    // a user method's result or rejection, delivered to a callback
    const deliver = <P, R>(p: MaybePromise<P>, ok: (p: P) => R, cb: (r: R | { err: Error }) => void) => {
      toPromise(p).then(
        (result) => cb(ok(result)),
        (e: unknown) => cb({ err: e as Error }),
      );
    };
    const rtxn: RTxn = {
      get: (key, type, want, cb) => deliver(userTxn.get(key, type, want), (value) => ({ value }), cb),
      scan: (range, cb) => deliver(userTxn.scan(range), (r) => r, cb),
    };
    const txn: WTxn = writable
      ? {
          ...rtxn,
          set: (key, type, value, cb) =>
            deliver(userTxn.set(key, type, value), () => ({ value: true }) as const, cb),
          del: (key, cb) => deliver(userTxn.del(key), () => ({ value: true }) as const, cb),
          delPrefix: (prefix, cb) => deliver(userTxn.delPrefix(prefix), (keys) => ({ keys }), cb),
          move: (src, dst, cb) => deliver(userTxn.move(src, dst), (keys) => ({ keys }), cb),
        }
      : (rtxn as WTxn);

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
  // keys to look up, with their type; the answer is the rich js value
  get?: Record<string, string>;
  // rich js values to set, with their type
  set?: Record<string, { type: string; value: unknown }>;
  // keys to delete
  del?: Record<string, true>;
};

export type ReducerAnswer = {
  // key-value lookup results
  get: Record<string, { value: unknown } | { err: Error }>;
  // keys done setting
  set: Record<string, StoreDone>;
  // keys done deleting
  del: Record<string, StoreDone>;
};

export type Reducer<T> = Generator<ReducerQuestion, T, ReducerAnswer>;

/** wrap a Reducer so it acts like a WStoreGenerator, returning the set of updated keys.
    Reducers work in rich js: every get asks the store for `js` and every set hands it `js`. */
export function* runReducer(g: Reducer<void>): WStoreGenerator<{ updates: string[] }> {
  // our cache of get's we've already completed
  const old: Record<string, unknown> = Object.create(null);
  // our planned sets and dels that we submit at the end
  const cur: Record<string, unknown> = Object.create(null);
  // the type of every key we set, for the store
  const types: Record<string, string> = Object.create(null);

  function* finish(): WStoreGenerator<{ updates: string[] }> {
    const updates = [];
    const question: WStoreQuestion = { set: {}, del: {} };
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
        question.set![k] = { type: types[k], value: { [JS]: r } };
      }
    }
    // are there any store updates to make?
    if (updates.length === 0) return { updates };
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
    return { updates };
  }

  let ans: ReducerAnswer = { get: {}, set: {}, del: {} };
  // inflight is for gets we have submitted but haven't received
  const inflight: Record<string, true> = {};
  let storeQuestion: WStoreQuestion = { get: {} };

  // run the reducer to completion
  while (true) {
    let ready = true;
    while (ready) {
      const { value, done } = g.next(ans);
      if (done) return yield* finish();

      ans = { get: {}, set: {}, del: {} };
      ready = false;

      for (const [key, type] of Object.entries(value.get ?? {})) {
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
          storeQuestion.get![key] = { type, want: JS };
        }
      }

      for (const [key, { type, value: val }] of Object.entries(value.set ?? {})) {
        // just store this in memory for now
        cur[key] = val;
        types[key] = type;
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
      storeQuestion = { get: {} };

      for (const [key, val] of Object.entries(storeAnswer.get)) {
        delete inflight[key];
        if ('err' in val) {
          ans.get[key] = val;
        } else {
          // cache the rich value; undefined for an absent key
          old[key] = val.value === undefined ? undefined : (val.value as Record<number, unknown>)[JS];
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.get[key] = { value: old[key] };
        }
        ready = true;
      }
    }
  }
}

/** runReducers2 runs several slice reducers against one store transaction, one store question
    per step.  It replaces runReducer once the reducer protocol is one ask per yield:

    - ReducerQuestion becomes a union of one ask: { get, type } | { set, type, value } | { del }
    - ReducerAnswer becomes { value } | { err }, a get answering the rich value or undefined
    - each step: step every runnable generator, gather their single asks into one store question,
      yield once, distribute the answers; a get is served from the reducer's own pending writes,
      then its cache, else asked of the store
    - every reducer's write set is merged into one batch at the end, with the noop check against
      the cache as now
    - a single reducer is the N=1 case

    Slices are the axis that parallelizes: their key sets are disjoint by the slice rule, so the
    land reduces many streams at once and IndexedDB pipelines one round trip per step. */
export function* runReducers2(_gs: Reducer<void>[]): WStoreGenerator<{ updates: string[] }> {
  throw new Error('runReducers2 is not built yet');
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
  store: Record<string, StoreResult>;
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
       /command.{ordinal}         Command<C> (`.command`): the outbox, in send order
       /backfill.{ref}            BackfillRecord: an in-flight backfill's until, resume, replacing,
                                  and children
       /backfill-seqs.{ref}       the backfill blob's header seqs, stream name to seq
       /park.ev.{stream}/{seq}    a parked event (`.event`), raw as delivered; seq zero-padded to
                                  20 digits so a stream's range walks its chain
       /park.kv.{ref}/{key}       a slice value from the ref's backfill blob, typed as its key
                                  is, moved to {key} when the backfill lands
*/
/** one slice's reducer and the context it runs in, keyed by stream prefix in the Engine's table */
export type SliceReducer = {
  rx: unknown;
  reducer: (rx: any, events: unknown[]) => Reducer<void>;
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
type BackfillWork = { ref: string; item: BackfillItem; resolve: () => void; reject: (e: unknown) => void };

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
  #forecaster: null | ((qx: QX, command: C) => QueryGenerator<{ stream: string; event: unknown }[] | string>);
  #wants: string[];
  #signal: AbortSignal;

  #overlay: OverlayStore;
  #graph: QueryGraph<QX>;
  #coro: Generator<void, void, void>;
  #fx: FutureContext;
  #scheduled: boolean = false;

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
  // how each backfill() call ended
  #backfillOutcomes: { ref: string; outcome: BackfillOutcome | { failed: unknown } }[] = [];
  // how each sendCommand() call ended, with the ids it carried in order
  #commandOutcomes: { ids: string[]; results: CommandResult[] | { failed: unknown } }[] = [];
  // work received from the app
  #sendCommands: C[] = [];
  #newQueries: boolean = false;
  // the outbox is flushed on every new connection
  #flush: boolean = false;
  // the query context, handed to every query and every forecast
  #qx: QX;

  constructor(
    qx: QX,
    // if store is null, InMemStore is used
    store: Store | null,
    reg: Registry,
    connect: ConnectorFactory,
    callbacks: {
      // injected by generated subclass: each slice's reducer and scoped context, by stream prefix
      reducers: Record<string, SliceReducer>;
      // injected by generated subclass: the refs of the shards the engine declares
      wants: string[];
      // optional: forecast the events the server will mint for a command, by stream, reading the
      // state the earlier outbox commands leave; a string is a rejection
      forecaster?: (qx: QX, command: C) => QueryGenerator<{ stream: string; event: unknown }[] | string>;
      // optional: ends the Engine, its connector, and every backfill
      signal?: AbortSignal;
    },
  ) {
    this.#qx = qx;
    this.#store = store ?? new InMemStore(reg);
    this.#reg = reg;
    this.#connect = connect;
    this.#reducers = callbacks.reducers;
    this.#wants = callbacks.wants;
    this.#forecaster = callbacks.forecaster ?? null;
    this.#signal = callbacks.signal ?? new AbortController().signal;

    this.#overlay = new OverlayStore(this.#store, reg);
    this.#graph = new QueryGraph(qx);

    this.#coro = this.#advancer();
    this.#fx = new FutureContext(this.#coro);
    // let the advancer begin initializing
    this.#fx.wakeup();
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
  newQuery<T>(fn: QueryFunction<QX, T>): LocalQuery<T> {
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
      this.#fx.wakeup();
    });
  }

  // boot: load the persisted state into memory, rebuild the overlay, and connect
  *#initialize(): Generator<void, void, void> {
    const self = this;
    const js = (v: StoreValue) => (v as Record<number, unknown>)[JS];

    yield* withRTxn(this.#fx, this.#store, function* () {
      self.#checkpoint = ((yield* txnGet('/checkpoint', '.json')) as CheckpointRecord | undefined) ?? null;
      self.#view = ((yield* txnGet('/view', '.json')) as ViewRecord | undefined) ?? null;

      // the streams table: seq per held stream, or the marker for a stream under a backfill
      for (const [key, value] of yield* txnScanAll(prefixRange('/seq.', 1000, { type: '.json', want: JS }))) {
        self.#streams.set(key.slice('/seq.'.length), js(value!) as number | 'backfill');
      }

      // the outbox in ordinal order; the next ordinal continues from the last key
      for (const [key, value] of yield* txnScanAll(prefixRange('/command.', 1000, { type: '.command', want: JS }))) {
        const ordinal = Number(key.slice('/command.'.length));
        self.#outbox.set((js(value!) as Command<C>).id, ordinal);
        self.#nextOrdinal = ordinal + 1;
      }

      // backfills in flight, each with a fresh controller
      for (const [key, value] of yield* txnScanAll(prefixRange('/backfill.', 1000, { type: '.json', want: JS }))) {
        const record = js(value!) as BackfillRecord;
        self.#backfills.set(key.slice('/backfill.'.length), {
          record,
          controller: new AbortController(),
          status: 'downloading',
          parent: null,
          attempts: 0,
          retryTimer: null,
        });
        if (record.replacing) self.#replacing++;
      }
    });
    for (const [ref, entry] of this.#backfills) {
      entry.parent = this.#parentOf(ref);
      const r = entry.record;
      if (r.resume?.snapshotDone && r.resume.tailDone) entry.status = 'ready';
    }

    this.#reduced = this.#checkpoint?.reduced ?? -1;

    // the overlay: every outbox command forecast in order against the base
    yield* this.#rebuildOverlay();

    // the first connection attempt
    this.#connectNow = true;
  }

  // the most specific in-flight ref covering ref, other than itself: by the prefix rule any two
  // refs are disjoint or nested, so this is the parent a child backfill merges into
  #parentOf(ref: string): string | null {
    let parent: string | null = null;
    for (const other of this.#backfills.keys()) {
      if (other === ref || !refCovers(other, ref)) continue;
      if (parent === null || other.length > parent.length) parent = other;
    }
    return parent;
  }

  // our main logic is implemented as a coroutine.  Each pass takes one kind of work, does it in
  // its own transactions, and starts over, so the order of the branches is the priority: work
  // that keeps the connector unblocked first, then the stream in order, then everything the
  // stream's arrival implies, then the app.  Anything thrown out of a pass ends the Engine: the
  // transaction rolled back, so the store resumes from the same point on the next start, and
  // memory changed inside a transaction is never read again.  Nothing catches and continues
  *#advancer(): Generator<void, void, void> {
    yield* this.#initialize();

    while (true) {
      if (this.#signal.aborted) {
        // ends the connector and every backfill; nothing runs after
        yield* this.#shutdown();
        return;
      }

      if (this.#backfillWork.length > 0) {
        // header, values, events, and done marks from in-flight backfills: parked in their own
        // transactions, each resolving the connector's promise after commit.  Anytime work: it
        // orders against nothing in the inbox
        yield* this.#onBackfillWork();
        continue;
      }

      if (this.#inbox.length > 0) {
        // the stream, in arrival order: a run of event items is one wave, sorted by stream and
        // reduced with the slices in parallel; a view, vouch, live, or end is handled alone
        yield* this.#onInbox();
        continue;
      }

      if (this.#backfillOutcomes.length > 0) {
        // 'done', 'stale', or a rejection for a backfill: land attempts, retries with resume,
        // discards, and children spawned by chain breaks
        yield* this.#onBackfillOutcomes();
        continue;
      }

      if (this.#commandOutcomes.length > 0) {
        // ack, dup, reject, and conflict from sends: release the outbox and rebuild the overlay
        yield* this.#onCommandOutcomes();
        continue;
      }

      if (this.#sendCommands.length > 0 || this.#flush) {
        // write to the outbox, forecast, send through the connector in order
        yield* this.#onSendCommands();
        continue;
      }

      if (this.#newQueries && this.#live) {
        yield* this.#onNewQueries();
        continue;
      }

      if (this.#connector === null && (this.#connectNow || this.#retryTimer === null)) {
        // one attempt: a new connector from the factory, or the next one after backoff
        this.#onConnect();
        continue;
      }

      // nothing to do: wait for a hook, a timer, or the app
      yield;
    }
  }

  // one connection attempt: the factory is called with the checkpoint, the stored view token,
  // the wants, and this connection's signal.  Its hooks queue everything for the advancer, and a
  // connector that has since been replaced is ignored.  Every backfill still downloading, and not
  // waiting on its own backoff, starts on the new connection
  #onConnect(): void {
    this.#connectNow = false;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
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
    for (const [ref, entry] of this.#backfills) {
      if (entry.status === 'downloading' && entry.retryTimer === null) this.#startBackfill(ref);
    }
    this.#flush = true;
  }

  // one push from a backfill, in its own transaction; the connector's promise resolves after the
  // commit, which is the backpressure
  *#onBackfillWork(): Generator<void, void, void> {
    const self = this;
    while (this.#backfillWork.length > 0) {
      const { ref, item, resolve, reject } = this.#backfillWork.shift()!;
      const entry = this.#backfills.get(ref);
      if (entry === undefined) {
        reject(new Error(`backfill ${ref} is no longer in flight`));
        continue;
      }
      const record = entry.record;
      try {
        yield* withWTxn(this.#fx, this.#store, function* () {
          if ('header' in item) {
            const { position, seqs } = item.header;
            // a resumed tail keeps its floor; a newer blob overrides it
            const fromPosition = Math.max(record.resume?.fromPosition ?? position, position);
            record.resume = { position, skipBytes: 0, fromPosition, snapshotDone: false, tailDone: false };
            yield* txnSet(`/backfill-seqs.${ref}`, '.json', { [JS]: seqs });
          } else if ('values' in item) {
            for (const [key, bytes] of item.values) {
              // a key no slice declares is from a newer vocabulary: dropped
              const type = storeTypeOf(self.#reg, key);
              if (type === undefined) continue;
              yield* txnSet(`/park.kv.${ref}/${key}`, type, { [MSGPACK]: bytes });
              yield* self.#maybeMarkBackfilling(key.slice(0, key.indexOf('/')), record.replacing);
            }
            record.resume!.skipBytes = item.skip;
          } else if ('valuesDone' in item) {
            record.resume!.snapshotDone = true;
          } else if ('events' in item) {
            for (const ev of item.events) {
              yield* txnSet(parkedEventKey(ev.stream, ev.seq), '.event', { [MSGPACK]: ev.raw });
              yield* self.#maybeMarkBackfilling(ev.stream, record.replacing);
              record.resume!.fromPosition = Math.max(record.resume!.fromPosition, ev.position);
            }
          } else if ('tailDone' in item) {
            record.resume!.tailDone = true;
          } else {
            throw new Error("unexpected snapshot");
          }
          yield* txnSet(`/backfill.${ref}`, '.json', { [JS]: record });
        });
        resolve();
      } catch (e: unknown) {
        reject(e);
      }
    }
  }

  // a stream seen under a backfill is marked in the streams table, in memory and at /seq., once.
  // An additive backfill leaves a held stream held and lands around it; a replacing one takes it
  *#maybeMarkBackfilling(stream: string, replacing: boolean): WStoreGenerator<void> {
    const held = this.#streams.get(stream);
    if (held === 'backfill' || (typeof held === 'number' && !replacing)) return;
    this.#streams.set(stream, 'backfill');
    yield* txnSet(`/seq.${stream}`, '.json', { [JS]: 'backfill' });
  }

  // how each backfill() call ended: a finished one waits on its children or is ready to land, a
  // stale one starts its download over, a failed one retries after backoff
  *#onBackfillOutcomes(): Generator<void, void, void> {
    const self = this;
    while (this.#backfillOutcomes.length > 0) {
      const { ref, outcome } = this.#backfillOutcomes.shift()!;
      const entry = this.#backfills.get(ref);
      if (entry === undefined) continue;
      if (outcome === 'done') {
        entry.attempts = 0;
        entry.status = 'ready';
      } else if (outcome === 'stale') {
        // the blob is gone: the parked values go, the parked events stay, and the download starts
        // over under the same `until`
        entry.attempts = 0;
        yield* withWTxn(this.#fx, this.#store, function* () {
          yield* txnDelPrefix(`/park.kv.${ref}/`);
          const r = entry.record.resume;
          if (r !== null) entry.record.resume = { ...r, skipBytes: 0, snapshotDone: false };
          yield* txnSet(`/backfill.${ref}`, '.json', { [JS]: entry.record });
        });
        this.#startBackfill(ref);
      } else {
        // a rejection: ours, if the entry's signal fired; the connection's, if it ended, and the
        // next one restarts the download; else a failure the Engine retries after backoff
        if (entry.controller.signal.aborted) continue;
        entry.status = 'downloading';
        if (this.#connector === null) continue;
        const delay = backoffDelay(entry.attempts++);
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          // the entry may have gone, or the Engine, while the timer ran
          if (self.#backfills.get(ref) === entry && !self.#signal.aborted) self.#startBackfill(ref);
        }, delay);
      }
    }
    yield* this.#tryLand();
  }

  // one backfill() call on the current connector.  Its pushes and its outcome come back through
  // the queues, so nothing here runs a transaction; without a connector nothing starts, and the
  // next connection starts every backfill still downloading
  #startBackfill(ref: string): void {
    const entry = this.#backfills.get(ref)!;
    if (this.#connector === null) return;
    const self = this;
    entry.status = 'downloading';
    const backfill: Backfill = {
      ref,
      until: entry.record.until,
      resume: entry.record.resume,
      signal: AbortSignal.any([this.#connectorAbort.signal, entry.controller.signal]),
      push: (item) =>
        new Promise<void>((resolve, reject) => {
          self.#backfillWork.push({ ref, item, resolve, reject });
          self.#schedule();
        }),
    };
    this.#connector.backfill(backfill).then(
      (outcome) => {
        self.#backfillOutcomes.push({ ref, outcome });
        self.#schedule();
      },
      (e: unknown) => {
        self.#backfillOutcomes.push({ ref, outcome: { failed: e } });
        self.#schedule();
      },
    );
  }

  // land what can land in one transaction.  Chains are checked key-only before anything is
  // written.  A ready child is checked on its own, so a broken one restarts without waiting on
  // its parent.  A top-level ref whose whole subtree is ready is checked as one: a broken stream
  // with an entry restarts it, one without becomes a child, and a clean subtree lands as one.
  // While a replacing backfill is in flight the base is frozen: nothing lands unless every
  // replacing entry is in a landing subtree and the frozen events chain, and then the frozen
  // events land with them, so this is the transaction that unfreezes
  *#tryLand(): Generator<void, void, void> {
    const self = this;
    const frozen = this.#replacing > 0;
    const dirty: string[] = [];
    yield* withWTxn(this.#fx, this.#store, function* () {
      for (const ref of [...self.#backfills.keys()]) {
        const entry = self.#backfills.get(ref)!;
        if (entry.parent === null || entry.status !== 'ready') continue;
        const streams = yield* self.#brokenStreamsIn(ref);
        if (streams.length > 0) yield* self.#repairIn(ref, streams);
      }
      let frozenClean = true;
      if (frozen) {
        const streams = yield* self.#brokenStreamsIn(null);
        if (streams.length > 0) yield* self.#repairIn(null, streams);
        frozenClean = streams.length === 0;
      }
      const clean: string[] = [];
      for (const ref of [...self.#backfills.keys()]) {
        if (self.#backfills.get(ref)!.parent !== null || !self.#landable(ref)) continue;
        const streams = yield* self.#brokenStreamsIn(ref);
        if (streams.length > 0) {
          yield* self.#repairIn(ref, streams);
        } else {
          clean.push(ref);
        }
      }
      if (frozen) {
        const landing = new Set(clean.flatMap((ref) => self.#subtree(ref)));
        const pending = [...self.#backfills].some(
          ([ref, e]) => e.record.replacing && !landing.has(ref)
        );
        if (pending || !frozenClean) return;
      }
      for (const ref of clean) yield* self.#landRefIn(ref, dirty);
      if (frozen) {
        yield* self.#reduceParkedIn(null, {}, dirty);
        yield* self.#reducedTo(self.#checkpoint?.position ?? -1);
      }
    });
    yield* this.#refresh(dirty);
  }

  // a ref's children still in flight
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
  *#headerOf(ref: string): RStoreGenerator<Record<string, number>> {
    return ((yield* txnGet(`/backfill-seqs.${ref}`, '.json')) ?? {}) as Record<string, number>;
  }

  // a subtree's seqs at its cuts: the ref's blob header, each child's laid over it for its
  // streams, the deepest winning
  *#mergedHeaderIn(ref: string): RStoreGenerator<Record<string, number>> {
    let header = yield* this.#headerOf(ref);
    for (const child of this.#childrenOf(ref)) {
      header = { ...header, ...(yield* this.#mergedHeaderIn(child)) };
    }
    return header;
  }

  // key-only: the streams among a subtree's parked events whose chain does not continue from
  // the state that will be in place, or among the frozen events (null) from the held seq.  A
  // stream under some other backfill is not ours and is skipped, and so is an event the base
  // already covers
  *#brokenStreamsIn(ref: string | null): RStoreGenerator<string[]> {
    const header = ref === null ? {} : yield* this.#mergedHeaderIn(ref);
    const broken: string[] = [];
    let range = this.#parkRange(ref, false);
    let stream = '';
    let last = 0;
    for (;;) {
      const { entries, next } = yield* txnScan(range);
      for (const [key] of entries) {
        const park = parsePark(key);
        const held = this.#streams.get(park.stream);
        if (ref === null && held === 'backfill') continue;
        if (park.stream !== stream) {
          stream = park.stream;
          // the base is the newest state in place: the held seq or the cut, whichever is ahead
          last = Math.max(typeof held === 'number' ? held : 0, header[stream] ?? 0);
        }
        // at or below the base the snapshot covers it
        if (park.seq <= last) continue;
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

  // inside a landing transaction: a broken stream with an entry restarts it, the rest become
  // children of the ref checked (null for the frozen events)
  *#repairIn(ref: string | null, streams: string[]): WStoreGenerator<void> {
    const fresh: string[] = [];
    for (const stream of streams) {
      if (this.#backfills.has(stream)) {
        yield* this.#restartIn(stream);
      } else {
        fresh.push(stream);
      }
    }
    if (fresh.length > 0) {
      const replacing = ref !== null && this.#backfills.get(ref)!.record.replacing;
      yield* this.#spawnIn(ref, fresh, this.#checkpoint?.position ?? 0, replacing);
    }
  }

  // inside a landing transaction: a top-level ref's subtree lands as one.  Per stream under the
  // ref, the newest state wins: a held stream at or past the cut keeps its state and its blob
  // values go, any other loses its state to the blob.  Then the values move in, each child's over
  // its parent's for its streams, the parked events reduce per stream from the state in place,
  // and every record and entry of the subtree goes
  *#landRefIn(ref: string, dirty: string[]): WStoreGenerator<void> {
    const header = yield* this.#mergedHeaderIn(ref);
    const subtree = this.#subtree(ref);
    const kept = new Set<string>();
    for (const [stream, held] of this.#streams) {
      if (!refCovers(ref, stream)) continue;
      if (typeof held === 'number' && held >= (header[stream] ?? 0)) {
        kept.add(stream);
        delete header[stream];
        for (const r of subtree) yield* txnDelPrefix(`/park.kv.${r}/${stream}/`);
      } else {
        dirty.push(...(yield* txnDelPrefix(`${stream}/`)));
      }
    }
    yield* this.#moveValuesIn(ref, dirty, kept);
    yield* this.#reduceParkedIn(ref, header, dirty);
    yield* this.#dropIn(ref);
  }

  // inside a landing transaction: a ref's parked values into place, then each child's over them
  // for the streams in the child's blob, the deepest winning; a kept stream is never touched, and
  // a stream only the parent's blob has keeps the parent's values
  *#moveValuesIn(ref: string, dirty: string[], kept: Set<string>): WStoreGenerator<void> {
    dirty.push(...(yield* txnMove(`/park.kv.${ref}/`, '')));
    for (const child of this.#childrenOf(ref)) {
      for (const stream of Object.keys(yield* this.#headerOf(child))) {
        if (!kept.has(stream)) dirty.push(...(yield* txnDelPrefix(`${stream}/`)));
      }
      yield* this.#moveValuesIn(child, dirty, kept);
    }
  }

  // inside a transaction creating a ref: every in-flight top-level ref it covers becomes its
  // child, downloading on in its own values range and landing over the new blob for its streams
  *#adoptChildrenIn(ref: string): WStoreGenerator<void> {
    const entry = this.#backfills.get(ref)!;
    for (const [other, e] of this.#backfills) {
      if (other === ref || e.parent !== null || !refCovers(ref, other)) continue;
      e.parent = ref;
      entry.record.children.push(other);
    }
    yield* txnSet(`/backfill.${ref}`, '.json', { [JS]: entry.record });
  }

  // inside a transaction creating a replacing ref: every held stream under it is marked, since
  // the blob replaces them all and their events park from here
  *#markUnderIn(ref: string): WStoreGenerator<void> {
    for (const [stream, held] of this.#streams) {
      if (typeof held === 'number' && refCovers(ref, stream)) {
        yield* this.#maybeMarkBackfilling(stream, true);
      }
    }
  }

  // inside a landing transaction: a subtree's records and entries go
  *#dropIn(ref: string): WStoreGenerator<void> {
    for (const child of this.#childrenOf(ref)) yield* this.#dropIn(child);
    yield* txnDel(`/backfill.${ref}`);
    yield* txnDel(`/backfill-seqs.${ref}`);
    const entry = this.#backfills.get(ref)!;
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;
  }

  // inside a landing transaction: reduce the parked events of a subtree, or of every stream under
  // no backfill for the frozen events (null), each stream's run in one reducer call, then clear
  // the range.  An event the base already covers is skipped.  Every landed stream's seq is
  // written once: the last walked for a stream with events, the cut's for a header stream
  // without.  Chains were checked before any write
  *#reduceParkedIn(
    ref: string | null, header: Record<string, number>, dirty: string[],
  ): WStoreGenerator<void> {
    const seqs = new Map(Object.entries(header));
    let range = this.#parkRange(ref, { type: '.event', want: JS });
    let stream = '';
    let run: DbEvent<unknown>[] = [];
    for (;;) {
      const { entries, next } = yield* txnScan(range);
      for (const [, value] of entries) {
        const ev = (value as Record<number, unknown>)[JS] as DbEvent<unknown>;
        const held = this.#streams.get(ev.stream);
        if (ref === null && held === 'backfill') continue;
        if (ev.stream !== stream) {
          if (run.length > 0) yield* this.#reduceStreamIn(stream, run, dirty);
          stream = ev.stream;
          run = [];
          seqs.set(stream, Math.max(typeof held === 'number' ? held : 0, seqs.get(stream) ?? 0));
        }
        if (ev.seq <= seqs.get(stream)!) continue;
        seqs.set(stream, ev.seq);
        run.push(ev);
      }
      if (next === null) break;
      range = resumeRange(range, next);
    }
    if (run.length > 0) yield* this.#reduceStreamIn(stream, run, dirty);
    dirty.push(...(yield* txnDelPrefix(range.gte!)));
    for (const [name, seq] of seqs) {
      this.#streams.set(name, seq);
      yield* txnSet(`/seq.${name}`, '.json', { [JS]: seq });
    }
  }

  // one stream's run of events, in order, through its slice's reducer; births and deaths are the
  // Engine's: a death drops the stream's keys, the stream stays known so a rebirth chains, and
  // neither reaches a reducer.  This is where events enter the base, so an event carrying an
  // outbox command's id is that command's round trip, whichever path parked or delivered it
  *#reduceStreamIn(
    stream: string, events: DbEvent<unknown>[], dirty: string[],
  ): WStoreGenerator<void> {
    const slice = this.#reducers[stream.split('.')[0]];
    let data: unknown[] = [];
    const reduce = function* (this: Engine<QX, C>): WStoreGenerator<void> {
      if (data.length === 0) return;
      const { updates } = yield* runReducer(slice.reducer(slice.rx, data));
      dirty.push(...updates);
      data = [];
    }.bind(this);
    for (const ev of events) {
      if (this.#outbox.has(ev.id)) yield* this.#releaseIn([ev.id]);
      const sys = sysOf(ev.data);
      if (sys === 'death') {
        yield* reduce();
        dirty.push(...(yield* txnDelPrefix(`${stream}/`)));
      } else if (sys === null) {
        data.push(ev.data);
      }
    }
    yield* reduce();
  }

  // inside a landing transaction: a ref whose tail did not reach its parked live events drops its
  // parked values and downloads again from a fresh snapshot, whose cut is past the gap; the
  // parked events stay and chain from the live cut
  *#restartIn(ref: string): WStoreGenerator<void> {
    const entry = this.#backfills.get(ref)!;
    yield* txnDelPrefix(`/park.kv.${ref}/`);
    entry.record.resume = null;
    entry.status = 'downloading';
    entry.attempts = 0;
    yield* txnSet(`/backfill.${ref}`, '.json', { [JS]: entry.record });
    this.#startBackfill(ref);
  }

  // inside a transaction: new backfills, each downloading at once into its own values range.  A
  // stream ref is marked; a family has nothing to mark.  With a parent they are its children and
  // it lands when they have too
  *#spawnIn(parent: string | null, refs: string[], until: number, replacing: boolean): WStoreGenerator<void> {
    for (const ref of refs) {
      const record: BackfillRecord = { until, resume: null, replacing, children: [] };
      yield* txnSet(`/backfill.${ref}`, '.json', { [JS]: record });
      this.#backfills.set(ref, {
        record,
        controller: new AbortController(),
        status: 'downloading',
        parent,
        attempts: 0,
        retryTimer: null,
      });
      if (replacing) this.#replacing++;
      if (!ref.endsWith('*')) yield* this.#maybeMarkBackfilling(ref, replacing);
      if (replacing) yield* this.#markUnderIn(ref);
      this.#startBackfill(ref);
    }
    if (parent !== null) {
      const p = this.#backfills.get(parent)!;
      p.record.children.push(...refs);
      yield* txnSet(`/backfill.${parent}`, '.json', { [JS]: p.record });
    }
  }

  // inside a transaction: an in-flight backfill ends.  Its download is aborted, its values range
  // and records go, and its children carry on with the parent they have left, if any
  *#dropBackfillIn(ref: string): WStoreGenerator<void> {
    const entry = this.#backfills.get(ref)!;
    entry.controller.abort();
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    yield* txnDelPrefix(`/park.kv.${ref}/`);
    yield* txnDel(`/backfill.${ref}`);
    yield* txnDel(`/backfill-seqs.${ref}`);
    this.#backfills.delete(ref);
    if (entry.record.replacing) this.#replacing--;
    if (entry.parent !== null) {
      const p = this.#backfills.get(entry.parent)!;
      p.record.children = p.record.children.filter((c) => c !== ref);
      yield* txnSet(`/backfill.${entry.parent}`, '.json', { [JS]: p.record });
    }
    for (const child of entry.record.children) {
      const c = this.#backfills.get(child);
      if (c === undefined) continue;
      c.parent = this.#parentOf(child);
      if (c.parent === null) continue;
      const p = this.#backfills.get(c.parent)!;
      p.record.children.push(child);
      yield* txnSet(`/backfill.${c.parent}`, '.json', { [JS]: p.record });
    }
  }

  // inside a transaction: a stream leaves the Engine: its state, its seq, and its parked events
  *#dropStreamIn(stream: string, dirty: string[]): WStoreGenerator<void> {
    dirty.push(...(yield* txnDelPrefix(`${stream}/`)));
    yield* txnDel(`/seq.${stream}`);
    yield* txnDelPrefix(`/park.ev.${stream}/`);
    this.#streams.delete(stream);
  }

  // one inbound item from the connector, in arrival order
  *#onInbox(): Generator<void, void, void> {
    const item = this.#inbox.shift()!;
    if ('events' in item) {
      yield* this.#onEvents(item.events);
    } else if ('open' in item) {
      // a different epoch is a replaced log: positions held mean nothing there.  Dropping
      // everything and backfilling every ref is the answer, and until that exists this ends
      if (this.#checkpoint !== null && this.#checkpoint.epoch !== item.open) {
        throw new Error(`epoch ${item.open}, checkpoint from ${this.#checkpoint.epoch}`);
      }
      this.#epoch = item.open;
    } else if ('view' in item) {
      yield* this.#onView(item.view);
    } else if ('vouch' in item) {
      yield* this.#onCursor(item.vouch);
    } else if ('live' in item) {
      yield* this.#onCursor(item.live);
      this.#live = true;
      this.#attempt = 0;
      if (this.#replacing === 0) yield* this.#rebuildOverlay();
    } else {
      this.#onEnd();
    }
  }

  // one atom's events in one transaction.  Routing is a streams-table lookup: a marked stream
  // parks; an unknown stream under an in-flight ref is marked and parks; an unknown non-birth
  // under no ref starts its own backfill and parks; while frozen everything else parks too; a
  // held stream's next event joins its run, a repeat is dropped, and a jump is a gap, which
  // starts a replacing backfill for the stream at once, under the in-flight ref covering it if
  // any, and freezes the base from that event on.  Runs reduce per stream, the seqs and the
  // checkpoint are written, and the graph runs when live and not frozen
  *#onEvents(events: WireEvent[]): Generator<void, void, void> {
    const self = this;
    const dirty: string[] = [];
    yield* withWTxn(this.#fx, this.#store, function* () {
      const seqs = new Map<string, number>();
      const runs = new Map<string, DbEvent<unknown>[]>();
      let reduced = self.#reduced;
      for (const ev of events) {
        const held = self.#streams.get(ev.stream);
        let park = held === 'backfill';
        if (held === undefined) {
          const parent = self.#parentOf(ev.stream);
          if (parent !== null) {
            yield* self.#maybeMarkBackfilling(ev.stream, self.#backfills.get(parent)!.record.replacing);
            park = true;
          } else if (sysOf(self.#decode(ev).data) !== 'birth') {
            yield* self.#spawnIn(null, [ev.stream], ev.position, false);
            park = true;
          }
        }
        if (!park && self.#replacing > 0) park = true;
        if (!park) {
          const last = seqs.get(ev.stream) ?? (typeof held === 'number' ? held : 0);
          if (ev.seq <= last) continue;
          if (ev.seq === last + 1) {
            seqs.set(ev.stream, ev.seq);
            if (!runs.has(ev.stream)) runs.set(ev.stream, []);
            runs.get(ev.stream)!.push(self.#decode(ev));
            reduced = ev.position;
            continue;
          }
          yield* self.#spawnIn(self.#parentOf(ev.stream), [ev.stream], ev.position, true);
          seqs.delete(ev.stream);
          park = true;
        }
        yield* txnSet(parkedEventKey(ev.stream, ev.seq), '.event', { [MSGPACK]: ev.raw });
      }
      for (const [stream, run] of runs) yield* self.#reduceStreamIn(stream, run, dirty);
      for (const [stream, seq] of seqs) {
        self.#streams.set(stream, seq);
        yield* txnSet(`/seq.${stream}`, '.json', { [JS]: seq });
      }
      const last = events[events.length - 1].position;
      // a batch that froze part way reduced up to the event before the gap
      yield* self.#reducedTo(self.#replacing > 0 ? reduced : last);
      yield* self.#advanceCursorIn(last);
    });
    yield* this.#refresh(dirty);
  }

  // after a commit: the graph learns what changed and runs when live.  Base changes reach
  // queries only when not frozen; outbox changes always do, since forecasts are not base state
  *#refresh(dirty: string[]): Generator<void, void, void> {
    this.#graph.dirty(dirty);
    const outbox = this.#outboxChanged;
    this.#outboxChanged = false;
    if (this.#live && (outbox || (dirty.length > 0 && this.#replacing === 0))) {
      yield* this.#rebuildOverlay();
    }
  }

  // a live event as the reducers see it
  #decode(ev: WireEvent): DbEvent<unknown> {
    const v = this.#reg.convert('.event', { [MSGPACK]: ev.raw }, JS);
    return (v as Record<number, unknown>)[JS] as DbEvent<unknown>;
  }

  // inside a transaction: the checkpoint moves forward, never back, under the connection's epoch
  *#advanceCursorIn(position: number): WStoreGenerator<void> {
    if (this.#epoch === null) throw new Error('cursor with no epoch');
    if (this.#checkpoint !== null && position <= this.#checkpoint.position) return;
    this.#checkpoint = { epoch: this.#epoch, position, reduced: this.#reduced };
    yield* txnSet('/checkpoint', '.json', { [JS]: this.#checkpoint });
  }

  // inside a transaction: the base has been reduced through position, never back, and every
  // acked command at or below it is in the base, events or none, and leaves the outbox
  *#reducedTo(position: number): WStoreGenerator<void> {
    if (position <= this.#reduced) return;
    this.#reduced = position;
    if (this.#checkpoint !== null) {
      this.#checkpoint = { ...this.#checkpoint, reduced: position };
      yield* txnSet('/checkpoint', '.json', { [JS]: this.#checkpoint });
    }
    yield* this.#releaseAckedIn();
  }

  // inside a transaction: every acked command the base has reduced past leaves the outbox
  *#releaseAckedIn(): WStoreGenerator<void> {
    yield* this.#releaseIn([...this.#acked].filter(([, p]) => p <= this.#reduced).map(([id]) => id));
  }

  // inside a transaction: commands leave the outbox
  *#releaseIn(ids: string[]): WStoreGenerator<void> {
    for (const id of ids) {
      const ordinal = this.#outbox.get(id);
      if (ordinal === undefined) continue;
      yield* txnDel(`/command.${ordinal}`);
      this.#outbox.delete(id);
      this.#sent.delete(id);
      this.#acked.delete(id);
      this.#outboxChanged = true;
    }
  }

  // a vouch, or the live mark: the cursor converges in its own transaction, and unless frozen
  // nothing below it was withheld, so the base is reduced through it
  *#onCursor(position: number): Generator<void, void, void> {
    const self = this;
    yield* withWTxn(this.#fx, this.#store, function* () {
      if (self.#replacing === 0) yield* self.#reducedTo(position);
      yield* self.#advanceCursorIn(position);
    });
    yield* this.#refresh([]);
  }

  // the results of one sendCommand call, or its failure.  An ack or dup names the position the
  // command landed at, and the command is done once the checkpoint reaches it.  A reject or a
  // conflict is final and the command goes at once.  A failed call leaves its commands unsent
  // for the next connection to flush, in order
  *#onCommandOutcomes(): Generator<void, void, void> {
    const self = this;
    const { ids, results } = this.#commandOutcomes.shift()!;
    if ('failed' in results) {
      for (const id of ids) this.#sent.delete(id);
      return;
    }
    const drop: string[] = [];
    results.forEach((r, i) => {
      const id = ids[i];
      if (r.kind === 'ack' || r.kind === 'dup') {
        this.#acked.set(id, r.position);
        if (r.position <= this.#reduced) drop.push(id);
      } else {
        drop.push(id);
      }
    });
    if (drop.length === 0) return;
    yield* withWTxn(this.#fx, this.#store, function* () {
      yield* self.#releaseIn(drop);
    });
    yield* this.#refresh([]);
  }

  // a view frame, reconciled against state in one transaction.  Drops first: an in-flight ref
  // the new set does not fully cover ends, and a stream the new set does not cover goes.  Then
  // every ref of the new set that nothing accounts for starts a backfill, broadest first so a
  // covered ref finds its cover, and adopts the in-flight refs it covers.  A drop that ends the
  // last replacing backfill lands the frozen events here.  The view is written only when this
  // commits.  A revoke changes what queries may see, so the graph runs even while frozen: a new
  // query would otherwise disagree with the results already delivered
  *#onView(view: ViewRecord): Generator<void, void, void> {
    const self = this;
    const dirty: string[] = [];
    const wasFrozen = this.#replacing > 0;
    yield* withWTxn(this.#fx, this.#store, function* () {
      const covered = (refs: string[], x: string) => refs.some((r) => refCovers(r, x));
      const old = self.#view?.refs ?? [];
      const atStart = [...self.#backfills.keys()];
      for (const ref of atStart) {
        if (!covered(view.refs, ref)) yield* self.#dropBackfillIn(ref);
      }
      for (const stream of [...self.#streams.keys()]) {
        if (!covered(view.refs, stream)) yield* self.#dropStreamIn(stream, dirty);
      }
      // the first view's grants replace an empty base: frozen until they land as a group, so
      // the first frame shown is complete.  Every later grant is additive
      const bootstrap = self.#view === null;
      const refs = [...view.refs].sort((a, b) => refPrefix(a).length - refPrefix(b).length);
      for (const ref of refs) {
        const entries = [...self.#backfills.keys()];
        if (entries.some((e) => refCovers(e, ref))) continue;
        const held = covered(old, ref) && !atStart.some((e) => refCovers(e, ref));
        if (held || typeof self.#streams.get(ref) === 'number') continue;
        yield* self.#spawnIn(null, [ref], view.position, bootstrap);
        yield* self.#adoptChildrenIn(ref);
      }
      yield* txnSet('/view', '.json', { [JS]: view });
      self.#view = view;
      if (wasFrozen && self.#replacing === 0) {
        yield* self.#reduceParkedIn(null, {}, dirty);
        yield* self.#reducedTo(self.#checkpoint?.position ?? -1);
      }
    });
    yield* this.#refresh(dirty);
  }

  // the connection ended: the next attempt is scheduled with backoff, and every in-flight
  // backfill call fails through its outcome and waits for the next connection
  #onEnd(): void {
    const self = this;
    this.#connector = null;
    this.#connectorAbort.abort();
    this.#connectorAbort = new AbortController();
    this.#live = false;
    this.#epoch = null;
    this.#retryTimer = setTimeout(() => {
      self.#retryTimer = null;
      self.#schedule();
    }, backoffDelay(this.#attempt++));
  }

  // the overlay is rebuilt from the outbox after any change under it: a fresh overlay over the
  // base, every outbox command forecast in order against it, each seeing what the ones before
  // left, and the graph run on the result.  A forecast that answers a reason, or throws, adds
  // nothing: the command is still in flight and the server decides
  *#rebuildOverlay(): Generator<void, void, void> {
    const self = this;
    this.#graph.dirty(this.#overlay.keys());
    this.#overlay = new OverlayStore(this.#store, this.#reg);
    const forecaster = this.#forecaster;
    if (forecaster !== null && this.#outbox.size > 0) {
      const updates = yield* withWTxn(this.#fx, this.#overlay, function* () {
        const dirty: string[] = [];
        const rows = yield* txnScanAll(prefixRange('/command.', 1000, { type: '.command', want: JS }));
        for (const [, value] of rows) {
          const command = (value as Record<number, unknown>)[JS] as Command<C>;
          const forecast = yield* self.#runForecast(forecaster(self.#qx, command.data));
          if (typeof forecast === 'string') continue;
          const runs = new Map<string, unknown[]>();
          for (const { stream, event } of forecast) {
            if (!runs.has(stream)) runs.set(stream, []);
            runs.get(stream)!.push(event);
          }
          for (const [stream, events] of runs) {
            const slice = self.#reducers[stream.split('.')[0]];
            if (slice === undefined) continue;
            dirty.push(...(yield* runReducer(slice.reducer(slice.rx, events))).updates);
          }
        }
        return dirty;
      });
      this.#graph.dirty(updates);
    }
    const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
      self.#newQueries = false;
      return yield* self.#graph.run();
    });
    cbs();
  }

  // drives a forecast's query generator inside a transaction on the overlay: its store questions
  // are answered from there, and a throw from the forecast itself is a reason.  A forecast
  // cannot await another query
  *#runForecast<T>(g: QueryGenerator<T | string>): RStoreGenerator<T | string> {
    let ans: QueryAnswer = { store: {}, query: {} };
    for (;;) {
      let step: IteratorResult<QueryQuestion, T | string>;
      try {
        step = g.next(ans);
      } catch (e: unknown) {
        return `forecast threw: ${String(e)}`;
      }
      if (step.done) return step.value;
      if (Object.keys(step.value.query ?? {}).length > 0) throw new Error('a forecast awaited a query');
      const got = (yield { get: step.value.store ?? {} }).get;
      ans = { store: got, query: {} };
    }
  }

  // the app's new commands, and the outbox flush.  New commands take the next ordinals into the
  // outbox in one transaction and are forecast at once.  Then every outbox command not yet handed
  // to this connection is sent, in ordinal order, its results coming back through the outcomes;
  // without a connector the next connection flushes
  *#onSendCommands(): Generator<void, void, void> {
    const self = this;
    const fresh = this.#sendCommands.splice(0);
    this.#flush = false;
    if (fresh.length > 0) {
      yield* withWTxn(this.#fx, this.#store, function* () {
        for (const data of fresh) {
          const command: Command<C> = { id: generateUuid(), data };
          const ordinal = self.#nextOrdinal++;
          yield* txnSet(commandKey(ordinal), '.command', { [JS]: command });
          self.#outbox.set(command.id, ordinal);
        }
      });
      this.#outboxChanged = true;
      yield* this.#refresh([]);
    }
    const connector = this.#connector;
    if (connector === null) return;
    const pending = [...this.#outbox]
      .filter(([id]) => !this.#sent.has(id) && !this.#acked.has(id))
      .sort((a, b) => a[1] - b[1]);
    if (pending.length === 0) return;
    const wire = yield* withRTxn(this.#fx, this.#store, function* () {
      const out: Command<Uint8Array>[] = [];
      for (const [id, ordinal] of pending) {
        const command = (yield* txnGet(commandKey(ordinal), '.command')) as Command<C>;
        const bytes = self.#reg.convert(self.#reg.commands, { [JS]: command.data }, MSGPACK);
        out.push({ id, data: (bytes as Record<number, unknown>)[MSGPACK] as Uint8Array });
      }
      return out;
    });
    const ids = wire.map((c) => c.id);
    for (const id of ids) this.#sent.add(id);
    connector.sendCommand(wire).then(
      (results) => {
        self.#commandOutcomes.push({ ids, results });
        self.#schedule();
      },
      (e: unknown) => {
        self.#commandOutcomes.push({ ids, results: { failed: e } });
        self.#schedule();
      },
    );
  }

  *#onNewQueries(): Generator<void, void, void> {
    const self = this;
    const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
      self.#newQueries = false;
      return yield* self.#graph.extend();
    });
    cbs();
  }

  // ends everything the Engine drives: the connection, its backfills, the retry timer, and the
  // pushes waiting for a transaction they will never get.  Nothing is persisted; the store is
  // already consistent at the last commit
  *#shutdown(): Generator<void, void, void> {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#connectorAbort.abort();
    this.#connector = null;
    for (const entry of this.#backfills.values()) {
      entry.controller.abort();
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    }
    const reason = new Error('engine shut down');
    for (const work of this.#backfillWork) work.reject(reason);
    this.#backfillWork = [];
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
