/*!
 * Vendored from msgpack-javascript (npm @msgpack/msgpack) 3.1.3,
 * https://github.com/msgpack/msgpack-javascript, file src/DecodeError.ts,
 * at commit 6d4b666f061e49d5cccab88d266cf6cf1b96bbbf.
 * Unmodified.
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

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);

    // fix the prototype chain in a cross-platform way
    const proto: typeof DecodeError.prototype = Object.create(DecodeError.prototype);
    Object.setPrototypeOf(this, proto);

    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: DecodeError.name,
    });
  }
}
