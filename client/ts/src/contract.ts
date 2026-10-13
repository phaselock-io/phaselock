// The connector contract and the envelope types.  These are declared in the generated
// skeleton too, which has no imports; they are duplicated here verbatim, and structural typing
// lines the two up.  Changing them costs a change in every client in every language.

/** Command wraps command data T with the client-minted id it will carry through the log, and
    the session and number the database dedups it by: a sender numbers its commands in a session
    it mints, and the database runs each number once.  A sessionless command has neither. */
export type Command<T> = {
  id: string;
  session: string | null;
  n: number | null;
  data: T;
};

/** DbEvent is event data T with the envelope the DB stamped on it when it was committed:
    [position, stream, seq, id, servertime] on the wire, the server time a msgpack timestamp.  The
    id is the command's. */
export type DbEvent<T> = {
  id: string;
  data: T;
  position: number;
  stream: string;
  seq: number;
  servertime: Date;
};

/** WireEvent is an event as a connector delivers it: the envelope decoded for routing, data as
    the bytes the server sent, and the whole wire pair `[env, data]` so parking it is a slice. */
export type WireEvent = DbEvent<Uint8Array> & { raw: Uint8Array };

/** A cancellation signal, as the Engine and its connectors use one: whether it has fired and why,
    and a listener for when it does.  A browser's or Node's AbortSignal is one. */
export interface Signal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export type Backfill = {
  // what ref are we backfilling (stream name or prefix)
  ref: string;
  // the tail's exclusive upper bound: the cursor when this backfill started.  Anything at or
  // above it arrives on the live stream and is parked.  Retries keep the original value.
  until: number;
  // what a previous attempt got through, or null for a fresh backfill.  A finished half is
  // skipped outright.  Otherwise skipBytes > 0 resumes the blob download, and the header's
  // position must then equal position or the outcome is 'stale'; skipBytes === 0 fetches from
  // the start and accepts any position.  The tail starts at max(fromPosition, header position),
  // so a newer blob overrides the floor.  It reads forward, which may result in gaps if retention
  // pruning happens concurrently, so it must be checked for gaps just before landing.
  resume: null | {
    position: number;
    skipBytes: number;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  // cancels this backfill alone; the connector's own signal cancels everything
  signal: Signal;
  // one call per delivery, resolved once the Engine has committed it
  push(item: BackfillItem): Promise<void>;
};

/** One delivery of a backfill: the blob's whole length in bytes, when its response states one;
    the blob's header (its cut position and the seq of every stream in it); a batch of values with
    the byte offset after them; a page of tail events with the position its scan reached; or the
    end of either half.  The length and the scan feed the Engine's progress status alone. */
export type BackfillItem =
  | { length: number }
  | { header: { position: number; seqs: Record<string, number> } }
  | { values: [string, Uint8Array][]; skip: number }
  | { valuesDone: true }
  | { events: WireEvent[]; scanned: number }
  | { eventsDone: true };

/** What the database answers for a command.  `ok` means it was decided at or before position, so
    a client that has reduced that far can read the outcome from its state.  A reject's reason
    and a conflict's current seqs come only in the first answer to a decision, and a resend of
    either is answered `ok`. */
export type CommandResult =
  | { kind: 'ok'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, or a resumed fetch's PhaseLock-Position differs from
// resume.position; the Engine discards what it parked and starts over.  Any other failure rejects,
// and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connector {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and within a call, array order.  A call that fails also
  // fails every call behind it, unsent, and ends the connection, so the next connection's resend
  // keeps the Engine's order.  Retrying before giving up is the connector's choice.
  sendCommands(commands: Command<Uint8Array>[]): Promise<CommandResult[]>;
}

export interface ConnectorHooks {
  // first, once per connection, before any frame: from the response headers, the epoch, the log
  // every position on this connection belongs to, and the head, the log's position as the
  // connection opened
  onOpen(epoch: string, head: number): void;
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
  signal: Signal,
  hooks: ConnectorHooks,
) => Connector;

// the store's value bundles and the Registry, with the registry data a host builds one from

/** The representations a value can be in: JS is the rich JS value, HOST the host language's,
    MSGPACK the bytes.  Every get names the one it wants and every set the one it gives; a store
    converts to what it keeps on the way in and to what was asked for on the way out. */
export const JS = 1;
export const HOST = 2;
export const MSGPACK = 3;
export type Rep = typeof JS | typeof HOST | typeof MSGPACK;

/** Registry converts between representations of typed values and names the types the store
    holds.  Types are model names from the TypeSpec, plus three reserved names: `.json` for the
    Engine's own shapes; `.command` for the outbox envelope, `{id, data}` with `data` already the
    command's wire bytes, so it needs no vocabulary to read; and `.event` for a parked event, the
    wire pair `[env, data]` in `msgpack` and a DbEvent in `js`, its `data` converted through the
    union of the stream's slice. */
export interface Registry {
  /** a value of type `type`, given in one representation, in another */
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown;
  /** the commands union this engine may submit */
  commands: string;
  /** a family, a stream name before its first ':', to the slice's events union */
  eventTypes: Record<string, string>;
  /** family/name, a key's family and its local key's name, to the store value's type */
  storeTypes: Record<string, string>;
}

/** One type of the model, as the generated registry describes it; children are indices into
    the same node table.  A struct lists its fields in declaration order, and names the one it
    writes first, the field a union tells it apart from its other members by, or -1; a union
    carries the solver's decision tree; an intake node names a field the database prepares for
    precommit, over the wire type a client sends.  The identities of a struct, record, array,
    tuple, or union are its name, or null when the type has none. */
export type SchemaNode =
  | ['null']
  | ['int']
  | ['str']
  | ['bool']
  | ['date']
  | ['json']
  | ['lit', string | number | boolean]
  | [
      'struct',
      string | null,
      [key: string, type: number, optional: boolean][],
      discriminator: number,
    ]
  | ['record', string | null, number]
  | ['array', string | null, number]
  | ['tuple', string | null, number[]]
  | ['union', string | null, SchemaSolution]
  | ['intake', string, number];

/** How a walk tells a union's members apart.  `match` names the member.  `jsontype` branches on
    the value's json type, `literal` on its value, `length` on an array's length with a default
    for any other, `index` descends into an array element, `field` tests a field of the object
    without descending, and `hasfield` picks the first of its keys present. */
export type SchemaSolution =
  | ['match', number]
  | ['jsontype', [string, SchemaSolution][]]
  | ['literal', [string | number | boolean, SchemaSolution][]]
  | ['length', [number, SchemaSolution][], SchemaSolution | null]
  | ['index', number, SchemaSolution]
  | ['field', string, SchemaSolution]
  | ['hasfield', [string, SchemaSolution][]];

/** The type registry as data, generated per engine and per database: the model's types as a
    node table, the type identities the Registry answers for and their nodes, and what the
    Registry's `commands`, `eventTypes`, and `storeTypes` are.  Every engine and database of one
    model shares one node table.  A host walks it to convert values; the reserved identities are
    the host's own. */
export type Schema = {
  nodes: SchemaNode[];
  ids: Record<string, number>;
  /** the commands union, or null for a database with no commands */
  commands: string | null;
  eventTypes: Record<string, string>;
  storeTypes: Record<string, string>;
};
