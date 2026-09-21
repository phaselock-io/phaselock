// The frames of /stream and /events.

import type { DbEvent } from './contract.js';
import { Reader } from './msgpack.js';
import type { ByteReader } from './bytes.js';

export type Frame =
  | { tag: 'events'; events: DbEvent<Uint8Array>[] }
  | { tag: 'live'; position: number }
  | { tag: 'vouch'; position: number }
  | { tag: 'view'; token: string; position: number; grants: string[]; revokes: string[] }
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
      const events: DbEvent<Uint8Array>[] = [];
      for (let i = 0; i < m; i++) {
        const pair = r.arrayHeader();
        if (pair < 2) throw new Error('event without data');
        const env = r.arrayHeader();
        if (env < 5) throw new Error('short envelope');
        const position = r.int();
        const stream = r.str();
        const seq = r.int();
        const id = r.str();
        const servertime = r.int();
        for (let k = 5; k < env; k++) r.skip();
        const data = r.raw();
        for (let k = 2; k < pair; k++) r.skip();
        events.push({ id, data, position, stream, seq, servertime });
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
      frame = { tag, token: r.str(), position: r.int(), grants: strings(r), revokes: strings(r) };
      used = 5;
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
