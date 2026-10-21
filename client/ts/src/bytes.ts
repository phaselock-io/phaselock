// Buffered reading of a response body.

import { measure } from './msgpack.js';

/** ByteReader buffers a response body and hands out byte counts and whole msgpack values
    synchronously; callers await only to refill, so awaits track network chunks, not records.
    Reading only when asked is the backpressure: an unread body stalls the sender. */
export class ByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf = new Uint8Array(64 * 1024);
  #pos = 0;
  #len = 0;
  // bytes discarded from the front of the buffer, plus the offset the body started at
  #base: number;
  #eof = false;

  constructor(body: ReadableStream<Uint8Array>, base = 0) {
    this.#reader = body.getReader();
    this.#base = base;
  }

  /** offset is the byte position in the whole body of the next unread byte */
  get offset(): number {
    return this.#base + this.#pos;
  }

  /** available is the number of buffered, unread bytes */
  get available(): number {
    return this.#len - this.#pos;
  }

  /** more appends one chunk, compacting and growing as needed; false at EOF */
  async more(): Promise<boolean> {
    if (this.#eof) return false;
    const { done, value } = await this.#reader.read();
    if (done || !value) {
      this.#eof = true;
      return false;
    }
    if (this.#len + value.length > this.#buf.length) {
      // no room at the end: compact, or grow when the unread tail plus the chunk needs more
      const keep = this.#len - this.#pos;
      if (keep + value.length > this.#buf.length) {
        const grown = new Uint8Array(Math.max(this.#buf.length * 2, keep + value.length));
        grown.set(this.#buf.subarray(this.#pos, this.#len));
        this.#buf = grown;
      } else {
        this.#buf.copyWithin(0, this.#pos, this.#len);
      }
      this.#base += this.#pos;
      this.#pos = 0;
      this.#len = keep;
    }
    this.#buf.set(value, this.#len);
    this.#len += value.length;
    return true;
  }

  /** fill reads until n bytes are available */
  async fill(n: number): Promise<void> {
    while (this.#len - this.#pos < n) {
      if (!(await this.more())) throw new Error('body ended early');
    }
  }

  /** take returns a view of the next n bytes, which must already be available; the view is
      valid until the next refill */
  take(n: number): Uint8Array {
    if (this.#len - this.#pos < n) throw new Error('ByteReader.take past the buffer');
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  async skipBytes(n: number): Promise<void> {
    while (n > 0) {
      const have = this.#len - this.#pos;
      if (have >= n) {
        this.#pos += n;
        return;
      }
      this.#pos = this.#len;
      n -= have;
      if (!(await this.more())) throw new Error('body ended early');
    }
  }

  /** peek returns the next byte, which must already be available, without consuming it */
  peek(): number {
    if (this.#pos >= this.#len) throw new Error('ByteReader.peek past the buffer');
    return this.#buf[this.#pos];
  }

  /** tryValue returns a copy of the next whole msgpack value if it is buffered, else null */
  tryValue(): Uint8Array | null {
    const end = measure(this.#buf, this.#pos, this.#len);
    if (end < 0) return null;
    const out = this.#buf.slice(this.#pos, end);
    this.#pos = end;
    return out;
  }

  /** tryValues returns a view of the next n whole msgpack values if they are all buffered, else
      null, consuming nothing then; the view is valid until the next refill */
  tryValues(n: number): Uint8Array | null {
    let end = this.#pos;
    for (let i = 0; i < n; i++) {
      end = measure(this.#buf, end, this.#len);
      if (end < 0) return null;
    }
    const out = this.#buf.subarray(this.#pos, end);
    this.#pos = end;
    return out;
  }
}
