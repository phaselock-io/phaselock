// The snapshot blob's checksums: CRC-32C per record and header, FNV-1a 64 over the records.

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** FNV-1a 64 on four 16-bit limbs, low limb first, so no BigInt per byte */
export class Fnv64 {
  #h = [0x2325, 0x8422, 0x9ce4, 0xcbf2];

  update(bytes: Uint8Array): void {
    let [h0, h1, h2, h3] = this.#h;
    for (let i = 0; i < bytes.length; i++) {
      h0 ^= bytes[i];
      // multiply by 0x100000001b3 = 0x1b3 + (1 << 40)
      let t0 = h0 * 0x1b3;
      let t1 = h1 * 0x1b3;
      let t2 = h2 * 0x1b3 + ((h0 << 8) & 0xffff);
      let t3 = h3 * 0x1b3 + (((h0 >>> 8) | (h1 << 8)) & 0xffff);
      t1 += t0 >>> 16;
      t0 &= 0xffff;
      t2 += t1 >>> 16;
      t1 &= 0xffff;
      t3 += t2 >>> 16;
      t2 &= 0xffff;
      t3 &= 0xffff;
      h0 = t0;
      h1 = t1;
      h2 = t2;
      h3 = t3;
    }
    this.#h = [h0, h1, h2, h3];
  }

  /** the running state as 16 hex digits, the digest so far, which resume continues from */
  state(): string {
    return Array.from(this.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  static resume(state: string): Fnv64 {
    if (!/^[0-9a-f]{16}$/.test(state)) throw new Error(`bad FNV-1a 64 state ${state}`);
    const fnv = new Fnv64();
    fnv.#h = [3, 2, 1, 0].map((i) => parseInt(state.slice(i * 4, i * 4 + 4), 16));
    return fnv;
  }

  /** big-endian digest */
  digest(): Uint8Array {
    const [h0, h1, h2, h3] = this.#h;
    return Uint8Array.of(
      h3 >>> 8,
      h3 & 0xff,
      h2 >>> 8,
      h2 & 0xff,
      h1 >>> 8,
      h1 & 0xff,
      h0 >>> 8,
      h0 & 0xff,
    );
  }
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
