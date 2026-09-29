# PhaseLock client libraries

A client library is the half of a PhaseLock engine that needs a real
host: sockets, streams, msgpack, cancellation.  The other half, the
Engine, is the generated skeleton and runs anywhere, including hosts
with none of those.  The two meet at the connector contract described
here.  This document is the blueprint for every client we write; the
TypeScript client is the canonical implementation and supplies the
examples.  Cross-language details are deliberately thin; they have not
been thought through yet.

The wire protocol itself is specified once, in `db/README.md`.  A client
implements it; it does not restate it.

## Layout

One directory per language, each a self-contained package for its
ecosystem:

    client/
      ts/     @phaselock/client        pnpm, depends on @msgpack/msgpack
      py/     phaselock-client         pyproject           (planned)
      go/     phaselock.io/client      its own go.mod      (planned)

## Envelopes

Two wrappers, named `Command` and `Event` in every language.  TypeScript
calls the second `DbEvent`, because `Event` is a DOM global and the
generated unions are already named `*Events`.  This is the only per-
language naming deviation.

```ts
/** command data T with the client-minted id it carries through the log */
export type Command<T> = { id: string; data: T };

/** event data T with the envelope the DB stamped on it when committed;
    the id is the command's */
export type DbEvent<T> = {
  id: string;
  data: T;
  position: number;
  stream: string;
  seq: number;
  servertime: number;
};
```

A command is the client's until precommit turns it into events, so it
has no stream; an event is the DB's.  Connectors deliver a `WireEvent`:
the envelope decoded for routing, `data` as the raw msgpack bytes the
server sent, and `raw`, the whole wire pair, so the Engine can park an
event as a slice with no conversion.  They take command data as bytes
the same way, `Command<Uint8Array>`.  A connector
never decodes or encodes a payload and never sees a registry: the
Engine converts bytes to rich values through the host's registry when
it reduces, and parks bytes untouched when it parks.  How a host turns
msgpack into rich values (in TypeScript today a stock decode to plain
values plus the generated lift; perhaps a generated one-walk decoder
over a msgpack cursor later) is an Engine and emitter decision the
contract does not depend on.

## One connector per connection

```ts
export type ConnectorFactory = (
  since: number,        // the Engine's checkpoint, -1 to bootstrap
  view: string | null,  // the Engine's stored view token, null to bootstrap
  wants: string[],      // refs the server cuts the view down to
  signal: AbortSignal,  // the connector's lifetime
  hooks: ConnectorHooks,
) => Connector;
```

Calling the factory is the connect attempt.  A connector lives for
exactly one connection and reports exactly one `onEnd`, whether the
handshake was refused, the stream dropped, or the Engine aborted the
signal.  There is no `connect()` and no connected-or-not state inside a
connector.  Consequences:

- Every attempt gets the current checkpoint as an argument, so a stale
  `since` cannot happen.
- Backfills and command sends are scoped to the connector.  When it
  ends, its signal aborts them and their promises reject.  That is
  slightly wasteful when only the stream dropped, and worth it: one
  lifetime, one signal, one end.
- Configuration lives in the factory's closure.  The TypeScript
  `NewHTTPConnector(url)` captures the URL and whatever supplies auth
  tokens; the contract never sees either.

`wants` is the engine's compile-time mask: the refs of the shards the
generated engine declares (`"book"`, `"patron.{id}"` lower to `book`,
`patron.*`).  The server cuts the view down to them and hashes the
token from the result, so a build whose wants changed presents a
stale token and gets the view frame, and the Engine never backfills
what it cannot fold.  At boot the Engine purges whatever an earlier
build held outside the current wants: streams, backfills, and view
refs.  An app-level mask intersected with it is deliberately omitted
until there is a use for one.

## Hooks: the live stream

```ts
export interface ConnectorHooks {
  onOpen(epoch: string): void;
  onView(token: string, position: number, refs: string[]): void;
  onEvents(events: WireEvent[]): void;
  onLive(position: number): void;
  onVouch(position: number): void;
  onEnd(code: number, reason: string): void;
}
```

- `onOpen` comes first, once per connection, before any frame, with
  `PhaseLock-Epoch` from the response headers: an opaque id for the log
  every position on this connection belongs to.  The Engine writes no
  checkpoint
  without it, and a connection whose epoch differs from the stored
  checkpoint's is a replaced log.
- `onView` is the whole view: the token, the position it is the view
  at, and the full set of refs.  The connector sends the Engine's
  stored token as `view`; when it is current no view frame comes at
  all, and when it is not the server's first frame is the view, ahead
  of any history.  Every later change is another view frame, ahead of
  the events of the commit that caused it.  The Engine always diffs
  the set against what it holds: gone is cut by prefix, new is
  backfilled.  There is no incremental form, because the set is small
  by construction (a family is one ref), a whole set is idempotent
  where a diff must be applied exactly once, and the Engine needs the
  diffing code for the reconnect case anyway.
- Everything about views is in stream order, and that is deliberate.
  There is no list endpoint: an out-of-band answer could cross a view
  frame, and applying it could cut a stream a later frame regranted or
  backfill a ref an earlier frame revoked.  History is replayed under
  the current view, so the Engine's held set at its checkpoint plus
  the replay is complete whatever changed while it was away, which is
  why a content-hashed token is enough to compare.  The Engine persists
  its view only when a reconciliation commits; a crash before that
  presents the old token again and gets the view again.
- Refs, never stream names: a family grant is one ref and one
  backfill, and the Engine learns the members from the blob.  Every
  change to the set is sent, even one that leaves coverage as it was,
  because the token hashes the set.
- `onLive` is the `live` frame, once per connection: history done.
- The live stream is assumed to keep up.  These hooks return `void`;
  there is no backpressure on the live path yet.

## Refs

Refs use the wire grammar from `db/README.md`: a stream name,
`family.*`, or `*`.  A connector puts a ref into a URL as it is.  Every
allowed character is URL-safe and `*` is legal unencoded in a path, so
there is no escaping and no `encodeURIComponent`.  Validation of refs is
not the client's job.

## Backfill

```ts
export type Backfill = {
  ref: string;
  until: number;
  resume: null | {
    position: number;
    skipBytes: number;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  signal: AbortSignal;
  push(item: BackfillItem): Promise<void>;
};

export type BackfillItem =
  | { header: { position: number; seqs: Record<string, number> } }
  | { values: [string, Uint8Array][]; skip: number }
  | { valuesDone: true }
  | { events: WireEvent[] }
  | { eventsDone: true };

export type BackfillOutcome = 'done' | 'stale';

export interface Connector {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  sendCommand(commands: Command<Uint8Array>[]): Promise<CommandResult[]>;
}
```

A backfill loads one ref: a snapshot blob, then the events between the
blob's position and `until`.  The connector runs the two downloads
concurrently.

**The snapshot.**  `GET /snapshot/<ref>` answers either the blob inline
or a `text/plain` pointer to a URL to fetch with `Range`.  The header
gives the cut position and the seq of every stream in the blob; deliver
it as one `header` item.  Then stream the records.

**Memory.**  Snapshots need not fit in memory.  The blob's outer
framing is length-prefixed binary, so the connector needs a byte cursor
over the response body ("give me exactly n bytes, spanning chunks"), not
a streaming msgpack decoder.  Values are never decoded by the connector:
a `values` item hands the Engine raw bytes, which the store keeps in msgpack
form.  `/events` pages and `/stream` are back-to-back msgpack values,
and the connector frames them with a small msgpack cursor of its own
(array and map headers, strings, ints, and skip): it decodes the tag
and each envelope, skips over `data` to find its extent, and slices the
bytes out.  The stock library decodes only whole small values: the blob
header map and command results.

**Backpressure.**  Every delivery is one `push`, and it resolves when
the Engine has committed that item, not when it has queued it.  One
method carries the whole protocol, which is one method to implement in
every language.  The
connector batches records (a few hundred KB or a thousand records),
allows one batch in flight at the Engine while it parses the next, and
does not read the body further until the earlier batch resolves.  Not
calling `read()` is what pushes back on the network.  Bounded memory is
two batches plus one partial record.  `skip`, the byte offset after the
batch, is committed with the batch, so a resume at `skipBytes` is
exact.

**The tail.**  Pages forward: `after` starts at
`max(resume.fromPosition, header position)`, `before` is `until`, `max`
is 1000.  Each page's `PhaseLock-Scanned` is the next `after`, verbatim.
Stop on a short page or when `Scanned >= until`.  A blob cut ahead of
the cursor (every v0 live-cut blob) needs no special case: the first
request has an empty range and ends the loop.

**`until`** is the tail's exclusive upper bound: the cursor when the
backfill started.  Everything at or above it arrives on the live stream
and is parked by the Engine, so the three ranges partition by
construction and nothing is deduplicated.  Retries keep the original
value.  The event that triggered a backfill sits at the cursor and is
parked before the backfill starts.

**`resume`** records what a previous attempt got through.  Each half
reports its own end with its own item, `valuesDone` and `eventsDone`,
so a batch item always carries a batch; the Engine persists
`snapshotDone` and `tailDone` from them, and a resumed
backfill skips a finished half outright, which is what spares a
live-cut blob a second full download when only the tail was open.  For
an unfinished snapshot half,
`skipBytes > 0` resumes the download, and the header's position must
then equal `resume.position` or the outcome is `'stale'`;
`skipBytes === 0` fetches from the start and accepts any position.
`fromPosition` is a floor for the tail, overridden by a newer blob.  A
snapshot's identity across attempts is its position.  That works for
blobs written to a cache first and never for live cuts, which is
accepted: resuming a download only works for a cached blob.

**Outcomes.**  `'done'` means both downloads were delivered and
acknowledged.  `'stale'` means the snapshot vanished (404 or 410 from
the pointer URL) or a resumed fetch's position did not match; the
Engine discards the values it parked, keeps the parked tail events, and
retries with `skipBytes: 0` and `fromPosition` intact.  Any other
failure rejects, and everything delivered before it is still valid.

**The connector never retries.**  Not on 404, not on a dropped
connection.  It makes one attempt, returns or rejects, and the Engine
owns every retry and every backoff.  When one of the two downloads
fails the connector aborts the other; that is the only `AbortController`
it keeps, and it is not a retry mechanism.

## Commands

```ts
export type CommandResult =
  | { kind: 'ack'; position: number }
  | { kind: 'dup'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };
```

`sendCommand` mirrors the wire outcomes one for one.  `expect` has no
place on `Command` yet.

**Ordering is the connector's guarantee.**  Calls are applied in call
order, and a call that fails also fails every call behind it, unsent,
so the Engine's outbox order survives a retry; within a call, array
order.  The Engine writes to that rule without awaiting between calls.
How a connector delivers it is its own business: the HTTP connector
serializes, one request in flight, because two requests have no
ordering between them; a WebSocket connector sends every call down its
one ordered stream at once and matches replies to calls, so the Engine
gets pipelining wherever the transport can give it.  Batching stays the
Engine's lever, since one call is one request.

## What the Engine does with all this

Connectors never interpret seqs; they are numbers.  The Engine owns:

- **Lazy gap detection.**  The blob header gives every member's seq at
  the cut, every event carries its seq, and a stream whose chain breaks,
  in a tail or on the live stream, is re-backfilled by itself with an
  exact-ref backfill.  A family blob is never invalidated as a whole.
- **The race we tolerate.**  The client is live at P and takes a
  snapshot cut at S below P.  Before its tail read, a new event on some
  member commits above P and retention evicts that member's events
  between S and P (keep-last-1 is enough).  The tail read then sees
  nothing in (S, P), the backfill lands, and only afterwards does the
  new event reach the client on the live stream, where its seq jump
  reveals that the landed member was stale.  The stale member is
  visible for exactly the client's live-delivery lag, then the gap
  starts a replacing backfill.  Closing the window costs more than it
  is worth: a fixed backward overread proves the member intact for one
  stream but is unbounded per family, reading forward to the head is
  unbounded, and waiting is not a fix.  So it is accepted, and it is
  what lazy detection means.  The one invariant it rests on is the
  retention floor: a stream's last event is always kept, so an eviction
  always implies a newer event that will arrive.
- **Additive versus replacing backfills.**  A grant or an unknown
  stream's first event is additive: the stream is not held, so its
  backfill lands whenever it finishes.  A seq gap on a held stream, or
  a reboot, is replacing: the moment one starts, everything parks, the
  base store freezes, and every replacing backfill lands in one
  transaction, with the parked live events applied in position order
  after the moves.  Landing uses the store's `delPrefix` and `move`,
  which rekey without lifting values into the host language and report
  the keys they touched for query invalidation.
- **`caughtUp` is a conjunction**: the connector delivered `live` and
  no replacing backfill is in flight.  It can go false mid-session.
  Each replacing backfill is complete when its snapshot and its event
  tail are fully downloaded and no seq gap is observed (including across
  the initial live cursor mark).
- **Frames are consistent.**  The query graph runs every query from one
  read transaction and delivers every callback in one stack frame.
  While the base is frozen, commits to the store are limited to the
  parking prefix until a single atomic update can update the main keys of the
  store.  During that time, optimistic updates continue but run against the
  base state, while backfills and live events continue to get parked.
  The only carve-out would be a query that reads only status keys, which
  are in-memory keys owned by the Engine.
- **Reconnect versus reboot** is a cost choice made up front: replay
  since the checkpoint, or drop state and backfill every ref.  The
  trigger wants the server's oldest retained position alongside the
  head on `/stream` (not yet in the protocol).

## Decided but not built

- the status key available to Queries but originating in the Engine.
- Precommit as the forecaster (using an rx to reforecast after each Store change).

## Undecided

- Who supplies and refreshes the auth token, beyond "the factory's
  closure".
- Whether the Engine, on a single-stream gap, may cut (drop the stream
  and treat its backfill as additive) instead of freezing.  Freeze is
  the rule; cut is a possible exception if the pause proves annoying.
- Per-command outcomes to the UI: counts on the status, or a promise
  per command.
- An app-level `wants` mask.
- A head-position and oldest-retained-position header on `/stream`.
- The Python and Go shapes of promises, hooks, and cancellation.
  Blocking calls are the natural backpressure in Go; `async def` hooks
  and task cancellation in Python; nothing in the contract depends on
  JavaScript except `AbortSignal`, which maps to `context.Context` and
  asyncio cancellation.
