// Command ids: a uuid string in the Engine and in app code, its 16 bytes on the wire.

const HEX = '0123456789abcdef';

/** the 16 bytes of a uuid written as 32 hex digits, dashed or not, in either case */
export function uuidBytes(id: string): Uint8Array {
  const hex = id.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`command id is not a uuid: ${id}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** 16 bytes as a uuid, lower-case and grouped 8-4-4-4-12 */
export function uuidString(b: Uint8Array): string {
  if (b.length !== 16) throw new Error(`command id is ${b.length} bytes, not 16`);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[b[i] >>> 4] + HEX[b[i] & 0x0f];
  }
  return out;
}
