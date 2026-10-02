// The frames of /stream and /events.

import type { WireEvent } from './contract.js';
import { Reader } from './msgpack.js';
import type { ByteReader } from './bytes.js';

export type Frame =
  | { tag: 'events'; events: WireEvent[] }
  | { tag: 'live'; position: number }
  | { tag: 'vouch'; position: number }
  | { tag: 'view'; token: string; position: number; refs: string[] }
  | { tag: 'end'; code: number; reason: string };

function strings(r: Reader): string[] {
  const n = r.arrayHeader();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(r.str());
  return out;
}

/** parseFrame decodes one frame of /stream or /events.  Envelope and frame elements appended by
    later protocol versions are skipped; event data is sliced out undecoded. */
export function parseFrame(bytes: Uint8Array): Frame {
  const r = new Reader(bytes);
  const n = r.arrayHeader();
  if (n < 1) throw new Error('empty frame');
  const tag = r.str();
  let used = 1;
  let frame: Frame;
  switch (tag) {
    case 'events': {
      const m = r.arrayHeader();
      const events: WireEvent[] = [];
      for (let i = 0; i < m; i++) {
        // the whole pair is sliced once; the envelope is read from it and data is a view into it
        const raw = r.raw();
        const p = new Reader(raw);
        const pair = p.arrayHeader();
        if (pair < 2) throw new Error('event without data');
        const env = p.arrayHeader();
        if (env < 5) throw new Error('short envelope');
        const position = p.int();
        const stream = p.str();
        const seq = p.int();
        const id = p.str();
        const servertime = p.timestamp();
        for (let k = 5; k < env; k++) p.skip();
        const data = p.view();
        events.push({ id, data, raw, position, stream, seq, servertime });
      }
      frame = { tag, events };
      used = 2;
      break;
    }
    case 'live':
    case 'vouch':
      frame = { tag, position: r.int() };
      used = 2;
      break;
    case 'view':
      frame = { tag, token: r.str(), position: r.int(), refs: strings(r) };
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
