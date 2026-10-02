// The Registry of a JS host: an interpreted walk over the generated registry data, converting
// msgpack bytes to rich values and back, checked against the schema in both directions, plus the
// Engine's reserved identities.

import { decode, encode } from '@msgpack/msgpack';
import {
  type DbEvent,
  JS,
  MSGPACK,
  type Registry,
  type Schema,
  type SchemaNode,
  type SchemaSolution,
  type StoreValue,
  type Wants,
} from './contract.js';
import { Reader, Writer } from './msgpack.js';

const utf8 = new TextEncoder();

/** a value that does not match its type; the message names the path and the problem */
export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}

/** what a walk does with a field the schema does not name: a command's are rejected, since
    the database rejects them too; anything else's are dropped */
type Policy = 'reject' | 'drop';

type Struct = Extract<SchemaNode, { 0: 'struct' }>;

/** a conversion in progress: the path to the value being converted, for its error, as object
    keys and array indices */
class Walk {
  path: (string | number)[] = [];

  constructor(
    readonly reg: Registry_,
    readonly policy: Policy,
  ) {}

  fail(message: string): never {
    const path = this.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
    throw new ConvertError(`$${path}: ${message}`);
  }

  // reading //////////////////////////////////////////////////////////////////

  read(r: Reader, i: number): unknown {
    const n = this.reg.schema.nodes[i];
    switch (n[0]) {
      case 'null':
        if (r.kind() !== 'nil') this.fail('expected null');
        r.nil();
        return null;
      case 'int':
        return this.readInt(r);
      case 'str':
        if (r.kind() !== 'str') this.fail('expected a string');
        return r.str();
      case 'bool':
        if (r.kind() !== 'bool') this.fail('expected a bool');
        return r.bool();
      case 'date':
        if (r.kind() !== 'ext') this.fail('expected a timestamp');
        return r.timestamp();
      case 'json':
        return decode(r.view());
      case 'lit':
        return this.readLiteral(r, n[1]);
      case 'struct':
        return this.readStruct(r, n);
      case 'record': {
        if (r.kind() !== 'map') this.fail('expected an object');
        const count = r.mapHeader();
        const out: Record<string, unknown> = {};
        for (let k = 0; k < count; k++) {
          if (r.kind() !== 'str') this.fail('expected a string key');
          const key = r.key();
          this.path.push(key);
          out[key] = this.read(r, n[2]);
          this.path.pop();
        }
        return out;
      }
      case 'array': {
        if (r.kind() !== 'array') this.fail('expected an array');
        const count = r.arrayHeader();
        const out = new Array<unknown>(count);
        for (let k = 0; k < count; k++) {
          this.path.push(k);
          out[k] = this.read(r, n[2]);
          this.path.pop();
        }
        return out;
      }
      case 'tuple': {
        if (r.kind() !== 'array') this.fail('expected an array');
        const count = r.arrayHeader();
        if (count !== n[2].length) this.fail(`expected ${n[2].length} items, not ${count}`);
        const out = new Array<unknown>(count);
        for (let k = 0; k < count; k++) {
          this.path.push(k);
          out[k] = this.read(r, n[2][k]);
          this.path.pop();
        }
        return out;
      }
      case 'union':
        return this.readUnion(r, n[2], r.pos, r.pos, r.pos);
      case 'intake':
        return this.read(r, n[2]);
    }
  }

  // an int in any msgpack form, an integral float included
  readInt(r: Reader): number {
    const kind = r.kind();
    const v = kind === 'int' ? r.int() : kind === 'float' ? r.float() : NaN;
    if (!Number.isSafeInteger(v)) this.fail('expected an int');
    return v;
  }

  readLiteral(r: Reader, lit: string | number | boolean): unknown {
    const kind = r.kind();
    const v =
      typeof lit === 'string' && kind === 'str'
        ? r.str()
        : typeof lit === 'number' && (kind === 'int' || kind === 'float')
          ? this.readInt(r)
          : typeof lit === 'boolean' && kind === 'bool'
            ? r.bool()
            : undefined;
    if (v !== lit) this.fail(`expected ${JSON.stringify(lit)}, not ${JSON.stringify(v)}`);
    return v;
  }

  readStruct(r: Reader, n: Struct): unknown {
    if (r.kind() !== 'map') this.fail('expected an object');
    const fields = n[2];
    const keys = this.reg.encodedKeys(n);
    const count = r.mapHeader();
    const out: Record<string, unknown> = {};
    const seen = new Uint8Array(fields.length);

    // each entry: a declared field, read once, or a foreign one, under the policy; fields are
    // usually in declaration order, so each search starts after the last match
    let hint = 0;
    for (let k = 0; k < count; k++) {
      if (r.kind() !== 'str') this.fail('expected a string key');
      const f = r.keyIndex(keys, hint);
      if (f < 0) {
        if (this.policy === 'reject') {
          this.path.push(r.lastKey());
          this.fail('unknown field');
        }
        r.skip();
        continue;
      }
      const key = fields[f][0];
      this.path.push(key);
      if (seen[f]) this.fail('repeated field');
      seen[f] = 1;
      out[key] = this.read(r, fields[f][1]);
      this.path.pop();
      hint = f + 1 < fields.length ? f + 1 : 0;
    }

    // every required field was present
    for (let f = 0; f < fields.length; f++) {
      if (seen[f] || fields[f][2]) continue;
      this.path.push(fields[f][0]);
      this.fail('missing required field');
    }
    return out;
  }

  /* A solution is evaluated by looking ahead from the cursor, never consuming: `obj` is the
     container being navigated, `subj` the value being tested, and `root` the union value, which
     a match reads in full. */
  readUnion(r: Reader, s: SchemaSolution, obj: number, subj: number, root: number): unknown {
    switch (s[0]) {
      case 'match':
        r.pos = root;
        return this.read(r, s[1]);
      case 'jsontype': {
        const jt = this.jsonTypeAt(r, subj);
        const opt = s[1].find(([k]) => k === jt) ?? s[1].find(([k]) => k === '*');
        if (opt === undefined) this.fail(`type ${jt} not allowed here`);
        return this.readUnion(r, opt[1], obj, subj, root);
      }
      case 'literal': {
        const v = this.literalAt(r, subj);
        const opt = s[1].find(([lit]) => lit === v);
        if (opt === undefined) this.fail(`unexpected value ${JSON.stringify(v)}`);
        return this.readUnion(r, opt[1], obj, subj, root);
      }
      case 'length': {
        r.pos = subj;
        if (r.kind() !== 'array') this.fail('expected an array');
        const len = r.arrayHeader();
        const opt = s[1].find(([n]) => n === len);
        const sub = opt !== undefined ? opt[1] : s[2];
        if (sub === null) this.fail(`unexpected length ${len}`);
        return this.readUnion(r, sub, obj, subj, root);
      }
      case 'index': {
        r.pos = subj;
        if (r.kind() !== 'array') this.fail('expected an array');
        const len = r.arrayHeader();
        if (s[1] >= len) this.fail(`missing index ${s[1]}`);
        for (let k = 0; k < s[1]; k++) r.skip();
        const at = r.pos;
        return this.readUnion(r, s[2], at, at, root);
      }
      case 'field': {
        const at = this.findField(r, obj, s[1]);
        if (at < 0) this.fail(`missing discriminator ${JSON.stringify(s[1])}`);
        return this.readUnion(r, s[2], obj, at, root);
      }
      case 'hasfield': {
        for (const [key, sub] of s[1]) {
          if (this.findField(r, obj, key) >= 0) return this.readUnion(r, sub, obj, obj, root);
        }
        return this.fail(`none of the fields ${s[1].map(([k]) => k).join(', ')}`);
      }
    }
  }

  // the json type the solver names for the value at pos
  jsonTypeAt(r: Reader, pos: number): string {
    const saved = r.pos;
    r.pos = pos;
    const kind = r.kind();
    let jt: string;
    switch (kind) {
      case 'nil':
        jt = 'null';
        break;
      case 'bool':
        jt = 'boolean';
        break;
      case 'int':
        jt = 'int';
        break;
      case 'float':
        jt = Number.isInteger(r.float()) ? 'int' : 'float';
        break;
      case 'str':
      case 'ext':
        jt = 'string';
        break;
      case 'map':
        jt = 'object';
        break;
      case 'array':
        jt = 'array';
        break;
      case 'bin':
        jt = 'bin';
        break;
    }
    r.pos = saved;
    return jt;
  }

  // the scalar at pos, when it is one a literal can be
  literalAt(r: Reader, pos: number): unknown {
    const saved = r.pos;
    r.pos = pos;
    const kind = r.kind();
    const v =
      kind === 'str'
        ? r.str()
        : kind === 'int' || kind === 'float'
          ? this.readInt(r)
          : kind === 'bool'
            ? r.bool()
            : undefined;
    r.pos = saved;
    return v;
  }

  // the position of the value of key in the map at pos, or -1
  findField(r: Reader, pos: number, key: string): number {
    const saved = r.pos;
    r.pos = pos;
    const want = [this.reg.encodedKey(key)];
    let at = -1;
    if (r.kind() === 'map') {
      const count = r.mapHeader();
      for (let k = 0; k < count; k++) {
        if (r.kind() !== 'str') this.fail('expected a string key');
        if (r.keyIndex(want, 0) === 0) {
          at = r.pos;
          break;
        }
        r.skip();
      }
    }
    r.pos = saved;
    return at;
  }

  // writing //////////////////////////////////////////////////////////////////

  write(w: Writer, i: number, v: unknown): void {
    const n = this.reg.schema.nodes[i];
    switch (n[0]) {
      case 'null':
        if (v !== null) this.fail('expected null');
        return w.nil();
      case 'int':
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) this.fail('expected an int');
        return w.int(v);
      case 'str':
        if (typeof v !== 'string') this.fail('expected a string');
        return w.str(v);
      case 'bool':
        if (typeof v !== 'boolean') this.fail('expected a bool');
        return w.bool(v);
      case 'date':
        if (!(v instanceof Date) || Number.isNaN(v.getTime())) this.fail('expected a Date');
        return w.timestamp(v);
      case 'json':
        return w.raw(encode(v, { ignoreUndefined: true }));
      case 'lit':
        if (v !== n[1]) this.fail(`expected ${JSON.stringify(n[1])}, not ${JSON.stringify(v)}`);
        return this.writeScalar(w, n[1]);
      case 'struct':
        return this.writeStruct(w, i, n, v);
      case 'record': {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          this.fail('expected an object');
        const entries = Object.entries(v).filter(([, x]) => x !== undefined);
        w.mapHeader(entries.length);
        for (const [key, x] of entries) {
          w.str(key);
          this.path.push(key);
          this.write(w, n[2], x);
          this.path.pop();
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(v)) this.fail('expected an array');
        w.arrayHeader(v.length);
        for (let k = 0; k < v.length; k++) {
          this.path.push(k);
          this.write(w, n[2], v[k]);
          this.path.pop();
        }
        return;
      }
      case 'tuple': {
        if (!Array.isArray(v)) this.fail('expected an array');
        if (v.length !== n[2].length) this.fail(`expected ${n[2].length} items, not ${v.length}`);
        w.arrayHeader(v.length);
        for (let k = 0; k < v.length; k++) {
          this.path.push(k);
          this.write(w, n[2][k], v[k]);
          this.path.pop();
        }
        return;
      }
      case 'union':
        return this.writeUnion(w, n[2], v, v, v);
      case 'intake':
        return this.write(w, n[2], v);
    }
  }

  writeScalar(w: Writer, v: string | number | boolean): void {
    if (typeof v === 'string') w.str(v);
    else if (typeof v === 'number') w.int(v);
    else w.bool(v);
  }

  writeStruct(w: Writer, i: number, n: Struct, v: unknown): void {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail('expected an object');
    const o = v as Record<string, unknown>;
    const fields = n[2];

    // a command's foreign fields are an error; anything else's are left out
    if (this.policy === 'reject') {
      const index = this.reg.fieldIndex(n);
      for (const key of Object.keys(o)) {
        if (!index.has(key) && o[key] !== undefined) {
          this.path.push(key);
          this.fail('unknown field');
        }
      }
    }

    // the fields present, the discriminator first and then declaration order
    let present = 0;
    for (const [key, , optional] of fields) {
      if (o[key] !== undefined) {
        present++;
      } else if (!optional) {
        this.path.push(key);
        this.fail('missing required field');
      }
    }
    w.mapHeader(present);
    for (const f of this.reg.writeOrder(i, n)) {
      const [key, type] = fields[f];
      const x = o[key];
      if (x === undefined) continue;
      w.str(key);
      this.path.push(key);
      this.write(w, type, x);
      this.path.pop();
    }
  }

  // the solution evaluated over the value itself
  writeUnion(w: Writer, s: SchemaSolution, obj: unknown, subj: unknown, root: unknown): void {
    switch (s[0]) {
      case 'match':
        return this.write(w, s[1], root);
      case 'jsontype': {
        const jt = jsTypeOf(subj);
        const opt = s[1].find(([k]) => k === jt) ?? s[1].find(([k]) => k === '*');
        if (opt === undefined) this.fail(`type ${jt} not allowed here`);
        return this.writeUnion(w, opt[1], obj, subj, root);
      }
      case 'literal': {
        const opt = s[1].find(([lit]) => lit === subj);
        if (opt === undefined) this.fail(`unexpected value ${JSON.stringify(subj)}`);
        return this.writeUnion(w, opt[1], obj, subj, root);
      }
      case 'length': {
        if (!Array.isArray(subj)) this.fail('expected an array');
        const opt = s[1].find(([n]) => n === subj.length);
        const sub = opt !== undefined ? opt[1] : s[2];
        if (sub === null) this.fail(`unexpected length ${subj.length}`);
        return this.writeUnion(w, sub, obj, subj, root);
      }
      case 'index': {
        if (!Array.isArray(subj) || s[1] >= subj.length) this.fail(`missing index ${s[1]}`);
        const at = subj[s[1]];
        return this.writeUnion(w, s[2], at, at, root);
      }
      case 'field': {
        const at = hasKey(obj, s[1]) ? obj[s[1]] : undefined;
        if (at === undefined) this.fail(`missing discriminator ${JSON.stringify(s[1])}`);
        return this.writeUnion(w, s[2], obj, at, root);
      }
      case 'hasfield': {
        for (const [key, sub] of s[1]) {
          if (hasKey(obj, key) && obj[key] !== undefined)
            return this.writeUnion(w, sub, obj, obj, root);
        }
        return this.fail(`none of the fields ${s[1].map(([k]) => k).join(', ')}`);
      }
    }
  }
}

function hasKey(v: unknown, key: string): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && key in v;
}

// the json type the solver names for a rich value
function jsTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float';
    case 'string':
      return 'string';
    case 'object':
      return v instanceof Date ? 'string' : 'object';
    default:
      return typeof v;
  }
}

/** the family of a stream name: the part before the first dot */
function familyOf(stream: string): string {
  const dot = stream.indexOf('.');
  return dot < 0 ? stream : stream.slice(0, dot);
}

/** whether the map at the cursor is a system event, `{$sys: ...}`, without consuming it */
function isSystemEvent(r: Reader): boolean {
  const saved = r.pos;
  let sys = false;
  if (r.kind() === 'map' && r.mapHeader() > 0 && r.kind() === 'str') sys = r.key() === '$sys';
  r.pos = saved;
  return sys;
}

class Registry_ implements Registry {
  readonly commands: string;
  readonly eventTypes: Record<string, string>;
  readonly storeTypes: Record<string, string>;
  // the key each struct's walk writes first, where the struct is a union member told apart by it
  readonly #discriminators = new Map<number, string>();
  // each struct's field names to their positions, built on first use
  readonly #fieldIndexes = new Map<Struct, Map<string, number>>();
  readonly #writeOrders = new Map<number, number[]>();
  readonly #encodedKeys = new Map<Struct, Uint8Array[]>();
  readonly #encodedKey = new Map<string, Uint8Array>();
  // one cursor every conversion from bytes reads with
  readonly #reader = new Reader(new Uint8Array(0));
  // one buffer every conversion to bytes writes into, emptied first and copied out after
  readonly #writer = new Writer();

  constructor(readonly schema: Schema) {
    this.commands = schema.commands ?? '';
    this.eventTypes = schema.eventTypes;
    this.storeTypes = schema.storeTypes;
    for (const n of schema.nodes) if (n[0] === 'union') this.#learnDiscriminators(n[2], null);
  }

  // every struct matched under a `field` test of a union's object members writes that key first
  #learnDiscriminators(s: SchemaSolution, key: string | null): void {
    switch (s[0]) {
      case 'match':
        if (key !== null && !this.#discriminators.has(s[1])) this.#discriminators.set(s[1], key);
        return;
      case 'jsontype':
      case 'literal':
      case 'hasfield':
        for (const [, sub] of s[1]) this.#learnDiscriminators(sub, key);
        return;
      case 'length':
        for (const [, sub] of s[1]) this.#learnDiscriminators(sub, key);
        if (s[2] !== null) this.#learnDiscriminators(s[2], key);
        return;
      case 'index':
        return this.#learnDiscriminators(s[2], null);
      case 'field':
        return this.#learnDiscriminators(s[2], key ?? s[1]);
    }
  }

  /** a struct's field names, UTF-8, in declaration order */
  encodedKeys(n: Struct): Uint8Array[] {
    let keys = this.#encodedKeys.get(n);
    if (keys === undefined) {
      keys = n[2].map(([key]) => utf8.encode(key));
      this.#encodedKeys.set(n, keys);
    }
    return keys;
  }

  /** one key, UTF-8 */
  encodedKey(key: string): Uint8Array {
    let k = this.#encodedKey.get(key);
    if (k === undefined) {
      k = utf8.encode(key);
      this.#encodedKey.set(key, k);
    }
    return k;
  }

  fieldIndex(n: Struct): Map<string, number> {
    let index = this.#fieldIndexes.get(n);
    if (index === undefined) {
      index = new Map(n[2].map(([key], f) => [key, f]));
      this.#fieldIndexes.set(n, index);
    }
    return index;
  }

  /** the order a struct's fields are written in: its discriminator, then declaration order */
  writeOrder(i: number, n: Struct): number[] {
    let order = this.#writeOrders.get(i);
    if (order === undefined) {
      const all = n[2].map((_, f) => f);
      const key = this.#discriminators.get(i);
      const first = key === undefined ? -1 : n[2].findIndex(([k]) => k === key);
      order = first < 0 ? all : [first, ...all.filter((f) => f !== first)];
      this.#writeOrders.set(i, order);
    }
    return order;
  }

  // the node and policy of a type identity
  #resolve(type: string): [number, Policy] {
    const i = this.schema.ids[type];
    if (i === undefined) throw new ConvertError(`no registry entry for type ${type}`);
    return [i, type === this.commands ? 'reject' : 'drop'];
  }

  convert(type: string, value: StoreValue, want: Wants): StoreValue {
    const out = { ...value } as Record<number, unknown>;
    if (want & JS && !(JS in out)) {
      if (!(MSGPACK in out)) throw new ConvertError(`no representation of ${type} to convert`);
      out[JS] = this.#toJs(type, out[MSGPACK] as Uint8Array);
    }
    if (want & MSGPACK && !(MSGPACK in out)) {
      if (!(JS in out)) throw new ConvertError(`no representation of ${type} to convert`);
      out[MSGPACK] = this.#toBytes(type, out[JS]);
    }
    return out as StoreValue;
  }

  #toJs(type: string, bytes: Uint8Array): unknown {
    if (type === '.json' || type === '.command') return decode(bytes);
    const r = this.#reader;
    r.reset(bytes);
    const walk = new Walk(this, 'drop');
    try {
      const v = type === '.event' ? this.#readEvent(r, walk) : this.#readTyped(r, type);
      if (!r.done) walk.fail('trailing bytes after the value');
      return v;
    } catch (e: unknown) {
      if (e instanceof ConvertError) throw e;
      walk.fail(e instanceof Error ? e.message : String(e));
    }
  }

  #readTyped(r: Reader, type: string): unknown {
    const [i, policy] = this.#resolve(type);
    return new Walk(this, policy).read(r, i);
  }

  // the wire pair [env, data], data typed by its stream's family, system events untouched
  #readEvent(r: Reader, walk: Walk): DbEvent<unknown> {
    if (r.kind() !== 'array') walk.fail('expected an event pair');
    const pair = r.arrayHeader();
    if (pair < 2) walk.fail('event without data');
    if (r.kind() !== 'array') walk.fail('expected an envelope');
    const env = r.arrayHeader();
    if (env < 5) walk.fail('short envelope');
    const position = walk.readInt(r);
    if (r.kind() !== 'str') walk.fail('stream: expected a string');
    const stream = r.str();
    const seq = walk.readInt(r);
    if (r.kind() !== 'str') walk.fail('id: expected a string');
    const id = r.str();
    if (r.kind() !== 'ext') walk.fail('servertime: expected a timestamp');
    const servertime = r.timestamp();
    for (let k = 5; k < env; k++) r.skip();

    // the data, under the type its family folds
    let data: unknown;
    if (isSystemEvent(r)) {
      data = decode(r.view());
    } else {
      const family = familyOf(stream);
      const type = this.eventTypes[family];
      if (type === undefined) walk.fail(`stream ${stream}: no events type for family ${family}`);
      data = new Walk(this, 'drop').read(r, this.#resolve(type)[0]);
    }
    for (let k = 2; k < pair; k++) r.skip();
    return { id, data, position, stream, seq, servertime };
  }

  #toBytes(type: string, v: unknown): Uint8Array {
    if (type === '.json' || type === '.command') return encode(v, { ignoreUndefined: true });
    const w = this.#writer;
    w.reset();
    if (type === '.event') {
      this.#writeEvent(w, v as DbEvent<unknown>);
    } else {
      const [i, policy] = this.#resolve(type);
      new Walk(this, policy).write(w, i, v);
    }
    return w.bytes();
  }

  #writeEvent(w: Writer, ev: DbEvent<unknown>): void {
    const walk = new Walk(this, 'drop');
    w.arrayHeader(2);
    w.arrayHeader(5);
    w.int(ev.position);
    w.str(ev.stream);
    w.int(ev.seq);
    w.str(ev.id);
    if (!(ev.servertime instanceof Date)) walk.fail('servertime: expected a Date');
    w.timestamp(ev.servertime);
    const data = ev.data;
    if (typeof data === 'object' && data !== null && '$sys' in data) {
      w.raw(encode(data));
    } else {
      const type = this.eventTypes[familyOf(ev.stream)];
      if (type === undefined) walk.fail(`stream ${ev.stream}: no events type for its family`);
      walk.write(w, this.#resolve(type)[0], data);
    }
  }
}

/** the Registry over generated registry data */
export function buildRegistry(schema: Schema): Registry {
  return new Registry_(schema);
}
