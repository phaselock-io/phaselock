// The Registry of a JS host: the generated registry data compiled into linked plans, and a walk
// over them converting msgpack bytes to rich values and back, checked against the schema in both
// directions, plus the Engine's reserved identities.

import {
  type Command,
  type DbEvent,
  JS,
  MSGPACK,
  type Registry,
  type Rep,
  type Schema,
  type SchemaNode,
  type SchemaSolution,
} from './contract.js';
import { decodeAny, encodeAny, Reader, setEntry, Writer } from './msgpack.js';
import { uuidBytes, uuidString } from './uuid.js';

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

// plan kinds
const NULL = 0;
const INT = 1;
const STR = 2;
const BOOL = 3;
const DATE = 4;
const JSON_ = 5;
const LIT = 6;
const STRUCT = 7;
const RECORD = 8;
const ARRAY = 9;
const TUPLE = 10;
const UNION = 11;
const INTAKE = 12;

// json types, as the union solver names them, indexing a jsontype solution's options
const JT_NULL = 0;
const JT_INT = 1;
const JT_STRING = 2;
const JT_BOOLEAN = 3;
const JT_OBJECT = 4;
const JT_ARRAY = 5;
const JT_FLOAT = 6;
const JT_BIN = 7;
const JT_NAMES = ['null', 'int', 'string', 'boolean', 'object', 'array', 'float', 'bin'];
const JT_CODES: Record<string, number> = Object.fromEntries(JT_NAMES.map((n, i) => [n, i]));

// solution kinds
const MATCH = 0;
const JSONTYPE = 1;
const LITERAL = 2;
const LENGTH = 3;
const INDEX = 4;
const FIELD = 5;
const HASFIELD = 6;

/** One node of the registry, compiled: children are linked directly, and a struct carries its
    keys as UTF-8, its required fields as a bitmask, and its write order.  Every plan has every
    field, so the walk's property reads stay monomorphic. */
class Plan {
  k = NULL;
  // a literal, and a string literal's UTF-8
  lit: string | number | boolean = '';
  litBytes: Uint8Array[] = [];
  // a struct
  keys: string[] = [];
  keyBytes: Uint8Array[] = [];
  types: Plan[] = [];
  optional: boolean[] = [];
  // the required fields, for a struct of at most 31 fields
  required = 0;
  order: number[] = [];
  index = new Map<string, number>();
  // a record's values, an array's items, an intake field's wire type
  child: Plan = this;
  // a tuple's items
  items: Plan[] = [];
  sol: Sol | null = null;
}

/** One step of a union's decision tree, compiled, every kind with every field. */
class Sol {
  k = MATCH;
  plan: Plan | null = null;
  // jsontype: the option per json type code, and the one for any type
  byType: (Sol | null)[] = [];
  any: Sol | null = null;
  // literal: the options in order, string ones also as UTF-8 to compare as bytes
  lits: (string | number | boolean)[] = [];
  litBytes: Uint8Array[] = [];
  strings = true;
  subs: Sol[] = [];
  // length
  lengths = new Map<number, Sol>();
  dflt: Sol | null = null;
  // index
  at = 0;
  sub: Sol | null = null;
  // field, and hasfield's keys in order
  key = '';
  keyBytes: Uint8Array[] = [];
  keys: string[] = [];
}

/** a conversion in progress: the path to the value being converted, for its error, as object
    keys and array indices */
class Walk {
  path: (string | number)[] = [];
  policy: Policy = 'drop';

  fail(message: string): never {
    const path = this.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('');
    throw new ConvertError(`$${path}: ${message}`);
  }

  // reading //////////////////////////////////////////////////////////////////

  read(r: Reader, p: Plan): unknown {
    switch (p.k) {
      case NULL:
        if (!r.tryNil()) this.fail('expected null');
        return null;
      case INT:
        return this.readInt(r);
      case STR: {
        const v = r.tryStr();
        if (v === undefined) this.fail('expected a string');
        return v;
      }
      case BOOL: {
        const v = r.tryBool();
        if (v === undefined) this.fail('expected a bool');
        return v;
      }
      case DATE: {
        const v = r.tryTimestamp();
        if (v === undefined) this.fail('expected a timestamp');
        return v;
      }
      case JSON_:
        return r.any();
      case LIT:
        return this.readLiteral(r, p);
      case STRUCT:
        return this.readStruct(r, p);
      case RECORD: {
        const count = r.tryMapHeader();
        if (count < 0) this.fail('expected an object');
        const out: Record<string, unknown> = {};
        for (let k = 0; k < count; k++) {
          if (r.kind() !== 'str') this.fail('expected a string key');
          const key = r.str();
          this.path.push(key);
          setEntry(out, key, this.read(r, p.child));
          this.path.pop();
        }
        return out;
      }
      case ARRAY: {
        const count = r.tryArrayHeader();
        if (count < 0) this.fail('expected an array');
        const out = new Array<unknown>(count);
        for (let k = 0; k < count; k++) {
          this.path.push(k);
          out[k] = this.read(r, p.child);
          this.path.pop();
        }
        return out;
      }
      case TUPLE: {
        const count = r.tryArrayHeader();
        if (count < 0) this.fail('expected an array');
        const items = p.items;
        if (count !== items.length) this.fail(`expected ${items.length} items, not ${count}`);
        const out = new Array<unknown>(count);
        for (let k = 0; k < count; k++) {
          this.path.push(k);
          out[k] = this.read(r, items[k]);
          this.path.pop();
        }
        return out;
      }
      case UNION: {
        const at = r.pos;
        return this.readUnion(r, p.sol!, at, at, at);
      }
      default:
        return this.read(r, p.child);
    }
  }

  // an int in any msgpack form, an integral float included
  readInt(r: Reader): number {
    const v = r.tryNumber();
    if (!Number.isSafeInteger(v)) this.fail('expected an int');
    return v;
  }

  readLiteral(r: Reader, p: Plan): unknown {
    const lit = p.lit;
    let v: unknown;
    if (typeof lit === 'string') {
      // a string literal compares as bytes
      const i = r.keyIndex(p.litBytes, 0);
      if (i === 0) return lit;
      v = i === -1 ? r.lastKey() : undefined;
    } else if (typeof lit === 'number') {
      const n = r.tryNumber();
      v = Number.isNaN(n) ? undefined : n;
    } else {
      v = r.tryBool();
    }
    if (v !== lit) this.fail(`expected ${JSON.stringify(lit)}, not ${JSON.stringify(v)}`);
    return v;
  }

  readStruct(r: Reader, p: Plan): unknown {
    const count = r.tryMapHeader();
    if (count < 0) this.fail('expected an object');
    const keys = p.keys;
    const nf = keys.length;
    const out: Record<string, unknown> = {};
    // the fields seen, as a bitmask while they fit in one
    let seen = 0;
    const many = nf > 31 ? new Uint8Array(nf) : null;

    // each entry: a declared field, read once, or a foreign one, under the policy; fields are
    // usually in declaration order, so each search starts after the last match
    let hint = 0;
    for (let k = 0; k < count; k++) {
      const f = r.keyIndex(p.keyBytes, hint);
      if (f === -2) this.fail('expected a string key');
      if (f < 0) {
        if (this.policy === 'reject') {
          this.path.push(r.lastKey());
          this.fail('unknown field');
        }
        r.skip();
        continue;
      }
      const key = keys[f];
      this.path.push(key);
      if (many === null) {
        if (seen & (1 << f)) this.fail('repeated field');
        seen |= 1 << f;
      } else {
        if (many[f]) this.fail('repeated field');
        many[f] = 1;
      }
      out[key] = this.read(r, p.types[f]);
      this.path.pop();
      hint = f + 1 < nf ? f + 1 : 0;
    }

    // every required field was present
    if (many === null && (seen & p.required) === p.required) return out;
    for (let f = 0; f < nf; f++) {
      const have = many === null ? seen & (1 << f) : many[f];
      if (have || p.optional[f]) continue;
      this.path.push(keys[f]);
      this.fail('missing required field');
    }
    return out;
  }

  /* A solution is evaluated by looking ahead from the cursor, never consuming: `obj` is the
     container being navigated, `subj` the value being tested, and `root` the union value, which
     a match reads in full. */
  readUnion(r: Reader, s: Sol, obj: number, subj: number, root: number): unknown {
    switch (s.k) {
      case MATCH:
        r.pos = root;
        return this.read(r, s.plan!);
      case JSONTYPE: {
        const jt = this.jsonTypeAt(r, subj);
        const sub = s.byType[jt] ?? s.any;
        if (sub === null) this.fail(`type ${JT_NAMES[jt]} not allowed here`);
        return this.readUnion(r, sub, obj, subj, root);
      }
      case LITERAL: {
        const i = this.literalAt(r, s, subj);
        if (i < 0) this.fail(`unexpected value ${this.valueAt(r, subj)}`);
        return this.readUnion(r, s.subs[i], obj, subj, root);
      }
      case LENGTH: {
        r.pos = subj;
        if (r.kind() !== 'array') this.fail('expected an array');
        const len = r.arrayHeader();
        const sub = s.lengths.get(len) ?? s.dflt;
        if (sub === null) this.fail(`unexpected length ${len}`);
        return this.readUnion(r, sub, obj, subj, root);
      }
      case INDEX: {
        r.pos = subj;
        if (r.kind() !== 'array') this.fail('expected an array');
        const len = r.arrayHeader();
        if (s.at >= len) this.fail(`missing index ${s.at}`);
        for (let k = 0; k < s.at; k++) r.skip();
        const at = r.pos;
        return this.readUnion(r, s.sub!, at, at, root);
      }
      case FIELD: {
        const at = this.findField(r, obj, s.keyBytes);
        if (at < 0) this.fail(`missing discriminator ${JSON.stringify(s.key)}`);
        return this.readUnion(r, s.sub!, obj, at, root);
      }
      default: {
        const i = this.findAnyField(r, obj, s.keyBytes);
        if (i < 0) this.fail(`none of the fields ${s.keys.join(', ')}`);
        return this.readUnion(r, s.subs[i], obj, obj, root);
      }
    }
  }

  // the json type code the solver names for the value at pos
  jsonTypeAt(r: Reader, pos: number): number {
    const saved = r.pos;
    r.pos = pos;
    let jt: number;
    switch (r.kind()) {
      case 'nil':
        jt = JT_NULL;
        break;
      case 'bool':
        jt = JT_BOOLEAN;
        break;
      case 'int':
        jt = JT_INT;
        break;
      case 'float':
        jt = Number.isInteger(r.float()) ? JT_INT : JT_FLOAT;
        break;
      case 'str':
      case 'ext':
        jt = JT_STRING;
        break;
      case 'map':
        jt = JT_OBJECT;
        break;
      case 'array':
        jt = JT_ARRAY;
        break;
      case 'bin':
        jt = JT_BIN;
        break;
    }
    r.pos = saved;
    return jt;
  }

  // the index of the literal option the scalar at pos is, or -1
  literalAt(r: Reader, s: Sol, pos: number): number {
    const saved = r.pos;
    r.pos = pos;
    const kind = r.kind();
    let i = -1;
    if (kind === 'str') {
      if (s.strings) i = r.keyIndex(s.litBytes, 0);
      else i = s.lits.indexOf(r.str());
    } else if (kind === 'int' || kind === 'float') {
      const v = kind === 'int' ? r.int() : r.float();
      i = s.lits.indexOf(v);
    } else if (kind === 'bool') {
      i = s.lits.indexOf(r.bool());
    }
    r.pos = saved;
    return i;
  }

  // the value at pos, for an error
  valueAt(r: Reader, pos: number): string {
    const saved = r.pos;
    r.pos = pos;
    try {
      return JSON.stringify(r.any());
    } finally {
      r.pos = saved;
    }
  }

  // the position of the value of a key in the map at pos, or -1
  findField(r: Reader, pos: number, key: Uint8Array[]): number {
    const saved = r.pos;
    r.pos = pos;
    let at = -1;
    if (r.kind() === 'map') {
      const count = r.mapHeader();
      for (let k = 0; k < count; k++) {
        if (r.kind() !== 'str') this.fail('expected a string key');
        if (r.keyIndex(key, 0) === 0) {
          at = r.pos;
          break;
        }
        r.skip();
      }
    }
    r.pos = saved;
    return at;
  }

  // the index of the first of keys, in their order, that the map at pos has; -1 for none
  findAnyField(r: Reader, pos: number, keys: Uint8Array[]): number {
    const saved = r.pos;
    r.pos = pos;
    let best = -1;
    if (r.kind() === 'map') {
      const count = r.mapHeader();
      for (let k = 0; k < count; k++) {
        if (r.kind() !== 'str') this.fail('expected a string key');
        const i = r.keyIndex(keys, 0);
        if (i >= 0 && (best < 0 || i < best)) best = i;
        r.skip();
      }
    }
    r.pos = saved;
    return best;
  }

  // writing //////////////////////////////////////////////////////////////////

  write(w: Writer, p: Plan, v: unknown): void {
    switch (p.k) {
      case NULL:
        if (v !== null) this.fail('expected null');
        return w.nil();
      case INT:
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) this.fail('expected an int');
        return w.int(v);
      case STR:
        if (typeof v !== 'string') this.fail('expected a string');
        return w.str(v);
      case BOOL:
        if (typeof v !== 'boolean') this.fail('expected a bool');
        return w.bool(v);
      case DATE:
        if (!(v instanceof Date) || Number.isNaN(v.getTime())) this.fail('expected a Date');
        return w.timestamp(v);
      case JSON_:
        return w.any(v);
      case LIT:
        if (v !== p.lit) this.fail(`expected ${JSON.stringify(p.lit)}, not ${JSON.stringify(v)}`);
        return this.writeScalar(w, p.lit);
      case STRUCT:
        return this.writeStruct(w, p, v);
      case RECORD: {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          this.fail('expected an object');
        }
        const entries = Object.entries(v).filter(([, x]) => x !== undefined);
        w.mapHeader(entries.length);
        for (const [key, x] of entries) {
          w.str(key);
          this.path.push(key);
          this.write(w, p.child, x);
          this.path.pop();
        }
        return;
      }
      case ARRAY: {
        if (!Array.isArray(v)) this.fail('expected an array');
        w.arrayHeader(v.length);
        for (let k = 0; k < v.length; k++) {
          this.path.push(k);
          this.write(w, p.child, v[k]);
          this.path.pop();
        }
        return;
      }
      case TUPLE: {
        if (!Array.isArray(v)) this.fail('expected an array');
        const items = p.items;
        if (v.length !== items.length) this.fail(`expected ${items.length} items, not ${v.length}`);
        w.arrayHeader(v.length);
        for (let k = 0; k < v.length; k++) {
          this.path.push(k);
          this.write(w, items[k], v[k]);
          this.path.pop();
        }
        return;
      }
      case UNION:
        return this.writeUnion(w, p.sol!, v, v, v);
      default:
        return this.write(w, p.child, v);
    }
  }

  writeScalar(w: Writer, v: string | number | boolean): void {
    if (typeof v === 'string') w.str(v);
    else if (typeof v === 'number') w.int(v);
    else w.bool(v);
  }

  writeStruct(w: Writer, p: Plan, v: unknown): void {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail('expected an object');
    const o = v as Record<string, unknown>;
    const keys = p.keys;

    // a command's foreign fields are an error; anything else's are left out
    if (this.policy === 'reject') {
      for (const key of Object.keys(o)) {
        if (!p.index.has(key) && o[key] !== undefined) {
          this.path.push(key);
          this.fail('unknown field');
        }
      }
    }

    // the fields present, the discriminator first and then declaration order
    let present = 0;
    for (let f = 0; f < keys.length; f++) {
      if (o[keys[f]] !== undefined) {
        present++;
      } else if (!p.optional[f]) {
        this.path.push(keys[f]);
        this.fail('missing required field');
      }
    }
    w.mapHeader(present);
    for (const f of p.order) {
      const key = keys[f];
      const x = o[key];
      if (x === undefined) continue;
      w.str(key);
      this.path.push(key);
      this.write(w, p.types[f], x);
      this.path.pop();
    }
  }

  // the solution evaluated over the value itself
  writeUnion(w: Writer, s: Sol, obj: unknown, subj: unknown, root: unknown): void {
    switch (s.k) {
      case MATCH:
        return this.write(w, s.plan!, root);
      case JSONTYPE: {
        const jt = jsTypeOf(subj);
        const sub = (jt >= 0 ? s.byType[jt] : null) ?? s.any;
        if (sub === null)
          this.fail(`type ${jt >= 0 ? JT_NAMES[jt] : typeof subj} not allowed here`);
        return this.writeUnion(w, sub, obj, subj, root);
      }
      case LITERAL: {
        const i = s.lits.indexOf(subj as string | number | boolean);
        if (i < 0) this.fail(`unexpected value ${JSON.stringify(subj)}`);
        return this.writeUnion(w, s.subs[i], obj, subj, root);
      }
      case LENGTH: {
        if (!Array.isArray(subj)) this.fail('expected an array');
        const sub = s.lengths.get(subj.length) ?? s.dflt;
        if (sub === null) this.fail(`unexpected length ${subj.length}`);
        return this.writeUnion(w, sub, obj, subj, root);
      }
      case INDEX: {
        if (!Array.isArray(subj) || s.at >= subj.length) this.fail(`missing index ${s.at}`);
        const at = subj[s.at];
        return this.writeUnion(w, s.sub!, at, at, root);
      }
      case FIELD: {
        const at = hasKey(obj, s.key) ? obj[s.key] : undefined;
        if (at === undefined) this.fail(`missing discriminator ${JSON.stringify(s.key)}`);
        return this.writeUnion(w, s.sub!, obj, at, root);
      }
      default: {
        for (let i = 0; i < s.keys.length; i++) {
          const key = s.keys[i];
          if (hasKey(obj, key) && obj[key] !== undefined) {
            return this.writeUnion(w, s.subs[i], obj, obj, root);
          }
        }
        return this.fail(`none of the fields ${s.keys.join(', ')}`);
      }
    }
  }
}

function hasKey(v: unknown, key: string): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && key in v;
}

// the json type code the solver names for a rich value, -1 for one it never names
function jsTypeOf(v: unknown): number {
  if (v === null) return JT_NULL;
  if (Array.isArray(v)) return JT_ARRAY;
  switch (typeof v) {
    case 'boolean':
      return JT_BOOLEAN;
    case 'number':
      return Number.isInteger(v) ? JT_INT : JT_FLOAT;
    case 'string':
      return JT_STRING;
    case 'object':
      return v instanceof Date ? JT_STRING : JT_OBJECT;
    default:
      return -1;
  }
}

// compiling the registry ////////////////////////////////////////////////////

/** the plan of every node, linked, from the registry data */
function compile(schema: Schema): Plan[] {
  const plans = schema.nodes.map(() => new Plan());

  const sol = (s: SchemaSolution): Sol => {
    const out = new Sol();
    switch (s[0]) {
      case 'match':
        out.k = MATCH;
        out.plan = plans[s[1]];
        break;
      case 'jsontype':
        out.k = JSONTYPE;
        out.byType = JT_NAMES.map(() => null);
        for (const [jt, sub] of s[1]) {
          if (jt === '*') out.any = sol(sub);
          else out.byType[JT_CODES[jt]] = sol(sub);
        }
        break;
      case 'literal':
        out.k = LITERAL;
        out.lits = s[1].map(([lit]) => lit);
        out.strings = out.lits.every((lit) => typeof lit === 'string');
        out.litBytes = out.strings ? out.lits.map((lit) => utf8.encode(lit as string)) : [];
        out.subs = s[1].map(([, sub]) => sol(sub));
        break;
      case 'length':
        out.k = LENGTH;
        for (const [n, sub] of s[1]) out.lengths.set(n, sol(sub));
        out.dflt = s[2] === null ? null : sol(s[2]);
        break;
      case 'index':
        out.k = INDEX;
        out.at = s[1];
        out.sub = sol(s[2]);
        break;
      case 'field':
        out.k = FIELD;
        out.key = s[1];
        out.keyBytes = [utf8.encode(s[1])];
        out.sub = sol(s[2]);
        break;
      case 'hasfield':
        out.k = HASFIELD;
        out.keys = s[1].map(([k]) => k);
        out.keyBytes = out.keys.map((k) => utf8.encode(k));
        out.subs = s[1].map(([, sub]) => sol(sub));
        break;
    }
    return out;
  };

  schema.nodes.forEach((n, i) => {
    const p = plans[i];
    switch (n[0]) {
      case 'null':
        p.k = NULL;
        break;
      case 'int':
        p.k = INT;
        break;
      case 'str':
        p.k = STR;
        break;
      case 'bool':
        p.k = BOOL;
        break;
      case 'date':
        p.k = DATE;
        break;
      case 'json':
        p.k = JSON_;
        break;
      case 'lit':
        p.k = LIT;
        p.lit = n[1];
        if (typeof n[1] === 'string') p.litBytes = [utf8.encode(n[1])];
        break;
      case 'struct': {
        const fields = n[2];
        p.k = STRUCT;
        p.keys = fields.map(([key]) => key);
        p.keyBytes = p.keys.map((key) => utf8.encode(key));
        p.types = fields.map(([, t]) => plans[t]);
        p.optional = fields.map(([, , opt]) => opt);
        p.required = fields.reduce((m, [, , opt], f) => (opt || f > 30 ? m : m | (1 << f)), 0);
        p.index = new Map(p.keys.map((key, f) => [key, f]));
        const all = p.keys.map((_, f) => f);
        const first = n[3];
        p.order = first < 0 ? all : [first, ...all.filter((f) => f !== first)];
        break;
      }
      case 'record':
        p.k = RECORD;
        p.child = plans[n[2]];
        break;
      case 'array':
        p.k = ARRAY;
        p.child = plans[n[2]];
        break;
      case 'tuple':
        p.k = TUPLE;
        p.items = n[2].map((t) => plans[t]);
        break;
      case 'union':
        p.k = UNION;
        p.sol = sol(n[2]);
        break;
      case 'intake':
        p.k = INTAKE;
        p.child = plans[n[2]];
        break;
      default:
        // a kind of node from an emitter newer than this library
        throw new Error(`schema: unknown node kind ${JSON.stringify((n as unknown[])[0])}`);
    }
  });
  return plans;
}

/* An outbox row, `.command`, is [id, series, n, command], the series and n nil for an
   unnumbered command and the command nested as the msgpack value its wire bytes are, so a row
   reads back as those bytes with no vocabulary. */

function readCommand(bytes: Uint8Array): Command<Uint8Array> {
  const r = new Reader(bytes);
  if (r.arrayHeader() !== 4) throw new Error('malformed outbox row');
  const id = r.str();
  let series: string | null = null;
  let n: number | null = null;
  if (r.tryNil()) {
    r.nil();
  } else {
    series = r.str();
    n = r.int();
  }
  const data = r.raw();
  if (!r.done) throw new Error('malformed outbox row');
  return { id, series, n, data };
}

function writeCommand(c: Command<Uint8Array>): Uint8Array {
  const w = new Writer();
  w.arrayHeader(4);
  w.str(c.id);
  if (c.series === null || c.n === null) {
    w.nil();
    w.nil();
  } else {
    w.str(c.series);
    w.int(c.n);
  }
  w.raw(c.data);
  return w.bytes();
}

/** the family of a stream name: the part before the first colon */
function familyOf(stream: string): string {
  const colon = stream.indexOf(':');
  return colon < 0 ? stream : stream.slice(0, colon);
}

/** whether the map at the cursor is a system event, `{$sys: ...}`, without consuming it */
function isSystemEvent(r: Reader): boolean {
  const saved = r.pos;
  let sys = false;
  if (r.kind() === 'map' && r.mapHeader() > 0 && r.kind() === 'str') sys = r.str() === '$sys';
  r.pos = saved;
  return sys;
}

// each node table's plans, compiled once and shared by every Registry over it, since every schema
// of one model shares one node table
const compiled = new WeakMap<readonly SchemaNode[], Plan[]>();

class Registry_ implements Registry {
  readonly commands: string;
  readonly eventTypes: Record<string, string>;
  readonly storeTypes: Record<string, string>;
  // each type identity's plan
  readonly #plans = new Map<string, Plan>();
  // one walk, one cursor, and one buffer every conversion uses, reset first
  readonly #walk = new Walk();
  readonly #reader = new Reader(new Uint8Array(0));
  readonly #writer = new Writer();

  constructor(schema: Schema) {
    this.commands = schema.commands ?? '';
    this.eventTypes = schema.eventTypes;
    this.storeTypes = schema.storeTypes;
    let plans = compiled.get(schema.nodes);
    if (plans === undefined) {
      plans = compile(schema);
      compiled.set(schema.nodes, plans);
    }
    for (const [id, i] of Object.entries(schema.ids)) this.#plans.set(id, plans[i]);
  }

  #plan(type: string): Plan {
    const p = this.#plans.get(type);
    if (p === undefined) throw new ConvertError(`no registry entry for type ${type}`);
    return p;
  }

  // the walk, emptied, under the policy of a type identity
  #begin(type: string): Walk {
    const walk = this.#walk;
    if (walk.path.length > 0) walk.path.length = 0;
    walk.policy = type === this.commands ? 'reject' : 'drop';
    return walk;
  }

  convert(type: string, value: unknown, from: Rep, to: Rep): unknown {
    if (from === to) return value;
    if (from === MSGPACK && to === JS) return this.#toJs(type, value as Uint8Array);
    if (from === JS && to === MSGPACK) return this.#toBytes(type, value);
    throw new ConvertError(`no conversion of ${type} from ${from} to ${to}`);
  }

  #toJs(type: string, bytes: Uint8Array): unknown {
    if (type === '.json') return decodeAny(bytes);
    if (type === '.command') return readCommand(bytes);
    const r = this.#reader;
    r.reset(bytes);
    const walk = this.#begin(type);
    try {
      const v = type === '.event' ? this.#readEvent(r, walk) : walk.read(r, this.#plan(type));
      if (!r.done) walk.fail('trailing bytes after the value');
      return v;
    } catch (e: unknown) {
      if (e instanceof ConvertError) throw e;
      walk.fail(e instanceof Error ? e.message : String(e));
    }
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
    if (r.kind() !== 'bin') walk.fail('id: expected bin');
    const id = uuidString(r.bin());
    if (r.kind() !== 'ext') walk.fail('servertime: expected a timestamp');
    const servertime = r.timestamp();
    for (let k = 5; k < env; k++) r.skip();

    // the data, under the type its family folds
    let data: unknown;
    if (isSystemEvent(r)) {
      data = r.any();
    } else {
      const family = familyOf(stream);
      const type = this.eventTypes[family];
      if (type === undefined) walk.fail(`stream ${stream}: no events type for family ${family}`);
      data = walk.read(r, this.#plan(type));
    }
    for (let k = 2; k < pair; k++) r.skip();
    return { id, data, position, stream, seq, servertime };
  }

  #toBytes(type: string, v: unknown): Uint8Array {
    if (type === '.json') return encodeAny(v);
    if (type === '.command') return writeCommand(v as Command<Uint8Array>);
    const w = this.#writer;
    w.reset();
    const walk = this.#begin(type);
    if (type === '.event') this.#writeEvent(w, walk, v as DbEvent<unknown>);
    else walk.write(w, this.#plan(type), v);
    return w.bytes();
  }

  #writeEvent(w: Writer, walk: Walk, ev: DbEvent<unknown>): void {
    w.arrayHeader(2);
    w.arrayHeader(5);
    w.int(ev.position);
    w.str(ev.stream);
    w.int(ev.seq);
    w.bin(uuidBytes(ev.id));
    if (!(ev.servertime instanceof Date)) walk.fail('servertime: expected a Date');
    w.timestamp(ev.servertime);
    const data = ev.data;
    if (typeof data === 'object' && data !== null && '$sys' in data) {
      w.any(data);
    } else {
      const type = this.eventTypes[familyOf(ev.stream)];
      if (type === undefined) walk.fail(`stream ${ev.stream}: no events type for its family`);
      walk.write(w, this.#plan(type), data);
    }
  }
}

/** the Registry over generated registry data */
export function buildRegistry(schema: Schema): Registry {
  return new Registry_(schema);
}
