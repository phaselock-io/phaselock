/*!
 * Vendored from msgpack-javascript (npm @msgpack/msgpack) 3.1.3,
 * https://github.com/msgpack/msgpack-javascript, file src/CachedKeyDecoder.ts,
 * at commit 6d4b666f061e49d5cccab88d266cf6cf1b96bbbf.
 * Modified: import paths are rewritten to ./*.js for this package's flat layout and module
 * resolution.  The code is otherwise unchanged.
 *
 * SPDX-License-Identifier: ISC
 *
 * Copyright 2019 The MessagePack Community.
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without
 * fee is hereby granted, provided that the above copyright notice and this permission notice
 * appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
 * SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
 * NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE
 * OF THIS SOFTWARE.
 */

import { utf8DecodeJs } from "./utf8.js";

const DEFAULT_MAX_KEY_LENGTH = 16;
const DEFAULT_MAX_LENGTH_PER_KEY = 16;

export interface KeyDecoder {
  canBeCached(byteLength: number): boolean;
  decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string;
}
interface KeyCacheRecord {
  readonly bytes: Uint8Array;
  readonly str: string;
}

export class CachedKeyDecoder implements KeyDecoder {
  hit = 0;
  miss = 0;
  private readonly caches: Array<Array<KeyCacheRecord>>;
  readonly maxKeyLength: number;
  readonly maxLengthPerKey: number;

  constructor(maxKeyLength = DEFAULT_MAX_KEY_LENGTH, maxLengthPerKey = DEFAULT_MAX_LENGTH_PER_KEY) {
    this.maxKeyLength = maxKeyLength;
    this.maxLengthPerKey = maxLengthPerKey;

    // avoid `new Array(N)`, which makes a sparse array,
    // because a sparse array is typically slower than a non-sparse array.
    this.caches = [];
    for (let i = 0; i < this.maxKeyLength; i++) {
      this.caches.push([]);
    }
  }

  public canBeCached(byteLength: number): boolean {
    return byteLength > 0 && byteLength <= this.maxKeyLength;
  }

  private find(bytes: Uint8Array, inputOffset: number, byteLength: number): string | null {
    const records = this.caches[byteLength - 1]!;

    FIND_CHUNK: for (const record of records) {
      const recordBytes = record.bytes;

      for (let j = 0; j < byteLength; j++) {
        if (recordBytes[j] !== bytes[inputOffset + j]) {
          continue FIND_CHUNK;
        }
      }
      return record.str;
    }
    return null;
  }

  private store(bytes: Uint8Array, value: string) {
    const records = this.caches[bytes.length - 1]!;
    const record: KeyCacheRecord = { bytes, str: value };

    if (records.length >= this.maxLengthPerKey) {
      // `records` are full!
      // Set `record` to an arbitrary position.
      records[(Math.random() * records.length) | 0] = record;
    } else {
      records.push(record);
    }
  }

  public decode(bytes: Uint8Array, inputOffset: number, byteLength: number): string {
    const cachedValue = this.find(bytes, inputOffset, byteLength);
    if (cachedValue != null) {
      this.hit++;
      return cachedValue;
    }
    this.miss++;

    const str = utf8DecodeJs(bytes, inputOffset, byteLength);
    // Ensure to copy a slice of bytes because the bytes may be a NodeJS Buffer and Buffer#slice() returns a reference to its internal ArrayBuffer.
    const slicedCopyOfBytes = Uint8Array.prototype.slice.call(bytes, inputOffset, inputOffset + byteLength);
    this.store(slicedCopyOfBytes, str);
    return str;
  }
}
