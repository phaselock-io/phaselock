// The frames of /stream and /edits.

import type { WireEdit } from './contract.js';
import { readEnvelope } from './edits.js';
import { Reader } from './msgpack.js';
import type { ByteReader } from './bytes.js';

export type Frame =
  | { tag: 'edits'; edits: WireEdit[] }
  | { tag: 'live'; position: number }
  | { tag: 'vouch'; position: number }
  | { tag: 'view'; token: string; position: number; selectors: string[] }
  | { tag: 'end'; code: number; reason: string };

function strings(r: Reader): string[] {
  const n = r.arrayHeader();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(r.str());
  return out;
}

/** parseFrame decodes one frame of /stream or /edits.  Envelope and frame elements appended by
    later protocol versions are skipped; an edit's payload is carried undecoded. */
export function parseFrame(bytes: Uint8Array): Frame {
  const r = new Reader(bytes);
  const n = r.arrayHeader();
  if (n < 1) throw new Error('empty frame');
  const tag = r.str();
  let used = 1;
  let frame: Frame;
  switch (tag) {
    case 'edits': {
      const m = r.arrayHeader();
      const edits: WireEdit[] = [];
      for (let i = 0; i < m; i++) {
        // the whole edit is sliced once, and its envelope read from the slice
        const raw = r.raw();
        edits.push({ ...readEnvelope(new Reader(raw)), raw });
      }
      frame = { tag, edits };
      used = 2;
      break;
    }
    case 'live':
    case 'vouch':
      frame = { tag, position: r.int() };
      used = 2;
      break;
    case 'view':
      frame = { tag, token: r.str(), position: r.int(), selectors: strings(r) };
      used = 4;
      break;
    case 'end':
      frame = { tag, code: r.int(), reason: r.str() };
      used = 3;
      break;
    default:
      throw new Error(`unknown frame ${tag}`);
  }
  if (n < used) throw new Error(`short ${tag} frame`);
  for (let k = used; k < n; k++) r.skip();
  return frame;
}

/** frames drives a frame loop: every buffered frame goes to fn synchronously, then one refill.
    Ends cleanly at EOF on a frame boundary; fn returns false to stop early. */
export async function frames(br: ByteReader, fn: (f: Frame) => boolean): Promise<void> {
  for (;;) {
    let v: Uint8Array | null;
    while ((v = br.tryValue()) !== null) {
      if (!fn(parseFrame(v))) return;
    }
    if (!(await br.more())) {
      if (br.available > 0) throw new Error('body ended mid-frame');
      return;
    }
  }
}
