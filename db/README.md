# DB, version 0

This DB is vibe-coded.  It is meant to meet a subset of the requirements for
the (planned) real DB, to power demos and full-stack development.

## The (planned) real DB:

The real db will have the following shape:

- it will be a CGO project: a Go HTTP wrapper around a C db core.
- the C core will use QuickJS, LDMB, a custom edit log and dedup index
- connections are received in Go, and JWT checked
- mutations are received in Go and passed byte-wise to the C core
- the C core will batch up incoming writes into transaction batches
- for each batch:
  - lmdb write txn is opened
  - for each txn:
    - mutation bytes are extracted to QuickJS, checked for validity and authz
    - duplicate mutations are skipped; reused client-minted IDs are rejected
    - user-provided decider reads lmdb through a write buffer, writing into it
    - the buffer's edits are appended to log file
    - the buffer's edits are applied to lmdb, natively
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
north of 100K edits/second in the non-HA configuration.

This is gonna be _really_ cool.

## Today's (vibe-coded) DB:

But time is short, so we're shipping a vibe-coded version of that just to power
demos:

- it will be a CGO project: a Go HTTP wrapper around a C core.
- the C core will use QuickJS, and SQLite for log, kv store, and dedup index
- connections are received in Go, and JWT checked
- mutations are received in Go and passed byte-wise to the C core
- the C core will batch up incoming writes into transaction batches
- for each batch:
  - sql txn is opened
  - for each txn:
    - mutation bytes are extracted to QuickJS, checked for validity and authz
    - duplicate mutations are skipped; reused client-minted IDs are rejected
    - user-provided decider reads sqlite through a write buffer, writing into it
    - the buffer's edits are appended to sqlite log table
    - the buffer's edits are applied to sqlite kv table, natively
  - sql txn is committed

Features not bothered with:
  - retention policies
  - ha configurations
  - live snapshots
  - memory conservation
  - parallel execution

This isn't the final shape we want,

This will be medium-performance, but it will support the whole pipline of a
PhaseLock app as we envision it, so it is useful to have.

## Decisions for the vibe-coded build

Settled in design discussion before writing code.  Deltas against the
plan above take precedence over it.

### Shape

- Go HTTP layer over a C core, joined by cgo.  Go never decodes
  msgpack on the data path: mutations go to C as the bytes the client
  sent, edits come out of C as their encoded wire arrays, and Go
  writes only container headers around them.  The auth endpoints are
  Go-owned and decode their own small request bodies.
- SQLite for everything in C: the log, the KV store, the series
  table, the slices table.  One write transaction per group commit,
  WAL mode, synchronous=FULL.
- Threads in C: the txn loop (owns QuickJS, SQLite writer connection,
  grant registrations); a results pop thread on the Go side that
  blocks in one cgo call; a reader thread with its own SQLite
  connection for history reads, edit reads, and snapshot cuts.
  Handler goroutines enqueue mutations directly; no dedicated push
  thread.  Mutation outcomes, view changes, and lookup replies all
  come back through the single results queue.
- The bundle is one JS file assigning `globalThis.__bundle` (see Bundle
  contract): the app's `db.ts` calling the generated `define{Database}`,
  bundled with the generated module.
- Every typed value crosses through the conversion kernel (`walk.c`):
  a source, either msgpack parsed by mpack's node API or a
  tokenization of a QuickJS value, a walk over the registry the
  bundle carries, and a sink that builds JS values, writes msgpack
  with mpack, or discards.  C builds rich values straight from
  msgpack and walks the JS heap straight to msgpack, and it checks
  every mutation on the handler's thread before anything else happens
  to it.  The registry is compiled once at open from the bundle's
  schema, `{nodes, ids, mutations}`; every read and write of the
  store names one of its identities, the value's type.  mpack writes
  the output; untyped values, the outcomes and `lookup`'s traffic,
  still go through `mpjs.c`.
- One context for the process, made in `main` from SIGINT and SIGTERM:
  every request runs under it (`http.Server.BaseContext`), so an open
  connection ends the moment it does.  Shutdown then waits for
  handlers to return, a cgo call or a hash in progress finishing
  first, stops the hash workers, and closes the core, which commits
  the batch in hand.  The core outlives every handler, since a
  handler reaching a closed core would be a use-after-free in C.

### Log and edits

- The mutation is the atom.  A POST may carry several mutations; each
  is checked, decided, committed, and acked independently and in
  order.  Group commit batches mutations per fsync.  The check runs in
  the handler's cgo call, against the mutations union of the registry
  and rejecting fields the model does not name, so a malformed
  mutation is answered there and never reaches dedup, `expect`, or
  the writer; the fields the database prepares for the decider (a
  `NewPassword`'s hash) are collected by the check and replaced when
  the checked mutation is written out for the writer thread.
- The decider runs over a read-write transaction whose writes go to a
  write buffer (`buffer.c`), never to the store.  The buffer holds
  each key written once, with its last value's msgpack bytes in store
  format, or a deletion, and each slice deleted, with whether its
  history goes too; deleting a slice drops the buffer's keys under
  it.  Reads see the buffer over the store: a point read checks the
  buffer first, and a scan walks the store as the pattern walk does,
  merging the buffer's keys in at their place in key order, so a
  decider reads its own writes.  A buffered key wins over the store's,
  and a store key under a slice the buffer deleted reads as absent.
  When the decider carries the mutation out, the buffer is the
  mutation's edits; when it rejects the mutation or throws, the buffer
  is discarded, and nothing reached the store.
- An edit is one mutation's writes to one slice.  The core commits a
  mutation's buffer as one edit per slice it touched, in slice name
  order, all at the mutation's position: each edit is appended to the
  log and applied to the store natively.  A mutation that edits
  nothing takes no position.  The log keeps one row per edit: its
  position, slice, seq, lifecycle, and wire encoding, keyed by
  position and slice.
- A rejection's reason, a decider's `Reject`, reaches the client as
  it is.  Any other failure is a bug: a throw from a decider or
  lookup, which includes a write the write gate refuses.  The client
  is told `internal error`, and the log gets the whole error with its
  stack, under the mutation's id.  A dev bundle answers the client
  with the whole error too.  Stacks are mapped through the bundle's
  source map when it carries one.
- The write gate: a key written holds no control character or lone
  surrogate, and its slice, the text before its first `!`, is a slice
  name (Store keys), so a key with no `!`, or an engine-reserved key
  beginning with `!`, is refused.  A slice deleted is a slice name.
  The gate checks syntax alone, so a well-formed name in a family no
  slice type declares, or with the wrong number of parameters, lands.
  The local key is the app's: one that no key template names lands as
  bytes that no typed accessor reads.
- Envelope: `[position, slice, seq, id, servertime, lifecycle]`,
  least important last.  Readers must ignore elements appended later.
  `id` is the mutation's 16-byte label, as it arrived, as bin;
  `servertime` is the msgpack timestamp; `lifecycle` is 0 for a
  normal edit, 1 for a birth, and 2 for a death.
- An edit on the wire is one msgpack array, its envelope, then its
  payload's items flat:

      [[position, slice, seq, id, servertime, lifecycle],
       0, key, value, 1, key, ...]

  The payload is a stream of operations, each a one-byte opcode and
  the items it fixes: `0, key, value` sets a key, a nil value setting
  null, and `1, key` deletes one.  Keys are whole store keys.  A
  value is inline msgpack in store format, the bytes the decider's
  write produced, which a host slices out as a byte span without
  decoding it.  A key written twice in one mutation appears once,
  with its last write.  An opcode a client does not know is an error.
- The lifecycle comes from the buffer and the slice's row:

  | The mutation                       | Live slice | Unborn or deleted |
  |------------------------------------|------------|-------------------|
  | sets keys of the slice             | normal     | birth             |
  | only deletes keys of the slice     | normal     | no edit           |
  | deletes the slice, then sets keys  | birth      | birth             |
  | deletes the slice, sets none after | death      | no edit           |

  A normal edit carries every write.  A birth clears the slice, then
  sets keys, and carries the sets alone.  A death clears the slice
  and carries no operations.
- `seq` is dense per slice name across the whole log: 1 on the first
  birth, and every later edit to that name, deaths and rebirths
  included, takes the next number.  A client keeps one integer per
  known slice; an edit whose seq is not last + 1 means it missed
  edits (a deletion, or a death and rebirth).  A birth or a death is
  a reset: the slice's state after it is the edit's sets alone,
  whatever came before, so the client accepts one at any seq above
  the last, wipes the slice, and chains from it.  Any other edit after
  a gap drops the slice and re-backfills it.  Densely numbered
  survivors are what make gap detection complete under deletion: a
  deletion always leaves later edits behind, and they arrive in the
  client's own history replay.
- The slices table has one row per slice ever born: its name, its
  seq, the position of its last birth, the position of its death or
  null while it is live, and its byte counters, its edits' bytes in
  the log and its keys' bytes in the store.  A deleted slice keeps its
  row as a tombstone, and a new birth on its name revives it with a
  new birth position.  An expectation's seq and a snapshot's slices
  come from this table.
- A death is a tombstone that retention never prunes.  An erasure,
  `deleteSlice` with `erase`, deletes every earlier edit of the slice
  from the log in the mutation's own commit; the death stays as the
  slice's last record, or the birth when the mutation writes the
  slice again, and on the wire an erasure is a death like any other.
  A client needs nothing of the erased edits: the death is a reset,
  and a rebirth starts from empty.
- Store keys are plain strings: `<slice>!<local key>`, as in
  `chat:acme,general!reply:t1,m5`; a key's slice is everything before
  its first `!`.  A template is a name, then, if it has parameters,
  `:{param}` and `,{param}` for each further one.  A slice name fills
  its slice type's family template (`chat:{org},{channel}` names
  `chat:acme,general`; `login` names itself), and a local key one of
  the type's key templates (`note:{id}` names `note:n1`), which the
  model declares and its generated accessors fill.  The family or key
  name is the part before the first `:`.  A parameter a
  template ends with is terminal and holds the rest of the string;
  every other parameter is a non-empty run of `A-Z a-z 0-9 _ -`.  A
  slice name's terminal parameter is non-empty and may also hold `.`
  and `~`; a key's may hold anything, the empty string included.  The
  database checks a slice name by this syntax alone: a family, a
  non-empty run of `A-Z a-z 0-9 _ -`, then optionally `:` and values
  separated by `,`, each non-empty, each but the last a run of the
  family's characters, and the last free to hold `.` and `~` too.  The
  family templates stay in the model's generated code.  Each
  separator after a parameter (`,` and `!`) sorts below every
  character the parameter may hold, so a scan of a family visits its
  slices, and a scan of a key template its keys, in the order of their
  parameters: `gen` before `gen-2`.
- A slice selector names a set of slices: an exact selector, a slice
  name, names one slice, and a prefix selector every slice whose name
  begins with its text before the `*`, or every slice for `*`.  A
  prefix selector covers the family alone or the family and whole
  leading parameters, each a segment followed by `,`: `chat:*` and
  `chat:acme,*`, never `chat:ac*` or `chat:acme.x,*`.  That is the
  wire form, used in URLs and `want`.  In the bundle, the grantor
  returns selectors with a terminator on every entry: `chat:*`,
  `chat:acme,*`, `*`, and `name!` for an exact selector, so a bare
  name is a malformed selector and a bundle bug, never a grant.  The
  core strips the `!`.  It checks every selector by syntax alone, so
  one naming a family no slice type declares, or the wrong number of
  parameters, is well-formed and covers no slice.

### Mutation dedup

Series with one mark each, and no frames in the log; a fuller
write-up of the dedup design is coming.

- A mutation carries a series `S`, an opaque string of at most 64
  bytes, and a number `n`, an integer from 1 to 2^53 - 1 that
  increases within the series.  A mutation whose `S` and `n` are both
  nil is unnumbered: it runs with no dedup and leaves no series
  state.
- The series table has one row per series: the hex SHA-256 of `S`,
  `hwm`, the highest `n` decided, and `time`, the server time of its
  last decision.  Rows are kept forever: v0 has no horizon.  Cron's
  marks share the table (Cron).
- The dedup check runs on the txn loop, after the mutation check and
  before `expect` and the decider, against the group's open
  transaction.  A mutation sees every decision ahead of it in its
  group, so two
  copies of one `(S, n)` in a group run once.

  | Case                     | Answer                               |
  |--------------------------|--------------------------------------|
  | unnumbered               | run; nothing recorded                |
  | `n <= hwm`               | `ok` at the head                     |
  | otherwise                | run; `hwm = n`; the decision's reply |

  An unknown series runs from whatever number it arrives with: rows
  are never pruned, so a series the table does not hold has decided
  nothing.

- Every decision moves the mark: an accept, a decider's `Reject`, a
  bug's rejection, a conflict.
- Every reply is sent after its group commits, rejects included.
  `ok` carries a position at or after the decision, the log's head
  when it was decided or answered: a client that has read that far
  has its answer.  A reject's reason and a conflict's seqs reach only
  the first reply; a resend of a rejected mutation gets `ok`.
- The id is a label: the core checks its length, stamps it on the
  envelopes of the mutation's edits, and keys nothing on it.
- The log carries no frames.  A series row commits in the
  transaction of the group that decided it, so it is as durable as
  the log, and v0 has no retention that would need them; the final DB
  will record each decision as a frame.

### Wire protocol

Every route is under the server's path prefix, `/phaselock` unless
`--path-prefix` names another, or `""` for the root, so an origin the
database shares with an app routes one prefix to it; the paths below
are relative to it.

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

    ["view", token, position, selectors]    the whole view: first, when the
                                       presented token is not current,
                                       and on every change
    ["edits", [edit, ...]]             one mutation's edits, filtered
                                       to the view
    ["live", position]                 history done; live from here
    ["vouch", position]                heartbeat; converges the cursor
    ["end", code, reason]

- `since=N` replays history from N+1, then sends `live` with the last
  position the replay reached; nothing after `live` repeats a position
  at or below it.  `since=-1` means bootstrap: history from the view's
  position, so everything above the position the view frame carries
  arrives on the connection.  `live` is sent exactly once per
  connection and carries the same convergence meaning as a vouch at
  that position.  A view frame may arrive during history when the
  grant changes; it applies from that point on.  History is read in
  windows of the log's positions, and a window that ends past the
  last edits frame is followed by a vouch at its end, so a client
  whose view matches little of the log still sees the replay advance.
- A view frame's position is the last position the connection sent
  under the previous view, whatever position the commit that changed
  the view had: everything the connection sends after the frame is
  filtered by the new view, and the new view's edits at or below the
  position are the client's backfills' to deliver, which tail through
  it.  Live, that is the end of the batch before the one that changed
  the view, whose edits the new view filters; in a replay, it is how
  far the replay has read.  The easy mistake is to take the position
  of the last frame the connection was sent: live, that lags every
  commit the old view could not see, and a backfill's tail ending there
  skips the new view's edits in those commits.  A snapshot cut fresh,
  past them, hides the gap, and one cut earlier, from a cache, leaves
  a slice born there missing until its next edit
  (`TestALiveViewFramesPositionPassesCommitsTheOldViewCouldNotSee`).
  A grantor runs once per group commit, after all of it, so a view
  changes only at a batch's end, and every edit in the batch that
  changed it is filtered by the new view: a client may briefly show a
  slice before the data that grants it.
- A bootstrap splits the log at the view's position V.  Once the
  client has processed the bootstrap's view frame at V, its cursor is
  V, so a reconnect presents `since=V`; the backfills cover every
  position at or below V, a backfill the view frame spawns tailing
  through V inclusive; and the connection covers every position above
  V.
- Server side, a replay of any length buffers nothing: the connection
  registers its grant up front, replays from the log unbuffered, then
  starts receiving live commits and replays the small gap up to the
  first one, deduplicating by position.
- Every deletion keeps at least the last edit of every slice, even
  deleted slices, whose last edit is a death.  With that floor a
  replay from any checkpoint introduces every slice born since (its
  surviving edit hits the unknown-slice rule) and delivers every
  death, so replay on a matching token is complete under any policy,
  and a client that receives a gapped slice's survivors sees the gap
  through seq.  A gap observed before a birth or death is tolerated
  by the client, since the client would ignore earlier edits anyway.
  A gap on a live slice, as may occur under retention policies, is
  repaired by an exact-selector backfill.  So the retention floor is
  per slice, set by the slice's own exact-selector snapshot: retention
  must not delete an edit of a live slice newer than that slice's latest
  exact-selector snapshot, and an exact-selector backfill is always
  served that snapshot or a newer one.  A prefix snapshot is held to no
  such floor: a slice in it may be older than retention allows, and the
  client repairs the gap that leaves with the slice's exact-selector
  backfill.  The exception to the floor is gaps that occur prior to
  birth or death edits, since the client would ignore those earlier
  edits anyway.  A server that
  would rather not replay a slice, because retention gapped it for
  this client or because its byte counters say a cut is cheaper,
  sends only the slice's last edit: the seq jump is the notice, and
  the client parks it, cuts, and drops it below the position, the
  same path as any other gap.
- `want` is a list of selectors: what the client can apply, one per slice
  type, `family:*` or the bare family of a type without parameters.
  No `want` means `*`, everything the grantor allows.
- A grantor that throws, writes, or returns a malformed selector fails
  closed: it grants nothing.  A connection registering under it is
  refused with a 500, and a connection it fails under when a commit
  re-runs it gets `["end", "error", reason]` and is closed.  The
  reason is as for a mutation's bug: `internal error`, or the whole
  error from a dev bundle.
- The grantor returns selectors (bundle form); the view is that set cut
  down to the wants, the narrower of each pair that covers the other,
  and the token is a hash of the view.  So the token names a
  principal and a set of wants together, and a client whose wants
  changed presents a token that is no longer current.  A view frame
  carries the whole view, at the commit position it names, and is
  sent on every change to it, even one that leaves coverage as it was
  (a selector inside a held family), because the client can only keep its
  token current by taking the set.  A grant change outside the wants
  changes nothing and sends nothing.  The client diffs the set against
  what it holds: what is gone is cut by prefix, what is new is
  backfilled, and whether anything changed is its computation.  Selectors
  are never expanded to slices: the client learns a family's members
  from its blob and from births.
- View changes are synchronous with the edits they apply to.  `view`
  is the client's stored token; the response headers carry the current
  token and the position it is the view at, and when the presented
  token is not current the first frame of the body is the view frame,
  ahead of any history.  Every later change is a view frame in log
  order, ahead of the edits of the group commit that caused it.  A
  connection that registers in the group commit that changes its grant
  is answered with the view as of the batch's end, in one answer: one
  built at the registration, from before the batch's writes, would race
  the re-run grantor's answer and could leave the connection streaming
  under the old view while the core counts it current
  (`TestARegistrationInTheBatchThatGrantsItASliceGetsTheSlice`,
  `TestARegistrationInTheBatchThatRevokesASliceNeverGetsItsEdits`).
  History
  from `since` is replayed under the current view, so a client's held
  set at its checkpoint plus the replay is complete whatever happened
  in between: a family revoked and regranted while the client was
  away is still held under a matching token, and the replay brings its
  members up to date and introduces the ones born meanwhile.  This is
  what makes the content-hashed token sufficient and the in-band view
  correct, and it is why there is no separate list endpoint: an
  out-of-band answer could cross a view frame, and a client applying
  it could cut a slice a later frame regranted or backfill a selector an
  earlier frame revoked.  The client persists its view (token and
  position) only when a reconciliation commits, so a crash
  mid-reconciliation presents the old token again and gets the view
  again.
- A commit produces frames only for the mutations a connection can
  see, one edits frame per mutation holding every edit of it the
  connection's view covers, so a client holding only some of a
  mutation's slices receives its part at once; invisible commits
  produce nothing.  The heartbeat vouch, sent on a fixed interval, is
  the only other cursor signal.  A vouch at N means the connection has
  sent every edit at or below N the client may see: the heartbeat
  first forwards every commit the server has published, then vouches
  the last position it has sent through.  So a reconnect skips
  history the client could not see, and a submitter whose mutation's
  edits all landed in slices it cannot see passes its ack position on
  the next heartbeat.

    POST /mutations                    body: [S, n, id, data, expect?]*
      → msgpack array of outcomes, one per mutation, in order:
        ["ok", position] | ["reject", reason]
        | ["conflict", { slice: actualSeq }]
        with a Server-Timing header, db;dur=<ms>: the database's own
        time, from the whole request in hand to its answer
      → 400 when the body is not a sequence of [S, n, id, data,
        expect?] values with S a string and n an integer, or both nil,
        and id 16 bytes of bin; nothing can be answered for such a
        body, mutation by mutation
      → 413 when the body carries more mutations than the request's
        limit, refused before any is checked, with the limit in a
        PhaseLock-Max-Mutations header

- Series, numbers, and the outcomes are under Mutation dedup.
- A request carries at most 128 mutations, and one without a session
  at most 8 (`--max-mutations`, `--max-anonymous-mutations`).  A
  client sends more as several requests, one after another, splitting
  again under the limit a 413 names.
- A mutation whose data fails the check gets `["reject", reason]`,
  the reason naming the path (`$.title: missing required field`).  It
  never reached dedup, so it is not a decision and its series' mark
  does not move.
- `expect` is optional concurrency control: a map from exact slice
  name to the seq of the slice's last edit as the client knows it (0
  for a slice it believes was never born).  The client always has
  that value: it tracks seq per slice for gap detection, reads it from
  every envelope, and gets it from a blob's slices map.  The core
  compares each entry to the slice's actual seq after the dedup check
  and before the decider; any mismatch answers `conflict` listing the
  actual seq of every mismatched slice, and the mutation never reaches
  user code or the log.  A conflict is a decision, and moves its
  series' mark like any other.  seq is the slice's clock, position
  the log's.  A conflict means refresh and re-decide, where a reject
  is final.  It is opt-in per mutation; offline-queued work should
  not carry expectations.
- `expect` names at most 1024 slices, each once and each a slice name
  (Store keys), with seqs from 0 to 2^53 - 1.  One that breaks this
  is checked with the data: the mutation gets `["reject", reason]`
  and is not a decision.
- An expectation answers a slice's seq, so it may name only slices
  the sender's grant covers when the mutation's turn comes.  Naming
  any other rejects the mutation, alike whether or not the slice
  exists; the reject is a decision.

    GET /snapshot/<selector>          selector = slice, prefix, or *
      → application/octet-stream: the blob (below), inline, with its
        Content-Length, not resumable; or
      → text/plain: one URL to fetch the blob from with Range; a 404
        or 410 there means re-request here
      The origin's response carries PhaseLock-Position, the log
      position the blob describes, and PhaseLock-Epoch, the log's
      epoch; the blob store owes only the bytes.  A client checks the
      epoch against its connection's, and a resuming client checks the
      position against the one it is mid-download of; the tail read
      can be issued from the header alone.  The grant must cover the
      whole selector.

    GET /edits/<selector>[?after=W][&before=X][&reverse=true][&max=N]
      → edits frames for the selector with W < position < X, one per
        mutation, ascending by default: N edits (default and cap
        1000) and the rest of the last one's mutation, or fewer when
        the range runs out; header PhaseLock-Scanned.  No after is the
        start of the log, no before is the head.  The grant must cover
        the whole selector, as for a snapshot.

- A snapshot response is the blob inline or a pointer to it in a blob
  store: v0 answers inline, and a deployment backed by a blob store
  answers with a pointer.  Either way the origin's response carries
  the position and the epoch.  A resumed download reads the blob with
  a Range from its resume offset, so it never sees the blob's own
  header and learns the cut's position and epoch only from the
  origin's response; and a blob store owes only the bytes, never
  PhaseLock headers.  The pointer is a 200 with a body rather than a
  3xx redirect because many HTTP clients follow redirects themselves
  and expose only the final response's headers, which would lose the
  origin's.
- Cuts never go backwards: for each selector, the database never answers
  `/snapshot` with a cut older than one it has answered before.  The
  origin answers every request itself (`/snapshot` is `no-store`, and
  only the immutable blob behind a pointer is cached), so the rule is
  about which blob the origin chooses: when the newest blob for a
  selector is missing, the answer is `stale` or a fresh cut, never an
  older blob, and the newest is never deleted while older ones remain.
  A deployment with several origin servers must hold the rule across
  all of them, reading the newest blob for a selector consistently
  rather than from whichever replica answers.  Why it matters: a
  backfill that starts its snapshot over, after `stale` or after a
  failure before any page was parked, keeps the tail it already parked
  and resumes its tail from where that tail reached, or from the new
  cut if that is later.  A new cut older than the previous attempt's
  leaves the positions between the two covered by neither the blob nor
  the tail, so a slice that changed only there stays stale on the
  client until its next edit.  Relaxing the rule means resetting the
  tail's floor to the new cut and reading that stretch again, in the
  Engine's `#parkPushIn` and its `stale` handling, and P17 with them.
- `/edits` is the tail read behind a snapshot: load the blob, then
  read the selector forward from the blob's position up to the
  backfill's `until`, apply, and unpark.  Both bounds are exclusive:
  the tail delivers the positions below `until`, and the connection
  those at or above it, which the client parks until the backfill
  lands.  `until` is where the connection's share begins: the
  position of the edit that revealed a gap or an unknown slice, for a
  backfill that edit spawns; the client's cursor plus one, for one a
  landing's repair spawns; and the view's position plus one, for one a
  view frame spawns, so a bootstrap's backfills tail through the view's
  position V as the contract above requires.  A page never splits
  the edits of one mutation, so a page's edit count says nothing about
  whether more follow.  `PhaseLock-Scanned` is the client's next
  bound, used as-is with no arithmetic: forward it becomes the next
  `after`, reverse the next `before`.  On a full page it is the last
  position delivered; on a short one it is the far bound itself,
  which lets a resume skip log the server already looked at for a
  quiet slice, except at the head, where it is the last position
  delivered (or `after`, when nothing was) so that clients at the
  head converge on one URL.
- Gap detection is lazy and per slice.  The blob's slices map gives
  the seq of every member at the cut, and every edit carries its
  seq, so a slice whose chain breaks, in the tail or later on the
  live connection, is re-backfilled by itself with an exact-selector
  snapshot and tail.  A family blob is therefore never invalidated as
  a whole; it degrades one member at a time.  A chain is checked from
  its last reset: of a slice's parked edits, those before its last
  birth or death are never applied, the run from that reset is
  applied, and a run with no reset must chain from the seq the blob
  or the held state gives, or the slice is broken.  A slice the map
  does not name was deleted or unborn at the cut, so its parked edits
  at or below the blob's position are covered and never applied, and
  its run above the cut must start at a reset.
- `reverse` is a general read option, not part of the backfill: it is
  how a person reads the log starting at the tail.  The backfill's
  tail reads forward from the cut.  Gaplessness could be proven by
  reading backwards from the live cursor to the seq of the edit
  from which the snapshot was cut; since the earliest seq in the tail
  was read last, and deletions happen forwards, there must not be any
  gaps.  What breaks that is the family backfill.  An overlapping
  strategy for a family of slices would be difficult or impossible
  to express to the /edits endpoint, except by accepting substantial
  overread.  The forward read from the snapshots position, however,
  has no such overread properties, but does have its own downside.
  When reading forwards, gaps may appear at any position and the lack
  of any edits may be because no edits have arrived or because the
  entire tail was pruned.  That can only be distinguished by the
  eventual arrival of a later edit, which should be very quick in
  the deleted tail case.

Msgpack values are the JSON projection, with one extension: a date,
the envelope's server time included, is the msgpack timestamp
extension, at millisecond precision, and within a JS Date's range,
±8.64e15 ms of the epoch; a value holding a timestamp outside it fails
its check.  Uuids are strings; there is no other ext, and the only
bin is a mutation's id, in the mutation and in its edits' envelopes.
Mutation data and stored values are the same values the browser
engine produces and consumes, and a stored value travels in an edit
or a blob as the bytes the store holds.

### Snapshot blob

All integers big-endian.  Operations sorted by key bytes.

    magic     "PLSN"
    u8        version = 1
    u32 hlen  + msgpack map { selector, position, epoch,
                              slices: { name: seq, ... }, visible,
                              edit_bytes?, state_bytes? }
    u32       crc32c of the header bytes
    op*       0, key, value: a set operation, as in an edit's payload
    u32       0xFFFFFFFF  (end marker, where the next opcode would be)
    u32       operation count
    u64       FNV-1a 64 over every operation's bytes
    u32       crc32c of the footer's preceding 12 bytes

The body is a run of set operations encoded as an edit's payload is:
the opcode 0, the key as a msgpack str, and the value inline as the
store holds it, so a client applies a blob with the same primitive as
an edit.  An opcode is one byte, 0, and the end marker's first byte is
0xFF, so a reader tells them apart at a glance.  A client cuts the body
into pages of whole operations as it reads, and resumes a download
from the offset after its last whole one.  Keys are the store keys
with the selector's scope intact (`patron:X!patron`).  `slices` maps every
live slice the selector covers to its seq at the cut, and is the
authoritative list of what the blob holds; a live slice with no keys
appears in the map and nowhere else, and a slice the map does not
name was deleted or unborn at the cut.  `visible` is the last position
at or below the cut where any slice the selector covers changed, a
deleted one included, read from the same rows as `slices`: a client
whose cursor has reached it holds nothing older than the blob, so it
lands the blob at its cursor, however far past it the cut lies.  Like
the rest of the blob, it depends on the selector and the cut alone, the
same for every reader.  `epoch` is the log's.  The
optional header fields are the slice row's counters and appear only
for an exact selector.  A blob is cut in one read transaction, so every
slice in it is at `position`.  That is a practical requirement, not a
logical one: the client chains each slice by the seq the header gives
it, so a blob assembled from parts cut at different positions would
technicall work, but the client would have to tail from its lowest
position, causing an unbounded waste of edit downloads.

### Protocol rules

The rules a client Engine and the database hold each other to at the
protocol boundary, whatever either's implementation: a client built on the
same `Transport` contract must satisfy every one.  A client *holds* a slice
at a seq when its base has the slice's state through that seq, and *parks*
an edit when it keeps it unapplied for the land.  The base is *frozen*
while any backfill is in flight.  The conformance suite,
`typespec/tests/src/engine/conformance/`, checks each rule in a group named
for it; the database's own halves are checked by `server_test.go`, under
the tests these rules name.

Chaining:

- P1.  A normal edit applies to a held slice only when its seq is one past
  the held seq; an edit at or below the held seq changes nothing.
- P2.  A birth or a death applies at any seq above the held seq, and to a
  slice the client does not hold, since the slice's state after it is its
  own writes alone; of a slice's run of edits, those before its last reset
  never apply.
- P3.  Unfrozen, a frame applies whole or not at all.  A normal edit that
  does not chain, a gap on a held slice or an edit of a slice the client
  does not hold, which is a missed birth, parks its whole frame and
  backfills its slice by its exact selector, with `until` the edit's
  position.  Frozen, every edit parks, and its chain is checked at the
  land.
- P4.  At the land, a slice's parked run applies onto its base, the
  winning blob's seq (P5) or, for a slice no backfill covers, the held
  seq, when it continues the base or starts over at a reset after its last
  gap.  A slice whose run breaks keeps the whole land waiting: it is
  backfilled again by its exact selector, with `until` the cursor plus
  one, or its own exact backfill starts over.
- P5.  Per slice, the in-flight backfill whose selector covers it and
  whose blob has the newest cut wins, and its blob's state replaces the
  slice's, unless the client holds the slice at or past the blob's seq,
  or the blob is cut at or below the base, when the slice keeps its
  state.  A slice the winning blob does not name
  was deleted or unborn at that cut: its parked edits at or below the cut
  never apply, its run above the cut must start at a reset, and when
  nothing above the cut applies, the client neither holds the slice nor
  keeps any state of it.

Lifecycle:

- P6.  A birth clears its slice, then applies its writes.  Unfrozen, a
  birth of a slice the client does not hold holds the slice at the
  birth's seq with no backfill.
- P7.  A death clears its slice, and the client forgets it, holding no
  seq: its next birth starts it from empty, and its next normal edit is a
  missed birth (P3).  A death of a slice the client does not hold costs no
  backfill.  The database makes no edit for a delete of a slice that is
  not live (`TestDeletingANonLiveSliceIsNoEdit`).

View:

- P8.  A view frame is read as it arrives: every in-flight backfill whose
  selector the view does not wholly cover is canceled, its header and
  parked pages gone.  Its effect on the base waits while frozen: at the
  land, and at once when unfrozen, the client keeps nothing of a slice the
  latest view does not cover, no state, held seq, or parked edit.  The
  same holds at boot for whatever the build's wants do not cover.  The
  database sends a view frame ahead of the edits of the group commit that
  caused it (`TestAViewFrameLeadsTheEditsItGrantsIntoStreaming`), and a
  view changes only at a group commit's end, so a frame may briefly show
  a slice before the data that grants it.
- P9.  A view frame backfills exactly the selectors it newly grants: a
  selector that an in-flight backfill covers, or that the previous view
  covered with no backfill in flight over it as the frame arrived, gets
  none; one the previous view did not cover gets one, even when it names a
  slice the frozen base still holds.  Each new backfill tails through the
  frame's position (`until` is the position plus one), the last position
  the connection sent under the previous view
  (`TestAStaleTokensViewFrameIsAtTheSincePresented`).  The view is
  persisted when its frame arrives, and every connect presents the latest
  view's token.

Bootstrap:

- P10.  A client with no cursor connects with `since` -1 and no token.
  Once it has read the bootstrap's view frame at V, its cursor is V, so a
  reconnect presents `since` V; the frame's backfills cover every position
  at or below V and the connection every position above it
  (`TestBootstrapDeliversEverythingAboveTheViewPosition`).  An edit at V
  that both deliver applies once.

Cursor:

- P11.  The cursor is the highest position of the edits, vouch, and live
  frames received, and of a bootstrap's view frame (P10); it never moves
  back, commits with the frame that moved it, and is the `since` of every
  connect.  The database sends a vouch or a live frame at N only after
  every edit at or below N that the connection may see
  (`TestAVouchNeverOvertakesAnEditItCovers`).
- P12.  The cursor never skips an edit: every edit at or below it of a
  slice the view covers is applied, parked, or below the `until` of an
  in-flight backfill covering its slice, across reconnects and restarts,
  so a reconnect from it loses nothing.
- P13.  An outbox mutation the database answers `ok` at P leaves the
  outbox, and its prediction the overlay, only once queries can show its
  outcome: an edit carrying its id has applied, or the base is applied
  through P.  The applied position stays put while frozen and reaches the
  cursor at the land.  A reject or a conflict releases it at once.
- P14.  A cursor belongs to its log's epoch: the client takes no frame
  from a connection whose epoch differs from its cursor's, and its first
  connection's epoch becomes the cursor's.

Freeze:

- P15.  While frozen, every edit delivered parks, a vouch or a live frame
  moves only the cursor, queries answer from the frozen base, and nothing
  of a revoke reaches the base.  The freeze ends with the land (P16), or,
  when view frames cancel every backfill, with a land of what parked.

Backfills:

- P16.  The land waits until every in-flight backfill has finished both
  halves, the cursor has reached every blob's `visible`, and no parked
  edit lies past the cursor; a grant that arrives first joins it.  Then
  one transaction applies every blob (P5), every parked run (P4), and
  the latest view's drops (P8), clears every backfill record, header,
  parked page, and parked edit, and applies the base through the cursor
  (`TestASnapshotsVisibleIsTheLastChangeUnderItsSelector`).
- P17.  A backfill whose snapshot starts over reads its tail again: after
  a `stale` outcome, from the later of the new snapshot's position and
  where its parked tail reached, since what it parked stays; after a
  broken run, from the new snapshot's position.  A retry after any other
  failure resumes from its record, skipping a finished half, and a failure
  after both halves are in leaves it ready to land.  Its `until` never
  changes.

Convergence:

- P18.  Every state queries show of the base is the server's state at one
  position, for the slices the client holds: each held slice's last
  birth's writes and the normal edits after it through that position.
  Erasure is retroactive, and P18 and P22 hold of the log as the client
  reads it, not as it stood before the erasure: a client replaying
  across a slice's erased edits sees frames without them, its other
  slices' edits applying while the erased slice keeps the state it
  held until the slice's surviving death arrives; and a client in the
  middle of a replay when the erasure commits gets no more of that
  slice's edits, so the slice shows stale until the replay reaches the
  death.  Only a replaying client is touched, and the death resets the
  slice when it arrives, so this is accepted rather than guarded
  against.  A replay across a live slice's history that retention
  pruned below its floor behaves the same way, until the slice's next
  surviving edit shows the gap and its repair lands.
- P19.  Once the client has received a live or vouch frame at the
  server's head, with no backfill in flight, every slice the view covers
  that is live at the server is held at its seq with its state, and no
  other slice is held.

Status:

- P20.  `state` is `live` only after the current connection's live frame
  and while unfrozen, and `syncing` while the connection replays or the
  base is frozen; `frozen` is true exactly while a backfill is in flight.
- P21.  On a fresh store, `hasBase` is false until the first view's
  backfills land, and once true it stays true, across restarts.  While it
  is false, a query that reads past the status waits, and one that reads
  only the status answers.

Atomicity:

- P22.  A frame commits in one store transaction, and queries see a
  mutation's edits to the slices a client holds whole or not at all
  (P3, P16).
- P23.  A tail page never splits the edits of one mutation
  (`TestAnEditsPageNeverSplitsAMutation`); the client parks each delivery
  in one transaction and resumes a tail after the highest position it
  parked, so a resumed tail never skips part of a mutation.

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
  on connection open and on every mutation; a mismatch is rejected, so
  a generation bump logs out everywhere.
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
- A mutation's `NewPassword` fields, which the registry marks, are
  hashed in the handler's cgo call, before the decider runs.  The
  decider and the log see only the hash.  Password-bearing mutations
  are `@online` in the model, so the generated client API never puts
  them in the outbox.  The other prepared kinds (CaptchaToken,
  IdentityProof), and `MutationAuth` proofs of any kind but `password`,
  are recognized, and a mutation carrying one is rejected until their
  verification is built.  A registry naming a kind the database does
  not know stops it at startup: the bundle needs a newer database.
- A `MutationAuth` proof of kind `password` proves the sender's own
  password.  Intake writes `{kind: "password"}` in its place and sets
  the password aside; Go asks `lookup` with `{kind: "token", user}`
  for the sender and checks the request's proofs against its
  `passwordHash` on the pool, within the client's budget, as a login
  does.  The anonymous principal and an account without a hash fail.
  Each mutation's verdict, with the hash it was checked against,
  travels to the writer beside the mutation and never reaches the log.
- The writer checks a proven mutation after the dedup check and before
  `expect` and the decider, so a failed proof never learns a slice's
  seq, and a resend of a mutation that landed is answered by dedup
  however its proof checks now.  It calls `lookup` again in the
  mutation's turn: when the hash is unchanged the verdict stands, and
  a failed one is rejected as "invalid credentials", a decision like
  any other.  When the hash changed, the writer bounces the call: it
  stops at the mutation and answers the outcomes before it, and Go
  checks every remaining proof against the new hash, outside the
  budget and waiting for room on the pool, then submits the rest of
  the call again.  The call's mutations are still decided once each
  and in order, and a call may prove a password its earlier mutation
  set.  A fourth change in a row is `lookup`'s bug, and rejects the
  mutation as one.  Every submit runs the generation check, so a
  token revoked partway through a call is refused with 401, as a lost
  reply is, and a resend dedups the mutations already decided.
- Every argon2id hash, at login and at intake, runs on a fixed pool of
  workers (`HashWorkers`, default `GOMAXPROCS`) behind a queue of twice
  that, so hashing's memory stays at the pool's size times one hash's.
  A full queue answers 503 at once, and a queued hash whose client has
  left is skipped.  Each client, by the address it connects from, has a
  budget of hashes, a token bucket (`AuthBurst` 10, refilled at
  `AuthRate` 1 per second); past it, a login answers 429.  A mutation
  request whose hash is refused, by a full pool or a spent budget, is
  refused whole with the same status, so its ids are still free to
  retry; refusing one mutation would be a final rejection.
- An IPv6 client is budgeted by its /64, since a single host is
  commonly given a whole /64.  Behind a proxy, `--client-ip-header
  <name>` takes each client's address from a header the proxy sets to
  one address, such as Cloudflare's `CF-Connecting-IP`; a request
  without a valid one falls back to the address it connects from.  The
  header is trusted from every request, so the flag is for a server
  only the proxy can reach.  `X-Forwarded-For` and `Forwarded`, which
  hold lists, are refused at startup.
- `--tls-cert <file> --tls-key <file>` serves HTTPS, and HTTP/2 with
  it, from a PEM certificate and key; without them the server speaks
  plain HTTP.  The pair is reloaded when either file changes, so a
  rotation reaches every new connection while an open one keeps the
  certificate it shook hands with.  A handshake looks at the files at
  most once a second, following symlinks, and a pair that does not
  load, such as one replaced halfway, leaves the last one that loaded
  in place.  A pair that does not load at startup stops the server
  before it opens anything.

### Bootstrap

- A fresh data directory starts from the app's optional bootstrap
  slot, `bootstrap(txn, ctx)`.  On startup with an empty log, the core runs
  it once over a write buffer, as a decider runs, and what it wrote
  commits as one mutation's edits: births, dense seqs, a mutation id
  the core mints, and the server time.  The mutation may be large; a
  seed of demo data is one commit.
- `txn` is the context a decider writes through.  `ctx` has two
  calls.  `hashPassword(plain)` returns the same salted argon2id hash
  intake produces, made at once, since bootstrap runs before anything
  is served; it is the only producer of a password hash besides
  intake.  `env(name)` reads only the environment variables the
  operator names with `--bootstrap-env NAME` (repeatable), and any
  other reads as the empty string, so a production seed carries no
  secret in its source.
- On a non-empty log `bootstrap` is skipped.  A throw, such as for a
  variable the operator did not provide, or a write the write gate
  refuses, stops startup with the error; a half-initialized database
  would be worse.
- The slot matters only to an empty log, so after the initial
  deployment it is optional: the seeded state lives in the log, and
  nothing reads `bootstrap` again.  A mature database with no need to
  rebootstrap can delete it from its bundle, and its variables from
  the command line, with no effect.  An app that still stands up fresh
  environments from scratch, such as staging or tests, keeps it.
- Bootstrap is how a database gets its first admin.  It is not a
  principal: it runs once, before any request, with the operator's
  trust, and it writes directly rather than sending mutations, so no
  decider ever sees a request it would have to fake.  Demos seed their
  accounts this way, since dev sign-in requires a real account.  The
  test bundle seeds an admin only when a test names `BOOTSTRAP_ADMIN`
  and `BOOTSTRAP_PASSWORD`; its `lookup` answers for the tests'
  standing users, `root` (an admin) and `p1`, with no account in the
  log, so the log of every other test starts empty.

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
- The scheduler (`cron.go`) wakes at the earliest next slot, or
  after a minute at most, and fires each entry's latest slot at or
  before the wall clock's now, and only that one, so downtime fires
  each entry once.  The mark becomes the slot, never the time it
  fired, so `@every d` keeps its slots at `mark + k·d`; a clock
  stepped backwards fires nothing until it passes the marks.
- A tick runs on the txn loop, past intake.  A slot at or below the
  entry's mark was decided already.  Any other calls the host's
  `tick`, which hands the install's `run` the mutation `{entry, slot,
  now}`, with `now` the group's server time, over a write buffer, as a
  decider runs, and what the hook and its requests wrote commits as
  one mutation's edits under a label the core mints.  The decision
  moves the mark, whatever the hook did: a hook that throws is a bug,
  logged, and its writes are discarded.
- Restoring a backup rewinds the marks with the log, and each entry's
  latest slot past its mark fires again.

### Bundle contract

The bundle installs the skeleton's `Bundle` (typespec/ts/assets/
skeleton.ts), which the generated `define{Database}` builds from the
app's slots:

    globalThis.__bundle = {
      schema,                   // the database's registry data
      bindWrite(txn),
      bindRead(txn),
      decide(data, principal) → null | reason,
      grant(principal) → [selector...],
      lookup(ident) → null | { user, generation, passwordHash },
      bootstrap(ctx),           // optional; see Bootstrap
      plugins: { name: { kind, config, run(mutation) } },
      dev,                      // the skeleton's DEV
      mapStack(stack, file, map) → stack,
    }

- `data` is the mutation's data; `principal` is `{user}` with `user`
  null for anonymous; `ident` is `{kind: "password", identity}` at
  login and the `token`/`refresh` shapes above otherwise.  The `token`
  shape also answers for a `MutationAuth` proof, and the writer reads
  its `passwordHash` again in the mutation's turn, so its answer
  should change only when the account's credentials do.
- The bundle's contexts are built once, when it is defined, and
  `host.js` binds them once, when the bundle loads, to one transaction
  object whose calls reach whichever call into the bundle is running:
  `get(key, type)`, `scan(req)`, `set(key, type, value)`, `del(key)`,
  and `deleteSlice(slice, erase)`.  `bindWrite` binds the read-write
  context of `decide`, `bootstrap`, and a plugin's `run`, and every
  plugin, and `bindRead` the one context `grant` and `lookup` share.
- `decide` answers null when it carried the mutation out, and the
  reason when it rejected it; anything else is a bug.  It runs over
  the read-write transaction of Log and edits, and so do `bootstrap`
  and a plugin's `run`.  `grant` and `lookup` only read: a write
  through their context throws `this call reads only, and made a
  write`, and a write that reaches the core in their call throws
  `<slot> reads only, and made a write`; either is a bug that fails
  the slot.
- `plugins` are the installed plugins by name.  `run`, present for a
  plugin with mutations of its own (a cron tick, a worker's result),
  hands the plugin one mutation.  A plugin's requests are writes
  through the transaction it is bound to, so they commit with the
  rest of the mutation's edits, or are discarded with them.  A built-in is recognized by its `kind` and
  carries a `config` the core reads; cron is the one the core knows
  (Cron).
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
  `get(key, type)` answers the value or undefined, and `scan(req)`
  answers one batch of a walk of the keys a pattern picks out,
  `{entries, next}`, as the skeleton's `ReadTxn` does.  Keys are
  global, `<slice>!<local key>`.  The core converts each value under
  the type the call names, a registry identity, so a value that does
  not fit its type fails the call.  A scan names one type too, or
  `false` for keys only, so a scan with values picks out one key
  template's keys.
- A scan walks the kv table in C (`scan.c`) the way the skeleton's
  `walkPattern` does: a skip scan that places each key against the
  pattern's fields and seeks past the keys that cannot match, after
  stepping up to 16 keys toward the target, since a SQLite seek costs
  about as much as 16 steps.  It reads one key past the batch to tell
  whether more follow, and decodes only the batch's values.  Over a
  write buffer, the walk merges in the buffer's keys that the pattern
  picks out (Log and edits).  The skeleton's conformance fixture
  (`typespec/tests/fixtures/scan-conformance.json`) runs against it
  in `scan_test.go`.
- The grantor is registered per distinct `principal` and re-run when
  a commit touches what it read: the keys it got, and for each scan
  batch, the stretch of keys the walk covered, the skeleton's
  `ScanSpan` (its pattern, its direction, from just past the batch's
  `after` to its `next` or the walk's end).  A written key touches a
  key it got or one a span covers, as `spanCovers` decides.  A
  cleared prefix, a deleted or reborn slice's `<slice>!`, touches a
  key it got under the prefix, or a span whenever the prefix could
  hold a key the span covers: the prefix and the pattern's head agree,
  one starting with the other, and the prefix's keys overlap the
  span's stretch.  A spurious re-run costs only time, so that test
  errs toward re-running.

### Layout and build

The database is one Go module, `phaselock.io/phaselockdb`, rooted at
`db/`, and one package: cgo compiles a package's C only from its own
directory, and calls C only in its own package, so the C core and the
Go layer sit side by side.

    db/*.c, *.h   the C core: pldb.c txn loop, queues, the mutation
                  check, and the commit of edits, buffer.c a
                  mutation's write buffer, store.c SQLite, scan.c key
                  patterns and their walk, walk.c the conversion
                  kernel, names.c the syntax of slice names, prefix
                  selectors, and keys, mpjs.c untyped msgpack<->JS,
                  js.c QuickJS host and the merging scan, host.js the
                  JS glue (embedded by Go), os.c the calls that differ
                  by platform, scantest.c the scan conformance test's
                  hold on the walk
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

Reader-side calls (history, edit reads, snapshot) share one SQLite reader
connection behind a mutex rather than a dedicated thread; each runs in
its own read transaction so a cut is consistent with its position.
