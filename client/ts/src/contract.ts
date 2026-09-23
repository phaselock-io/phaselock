// The connector contract and the envelope types.  These are declared in the generated
// skeleton too, which has no imports; they are duplicated here verbatim, and structural typing
// lines the two up.  Changing them costs a change in every client in every language.

export type Command<T> = {
  id: string;
  data: T;
};

/** DbEvent is event data T with the envelope the DB stamped on it when it was committed:
    [position, stream, seq, id, servertime] on the wire.  The id is the command's. */
export type DbEvent<T> = {
  id: string;
  data: T;
  position: number;
  stream: string;
  seq: number;
  servertime: number;
};

/** WireEvent is an event as a connector delivers it: the envelope decoded for routing, data as
    the bytes the server sent, and the whole wire pair `[env, data]` so parking it is a slice. */
export type WireEvent = DbEvent<Uint8Array> & { raw: Uint8Array };

export type Backfill = {
  // what ref are we backfilling (stream name or prefix)
  ref: string;
  // the tail's exclusive upper bound: the cursor when this backfill started.  Anything at or
  // above it arrives on the live stream and is parked.  Retries keep the original value.
  until: number;
  // what a previous attempt got through, or null for a fresh backfill.  skipBytes > 0 resumes
  // the blob download, and the header's position must then equal position or the outcome is
  // 'stale'; skipBytes === 0 fetches from the start and accepts any position.  The tail starts
  // at max(fromPosition, header position), so a newer blob overrides the floor.
  resume: null | { position: number; skipBytes: number; fromPosition: number };
  // cancels this backfill alone; the connector's own signal cancels everything
  signal: AbortSignal;
  // Tell the Engine the position the snapshot was cut at and the seq of every stream in it
  onHeader(position: number, seqs: Record<string, number>): Promise<void>;
  // Tell the Engine about a new value we read out of the snapshot.
  onValues(values: [string, Uint8Array][], skip: number): Promise<void>;
  // Tell the Engine about a new event we loaded from the post-snapshot tail.
  onEvents(events: WireEvent[]): Promise<void>;
};

export type CommandResult =
  | { kind: 'ack'; position: number }
  | { kind: 'dup'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, or a resumed fetch's PhaseLock-Position differs from
// resume.position; the Engine discards what it parked and starts over.  Any other failure rejects,
// and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connector {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and a call that fails also fails every call behind it,
  // unsent, so the Engine's outbox order survives a retry.  Within a call, array order.
  sendCommand(commands: Command<Uint8Array>[]): Promise<CommandResult[]>;
}

export interface ConnectorHooks {
  // the whole view: token is its hash, position the commit it is the view at, refs the set.
  // Sent first when the presented token was not current, and on every change, in stream order
  // ahead of the events it applies to.  The Engine diffs refs against what it holds.
  onView(token: string, position: number, refs: string[]): void;
  onEvents(events: WireEvent[]): void;
  // history done; live from here (sent once per connection)
  onLive(position: number): void;
  onVouch(position: number): void;
  onEnd(code: number, reason: string): void;
}

// One Connector per connection: calling the factory is the connect attempt, since is the
// Engine's checkpoint (-1 to bootstrap), and the connector reports exactly one onEnd.  The signal
// is its lifetime; aborting it ends the connection and rejects any backfill or send in flight.
export type ConnectorFactory = (
  since: number,
  view: string | null, // the Engine's stored view token; null to bootstrap
  wants: string[],
  signal: AbortSignal,
  hooks: ConnectorHooks,
) => Connector;
