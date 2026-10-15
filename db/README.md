# DB, version 0

This DB is vibe-coded.  It is meant to meet a subset of the requirements for
the (planned) real DB, to power demos and full-stack development.

## The (planned) real DB:

The real db will have the following shape:

- it will be a CGO project: a Go HTTP wrapper around a C db core.
- the C core will use QuickJS, LDMB, a custom event log and dedup index
- connections are received in Go, and JWT checked
- commands are received in Go and passed byte-wise to the C core
- the C core will batch up incoming writes into transaction batches
- for each batch:
  - lmdb write txn is opened
  - for each txn:
    - command bytes are extracted to QuickJS, and checked for validity and authz
    - duplicate commands are skipped; reused client-minted IDs are rejected
    - user-provided precommit function processes commands, returns events
    - events are appended to log file
    - user-provided reducer function updates lmdb
  - log file is committed
  - lmdb txn is committed
  - dedup index is committed

The reasons to use QuickJS (vs V8 or Node.js) are:
  - its performance and simplicity
  - its sandboxing abilities
  - raw IO and serde work can be done in C
  - optimistic parallelism is possible in the JS hot loop

Additional features will include:
  - live snapshots
  - support for deletions and retention policies
  - a viewstamped replication layer for HA configurations

According to exploratory benchmarks, we are hoping to support write capacities
north of 100K events/second in the non-HA configuration.

This is gonna be _really_ cool.

## Today's (vibe-coded) DB:

But time is short, so we're shipping a vibe-coded version of that just to power
demos:

- it will be a CGO project: a Go HTTP wrapper around a C core.
- the C core will use QuickJS, and SQLite for log, kv store, and dedup index
- connections are received in Go, and JWT checked
- commands are received in Go and passed byte-wise to the C core
- the C core will batch up incoming writes into transaction batches
- for each batch:
  - sql txn is opened
  - for each txn:
    - command bytes are extracted to QuickJS, and checked for validity and authz
    - duplicate commands are skipped; reused client-minted IDs are rejected
    - user-provided precommit function processes commands, returns events
    - events are appended to sqlite log table
    - user-provided reducer function updates sqlite kv table
  - sql txn is committed

Features not bothered with:
  - retention policies
  - ha configurations
  - live snapshots
  - memory conservation

This isn't the final shape we want,

This will be medium-performance, but it will support the whole pipline of a
PhaseLock app as we envision it, so it is useful to have.

## Decisions for the vibe-coded build

Settled in design discussion before writing code.  Deltas against the
plan above take precedence over it.

### Shape

- Go HTTP layer over a C core, joined by cgo.  Go never decodes
  msgpack on the data path: commands go to C as the bytes the client
  sent, events come out of C as encoded `[envelope, data]` values, and
  Go writes only container headers around them.  The auth endpoints
  are Go-owned and decode their own small request bodies.
- SQLite for everything in C: the log, the KV store, the series
  table, the known-streams table.  One write transaction per group
  commit, WAL mode, synchronous=FULL.
- Threads in C: the txn loop (owns QuickJS, SQLite writer connection,
  maySee registrations); a results pop thread on the Go side that
  blocks in one cgo call; a reader thread with its own SQLite
  connection for history reads, list, and snapshot cuts.  Handler
  goroutines enqueue commands directly; no dedicated push thread.
  Command outcomes, view changes, and lookup replies all come back
  through the single results queue.
- The bundle is one JS file assigning `globalThis.__bundle` (see Bundle
  contract): the app's `db.ts` calling the generated `define{Database}`,
  bundled with the generated module.
- Every typed value crosses through the conversion kernel
  (`core/walk.c`): a source, either msgpack parsed by mpack's node API
  or a tokenization of a QuickJS value, a walk over the registry the
  bundle carries, and a sink that builds JS values, writes msgpack
  with mpack, or discards.  C builds rich values
  straight from msgpack and walks the JS heap straight to msgpack, and
  it checks every command on the handler's thread before anything
  else happens to it.  The registry is compiled once at open; its
  identities type every store key (`storeTypes`) and every stream's
  events (`eventTypes`).  mpack writes the output; untyped values, the
  outcomes and `lookup`'s traffic, still go through `mpjs.c`.
- One context for the process, made in `main` from SIGINT and SIGTERM:
  every request runs under it (`http.Server.BaseContext`), so an open
  stream ends the moment it does.  Shutdown then waits for handlers to
  return, a cgo call or a hash in progress finishing first, stops the
  hash workers, and closes the core, which commits the batch in hand.
  The core outlives every handler, since a handler reaching a closed
  core would be a use-after-free in C.

### Log and atoms

- The command is the atom.  A POST may carry several commands; each is
  checked, pre-committed, folded, and acked independently and in
  order.  Group commit batches atoms per fsync, and every log row
  records the first position of its atom, which is how readers find
  atom boundaries.  The check runs in the
  handler's cgo call, against the commands union of the registry and
  rejecting fields the model does not name, so a malformed command is
  answered there and never reaches dedup, `expect`, or the writer; the
  fields the database prepares for precommit (a `NewPassword`'s hash)
  are collected by the check and replaced when the checked command is
  written out for the writer thread.
- Each command runs in a nested transaction, a SQLite savepoint inside
  the group's transaction.  A reducer that throws while folding a
  command's outputs is a bug, and it rolls back that command alone:
  its events, births, deaths, and state writes are undone, the command
  is rejected, and the rest of the group commits.
- A rejection's reason, a precommit handler's `Reject`, reaches the
  client as it is.  Any other failure is a bug: a throw from
  precommit, a reducer, or lookup, a precommit output whose stream
  does not fill its family's template, or a reducer write to a key no
  key template fills.  The client is told `internal error`, and the
  log gets the whole error with its stack, under the command's id.  A
  dev bundle answers the client with the whole error too.  Stacks are
  mapped through the bundle's source map when it carries one.
- precommit returns either a rejection reason or a list of
  `{stream, event}` pairs, any number per stream.  The C core stamps
  every emitted event with the command's id; precommit never sees or
  copies ids.  `{stream, death: true}` in the list ends a stream, and
  `{stream, death: true, erase: true}` ends it and erases its history.
- Envelope: `[position, stream, seq, commandid, servertime]`, least
  important last.  Readers must ignore elements appended later.
  `commandid` is the command's 16-byte label, as it arrived.
- `seq` is dense per stream name across the whole log: 1 on the first
  birth, and every later event on that name, including deaths and
  rebirths, takes the next number.  A client keeps one integer per
  known stream; an event whose seq is not last + 1 means it missed
  events (a deletion, or a death and rebirth).  A birth or a death is
  a reset: the stream's state is empty after it whatever came before,
  so the client accepts one at any seq above the last, wipes the
  stream, and chains from it.  Any other event after a gap drops the
  stream and re-backfills it.  Densely numbered survivors are what
  make gap detection complete under deletion: a deletion always
  leaves later events behind, and they arrive in the client's own
  history replay.
- Births are implicit: the first event to an unknown stream is
  preceded, in the same atom, by a system event with data
  `{"$sys": "birth"}`.  A death is `{"$sys": "death"}` followed by
  deletion of the stream's keys.  An erasure is a death that also
  deletes every earlier event of the stream, in the death's own atom;
  the death itself stays, as the stream's last event, and on the wire
  it is a death like any other.  Dead streams stay in the
  known-streams table as tombstones (name, birth, death); a new event
  to a dead name is a rebirth with a new birth position.  A client
  needs nothing of the erased events: the death is a reset, and a
  rebirth starts from empty.
- Store keys are plain strings: `<stream>!<local key>`, as in
  `chat:acme,general!reply:t1,m5`; a key's stream is everything
  before its first `!`.  A template is a name, then, if it has
  parameters, `:{param}` and `,{param}` for each further one.  A
  stream name fills its slice's family template
  (`chat:{org},{channel}` names `chat:acme,general`; `login` names
  itself), and a local key one of the slice's key templates
  (`note:{id}` names `note:n1`).  The family or key name is the part
  before the first `:`.  A parameter a template ends with is terminal
  and holds the rest of the string; every other parameter is a
  non-empty run of `A-Z a-z 0-9 _ -`.  A stream name's terminal
  parameter is non-empty and may also hold `.` and `~`; a key's may
  hold anything, the empty string included.  Each separator after a
  parameter (`,` and `!`) sorts below every character the parameter
  may hold, so a scan of a family visits its streams, and a scan of a
  key template its keys, in the order of their parameters: `gen`
  before `gen-2`.  The core rejects a precommit or bootstrap output
  whose stream does not fill its family's template, and a reducer
  write whose key fills none of its slice's key templates.
- A ref names a set of streams: a stream name, a wildcard for every
  stream whose name begins with its text before the `*`, or `*` for
  every stream.  A wildcard covers the family alone or the family and
  whole parameters other than the terminal one: `chat:*` and
  `chat:acme,*`, never `chat:ac*` or `chat:acme,gen,*`.  That is the
  wire form, used in URLs and `want`.  In the bundle, maySee returns
  refs with a terminator on every entry: `chat:*`, `chat:acme,*`,
  `*`, and `name!` for an exact stream, so a bare name is a malformed
  ref and a bundle bug, never a grant.  The core strips the `!`.

### Command dedup

Series with one mark each, and no frames in the log; a fuller
write-up of the dedup design is coming.

- A command carries a series `S`, an opaque string of at most 64
  bytes, and a number `n`, an integer from 1 to 2^53 - 1 that
  increases within the series.  A command whose `S` and `n` are both
  nil is unnumbered: it runs with no dedup and leaves no series
  state.
- The series table has one row per series: the hex SHA-256 of `S`,
  `hwm`, the highest `n` decided, and `time`, the server time of its
  last decision.  Rows are kept forever: v0 has no horizon.  Cron's
  marks share the table (Cron).
- The dedup check runs on the txn loop, after the command check and
  before `expect` and precommit, against the group's open transaction.
  A command sees every decision ahead of it in its group, so two
  copies of one `(S, n)` in a group run once.

  | Case                     | Answer                               |
  |--------------------------|--------------------------------------|
  | unnumbered               | run; nothing recorded                |
  | `n <= hwm`               | `ok` at the head                     |
  | otherwise                | run; `hwm = n`; the decision's reply |

  An unknown series runs from whatever number it arrives with: rows
  are never pruned, so a series the table does not hold has decided
  nothing.

- Every decision moves the mark: an accept, a precommit's `Reject`, a
  bug's rejection, a conflict.  A command its savepoint rolled back
  has its mark written after the rollback, in the group's transaction.
- Every reply is sent after its group commits, rejects included.
  `ok` carries a position at or after the decision, the log's head
  when it was decided or answered: a client that has read that far
  has its answer.  A reject's reason and a conflict's seqs reach only
  the first reply; a resend of a rejected command gets `ok`.
- The id is a label: the core checks its length, stamps it on the
  atom's envelopes, and keys nothing on it.
- The log carries no frames.  A series row commits in the
  transaction of the group that decided it, so it is as durable as
  the log, and v0 has no retention that would need them; the final DB
  will record each decision as a frame.

### Wire protocol

Streaming fetch, body is a sequence of msgpack values with no framing.
Every frame is an array whose first element is a tag.

    GET /stream?since=N&view=T&want=P&want=Q   Authorization: Bearer <jwt>
      → 200, headers PhaseLock-Protocol: 1, PhaseLock-Epoch (the id
        of this log instance, minted per data directory; positions
        mean nothing across epochs, and a copy of a data directory
        that is to diverge must get a fresh one),
        PhaseLock-Time (unix ms), PhaseLock-View (token),
        PhaseLock-Position (the position the token is the view at)
      → 400 on malformed wants

    ["view", token, position, refs]    the whole view: first, when the
                                       presented token is not current,
                                       and on every change
    ["events", [[env, data], ...]]     one atom, filtered to the view
    ["live", position]                 history done; live from here
    ["vouch", position]                heartbeat; converges the cursor
    ["end", code, reason]

- `since=N` replays history from N+1, then sends `live` with the last
  position the replay reached; nothing after `live` repeats a position
  at or below it.  `since=-1` means bootstrap: history from the view's
  position, so everything above the position the view frame carries
  arrives on the stream.  `live` is sent exactly once per connection and
  carries the same convergence meaning as a vouch at that position.
  A view frame may arrive during history when maySee changes; it
  applies from that point on.  History is read in windows of the log,
  each ending on an atom's end, and a window that ends past the last
  events frame is followed by a vouch at its end, so a client whose
  view matches little of the log still sees the replay advance.
- Server side, a replay of any length buffers nothing: the connection
  registers its maySee up front, replays from the log unbuffered, then
  starts receiving live commits and replays the small gap up to the
  first one, deduplicating by position.
- Every deletion keeps at least the last event of every stream, even
  deleted streams, whose last event is a deletion event.  With that floor
  a replay from any checkpoint introduces every stream born since (its
  surviving event hits the unknown-stream rule) and delivers every death,
  so replay on a matching token is complete under any policy, and a
  client that receives a gapped stream's survivors sees the gap through
  seq.  A gap observed before a birth or death is tolerated by the
  client, since the client would ignore earlier events anyway.  A gap on
  a live stream, as may occur under retention policies, is repaired by an
  exact-ref backfill, which implies a requirement that retention must not
  delete an event of a live stream that is newer than its stream's latest
  cut snapshot, and the latest available snapshot is always served to
  backfill requests.  The exception to that rule is gaps that occur prior
  to birth or death events, since the client would ignore those earlier
  events anyway.  A server that would rather not replay a stream, because
  retention gapped it for this client or because its byte counters say a
  cut is cheaper, sends only the stream's last event: the seq jump is the
  notice, and the client parks it, cuts, and drops it below the position,
  the same path as any other gap.
- `want` is a list of refs: what the client can fold.  No `want`
  means `*`, everything maySee allows.
- maySee that throws, or returns a ref that is malformed or does not
  fill its family's template, fails closed: it grants nothing.  A
  connection registering under it is refused with a 500, and a
  connection it fails under when a commit re-runs it gets
  `["end", "error", reason]` and is closed.  The reason is as for a
  command's bug: `internal error`, or the whole error from a dev
  bundle.
- maySee returns refs (bundle form); the view is that set cut down to
  the wants, the narrower of each pair that covers the other, and the
  token is a hash of the view.  So the token names a principal and a
  set of wants together, and a client whose wants changed presents a
  token that is no longer current.  A view frame carries the whole
  view, at the commit position it names, and is sent on every change
  to it, even one that leaves coverage as it was (a ref inside a held
  family), because the client can only keep its token current by
  taking the set.  A maySee change outside the wants changes nothing
  and sends nothing.  The client diffs the set against what it holds:
  what is gone is cut by prefix, what is new is backfilled, and
  whether anything changed is its computation.  Refs are never
  expanded to streams: the client learns a family's members from its
  blob and from births.
- View changes are synchronous with the events they apply to.  `view`
  is the client's stored token; the response headers carry the current
  token and the position it is the view at, and when the presented
  token is not current the first frame of the body is the view frame,
  ahead of any history.  Every later change is a view frame in stream
  order, ahead of the events of the commit that caused it.  History
  from `since` is replayed under the current view, so a client's held
  set at its checkpoint plus the replay is complete whatever happened
  in between: a family revoked and regranted while the client was
  away is still held under a matching token, and the replay brings its
  members up to date and introduces the ones born meanwhile.  This is
  what makes the content-hashed token sufficient and the in-band view
  correct, and it is why there is no separate list endpoint: an
  out-of-band answer could cross a view frame, and a client applying
  it could cut a stream a later frame regranted or backfill a ref an
  earlier frame revoked.  The client persists its view (token and
  position) only when a reconciliation commits, so a crash
  mid-reconciliation presents the old token again and gets the view
  again.
- A commit produces frames only for the atoms a connection can see;
  invisible commits produce nothing.  The heartbeat vouch, sent on a
  fixed interval, is the only other cursor signal: it carries the
  current position so a reconnect skips history the client could not
  see, and a submitter whose command's events all landed in streams it
  cannot see passes its ack position on the next heartbeat.

    POST /commands                     body: [S, n, id, data, expect?]*
      → msgpack array of outcomes, one per command, in order:
        ["ok", position] | ["reject", reason]
        | ["conflict", { stream: actualSeq }]
      → 400 when the body is not a sequence of [S, n, id, data,
        expect?] values with S a string and n an integer, or both nil,
        and id 16 bytes of bin; nothing can be answered for such a
        body, command by command
      → 413 when the body carries more commands than the request's
        limit, refused before any is checked, with the limit in a
        PhaseLock-Max-Commands header

- Series, numbers, and the outcomes are under Command dedup.
- A request carries at most 128 commands, and one without a session
  at most 8 (`--max-commands`, `--max-anonymous-commands`).  A client
  sends more as several requests, one after another, splitting again
  under the limit a 413 names.
- A command whose data fails the check gets `["reject", reason]`, the
  reason naming the path (`$.title: missing required field`).  It
  never reached dedup, so it is not a decision and its series' mark
  does not move.
- `expect` is optional concurrency control: a map from exact stream
  name to the seq of the stream's last event as the client knows it
  (0 for a stream it believes was never born).  The client always has
  that value: it tracks seq per stream for gap detection, reads it
  from every envelope, and gets it from a blob's streams map.  The
  core compares each entry to the stream's actual seq
  after the dedup check and before precommit; any
  mismatch answers `conflict` listing the actual seq of every
  mismatched stream, and the command never reaches user code or the
  log.  A conflict is a decision, and moves its series' mark like
  any other.  seq is the stream's clock, position the log's.  A conflict
  means refresh and re-decide, where a reject is final.  It is opt-in
  per command; offline-queued work should not carry expectations.
- `expect` names at most 1024 streams, each once, with seqs from 0 to
  2^53 - 1.  One that breaks this is checked with the data: the
  command gets `["reject", reason]` and is not a decision.
- An expectation answers a stream's seq, so it may name only streams
  the sender's maySee covers when the command's turn comes.  Naming
  any other rejects the command, alike whether or not the stream
  exists; the reject is a decision.

    GET /snapshot/<ref>          ref = stream, wildcard, or *
      → application/octet-stream: the blob (below), inline, with its
        Content-Length, not resumable; or
      → text/plain: one URL to fetch the blob from with Range; a 404
        or 410 there means re-request here
      The origin's response carries PhaseLock-Position, the log
      position the blob describes; the blob store owes only the bytes.
      A resuming client checks the position against the
      one it is mid-download of; the tail read can be issued from the
      header alone.  maySee must cover the whole ref.  v0 always
      answers inline.

    GET /events/<ref>[?after=W][&before=X][&reverse=true][&max=N]
      → events frames for the ref with W < position < X, ascending by
        default, at most N (default and cap 1000); header
        PhaseLock-Scanned.  No after is the start of the log, no
        before is the head.  maySee must cover the whole ref, as for a
        snapshot.

- `/events` is the tail read behind a snapshot: load the blob, then
  read the ref forward from the blob's position up to the first
  position the client parked, or to the head if nothing is parked,
  apply, and unpark.  Both bounds are exclusive.  `PhaseLock-Scanned`
  is the client's next bound, used as-is with no arithmetic: forward
  it becomes the next `after`, reverse the next `before`.  On a full
  page it is the last position delivered; on a short one it is the
  far bound itself, which lets a resume skip log the server already
  looked at for a quiet stream, except at the head, where it is the
  last position delivered (or `after`, when nothing was) so that
  clients at the head converge on one URL.
- Gap detection is lazy and per stream.  The blob's streams map gives
  the seq of every member at the cut, and every event carries its
  seq, so a stream whose chain breaks, in the tail or later on the
  live stream, is re-backfilled by itself with an exact-ref snapshot
  and tail.  A family blob is therefore never invalidated as a whole;
  it degrades one member at a time.  A chain is checked from its last
  reset: of a stream's parked events, those before its last birth or
  death are never reduced, the run from that reset is applied, and a
  run with no reset must chain from the seq the blob or the held
  state gives, or the stream is broken.  A stream the map does not
  name was dead or unborn at the cut, so its parked events at or below
  the blob's position are covered and never reduced, and its run above
  the cut must start at a reset.
- `reverse` is a general read option, not part of the backfill: it is
  how a person reads the log starting at the tail.  The backfill's
  tail reads forward from the cut.  Gaplessness could be proven by
  reading backwards from the live cursor to the seq of the event
  from which the snapshot was cut; since the earliest seq in the tail
  was read last, and deletions happen forwards, there must not be any
  gaps.  What breaks that is the family backfill.  An overlapping
  strategy for a family of streams would be difficult or impossible
  to express to the /events endpoint, except by accepting substantial
  overread.  The forward read from the snapshots position, however,
  has no such overread properties, but does have its own downside.
  When reading forwards, gaps may appear at any position and the lack
  of any events may be because no events have arrived or because the
  entire tail was pruned.  That can only be distinguished by the
  eventual arrival of a later event, which should be very quick in
  the deleted tail case.

Msgpack values are the JSON projection, with one extension: a date,
the envelope's server time included, is the msgpack timestamp
extension, at millisecond precision.  Uuids are strings; there is no
other ext, and the only bin is a command's id, in the command and in
its envelopes.  Command data and event data are the same values the
browser engine produces and consumes.

### Snapshot blob

All integers big-endian.  Records sorted by key bytes.

    magic     "PLSN"
    u8        version = 1
    u32 hlen  + msgpack map { ref, position, fold,
                              streams: { name: seq, ... },
                              event_bytes?, state_bytes? }
    u32       crc32c of the header bytes
    record*   u32 klen, key, u32 vlen, value, u32 crc32c(key ‖ value)
    u32       0xFFFFFFFF  (end marker in the klen slot)
    u32       record count
    u64       FNV-1a 64 over all record bytes
    u32       crc32c of the footer's preceding 12 bytes

Max record size 16 MiB; a larger klen or vlen is corruption.  Keys are
the store keys with the ref's scope intact (`patron:X!patron`).
`streams` maps every live stream the ref covers to its seq at the cut,
and is the authoritative list of what the blob holds; a live stream
with no keys appears in the map and nowhere else, and a stream the
map does not name was dead or unborn at the cut.  The optional header
fields are the stream row's counters and appear only for an exact ref.
A blob is cut in one read transaction, so every stream in it is at
`position`.  That is a practical requirement, not a logical one: the
client chains each stream by the seq the header gives it, so a blob
assembled from parts cut at different positions would technicall work,
but the client would have to tail from its lowest position, causing an
unbounded waste of event downloads.

### Auth

- `POST /auth/token`, msgpack body, msgpack reply `{token, user,
  exp}`.  Kinds: `{kind: "password", identity, password}`;
  `{kind: "refresh"}` with a bearer token; `{kind: "dev", identity}`
  accepted only when the server runs with `--dev-auth`, signing in as
  an existing account with no credential.  No Authorization header is
  the anonymous principal.
- Tokens are EdDSA JWTs over Ed25519 keys, claims `sub`, `gen`,
  `iat`, `exp`, `jti`, with the signing key's id as the header's
  `kid`; a token naming any other algorithm is refused.  Refresh is
  re-issue.  The token's `gen` is compared to the account's generation
  on stream open and on every command; a mismatch is rejected, so a
  generation bump logs out everywhere.
- A private key lives only in the memory of the process that signs
  with it.  The first signature after startup mints one, and so does
  the first signature once the current key has signed for a day, so
  every restart is a rotation and an idle server mints nothing.  A
  key's public half is committed to the store's token key table, in a
  writer batch, before anything it signed leaves the process; Go
  reads the table once, at startup, and verifies a token by the
  stored key its `kid` names, so tokens outlive their process.
- A key stops signing when its successor is minted, or, for the
  newest key of a past process, by this process's start.  Minting a
  key sweeps, in the same commit, every key retired for longer than
  the token lifetime plus a day of grace, after which every token it
  signed has expired.  The grace covers a clock stepped back between a
  key's last signature and its successor's minting, as restoring a VM
  snapshot can.
- Login and refresh call the bundle's `lookup` on the txn thread; Go
  verifies the password against its `passwordHash` (argon2id, in a
  PHC string) and mints the token.  A login naming no account runs a
  dummy verification, one argon2id hash at the current parameters, so
  it answers no faster than a wrong password.  Go never reads the
  store.  After the check Go calls `lookup` again, and when the
  account's user or `passwordHash` changed meanwhile, checks the
  password again against the new answer, outside the client's budget,
  so a login is decided against the credentials it ends with.
  Credentials still changing after a third re-check are `lookup`
  answering differently for the same state, a bug, which fails the
  login with 500.  The generation check calls `lookup` with
  `{kind: "token", user}`; refresh calls it with `{kind: "refresh",
  user}`; a null result means no account and fails like a moved
  generation, since a token speaks only for an existing account, dev
  tokens included.
- A command's `NewPassword` fields, which the registry marks, are
  hashed in the handler's cgo call, before precommit.  Precommit and
  the log see only the hash.  Password-bearing commands are `@online`
  in the model, so the generated client API never puts them in the
  outbox.  The other prepared kinds (CaptchaToken, IdentityProof), and
  `CommandAuth` proofs of any kind but `password`, are recognized, and
  a command carrying one is rejected until their verification is
  built.  A registry naming a kind the database does not know stops
  it at startup: the bundle needs a newer database.
- A `CommandAuth` proof of kind `password` proves the sender's own
  password.  Intake writes `{kind: "password"}` in its place and sets
  the password aside; Go asks `lookup` with `{kind: "token", user}`
  for the sender and checks the request's proofs against its
  `passwordHash` on the pool, within the client's budget, as a login
  does.  The anonymous principal and an account without a hash fail.
  Each command's verdict, with the hash it was checked against,
  travels to the writer beside the command and never reaches the log.
- The writer checks a proven command after the dedup check and before
  `expect` and precommit, so a failed proof never learns a stream's
  seq, and a resend of a command that landed is answered by dedup
  however its proof checks now.  It calls `lookup` again in the
  command's turn: when the hash is unchanged the verdict stands, and a
  failed one is rejected as "invalid credentials", a decision like any
  other.  When the hash changed, the writer bounces the call: it stops
  at the command and answers the outcomes before it, and Go checks
  every remaining proof against the new hash, outside the budget and
  waiting for room on the pool, then submits the rest of the call
  again.  The call's commands are still decided once each and in
  order, and a call may prove a password its earlier command set.  A
  fourth change in a row is `lookup`'s bug, and rejects the command as
  one.  Every submit runs the generation check, so a token revoked
  partway through a call is refused with 401, as a lost reply is, and
  a resend dedups the commands already decided.
- Every argon2id hash, at login and at intake, runs on a fixed pool of
  workers (`HashWorkers`, default `GOMAXPROCS`) behind a queue of twice
  that, so hashing's memory stays at the pool's size times one hash's.
  A full queue answers 503 at once, and a queued hash whose client has
  left is skipped.  Each client, by the address it connects from, has a
  budget of hashes, a token bucket (`AuthBurst` 10, refilled at
  `AuthRate` 1 per second); past it, a login answers 429.  A command
  request whose hash is refused, by a full pool or a spent budget, is
  refused whole with the same status, so its ids are still free to
  retry; refusing one command would be a final rejection.
- An IPv6 client is budgeted by its /64, since a single host is
  commonly given a whole /64.  Behind a proxy, `--client-ip-header
  <name>` takes each client's address from a header the proxy sets to
  one address, such as Cloudflare's `CF-Connecting-IP`; a request
  without a valid one falls back to the address it connects from.  The
  header is trusted from every request, so the flag is for a server
  only the proxy can reach.  `X-Forwarded-For` and `Forwarded`, which
  hold lists, are refused at startup.

### Bootstrap

- A fresh data directory starts from the bundle's optional
  `bootstrap(ctx)`.  On startup with an empty log, the core runs it
  once, and everything it emits lands as one atom through the
  ordinary append-and-fold path: implicit births, dense seqs, a
  command id the core mints, the server time, and the bundle's own
  reducers folding it.  The atom may be large; a seed of demo data is
  one commit.
- `ctx` has three calls.  `emit(stream, event)` takes the same
  stream-labelled event precommit returns.  `hashPassword(plain)`
  returns the same salted argon2id hash intake produces, made at once,
  since bootstrap runs before anything is served; it is the only
  producer of a password hash besides intake.  `env(name)` reads only
  the environment variables the operator names with `--bootstrap-env
  NAME` (repeatable), and any other reads as the empty string, so a
  production seed carries no secret in its source.
- On a non-empty log `bootstrap` is skipped.  A throw, such as for a
  variable the operator did not provide, or an emit to a malformed
  stream, stops startup with the error; a half-initialized database
  would be worse.
- The slot matters only to an empty log, so after the initial
  deployment it is optional: the seeded state lives in the log, and
  nothing reads `bootstrap` again.  A mature database with no need to
  rebootstrap can delete it from its bundle, and its variables from
  the command line, with no effect.  An app that still stands up fresh
  environments from scratch, such as staging or tests, keeps it.
- Bootstrap is how a database gets its first admin.  It is not a
  principal: it runs once, before any request, with the operator's
  trust, and it emits events rather than commands, so precommit never
  sees a request it would have to fake.  Demos seed their accounts
  this way, since dev sign-in requires a real account.  The test
  bundle seeds an admin only when a test names `BOOTSTRAP_ADMIN` and
  `BOOTSTRAP_PASSWORD`; its `lookup` answers for the tests' standing
  users, `root` (an admin) and `p1`, with no account in the log, so
  the log of every other test starts empty.

### Cron

- Cron is the built-in plugin of `@phaselock/plugins` (`plugins/`).
  When the core opens, it finds every install of kind `cron` in the
  bundle's `plugins` and reads each entry's name and spec from its
  config; an entry's name is 1 to 64 bytes of `[A-Za-z0-9_-]`.  Go
  parses every spec with robfig/cron's `ParseStandard`, in UTC unless
  it starts with `CRON_TZ=` or `TZ=`, and rounds an `@every` up to a
  whole minute, with a notice in the log.  A name or spec that fails
  stops startup.
- An entry's mark, the last of its slots decided, is its row in the
  series table, under the key `$cron:<install>,<entry>` as it is,
  with `hwm` the slot in Unix seconds.  A client's key is hex, so the
  two never meet.
- At startup, once the specs parse, one request on the txn loop gives
  every entry without a row the current minute as its mark, so a new
  or renamed entry first fires at its first slot after that, and
  answers every entry's mark.
- The scheduler (`server/cron.go`) wakes at the earliest next slot, or
  after a minute at most, and fires each entry's latest slot at or
  before the wall clock's now, and only that one, so downtime fires
  each entry once.  The mark becomes the slot, never the time it
  fired, so `@every d` keeps its slots at `mark + k·d`; a clock
  stepped backwards fires nothing until it passes the marks.
- A tick runs on the txn loop, past intake.  A slot at or below the
  entry's mark was decided already.  Any other calls the host's
  `tick`, which hands the install's `run` the command `{entry, slot,
  now}`, with `now` the group's server time, and what the hook's
  requests emitted and what it returned land as one atom under a label
  the core mints.  The decision moves the mark, whatever the hook did:
  a hook that throws is a bug, logged, and its atom is dropped.
- Restoring a backup rewinds the marks with the log, and each entry's
  latest slot past its mark fires again.

### Bundle contract

The bundle installs the skeleton's `Bundle` (typespec/ts/assets/
skeleton.ts), which the generated `define{Database}` builds from the
app's slots:

    globalThis.__bundle = {
      schema,                   // the database's registry data
      precommit(txn, data, principal) → reason | [{stream, event} |
                                                 {stream, death: true}],
      reducers: { family: { reducer(txn, events, stream, pending),
                            template, keys } },
      maySee(txn, principal) → [ref...],
      lookup(txn, ident) → null | { user, generation, passwordHash },
      bootstrap(ctx),           // optional; see Bootstrap
      plugins: { name: { kind, config, run(txn, cmd) → [output...] } },
      dev,                      // the skeleton's DEV
      mapStack(stack, file, map) → stack,
    }

- `data` is the command's data; `principal` is `{user}` with `user` null
  for anonymous; `ident` is `{kind: "password", identity}` at
  login and the `token`/`refresh` shapes above otherwise.  The `token`
  shape also answers for a `CommandAuth` proof, and the writer reads
  its `passwordHash` again in the command's turn, so its answer should
  change only when the account's credentials do.
- The `txn` of precommit, maySee, lookup, and a plugin's `run` also
  has `emit(outputs)`, which plugin code calls to add outputs to the
  command running.  A command's atom is what was emitted while
  precommit or `run` ran, in call order, then what it returned; a
  rejection or a throw drops both.  maySee or lookup emitting is a
  bug, which fails the slot.
- `plugins` are the installed plugins by name.  `run`, present for a
  plugin with commands of its own (a cron tick, a worker's result),
  hands the plugin one command with the database's contexts bound to
  `txn`, as precommit's are; the plugin calls the app's hooks from it.
  A built-in is recognized by its `kind` and carries a `config` the
  core reads; cron is the one the core knows (Cron).
- The host installs `crypto.getRandomValues` and `crypto.randomUUID`
  over `getrandom(2)`, as browsers and Node have them.
- The core defines `process.env.NODE_ENV` as `production` before
  evaluating the bundle, for a bundle built without a define; a build
  that defines it, as the test bundle does with `development`, wins.
  `dev` is the bundle's resulting mode, which decides whether clients
  see the whole error of a bug.
- A bundle may carry its source map inline, as a final
  `//# sourceMappingURL=data:application/json;base64,` comment (esbuild
  `--sourcemap=inline`).  The core passes the stack of every error
  through the bundle's own `mapStack`, so the mapping is the
  skeleton's and every host shares it.
- Every slot is a plain synchronous function over rich JS values.
  `txn` reads the store: `get(key, type)` answers the value or
  undefined, and `scan(req)` answers one batch of a walk of the keys a
  pattern picks out, `{entries, next}`, as the skeleton's `ReadTxn`
  does.  A reducer's `txn` also has `set(key, type, value)` and
  `del(key)`.  The core converts each value under the type the call
  names, a registry identity, so a value that does not fit its type
  fails the call.  A scan names one type too, or `false` for keys
  only, so a scan with values picks out one key template's keys.
- A scan walks the kv table in C (`core/scan.c`) the way the
  skeleton's `walkPattern` does: a skip scan that places each key
  against the pattern's fields and seeks past the keys that cannot
  match, after stepping up to 16 keys toward the target, since a
  SQLite seek costs about as much as 16 steps.  It reads one key past
  the batch to tell whether more follow, and decodes only the batch's
  values.  The skeleton's conformance fixture
  (`typespec/tests/fixtures/scan-conformance.json`) runs against it in
  `server/scan_test.go`.
- A reducer's keys are local: the core prefixes `<stream>!`.  Its
  `template` is the family template and `keys` the key templates, as
  declared in the model.  Its scan is the skeleton's `LocalScan`: the
  pattern's stream is its own, and `after` and the keys it answers are
  local.  It reads the command's own transaction, so it sees the
  reducer's writes.
  precommit, maySee, and lookup see global keys.
- maySee is registered per distinct `principal` and re-run when a
  commit touches what it read: the keys it got, and for each scan
  batch, the stretch of keys the walk covered, the skeleton's
  `ScanSpan` (its pattern, its direction, from just past the batch's
  `after` to its `next` or the walk's end).  A written key touches a
  key it got or one a span covers, as `spanCovers` decides.  A
  deleted prefix, a dead stream's `<stream>!`, touches a key it got
  under the prefix, or a span whenever the prefix could hold a key the
  span covers: the prefix and the pattern's head agree, one starting
  with the other, and the prefix's keys overlap the span's stretch.
  A spurious re-run costs only time, so that test errs toward
  re-running.

### Layout and build

The database is one Go module, `phaselock.io/phaselockdb`, rooted at
`db/`, and one package: cgo compiles a package's C only from its own
directory, and calls C only in its own package, so the C core and the
Go layer sit side by side.

    db/*.c, *.h   the C core: pldb.c txn loop, queues, and the
                  command check, store.c SQLite, scan.c key patterns
                  and their walk, walk.c the conversion kernel,
                  names.c stream names and keys against their
                  templates, mpjs.c untyped msgpack<->JS, js.c QuickJS
                  host, host.js the JS glue (embedded by Go), os.c the
                  calls that differ by platform, scantest.c the scan
                  conformance test's hold on the walk
    db/*.go       the Go layer: core.go cgo binding and build flags,
                  server.go HTTP, auth.go tokens and passwords, keys.go
                  token keys, cron.go the cron scheduler, mp.go
                  msgpack codec, server_test.go feature tests,
                  plugins_test.go plugins and cron ticks, cron_test.go
                  the scheduler, scan_test.go the scans, scantest.go
                  their test-only binding
    db/internal/  one Go package per vendored C library, so the
                  build cache keeps its object code across edits to
                  the core: lib_*.c wraps each vendored C file,
                  setting the defines its own build passes
    db/third_party/
                  QuickJS, SQLite's amalgamation, MPack, and SHA-256,
                  each file headed with its origin and license;
                  update.py vendors a new QuickJS or SQLite and
                  regenerates its wrappers and NOTICE entry
    db/testdata/  the test bundle: model.tsp and db.ts, generated into
                  bundle.js (dev, with an inline source map) and
                  bundle.prod.js by the TypeScript emitter and esbuild,
                  with @phaselock/plugins from plugins/

Building needs only Go 1.25 or newer and a C compiler: GCC or Clang on
Linux and macOS, MinGW-w64 on Windows, which is the only toolchain
cgo supports there.  QuickJS needs `-fwrapv`, which is outside cgo's
default flag allowlist, so a build sets `CGO_CFLAGS_ALLOW=-fwrapv`;
the makefile does.  The Go side depends on `golang.org/x/crypto` for
argon2id and `github.com/robfig/cron/v3` for cron specs.  The tests
need pnpm: `make -C db test` rebuilds the test bundle on every run,
from the emitter's and `plugins/`'s sources.  cgo compiles C without
warnings, so `make -C db check` compiles the core's own C with them,
as errors.

    CGO_CFLAGS_ALLOW=-fwrapv go install phaselock.io/phaselockdb@latest
    make -C db          build db/phaselockdb
    make -C db test     build the test bundle, run the Go tests
    make -C db check    the core's C, warnings as errors
    ./db/phaselockdb --bundle db/testdata/bundle.js --dev-auth

`go install` resolves `phaselock.io/phaselockdb` through a `go-import`
page on phaselock.io naming this repository's `db` directory, so the
module's versions are the repository's `db/v*` tags.

Reader-side calls (history, list, snapshot) share one SQLite reader
connection behind a mutex rather than a dedicated thread; each runs in
its own read transaction so a cut is consistent with its position.
