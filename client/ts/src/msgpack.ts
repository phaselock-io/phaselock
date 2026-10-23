// A msgpack cursor: measure a value without decoding it, read one value at a time by its type or
// any value with no schema, skip or slice anything else, and a writer that builds msgpack from
// headers, scalars, any value, and pre-encoded values.  Dates are the timestamp extension.  UTF-8, 64-bit integers, and the
// timestamp forms are msgpack-javascript's, vendored under ./vendor.

import { getInt64, getUint64, setInt64, setUint64 } from './vendor/msgpack-javascript/int.js';
import { encodeDateToTimeSpec, EXT_TIMESTAMP } from './vendor/msgpack-javascript/timestamp.js';
import { utf8Count, utf8Decode, utf8Encode } from './vendor/msgpack-javascript/utf8.js';

export const utf8 = new TextDecoder();

// the largest seconds of the 32- and 64-bit timestamp forms
const TIMESTAMP32_MAX_SEC = 0x100000000 - 1;
const TIMESTAMP64_MAX_SEC = 0x400000000 - 1;

// a value is a tree, so nothing legitimate nests this deep
const MAX_DEPTH = 512;

/** the kinds of msgpack value a cursor can be on */
export type Kind = 'nil' | 'bool' | 'int' | 'float' | 'str' | 'bin' | 'array' | 'map' | 'ext';

// big-endian unsigned integer of n bytes at pos
export function be(buf: Uint8Array, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i];
  return v;
}

/** measure returns the end offset of the msgpack value starting at pos, or -1 if the buffer
    ends before the value does.  Nothing is decoded. */
export function measure(buf: Uint8Array, pos: number, end: number): number {
  let pending = 1;
  while (pending > 0) {
    if (pos >= end) return -1;
    const b = buf[pos];
    let header = 1;
    let payload = 0;
    let children = 0;
    // the size of the length field, for the variable-length types
    let lenBytes = 0;
    let kind: 'bytes' | 'array' | 'map' = 'bytes';
    if (b <= 0x7f || b >= 0xe0) {
      // fixint
    } else if (b <= 0x8f) {
      children = (b & 0x0f) * 2;
    } else if (b <= 0x9f) {
      children = b & 0x0f;
    } else if (b <= 0xbf) {
      payload = b & 0x1f;
    } else {
      switch (b) {
        case 0xc0: // nil
        case 0xc2: // false
        case 0xc3: // true
          break;
        case 0xc4: // bin8
        case 0xd9: // str8
          lenBytes = 1;
          break;
        case 0xc5: // bin16
        case 0xda: // str16
          lenBytes = 2;
          break;
        case 0xc6: // bin32
        case 0xdb: // str32
          lenBytes = 4;
          break;
        case 0xc7: // ext8: len, type
          lenBytes = 1;
          header = 3;
          break;
        case 0xc8: // ext16
          lenBytes = 2;
          header = 4;
          break;
        case 0xc9: // ext32
          lenBytes = 4;
          header = 6;
          break;
        case 0xca: // float32
          payload = 4;
          break;
        case 0xcb: // float64
          payload = 8;
          break;
        case 0xcc: // uint8
        case 0xd0: // int8
          payload = 1;
          break;
        case 0xcd: // uint16
        case 0xd1: // int16
          payload = 2;
          break;
        case 0xce: // uint32
        case 0xd2: // int32
          payload = 4;
          break;
        case 0xcf: // uint64
        case 0xd3: // int64
          payload = 8;
          break;
        case 0xd4: // fixext1
          payload = 2;
          break;
        case 0xd5: // fixext2
          payload = 3;
          break;
        case 0xd6: // fixext4
          payload = 5;
          break;
        case 0xd7: // fixext8
          payload = 9;
          break;
        case 0xd8: // fixext16
          payload = 17;
          break;
        case 0xdc: // array16
          lenBytes = 2;
          kind = 'array';
          break;
        case 0xdd: // array32
          lenBytes = 4;
          kind = 'array';
          break;
        case 0xde: // map16
          lenBytes = 2;
          kind = 'map';
          break;
        case 0xdf: // map32
          lenBytes = 4;
          kind = 'map';
          break;
        default:
          throw new Error(`invalid msgpack byte 0x${b.toString(16)} at ${pos}`);
      }
    }
    if (lenBytes > 0) {
      if (pos + 1 + lenBytes > end) return -1;
      const n = be(buf, pos + 1, lenBytes);
      if (header === 1) header = 1 + lenBytes;
      if (kind === 'array') children = n;
      else if (kind === 'map') children = n * 2;
      else payload = n;
    }
    pos += header + payload;
    if (pos > end) return -1;
    pending += children - 1;
  }
  return pos;
}

/** set a key of an object read from msgpack, an own property whatever its name, `__proto__`
    included */
export function setEntry(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[key] = value;
  }
}

/** one whole msgpack value with no schema, as Reader.any reads it; trailing bytes are an error */
export function decodeAny(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const v = r.any();
  if (!r.done) throw new Error('trailing bytes after the msgpack value');
  return v;
}

/** any value as msgpack, as Writer.any writes it */
export function encodeAny(v: unknown): Uint8Array {
  const w = new Writer();
  w.any(v);
  return w.bytes();
}

/** Reader walks one complete msgpack value at a time from a buffer. */
export class Reader {
  #buf: Uint8Array;
  // made on first use, since most values need no multi-byte read
  #dataView: DataView | null = null;
  #pos: number;
  #end: number;
  #lastKey = 0;
  #lastKeyLen = 0;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.#buf = buf;
    this.#pos = pos;
    this.#end = end;
  }

  /** read another buffer, as a new reader over it would */
  reset(buf: Uint8Array, pos = 0, end = buf.length): void {
    this.#buf = buf;
    this.#dataView = null;
    this.#pos = pos;
    this.#end = end;
  }

  get #data(): DataView {
    const b = this.#buf;
    return (this.#dataView ??= new DataView(b.buffer, b.byteOffset, b.byteLength));
  }

  get done(): boolean {
    return this.#pos >= this.#end;
  }

  /** the cursor, which a walk saves and restores to look ahead */
  get pos(): number {
    return this.#pos;
  }

  set pos(p: number) {
    this.#pos = p;
  }

  /** the kind of the value at the cursor, without consuming it */
  kind(): Kind {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b <= 0x7f || b >= 0xe0) return 'int';
    if (b <= 0x8f) return 'map';
    if (b <= 0x9f) return 'array';
    if (b <= 0xbf) return 'str';
    switch (b) {
      case 0xc0:
        return 'nil';
      case 0xc2:
      case 0xc3:
        return 'bool';
      case 0xc4:
      case 0xc5:
      case 0xc6:
        return 'bin';
      case 0xc7:
      case 0xc8:
      case 0xc9:
      case 0xd4:
      case 0xd5:
      case 0xd6:
      case 0xd7:
      case 0xd8:
        return 'ext';
      case 0xca:
      case 0xcb:
        return 'float';
      case 0xcc:
      case 0xcd:
      case 0xce:
      case 0xcf:
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3:
        return 'int';
      case 0xd9:
      case 0xda:
      case 0xdb:
        return 'str';
      case 0xdc:
      case 0xdd:
        return 'array';
      case 0xde:
      case 0xdf:
        return 'map';
      default:
        throw new Error(`invalid msgpack byte 0x${b.toString(16)} at ${this.#pos}`);
    }
  }

  #need(n: number): void {
    if (this.#pos + n > this.#end) throw new Error('truncated msgpack value');
  }

  // a big-endian length or count of n bytes after the header byte, consuming both
  #length(n: 1 | 2 | 4): number {
    this.#need(1 + n);
    const at = this.#pos + 1;
    this.#pos += 1 + n;
    if (n === 1) return this.#buf[at];
    if (n === 2) return this.#data.getUint16(at);
    return this.#data.getUint32(at);
  }

  arrayHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b >= 0x90 && b <= 0x9f) {
      this.#pos++;
      return b & 0x0f;
    }
    if (b === 0xdc) return this.#length(2);
    if (b === 0xdd) return this.#length(4);
    throw new Error(`expected msgpack array, got 0x${b.toString(16)}`);
  }

  mapHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b >= 0x80 && b <= 0x8f) {
      this.#pos++;
      return b & 0x0f;
    }
    if (b === 0xde) return this.#length(2);
    if (b === 0xdf) return this.#length(4);
    throw new Error(`expected msgpack map, got 0x${b.toString(16)}`);
  }

  // the byte length of the string at the cursor, consuming its header
  #strHeader(): number {
    const n = this.#tryStrHeader();
    if (n < 0) {
      throw new Error(`expected msgpack string, got 0x${this.#buf[this.#pos].toString(16)}`);
    }
    return n;
  }

  // the byte length of the string at the cursor, consuming its header; -1, consuming nothing,
  // for any other value
  #tryStrHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b >= 0xa0 && b <= 0xbf) {
      this.#pos++;
      return b & 0x1f;
    }
    if (b === 0xd9) return this.#length(1);
    if (b === 0xda) return this.#length(2);
    if (b === 0xdb) return this.#length(4);
    return -1;
  }

  /* The typed reads a schema walk makes: each checks the header and reads in one step, and
     answers a marker (-1, undefined, NaN, false), consuming nothing, for a value of another
     type. */

  /** the entry count of the map at the cursor, consuming its header; -1 for another value */
  tryMapHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b >= 0x80 && b <= 0x8f) {
      this.#pos++;
      return b & 0x0f;
    }
    if (b === 0xde) return this.#length(2);
    if (b === 0xdf) return this.#length(4);
    return -1;
  }

  /** the element count of the array at the cursor, consuming its header; -1 for another value */
  tryArrayHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b >= 0x90 && b <= 0x9f) {
      this.#pos++;
      return b & 0x0f;
    }
    if (b === 0xdc) return this.#length(2);
    if (b === 0xdd) return this.#length(4);
    return -1;
  }

  /** the string at the cursor; undefined for another value */
  tryStr(): string | undefined {
    const n = this.#tryStrHeader();
    if (n < 0) return undefined;
    this.#need(n);
    const s = utf8Decode(this.#buf, this.#pos, n);
    this.#pos += n;
    return s;
  }

  /** the bool at the cursor; undefined for another value */
  tryBool(): boolean | undefined {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b !== 0xc2 && b !== 0xc3) return undefined;
    this.#pos++;
    return b === 0xc3;
  }

  /** whether the value at the cursor is nil, consuming it if so */
  tryNil(): boolean {
    this.#need(1);
    if (this.#buf[this.#pos] !== 0xc0) return false;
    this.#pos++;
    return true;
  }

  /** the number at the cursor, an integer or a float; NaN for another value */
  tryNumber(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b <= 0x7f) {
      this.#pos++;
      return b;
    }
    if (b >= 0xe0) {
      this.#pos++;
      return b - 256;
    }
    if (b >= 0xcc && b <= 0xd3) return this.int();
    if (b === 0xca || b === 0xcb) return this.float();
    return NaN;
  }

  /** the timestamp at the cursor; undefined for a value that is not an extension */
  tryTimestamp(): Date | undefined {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b !== 0xd6 && b !== 0xd7 && b !== 0xc7) return undefined;
    return this.timestamp();
  }

  str(): string {
    const n = this.#strHeader();
    this.#need(n);
    const s = utf8Decode(this.#buf, this.#pos, n);
    this.#pos += n;
    return s;
  }

  /** the bytes of the bin at the cursor, as a view into the buffer */
  bin(): Uint8Array {
    this.#need(1);
    const b = this.#buf[this.#pos];
    let n: number;
    if (b === 0xc4) n = this.#length(1);
    else if (b === 0xc5) n = this.#length(2);
    else if (b === 0xc6) n = this.#length(4);
    else throw new Error(`expected msgpack bin, got 0x${b.toString(16)}`);
    this.#need(n);
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  /** The index of the key at the cursor among keys, each UTF-8, compared as bytes with no
      string made; -1 for none, and the key is then lastKey(); -2, consuming nothing, for a
      value that is not a string.  The search starts at hint, the index a caller expects, and
      wraps. */
  keyIndex(keys: readonly Uint8Array[], hint: number): number {
    const n = this.#tryStrHeader();
    if (n < 0) return -2;
    this.#need(n);
    const at = this.#pos;
    this.#pos += n;
    this.#lastKey = at;
    this.#lastKeyLen = n;
    const buf = this.#buf;
    const count = keys.length;
    for (let j = 0; j < count; j++) {
      const i = hint + j < count ? hint + j : hint + j - count;
      const k = keys[i];
      if (k.length !== n) continue;
      let b = 0;
      while (b < n && k[b] === buf[at + b]) b++;
      if (b === n) return i;
    }
    return -1;
  }

  /** the key keyIndex last read */
  lastKey(): string {
    return utf8Decode(this.#buf, this.#lastKey, this.#lastKeyLen);
  }

  int(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b <= 0x7f) {
      this.#pos++;
      return b;
    }
    if (b >= 0xe0) {
      this.#pos++;
      return b - 256;
    }
    const at = this.#pos + 1;
    const d = this.#data;
    let width: number;
    let v: number;
    switch (b) {
      case 0xcc:
        width = 1;
        this.#need(1 + width);
        v = d.getUint8(at);
        break;
      case 0xcd:
        width = 2;
        this.#need(1 + width);
        v = d.getUint16(at);
        break;
      case 0xce:
        width = 4;
        this.#need(1 + width);
        v = d.getUint32(at);
        break;
      case 0xcf:
        width = 8;
        this.#need(1 + width);
        v = getUint64(d, at);
        break;
      case 0xd0:
        width = 1;
        this.#need(1 + width);
        v = d.getInt8(at);
        break;
      case 0xd1:
        width = 2;
        this.#need(1 + width);
        v = d.getInt16(at);
        break;
      case 0xd2:
        width = 4;
        this.#need(1 + width);
        v = d.getInt32(at);
        break;
      case 0xd3:
        width = 8;
        this.#need(1 + width);
        v = getInt64(d, at);
        break;
      default:
        throw new Error(`expected msgpack integer, got 0x${b.toString(16)}`);
    }
    this.#pos += 1 + width;
    return v;
  }

  bool(): boolean {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b !== 0xc2 && b !== 0xc3) throw new Error(`expected msgpack bool, got 0x${b.toString(16)}`);
    this.#pos++;
    return b === 0xc3;
  }

  nil(): void {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b !== 0xc0) throw new Error(`expected msgpack nil, got 0x${b.toString(16)}`);
    this.#pos++;
  }

  float(): number {
    this.#need(1);
    const b = this.#buf[this.#pos];
    if (b === 0xca) {
      this.#need(5);
      this.#pos += 5;
      return this.#data.getFloat32(this.#pos - 4);
    }
    if (b === 0xcb) {
      this.#need(9);
      this.#pos += 9;
      return this.#data.getFloat64(this.#pos - 8);
    }
    throw new Error(`expected msgpack number, got 0x${b.toString(16)}`);
  }

  /** a timestamp extension in any of its three sizes, as a Date at millisecond precision, its
      forms as the vendored decodeTimestampToTimeSpec reads them, read in place */
  timestamp(): Date {
    this.#need(1);
    const b = this.#buf[this.#pos];
    let header: number;
    let size: number;
    if (b === 0xd6) {
      header = 1;
      size = 4;
    } else if (b === 0xd7) {
      header = 1;
      size = 8;
    } else if (b === 0xc7) {
      this.#need(2);
      header = 2;
      size = this.#buf[this.#pos + 1];
    } else {
      throw new Error(`expected msgpack timestamp, got 0x${b.toString(16)}`);
    }
    this.#need(header + 1 + size);
    const d = this.#data;
    const type = d.getInt8(this.#pos + header);
    if (type !== EXT_TIMESTAMP) {
      throw new Error(`expected msgpack timestamp, got extension ${type}`);
    }
    const at = this.#pos + header + 1;
    let sec: number;
    let nsec: number;
    if (size === 4) {
      sec = d.getUint32(at);
      nsec = 0;
    } else if (size === 8) {
      const hi = d.getUint32(at);
      sec = (hi & 0x3) * 0x100000000 + d.getUint32(at + 4);
      nsec = hi >>> 2;
    } else if (size === 12) {
      nsec = d.getUint32(at);
      sec = getInt64(d, at + 4);
    } else {
      throw new Error(`malformed msgpack timestamp of ${size} bytes`);
    }
    if (nsec > 999_999_999) throw new Error('malformed msgpack timestamp');
    this.#pos = at + size;
    return new Date(sec * 1e3 + Math.floor(nsec / 1e6));
  }

  /** Any value, with no schema: maps with string keys as objects, arrays, strings, numbers,
      bools, nil as null, and timestamps as Dates.  bin and any other extension are refused,
      as the wire carries neither. */
  any(depth = 0): unknown {
    if (depth > MAX_DEPTH) throw new Error('msgpack value nested too deeply');
    switch (this.kind()) {
      case 'nil':
        this.nil();
        return null;
      case 'bool':
        return this.bool();
      case 'int':
        return this.int();
      case 'float':
        return this.float();
      case 'str':
        return this.str();
      case 'ext':
        return this.timestamp();
      case 'array': {
        const n = this.arrayHeader();
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i++) out[i] = this.any(depth + 1);
        return out;
      }
      case 'map': {
        const n = this.mapHeader();
        const out: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const key = this.tryStr();
          if (key === undefined) throw new Error('msgpack map key is not a string');
          setEntry(out, key, this.any(depth + 1));
        }
        return out;
      }
      case 'bin':
        throw new Error('msgpack bin is not a value here');
    }
  }

  /** skip one value of any type */
  skip(): void {
    const end = measure(this.#buf, this.#pos, this.#end);
    if (end < 0) throw new Error('truncated msgpack value');
    this.#pos = end;
  }

  /** view returns the next value's bytes as a view into the buffer, undecoded */
  view(): Uint8Array {
    const end = measure(this.#buf, this.#pos, this.#end);
    if (end < 0) throw new Error('truncated msgpack value');
    const out = this.#buf.subarray(this.#pos, end);
    this.#pos = end;
    return out;
  }

  /** raw returns a copy of the next value's bytes, undecoded */
  raw(): Uint8Array {
    const end = measure(this.#buf, this.#pos, this.#end);
    if (end < 0) throw new Error('truncated msgpack value');
    const out = this.#buf.slice(this.#pos, end);
    this.#pos = end;
    return out;
  }
}

/** Writer builds msgpack from headers, scalars, and pre-encoded values, in a buffer that grows
    as needed.  Every value takes its smallest form. */
export class Writer {
  #buf = new Uint8Array(1024);
  #data = new DataView(this.#buf.buffer);
  #pos = 0;

  #ensure(n: number): void {
    if (this.#pos + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#pos + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.#buf.subarray(0, this.#pos));
    this.#buf = grown;
    this.#data = new DataView(grown.buffer);
  }

  // a container header: the fixed form, then the 16- and 32-bit forms
  #header(n: number, fix: number, wide: number): void {
    this.#ensure(5);
    if (n < 16) {
      this.#buf[this.#pos++] = fix | n;
    } else if (n < 0x10000) {
      this.#buf[this.#pos++] = wide;
      this.#data.setUint16(this.#pos, n);
      this.#pos += 2;
    } else {
      this.#buf[this.#pos++] = wide + 1;
      this.#data.setUint32(this.#pos, n);
      this.#pos += 4;
    }
  }

  arrayHeader(n: number): void {
    this.#header(n, 0x90, 0xdc);
  }

  mapHeader(n: number): void {
    this.#header(n, 0x80, 0xde);
  }

  str(s: string): void {
    const n = utf8Count(s);
    this.#ensure(5 + n);
    if (n < 32) {
      this.#buf[this.#pos++] = 0xa0 | n;
    } else if (n < 0x100) {
      this.#buf[this.#pos++] = 0xd9;
      this.#buf[this.#pos++] = n;
    } else if (n < 0x10000) {
      this.#buf[this.#pos++] = 0xda;
      this.#data.setUint16(this.#pos, n);
      this.#pos += 2;
    } else {
      this.#buf[this.#pos++] = 0xdb;
      this.#data.setUint32(this.#pos, n);
      this.#pos += 4;
    }
    utf8Encode(s, this.#buf, this.#pos);
    this.#pos += n;
  }

  /** a safe integer in its smallest form */
  int(v: number): void {
    this.#ensure(9);
    const d = this.#data;
    if (v >= 0) {
      if (v < 0x80) {
        this.#buf[this.#pos++] = v;
      } else if (v < 0x100) {
        this.#buf[this.#pos++] = 0xcc;
        this.#buf[this.#pos++] = v;
      } else if (v < 0x10000) {
        this.#buf[this.#pos++] = 0xcd;
        d.setUint16(this.#pos, v);
        this.#pos += 2;
      } else if (v < 0x100000000) {
        this.#buf[this.#pos++] = 0xce;
        d.setUint32(this.#pos, v);
        this.#pos += 4;
      } else {
        this.#buf[this.#pos++] = 0xcf;
        setUint64(d, this.#pos, v);
        this.#pos += 8;
      }
    } else if (v >= -0x20) {
      this.#buf[this.#pos++] = v & 0xff;
    } else if (v >= -0x80) {
      this.#buf[this.#pos++] = 0xd0;
      d.setInt8(this.#pos, v);
      this.#pos += 1;
    } else if (v >= -0x8000) {
      this.#buf[this.#pos++] = 0xd1;
      d.setInt16(this.#pos, v);
      this.#pos += 2;
    } else if (v >= -0x80000000) {
      this.#buf[this.#pos++] = 0xd2;
      d.setInt32(this.#pos, v);
      this.#pos += 4;
    } else {
      this.#buf[this.#pos++] = 0xd3;
      setInt64(d, this.#pos, v);
      this.#pos += 8;
    }
  }

  bool(v: boolean): void {
    this.#ensure(1);
    this.#buf[this.#pos++] = v ? 0xc3 : 0xc2;
  }

  bin(b: Uint8Array): void {
    this.#ensure(5 + b.length);
    if (b.length < 0x100) {
      this.#buf[this.#pos++] = 0xc4;
      this.#buf[this.#pos++] = b.length;
    } else if (b.length < 0x10000) {
      this.#buf[this.#pos++] = 0xc5;
      this.#data.setUint16(this.#pos, b.length);
      this.#pos += 2;
    } else {
      this.#buf[this.#pos++] = 0xc6;
      this.#data.setUint32(this.#pos, b.length);
      this.#pos += 4;
    }
    this.#buf.set(b, this.#pos);
    this.#pos += b.length;
  }

  nil(): void {
    this.#ensure(1);
    this.#buf[this.#pos++] = 0xc0;
  }

  float64(v: number): void {
    this.#ensure(9);
    this.#buf[this.#pos++] = 0xcb;
    this.#data.setFloat64(this.#pos, v);
    this.#pos += 8;
  }

  /** a Date as the smallest timestamp extension that holds it, the forms as the vendored
      encodeTimeSpecToTimestamp chooses them, written in place */
  timestamp(d: Date): void {
    const { sec, nsec } = encodeDateToTimeSpec(d);
    this.#ensure(15);
    const b = this.#buf;
    const v = this.#data;
    if (sec >= 0 && sec <= TIMESTAMP64_MAX_SEC) {
      if (nsec === 0 && sec <= TIMESTAMP32_MAX_SEC) {
        b[this.#pos++] = 0xd6;
        v.setInt8(this.#pos++, EXT_TIMESTAMP);
        v.setUint32(this.#pos, sec);
        this.#pos += 4;
      } else {
        b[this.#pos++] = 0xd7;
        v.setInt8(this.#pos++, EXT_TIMESTAMP);
        v.setUint32(this.#pos, (nsec << 2) | (sec / 0x100000000));
        v.setUint32(this.#pos + 4, sec >>> 0);
        this.#pos += 8;
      }
    } else {
      b[this.#pos++] = 0xc7;
      b[this.#pos++] = 12;
      v.setInt8(this.#pos++, EXT_TIMESTAMP);
      v.setUint32(this.#pos, nsec);
      setInt64(v, this.#pos + 4, sec);
      this.#pos += 12;
    }
  }

  /** Any value, with no schema, as Reader.any reads it back: an object's properties holding
      undefined are left out, and an array's undefined items are nil.  Anything with no msgpack
      form throws: a byte array, a Map or Set, a bigint, a function. */
  any(v: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) throw new Error('value nested too deeply for msgpack');
    if (v === null || v === undefined) return this.nil();
    switch (typeof v) {
      case 'boolean':
        return this.bool(v);
      case 'number':
        return Number.isSafeInteger(v) ? this.int(v) : this.float64(v);
      case 'string':
        return this.str(v);
      case 'object':
        break;
      default:
        throw new Error(`a ${typeof v} has no msgpack form`);
    }
    if (v instanceof Date) return this.timestamp(v);
    if (Array.isArray(v)) {
      this.arrayHeader(v.length);
      for (const x of v) this.any(x, depth + 1);
      return;
    }
    if (ArrayBuffer.isView(v) || v instanceof Map || v instanceof Set) {
      throw new Error(`a ${v.constructor.name} has no msgpack form`);
    }
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    this.mapHeader(entries.length);
    for (const [key, x] of entries) {
      this.str(key);
      this.any(x, depth + 1);
    }
  }

  /** raw appends an already-encoded value verbatim */
  raw(b: Uint8Array): void {
    this.#ensure(b.length);
    this.#buf.set(b, this.#pos);
    this.#pos += b.length;
  }

  /** the bytes written so far, as their own copy */
  bytes(): Uint8Array<ArrayBuffer> {
    return this.#buf.slice(0, this.#pos);
  }

  /** empty the writer to write another value into the same buffer */
  reset(): void {
    this.#pos = 0;
  }
}
