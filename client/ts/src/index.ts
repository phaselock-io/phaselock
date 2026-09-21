// @phaselock/client: the HTTP connector for JS-native hosts.
//
// The connector contract (Backfill, Connector, ConnectorHooks) and the event
// envelope types are declared in the generated skeleton, which has no
// imports.  They are duplicated here verbatim; structural typing lines the
// two up.

export type Identified<T> = {
  id: string;
  data: T;
};

/** Committed extends Identified with stream position data that originates from KurrentDB. */
export type Committed<T> = Identified<T> & {
  position: number;
};

export type Backfill = {
  // what ref are we backfilling (stream name or prefix)
  ref: string;
  // where is our live cursor
  until: number;
  // what previous backfill state are we resuming from?
  // (position, seq) are from onHeaders, skip is how far into the snapshot we've read
  resume: null | { position: number, seq: number, skip: number };
  // Tell the Engine what streams and seqs are contained in this snapshot
  onSeqs(seqs: Record<string, number>): void;
  // Tell the Engine about a new value we read out of the snapshot.
  onValues(values: Record<string, Uint8Array>[], skip: number): void;
  // Tell the Engine about a new event we loaded from the post-snapshot tail.
  onEvents(events: Committed[]): void;
};

export type ListVisibleResult = {
  token: string;
  position: number;
  refs: string[];
  streams: string[];
};

export type CommandResult = {
  code: number;
  reason: string;
}

export interface Connector {
  backfill(backfill: Backfill): Promise<void>;
  listVisible(): Promise<ListVisibleResult>;
  sendCommand(commands: Identified[]): Promise<CommandResult[]>;
}

export interface ConnectorHooks {
  // first view frame has neither grant nor revoke, and if token doesn't match a list-visible request is needed
  onView(token: string, grant?: string[], revoke?: string[]): void;
  onEvents(events: Committed[]): void;
  onVouch(position: number): void;
  onEnd(code: number, reason: string): void;
}

export type ConnectorFactory = (signal: AbortSignal, hooks: ConnectorHooks) => Connector;

export class HTTPConnector {
  #url: string;
  #hooks: ConnectorHooks;
  #signal: AbortSignal;

  constructor(url: string, signal: AbortSignal, hooks: ConnectorHooks) {
    this.url = url;
    this.#signal = signal;
    this.hooks = hooks;
  }

  async backfill(backfill: Backfill): Promise<void> {
    // retry loop, in case a snapshot goes stale on us
    let lastUrl = "";
    let until = backfill.until;
    while (true) {
      // if events after our snapshot disappear, we'll need to cancel the snapshot download
      const abort = new AbortController();
      const signal = AbortSignal.any([abort.signal, backfill.signal]);

      // fetch either a snapshot, or a pointer to one
      const resp = await fetch(`${url}/snapshot/${backfill.ref}`, {
        signal,
        headers: { Range: `bytes=${backfill.resume?.skip ?? 0}-` },
      });

      switch (resp.status) {
        case 200: // full content
        case 206: // partial content
        case 416: // offset leaves no content
          // proceed
          break;

        default:
          throw new Error(`unexpected /snapshot response: ${resp.status} ${resp.statusText}`);
      }

      // figure out the position where this snapshot was taken
      const pos = resp.headers.get("PhaseLock-Position");

      // now download the chunks and the events simultaneously
      let retry = false;

      const getChunks = async () => {
        // handle manual (non-3xx) redirects, since we need the headers from the origin
        let body = resp.Body();
        if (resp.headers.get("Content-Type") === "text/plain") {
          const newUrl = await resp.text();
          const r2 = await fetch(newUrl, { signal });
          switch (r2.status) {
            case 200: // full content
            case 206: // partial content
            case 416: // offset leaves no content
              break;

            case 404:
              // snapshot is stale
              if (newUrl === lastUrl) {
                throw new Error(`snapshot doesn't exist (repeatedly) for ref=${backfill.ref}`);
              }
              // we'll need to retry
              retry = true;
              // kill the other process
              abort.abort("snapshot is stale");
              throw new Error("need retry");
            default:
              throw new Error(`unexpected blob response: ${r2.status} ${r2.statusText}`);
          }
          body = r2.body;
        }

        // now actually stream the body
        // XXX use msgpack
        backfill.onSeqs(...);
        for (const [key, value, skip] of ...) {
          backfil.onValues([{ [key]: value }], skip);
        }
      };

      const getEvents = async () => {
        while (true) {
          const maxCount = 1000;
          const resp = fetch(
            `${url}/events/${backfill.ref}?max=${maxCount}&after=${pos}&before=${until}`,
            { signal },
          );
          if (resp.status !== 200) {
            throw new Error(`unexpected /events response: ${resp.status} ${resp.statusText}`);
          }
          // XXX use msgpack
          const events = ...;
          if (events.length === 0) {
            // done with event tail
            return;
          }
          for (const ev of events) {
            bacfkill.onEvent(ev);
          }
        }
        // XXX the Engine will have to check seq numbers and re-issue new Backfills as needed
      };

      try {
        await Promise.all([getChunks(), getEvents()]);
      } catch(e: unknown) {
        if (!retry) throw e;
      }

      break;
    };
  }

  async listVisible(): Promise<{ token: string, position: number, refs: string[], streams: string[] }> {
    const resp = await fetch(`${url}/list`, { signal: this.#signal });
    return msgpackParse(resp.bytes());
  }

  async sendCommand(): Promise<CommandResult> {
  }
}

export function NewHTTPConnector(url: string): ConnectorFactory {
  return (signal: AbortSignal, hooks: ConnectorHooks) => new HTTPConnector(url, signal, hooks);
}
