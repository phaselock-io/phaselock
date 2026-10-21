# PhaseLock client libraries

A client library is the half of a PhaseLock engine that needs a real
host: sockets, streams, msgpack, cancellation.  The other half, the
Engine, is the generated skeleton and runs anywhere, including hosts
with none of those.  The two meet at the transport contract described
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

## Mutations and edits

An app changes data by sending mutations; the database's decider
carries one out by writing keys, and the database records its writes
as edits, one per slice it touched, all at the mutation's log position.

```ts
/** mutation data T with the client-minted id it carries through the log,
    and the series and number the database dedups it by, or null for both
    in an unnumbered mutation */
export type Mutation<T> = {
  id: string;
  series: string | null;
  n: number | null;
  data: T;
};

/** what the database stamped on an edit when it committed it; the id is
    the mutation's */
export type EditEnvelope = {
  position: number;
  slice: string;
  seq: number;
  id: string;
  servertime: Date;
  lifecycle: 'normal' | 'birth' | 'death';
};

export type WireEdit = EditEnvelope & { raw: Uint8Array };
```

A mutation is the client's until a decider carries it out, so it has no
slice; an edit is the database's.  Connections deliver a `WireEdit`:
the envelope decoded for routing, and `raw`, the whole edit as the
server sent it, so the Engine can park it as one key or hand it to its
store to apply, with no conversion.  They take mutation data as bytes
the same way, `Mutation<Uint8Array>`.  A connection never decodes a
payload and never sees a registry.

Applying an edit is a store operation.  A birth or a death clears the
slice first; then the payload's operations run in order, each a set or
a deletion of one key.  A JS-native store splits a payload with the
Registry's `ops`, which slices each value out as a byte span without
decoding it, keeps the bytes, and decodes on read with the reader's
type.  The skeleton types `raw` as opaque `RawBytes`, so a
quickjs-class host can carry a handle instead and apply edits natively,
and value bytes never enter the JS heap.

## Transports and connections

```ts
export interface Transport {
  buildRegistry(schema: Schema): Registry;
  connect(
    since: number,            // the Engine's checkpoint, -1 to bootstrap
    view: string | null,      // the Engine's stored view token, null to bootstrap
    wants: string[],          // selectors the server cuts the view down to
    signal: Signal,           // the connection's lifetime
    hooks: ConnectionHooks,
    session: Session | null,  // who the Engine syncs as, null for anonymous
  ): Connection;
  post(mutations: Mutation<Uint8Array>[], session?: Session | null): Promise<MutationResult[]>;
}
```

A transport is how a host reaches one database, and it keeps no
identity: every connect and post names the session it speaks for, so
one transport serves any number of Engines and identities.
`buildRegistry` is the host's registry builder.  An Engine hands it the
generated schema it was built for, so an app never handles a schema or
a registry; the HTTP transport builds each schema once.

Calling `connect` is the connect attempt.  A connection lives for
exactly one attempt and reports exactly one `onEnd`, whether the
handshake was refused, the connection dropped, or the Engine aborted
the signal.  There is no connected-or-not state inside a connection.
Consequences:

- Every attempt gets the current checkpoint as an argument, so a stale
  `since` cannot happen.
- Backfills and mutation sends are scoped to the connection.  When it
  ends, its signal aborts them and their promises reject.  That is
  slightly wasteful when only the connection dropped, and worth it: one
  lifetime, one signal, one end.
- Configuration lives in the transport.  The TypeScript
  `new HTTPTransport(url)` holds the database's base URL, its origin
  and path prefix, such as `https://example.com/phaselock`; identity
  arrives as a session on each call.

`wants` is the engine's compile-time mask: the selectors of the slice types
the generated engine declares (`"book"`, `"patron:{id}"` lower to
`book`, `patron:*`).  The server cuts the view down to them and hashes
the token from the result, so a build whose wants changed presents a
stale token and gets the view frame, and the Engine never backfills
what it does not declare.  At boot the Engine purges whatever an
earlier build held outside the current wants: slices, backfills, and
view selectors.  An app-level mask intersected with it is deliberately
omitted until there is a use for one.

## Hooks: the live connection

```ts
export interface ConnectionHooks {
  onOpen(epoch: string, head: number): void;
  onView(token: string, position: number, selectors: string[]): void;
  onEdits(edits: WireEdit[]): void;
  onLive(position: number): void;
  onVouch(position: number): void;
  onEnd(code: number, reason: string, fatal?: unknown): void;
}
```

- `onOpen` comes first, once per connection, before any frame, with
  `PhaseLock-Epoch` from the response headers, an opaque id for the log
  every position on this connection belongs to, and `PhaseLock-Position`,
  the log's head as the connection opened.  The Engine writes no
  checkpoint without it, and a connection whose epoch differs from the
  stored checkpoint's is a replaced log.
- `onView` is the whole view: the token, the position it is the view
  at, and the full set of selectors.  The connection sends the Engine's
  stored token as `view`; when it is current no view frame comes at
  all, and when it is not the server's first frame is the view, ahead
  of any history.  Every later change is another view frame, ahead of
  the edits of the commit that caused it.  The Engine always diffs
  the set against what it holds: gone is cut by prefix, new is
  backfilled.  There is no incremental form, because the set is small
  by construction (a slice type is one selector), a whole set is idempotent
  where a diff must be applied exactly once, and the Engine needs the
  diffing code for the reconnect case anyway.
- Everything about views is in log order, and that is deliberate.
  There is no list endpoint: an out-of-band answer could cross a view
  frame, and applying it could cut a slice a later frame regranted or
  backfill a selector an earlier frame revoked.  History is replayed under
  the current view, so the Engine's held set at its checkpoint plus
  the replay is complete whatever changed while it was away, which is
  why a content-hashed token is enough to compare.  The Engine persists
  its view only when a reconciliation commits; a crash before that
  presents the old token again and gets the view again.
- Selectors, never slice names: a family grant is one selector and one
  backfill, and the Engine learns the members from the blob.  Every
  change to the set is sent, even one that leaves coverage as it was,
  because the token hashes the set.
- `onEdits` is one frame's edits, in log order.  A mutation's edits to
  the slices this connection holds arrive in one frame, so a client
  holding only some of a mutation's slices receives its part whole.
- `onLive` is the `live` frame, once per connection: history done.
- The live connection is assumed to keep up.  These hooks return
  `void`; there is no backpressure on the live path yet.

## Selectors

A slice selector picks out slices: an exact selector, a slice name,
names one slice, and a prefix selector, a family or its leading
parameters (`chat:*`, `chat:acme,*`) or `*`, names every slice under its
text before the star.  Grants, wants, and backfills are selectors, in the
wire grammar from `db/README.md`.  A connection puts a selector into a
URL path as it is.  Every allowed character, `:` and `,` included, is
legal unencoded in a path, and `*` too, so there is no escaping and no
`encodeURIComponent`; a `want` query parameter is form-encoded like any
other.  Validation of selectors is not the client's job.

## Backfill

```ts
export type Backfill = {
  selector: string;
  until: number;
  resume: null | {
    position: number;
    skipBytes: number;
    checksum: string;
    fromPosition: number;
    snapshotDone: boolean;
    tailDone: boolean;
  };
  signal: Signal;
  push(item: BackfillItem): Promise<void>;
};

export type BackfillItem =
  | { length: number }
  | { header: { position: number; seqs: Record<string, number> } }
  | { page: Uint8Array; skip: number; checksum: string }
  | { pagesDone: true }
  | { edits: WireEdit[]; scanned: number }
  | { editsDone: true };

export type BackfillOutcome = 'done' | 'stale';

export interface Connection {
  backfill(backfill: Backfill): Promise<BackfillOutcome>;
  sendMutations(mutations: Mutation<Uint8Array>[]): Promise<MutationResult[]>;
}
```

A backfill loads one selector: a snapshot blob, then the edits between the
blob's position and `until`.  The connection runs the two downloads
concurrently.

**The snapshot.**  `GET /snapshot/<selector>` answers either the blob inline
or a `text/plain` pointer to a URL to fetch with `Range`.  The header
gives the cut position and the seq of every slice in the blob; deliver
it as one `header` item.  Then stream the pages.

**Memory.**  Snapshots need not fit in memory.  The blob's header is
length-prefixed binary and its body a run of msgpack set operations,
encoded as an edit's payload is, so the connection needs a byte cursor
over the response body ("give me exactly n bytes, spanning chunks") and
a way to measure a msgpack value, not a streaming msgpack decoder.
Values are never decoded by the connection: a `page` item hands the
Engine whole operations, as the blob holds them, which the Engine parks
as they are and its store applies when the backfill lands.  `/edits`
pages and `/stream` are back-to-back msgpack values, and the connection
frames them with a small msgpack cursor of its own (array and map
headers, strings, ints, and skip): it decodes the tag and each envelope,
measures each edit to find its extent, and slices the bytes out.  The
stock library decodes only whole small values: the blob header map and
mutation results.

**Backpressure.**  Every delivery is one `push`, and it resolves when
the Engine has committed that item, not when it has queued it.  One
method carries the whole protocol, which is one method to implement in
every language.  The connection gathers operations into pages (a few
hundred KB or a thousand operations), allows one page in flight at the
Engine while it parses the next, and does not read the body further
until the earlier page resolves.  Not calling `read()` is what pushes
back on the network.  Bounded memory is two pages plus one partial
operation.  `skip`, the byte offset after the page, is committed with
the page, so a resume at `skipBytes` is exact.  So is `checksum`, the
connection's running check through the page, opaque to the Engine and
handed back as `resume.checksum`, so a resumed download still checks
the footer's operation count and content hash.

**The tail.**  Pages forward: `after` starts at
`max(resume.fromPosition, header position)`, `before` is `until`, `max`
is 1000.  Each page's `PhaseLock-Scanned` is the next `after`, verbatim.
Stop when `Scanned >= until`, or when a page states no `Scanned` or one
no further than its `after`.  How many edits a page holds decides
nothing, since a page never splits the edits of one position.  A blob
cut ahead of the cursor (every v0 live-cut blob) needs no special case:
the first request has an empty range and ends the loop.

**`until`** is the tail's exclusive upper bound: the cursor when the
backfill started.  Everything at or above it arrives on the live
connection and is parked by the Engine, so the three ranges partition
by construction and nothing is deduplicated.  Retries keep the original
value.  The edit that triggered a backfill sits at the cursor and is
parked before the backfill starts.

**`resume`** records what a previous attempt got through.  Each half
reports its own end with its own item, `pagesDone` and `editsDone`,
so a page item always carries a page; the Engine persists
`snapshotDone` and `tailDone` from them, and a resumed
backfill skips a finished half outright, which is what spares a
live-cut blob a second full download when only the tail was open.  For
an unfinished snapshot half,
`skipBytes > 0` resumes the download, and the header's position must
then equal `resume.position` or the outcome is `'stale'`;
`skipBytes === 0` fetches from the start and accepts any position.
Either way a blob whose epoch is not the connection's is `'stale'`.
`fromPosition` is a floor for the tail, overridden by a newer blob.  A
snapshot's identity across attempts is its position.  That works for
blobs written to a cache first and never for live cuts, which is
accepted: resuming a download only works for a cached blob.

**Outcomes.**  `'done'` means both downloads were delivered and
acknowledged.  `'stale'` means the snapshot vanished (404 or 410 from
the pointer URL) or a resumed fetch's position did not match; the
Engine discards the pages it parked, keeps the parked tail edits, and
retries with `skipBytes: 0` and `fromPosition` intact.  Any other
failure rejects, and everything delivered before it is still valid.

**The connection never retries.**  Not on 404, not on a dropped
connection.  It makes one attempt, returns or rejects, and the Engine
owns every retry and every backoff.  When one of the two downloads
fails the connection aborts the other; that is the only `AbortController`
it keeps, and it is not a retry mechanism.

## Sessions

A session is who a request speaks for: the token the database signed
at login, the user it names, its expiry, an `ended` flag, and an
optional `onRefresh`.  It is this library's own object: the skeleton
takes a session as opaque, and an Engine or a post only hands it back
to the transport, so a session from any other source is refused.  An Engine syncs as one session, or as anonymous,
for its whole life; signing in or out means building a new Engine.  The
TypeScript client makes sessions with `HTTPTransport.login`, which
takes a password or, against a database run with `--dev-auth`, an
identity alone, and with `restoreSession(token)` for a token the app
saved.

- The transport refreshes a session it is handed once the session has
  lived half its lifetime, in place, so every Engine and post sharing
  it presents the new token.  Refreshes of one session in flight
  together share one request, and `onRefresh` is the app's cue to save
  the token.  `refresh(session)` forces one, which is how an app checks
  a restored session before building an Engine.
- A 401 is the database refusing the session.  The transport ends the
  session; a connection reports an `AuthError` as `onEnd`'s `fatal`,
  which ends the Engine through `onError` instead of reconnecting; and a
  post rejects with it.  A refused login rejects with an `AuthError`
  naming the status.
- Mutations sent outside any Engine, such as account creation before
  anyone has signed in, go through the generated
  `post{Database}Mutation`, which posts any of a database's mutations,
  each under a fresh id and numbered 1 in a series of its own, as a
  session or as anonymous.  A transport retries a failed request of
  numbered mutations under the same ids, which the database's dedup
  makes safe, and tries one with an unnumbered mutation once.
  `postMutation` is the bare request beneath, for a transport of the
  app's own.

## Mutations

```ts
export type MutationResult =
  | { kind: 'ok'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'conflict'; current: Record<string, number> };
```

`sendMutations` and `post` mirror the wire outcomes one for one.  `ok`
means the mutation was decided at or before `position`, so a client
that has applied that far reads the outcome from its state.  A reject's
reason and a conflict's current seqs, by slice, come only in the first
answer to a decision; a resend of either is answered `ok` (DEDUP.md).
`expect` has no place on `Mutation` yet.

**Ordering is the connection's guarantee.**  Calls are applied in call
order, and within a call, array order.  A call that fails also fails
every call behind it, unsent, and ends the connection, so the next
connection's resend keeps the Engine's outbox order.  Retrying before
giving up is the connection's choice.  The HTTP connection retries a
failure that may not recur, a network failure or a 5xx, a few times
within a second under the same ids, which dedup makes safe; a 4xx
stands at once.  Then it gives up with the response's status as the
end code, and the Engine's reconnect with backoff takes over.  The
Engine writes to that rule without awaiting between calls.  How a
connection delivers it is its own business: the HTTP connection
serializes, one request in flight, because two requests have no
ordering between them; a WebSocket transport sends every call down its
one ordered connection at once and matches replies to calls, so the
Engine gets pipelining wherever the transport can give it.  Batching
stays the Engine's lever, since one call is one request.

## Types and decoding

The Registry is the host's view of the model's types: `convert` moves
a value between representations, `ops` splits an edit or a snapshot
page into operations, and `mutations` names the union the Engine may
send.  Besides the model's types it answers for four reserved ones:
`.json`, the Engine's own records; `.mutation`, an outbox row, whose
data stays the mutation's wire bytes; `.edits`, a parked edit, which
reads as its envelope alone, so the Engine walks parked chains without
touching payloads; and `.page`, a parked snapshot page, which nothing
converts.

Stored values follow the server's schema, which may be newer than the
client's.  Decoding drops fields the client's schema does not name, at
any depth.  A union value that matches none of its members is an
unknown member: in an optional field it reads as absent, in an array
or a record its element is dropped, and in a required field or a
tuple the failure moves up to the nearest value that can be dropped,
or fails the whole read.  A store treats a read that fails as a loud
error in a dev bundle and as absent in production.  Mutations are the
exception: the database rejects a foreign field or an unknown member
in one, so the Registry does too, both ways.

## What the Engine does with all this

Connections never interpret seqs; they are numbers.  The Engine owns:

- **Lazy gap detection.**  The blob header gives every slice's seq at
  the cut, every edit carries its seq, and a slice whose chain breaks,
  in a tail or on the live connection, is re-backfilled by itself with
  an exact-selector backfill.  A family blob is never invalidated as a
  whole.  A birth or a death is a reset, which the Engine chains on at
  any seq above its last.
- **The race we tolerate.**  The client is live at P and takes a
  snapshot cut at S below P.  Before its tail read, a new edit to some
  slice commits above P and retention evicts that slice's edits
  between S and P (keep-last-1 is enough).  The tail read then sees
  nothing in (S, P), the backfill lands, and only afterwards does the
  new edit reach the client on the live connection, where its seq jump
  reveals that the landed slice was stale.  The stale slice is
  visible for exactly the client's live-delivery lag, then the gap
  starts a replacing backfill.  Closing the window costs more than it
  is worth: a fixed backward overread proves one slice intact but is
  unbounded per family, reading forward to the head is unbounded, and
  waiting is not a fix.  So it is accepted, and it is what lazy
  detection means.  The one invariant it rests on is the retention
  floor: a slice's last edit is always kept, so an eviction always
  implies a newer edit that will arrive.
- **Additive versus replacing backfills.**  A grant or an unknown
  slice's first edit is additive: the slice is not held, so its
  backfill lands whenever it finishes.  A seq gap on a held slice, or
  a reboot, is replacing: the moment one starts, everything parks, the
  base store freezes, and every replacing backfill lands in one
  transaction.  Landing uses the store's `delPrefix`, `applySnapshot`,
  and `applyParked`, which apply parked bytes without lifting values
  into the host language and report the keys they touched for query
  invalidation.
- **`caughtUp` is a conjunction**: the connection delivered `live` and
  no replacing backfill is in flight.  It can go false mid-session.
  Each replacing backfill is complete when its snapshot and its edit
  tail are fully downloaded and no seq gap is observed (including across
  the initial live cursor mark).
- **Frames are consistent.**  The query graph runs every query from one
  read transaction and delivers every callback in one stack frame.
  While the base is frozen, commits to the store are limited to the
  parking prefix until a single atomic update can update the main keys of the
  store.  During that time, predictions continue but run against the
  base state, while backfills and live edits continue to get parked.
  The only carve-out would be a query that reads only status keys, which
  are in-memory keys owned by the Engine.
- **Reconnect versus reboot** is a cost choice made up front: replay
  since the checkpoint, or drop state and backfill every selector.  The
  trigger wants the server's oldest retained position alongside the
  head on `/stream` (not yet in the protocol).

## Undecided

- Whether the Engine, on a single-slice gap, may cut (drop the slice
  and treat its backfill as additive) instead of freezing.  Freeze is
  the rule; cut is a possible exception if the pause proves annoying.
- Per-mutation outcomes to the UI: counts on the status, or a promise
  per mutation.
- An app-level `wants` mask.
- A head-position and oldest-retained-position header on `/stream`.
- The Python and Go shapes of promises, hooks, and cancellation.
  Blocking calls are the natural backpressure in Go; `async def` hooks
  and task cancellation in Python; nothing in the contract depends on
  JavaScript except `AbortSignal`, which maps to `context.Context` and
  asyncio cancellation.
