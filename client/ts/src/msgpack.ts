// A msgpack cursor: measure a value without decoding it, read the few shapes the protocol's
// framing uses, skip or slice anything else, and write command frames from pre-encoded values.

export const utf8 = new TextDecoder();
const utf8enc = new TextEncoder();

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

/** Writer builds msgpack from headers, strings, and pre-encoded values. */
export class Writer {
  #parts: Uint8Array[] = [];

  arrayHeader(n: number): void {
    if (n < 16) this.#parts.push(Uint8Array.of(0x90 | n));
    else if (n < 0x10000) this.#parts.push(Uint8Array.of(0xdc, n >>> 8, n & 0xff));
    else
      this.#parts.push(
        Uint8Array.of(0xdd, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff),
      );
  }

  str(s: string): void {
    const b = utf8enc.encode(s);
    const n = b.length;
    if (n < 32) this.#parts.push(Uint8Array.of(0xa0 | n));
    else if (n < 0x100) this.#parts.push(Uint8Array.of(0xd9, n));
    else if (n < 0x10000) this.#parts.push(Uint8Array.of(0xda, n >>> 8, n & 0xff));
    else
      this.#parts.push(
        Uint8Array.of(0xdb, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff),
      );
    this.#parts.push(b);
  }

  /** raw appends an already-encoded value verbatim */
  raw(b: Uint8Array): void {
    this.#parts.push(b);
  }

  bytes(): Uint8Array<ArrayBuffer> {
    let n = 0;
    for (const p of this.#parts) n += p.length;
    const out = new Uint8Array(new ArrayBuffer(n));
    let pos = 0;
    for (const p of this.#parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  }
}
