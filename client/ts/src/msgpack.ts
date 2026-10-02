// A msgpack cursor: measure a value without decoding it, read one value at a time by its type,
// skip or slice anything else, and a writer that builds msgpack from headers, scalars, and
// pre-encoded values.  Dates are the timestamp extension.

export const utf8 = new TextDecoder();
const utf8enc = new TextEncoder();

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

/** Reader walks one complete msgpack value at a time from a buffer. */
export class Reader {
  #buf: Uint8Array;
  #pos: number;
  #end: number;

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.#buf = buf;
    this.#pos = pos;
    this.#end = end;
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

  #view(n: number): DataView {
    this.#need(n);
    const v = new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#pos, n);
    this.#pos += n;
    return v;
  }

  arrayHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos++];
    if (b >= 0x90 && b <= 0x9f) return b & 0x0f;
    if (b === 0xdc) return this.#view(2).getUint16(0);
    if (b === 0xdd) return this.#view(4).getUint32(0);
    throw new Error(`expected msgpack array, got 0x${b.toString(16)}`);
  }

  mapHeader(): number {
    this.#need(1);
    const b = this.#buf[this.#pos++];
    if (b >= 0x80 && b <= 0x8f) return b & 0x0f;
    if (b === 0xde) return this.#view(2).getUint16(0);
    if (b === 0xdf) return this.#view(4).getUint32(0);
    throw new Error(`expected msgpack map, got 0x${b.toString(16)}`);
  }

  str(): string {
    this.#need(1);
    const b = this.#buf[this.#pos++];
    let n: number;
    if (b >= 0xa0 && b <= 0xbf) n = b & 0x1f;
    else if (b === 0xd9) n = this.#view(1).getUint8(0);
    else if (b === 0xda) n = this.#view(2).getUint16(0);
    else if (b === 0xdb) n = this.#view(4).getUint32(0);
    else throw new Error(`expected msgpack string, got 0x${b.toString(16)}`);
    this.#need(n);
    const s = utf8.decode(this.#buf.subarray(this.#pos, this.#pos + n));
    this.#pos += n;
    return s;
  }

  int(): number {
    this.#need(1);
    const b = this.#buf[this.#pos++];
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 256;
    switch (b) {
      case 0xcc:
        return this.#view(1).getUint8(0);
      case 0xcd:
        return this.#view(2).getUint16(0);
      case 0xce:
        return this.#view(4).getUint32(0);
      case 0xcf:
        return Number(this.#view(8).getBigUint64(0));
      case 0xd0:
        return this.#view(1).getInt8(0);
      case 0xd1:
        return this.#view(2).getInt16(0);
      case 0xd2:
        return this.#view(4).getInt32(0);
      case 0xd3:
        return Number(this.#view(8).getBigInt64(0));
      default:
        throw new Error(`expected msgpack integer, got 0x${b.toString(16)}`);
    }
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
    const b = this.#buf[this.#pos++];
    if (b === 0xca) return this.#view(4).getFloat32(0);
    if (b === 0xcb) return this.#view(8).getFloat64(0);
    throw new Error(`expected msgpack number, got 0x${b.toString(16)}`);
  }

  /** a timestamp extension in any of its three sizes, as a Date at millisecond precision */
  timestamp(): Date {
    this.#need(1);
    const b = this.#buf[this.#pos];
    const ext = b === 0xd6 || b === 0xd7 || b === 0xc7;
    if (!ext) throw new Error(`expected msgpack timestamp, got 0x${b.toString(16)}`);
    this.#need(b === 0xc7 ? 3 : 2);
    const type = this.#buf[this.#pos + 1];
    if (b === 0xd6 && type === 0xff) {
      this.#pos += 2;
      return new Date(this.#view(4).getUint32(0) * 1000);
    }
    if (b === 0xd7 && type === 0xff) {
      this.#pos += 2;
      const v = this.#view(8);
      const hi = v.getUint32(0);
      const sec = (hi & 0x3) * 0x100000000 + v.getUint32(4);
      return new Date(sec * 1000 + Math.floor((hi >>> 2) / 1e6));
    }
    if (b === 0xc7 && type === 12 && this.#buf[this.#pos + 2] === 0xff) {
      this.#pos += 3;
      const v = this.#view(12);
      const nsec = v.getUint32(0);
      return new Date(Number(v.getBigInt64(4)) * 1000 + Math.floor(nsec / 1e6));
    }
    throw new Error('expected msgpack timestamp, got another extension');
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
    as needed. */
export class Writer {
  #buf = new Uint8Array(1024);
  #pos = 0;

  #ensure(n: number): void {
    if (this.#pos + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#pos + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.#buf.subarray(0, this.#pos));
    this.#buf = grown;
  }

  // a container header: the fixed form, then the 16- and 32-bit forms
  #header(n: number, fix: number, wide: number): void {
    this.#ensure(5);
    const b = this.#buf;
    if (n < 16) {
      b[this.#pos++] = fix | n;
    } else if (n < 0x10000) {
      b[this.#pos++] = wide;
      b[this.#pos++] = n >>> 8;
      b[this.#pos++] = n & 0xff;
    } else {
      b[this.#pos++] = wide + 1;
      b[this.#pos++] = n >>> 24;
      b[this.#pos++] = (n >>> 16) & 0xff;
      b[this.#pos++] = (n >>> 8) & 0xff;
      b[this.#pos++] = n & 0xff;
    }
  }

  arrayHeader(n: number): void {
    this.#header(n, 0x90, 0xdc);
  }

  mapHeader(n: number): void {
    this.#header(n, 0x80, 0xde);
  }

  str(s: string): void {
    const b = utf8enc.encode(s);
    const n = b.length;
    this.#ensure(n + 5);
    const out = this.#buf;
    if (n < 32) {
      out[this.#pos++] = 0xa0 | n;
    } else if (n < 0x100) {
      out[this.#pos++] = 0xd9;
      out[this.#pos++] = n;
    } else if (n < 0x10000) {
      out[this.#pos++] = 0xda;
      out[this.#pos++] = n >>> 8;
      out[this.#pos++] = n & 0xff;
    } else {
      out[this.#pos++] = 0xdb;
      out[this.#pos++] = n >>> 24;
      out[this.#pos++] = (n >>> 16) & 0xff;
      out[this.#pos++] = (n >>> 8) & 0xff;
      out[this.#pos++] = n & 0xff;
    }
    out.set(b, this.#pos);
    this.#pos += n;
  }

  /** a safe integer in its smallest form */
  int(v: number): void {
    this.#ensure(9);
    const b = this.#buf;
    if (v >= 0) {
      if (v < 0x80) {
        b[this.#pos++] = v;
      } else if (v < 0x100) {
        b[this.#pos++] = 0xcc;
        b[this.#pos++] = v;
      } else if (v < 0x10000) {
        b[this.#pos++] = 0xcd;
        b[this.#pos++] = v >>> 8;
        b[this.#pos++] = v & 0xff;
      } else if (v < 0x100000000) {
        b[this.#pos++] = 0xce;
        new DataView(b.buffer, b.byteOffset + this.#pos, 4).setUint32(0, v);
        this.#pos += 4;
      } else {
        b[this.#pos++] = 0xcf;
        new DataView(b.buffer, b.byteOffset + this.#pos, 8).setBigUint64(0, BigInt(v));
        this.#pos += 8;
      }
    } else if (v >= -32) {
      b[this.#pos++] = v & 0xff;
    } else if (v >= -0x80) {
      b[this.#pos++] = 0xd0;
      b[this.#pos++] = v & 0xff;
    } else if (v >= -0x8000) {
      b[this.#pos++] = 0xd1;
      new DataView(b.buffer, b.byteOffset + this.#pos, 2).setInt16(0, v);
      this.#pos += 2;
    } else if (v >= -0x80000000) {
      b[this.#pos++] = 0xd2;
      new DataView(b.buffer, b.byteOffset + this.#pos, 4).setInt32(0, v);
      this.#pos += 4;
    } else {
      b[this.#pos++] = 0xd3;
      new DataView(b.buffer, b.byteOffset + this.#pos, 8).setBigInt64(0, BigInt(v));
      this.#pos += 8;
    }
  }

  bool(v: boolean): void {
    this.#ensure(1);
    this.#buf[this.#pos++] = v ? 0xc3 : 0xc2;
  }

  nil(): void {
    this.#ensure(1);
    this.#buf[this.#pos++] = 0xc0;
  }

  float64(v: number): void {
    this.#ensure(9);
    this.#buf[this.#pos++] = 0xcb;
    new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#pos, 8).setFloat64(0, v);
    this.#pos += 8;
  }

  /** a Date as the smallest timestamp extension that holds it */
  timestamp(d: Date): void {
    const ms = d.getTime();
    const sec = Math.floor(ms / 1000);
    const nsec = (ms - sec * 1000) * 1e6;
    this.#ensure(15);
    const b = this.#buf;
    if (sec >= 0 && sec <= 0x3ffffffff) {
      if (nsec === 0 && sec <= 0xffffffff) {
        b[this.#pos++] = 0xd6;
        b[this.#pos++] = 0xff;
        new DataView(b.buffer, b.byteOffset + this.#pos, 4).setUint32(0, sec);
        this.#pos += 4;
      } else {
        b[this.#pos++] = 0xd7;
        b[this.#pos++] = 0xff;
        const v = new DataView(b.buffer, b.byteOffset + this.#pos, 8);
        v.setUint32(0, ((nsec << 2) | ((sec / 0x100000000) & 0x3)) >>> 0);
        v.setUint32(4, sec >>> 0);
        this.#pos += 8;
      }
    } else {
      b[this.#pos++] = 0xc7;
      b[this.#pos++] = 12;
      b[this.#pos++] = 0xff;
      const v = new DataView(b.buffer, b.byteOffset + this.#pos, 12);
      v.setUint32(0, nsec);
      v.setBigInt64(4, BigInt(sec));
      this.#pos += 12;
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
}
