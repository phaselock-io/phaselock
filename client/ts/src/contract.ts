// The transport contract, the edit envelope, and the Registry.  These are declared in the
// generated skeleton too, which has no imports; they are duplicated here, and structural typing
// lines the two up.  Changing them costs a change in every client in every language.  This is a
// JS-native host, so raw bytes, which the skeleton leaves opaque, are a Uint8Array here; and the
// skeleton takes a session as an opaque object, where this library's is its Session class.

import type { Session } from './session.js';

/** Mutation wraps mutation data T with the client-minted id it will carry through the log, and
    the series and number the database dedups it by: an Engine numbers its mutations in a series
    it mints, and the database runs each number once.  An unnumbered mutation has neither. */
export type Mutation<T> = {
  id: string;
  series: string | null;
  n: number | null;
  data: T;
};

/** Where an edit stands in its slice's life.  A normal edit applies its writes.  A birth clears
    the slice, then applies its writes.  A death clears the slice and writes nothing.  A birth or
    a death is a reset, which a client chains on at any seq above its last. */
export type Lifecycle = 'normal' | 'birth' | 'death';

/** What the database stamped on an edit when it committed it: the log position of its mutation,
    the slice it edits and its seq there, the mutation's id, the server time, and where the edit
    stands in the slice's life.  A mutation that edits three slices makes three edits at one
    position. */
export type EditEnvelope = {
  position: number;
  slice: string;
  seq: number;
  id: string;
  servertime: Date;
  lifecycle: Lifecycle;
};

/** WireEdit is an edit as a connection delivers it: the envelope decoded for routing, and the
    whole edit as it came, which the Engine parks or hands to its store to apply, never reading
    its payload. */
export type WireEdit = EditEnvelope & { raw: Uint8Array };

/** A cancellation signal, as the Engine and its connections use one: whether it has fired and why,
    and a listener for when it does.  A browser's or Node's AbortSignal is one. */
export interface Signal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export type Backfill = {
  // what selector are we backfilling (slice name or prefix)
  selector: string;
  /* The tail's exclusive upper bound, which retries keep: the tail delivers the positions below
     it, and the live connection those at or above it, which the Engine parks.  Between a
     bootstrap's backfills and its connection the contract is this: once the view frame that
     answers the bootstrap, at V, is processed, the cursor is V; the backfills cover every position
     at or below V, and the connection every position above it.  So a view frame's backfills take
     V + 1, and an edit at V that the connection delivers too parks again under the same key. */
  until: number;
  // what a previous attempt got through, or null for a fresh backfill.  A finished half is
  // skipped outright.  Otherwise skipBytes > 0 resumes the blob download, and the header's
  // position must then equal position or the outcome is 'stale'; skipBytes === 0 fetches from
  // the start and accepts any position.  Either way a blob from another log, its epoch not the
  // connection's, is 'stale'.  The tail starts at max(fromPosition, header position), so a newer
  // blob overrides the floor.  It reads forward, which may result in gaps if retention
  // pruning happens concurrently, so it must be checked for gaps just before landing.  The
  // checksum is the last parked page's, handed back so a resumed download continues its check;
  // it is '' when skipBytes is 0.
  resume: null | {
    position: number;
    skipBytes: number;
    checksum: string;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  // cancels this backfill alone; the connection's own signal cancels everything
  signal: Signal;
  // one call per delivery, resolved once the Engine has committed it
  push(item: BackfillItem): Promise<void>;
};

/** One delivery of a backfill: the blob's whole length in bytes, when its response states one;
    the blob's header, its cut position and the seq of every slice in it, which names every slice
    the blob holds; a page of the blob's set operations, whole ones, with the byte offset after
    it, to resume past, and the transport's running check over every page delivered so far; a run
    of tail edits with the position its scan reached; or the end of either half.  The length and
    the scan feed the Engine's progress status alone, and the checksum is opaque to it, kept only
    to hand back on a resume.  A download without a resume pushes its header before anything else
    but its length, since the header is what the rest is parked against. */
export type BackfillItem =
  | { length: number }
  | { header: { position: number; seqs: Record<string, number> } }
  | { page: Uint8Array; skip: number; checksum: string }
  | { pagesDone: true }
  | { edits: WireEdit[]; scanned: number }
  | { editsDone: true };

/** What the database answers for a mutation.  `ok` means it was decided at or before position,
    so a client that has applied that far can read the outcome from its state.  A reject's reason
    and a conflict's current seqs, by slice, come only in the first answer to a decision, and a
    resend of either is answered `ok`. */
export type MutationResult =
  | { kind: 'ok'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };

// 'stale' when the snapshot vanished, when its epoch is not the connection's, or when a resumed
// fetch's PhaseLock-Position differs from resume.position; the Engine discards what it parked and
// starts over.  Any other failure rejects, and the Engine may retry with resume as persisted.
export type BackfillOutcome = 'done' | 'stale';

export interface Connection {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  // Calls are applied in call order, and within a call, array order.  A call that fails also
  // fails every call behind it, unsent, and ends the connection, so the next connection's resend
  // keeps the Engine's order.  Retrying before giving up is the connection's choice.
  sendMutations(mutations: Mutation<Uint8Array>[]): Promise<MutationResult[]>;
}

export interface ConnectionHooks {
  // first, once per connection, before any frame: from the response headers, the epoch, the log
  // every position on this connection belongs to, and the head, the log's position as the
  // connection opened
  onOpen(epoch: string, head: number): void;
  // the whole view: token is its hash, position the commit it is the view at, selectors the set.
  // Sent first when the presented token was not current, and on every change, in log order
  // ahead of the edits it applies to.  The Engine diffs selectors against what it holds.
  onView(token: string, position: number, selectors: string[]): void;
  // the edits of one frame, in log order; a mutation's edits to the slices this connection holds
  // arrive in one frame
  onEdits(edits: WireEdit[]): void;
  // history done; live from here (sent once per connection)
  onLive(position: number): void;
  onVouch(position: number): void;
  // the connection is over; fatal is the error that ends the Engine, when no later connection
  // can succeed, such as the database refusing the session
  onEnd(code: number, reason: string, fatal?: unknown): void;
}

/** A Transport is how a host reaches one database: the host's Registry, built from generated
    registry data; one connection per connect attempt; and mutations posted outside any
    connection.  It keeps no identity: each call names the session it speaks for, or null for
    anonymous. */
export interface Transport {
  buildRegistry(schema: Schema): Registry;
  // One Connection per attempt: since is the Engine's checkpoint (-1 to bootstrap), and the
  // connection reports exactly one onEnd.  wants are the selectors of the Engine's slice types, one
  // each, which the database cuts the view down to.  The signal is its lifetime; aborting it ends
  // the connection and rejects any backfill or send in flight.
  connect(
    since: number,
    view: string | null, // the Engine's stored view token; null to bootstrap
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
    session: Session | null,
  ): Connection;
  // Mutations outside any connection, answered with their outcomes in order, in as many requests
  // as the database's limit on mutations per request calls for, one after another.  A transport
  // may retry a failed request when every mutation in it is numbered, since the database answers
  // a resend of one that landed as decided, and never retries one that is not.
  post(mutations: Mutation<Uint8Array>[], session?: Session | null): Promise<MutationResult[]>;
}

// the store's value representations and the Registry, with the registry data a host builds one
// from

/** The representations a value can be in: JS is the rich JS value, HOST the host language's,
    MSGPACK the bytes.  Every get names the one it wants and every set the one it gives; a store
    converts to what it keeps on the way in and to what was asked for on the way out. */
export const JS = 1;
export const HOST = 2;
export const MSGPACK = 3;
export type Rep = typeof JS | typeof HOST | typeof MSGPACK;

/** Registry converts between representations of typed values.  Types are model names from the
    TypeSpec, plus four reserved names.  `.json` is the Engine's own shapes.  `.mutation` is an
    outbox row, a Mutation<Uint8Array> whose `data` is already the mutation's wire bytes, so it
    needs no vocabulary to read.  `.edits` is a parked edit, the raw edit in `msgpack` and its
    EditEnvelope alone in `js`; it converts from `msgpack` only.  `.page` is a parked snapshot
    page, bytes that only a store's applySnapshot reads, which no Registry converts. */
export interface Registry {
  /** a value of type `type`, given in one representation, in another */
  convert(type: string, value: unknown, from: Rep, to: Rep): unknown;
  /** The operations of a raw edit, its envelope skipped, or of a snapshot page, in order, for a
      JS-native store to apply: each a key and its value's bytes, sliced out undecoded, or
      undefined for a deletion.  An opcode it does not know throws. */
  ops(bytes: Uint8Array, edit: boolean): EditOp[];
  /** the mutations union this engine may send */
  mutations: string;
}

/** one operation of an edit or a snapshot page: a set, with its value's msgpack bytes, a nil
    setting null, or a deletion, with undefined */
export type EditOp = [key: string, value: Uint8Array | undefined];

/** One type of the model, as the generated registry describes it; children are indices into
    the same node table.  A struct lists its fields in declaration order, and names the one it
    writes first, the field a union tells it apart from its other members by, or -1; a union
    carries the solver's decision tree; an intake node names a field the database prepares for
    the decider, over the wire type a client sends.  The identities of a struct, record, array,
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
    Registry's `mutations` is.  Every engine and database of one model shares one node table.  A
    host walks it to convert values; the reserved identities are the host's own. */
export type Schema = {
  nodes: SchemaNode[];
  ids: Record<string, number>;
  /** the mutations union, or null for a database with no mutations */
  mutations: string | null;
};
