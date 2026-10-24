# Protocol conformance suite: status and open items

Working notes for the protocol conformance suite and the sync-protocol
bug work that led to it, kept so the state survives a context reset.
Untracked.

## Where things are

- The rules: `db/README.md`, section "Protocol rules", P1 to P23.  Each
  rule states what must hold between the database and a client Engine,
  independent of how this Engine implements it; a rule with a database
  half names the Go test in `db/server_test.go` that checks that half.
- The scenarios: `typespec/tests/src/engine/conformance/`, one file per
  rule group (`chaining`, `lifecycle`, `view`, `bootstrap`, `cursor`,
  `freeze`, `backfills`, `convergence`, `status`, `atomicity`, each
  `.test.ts`) and shared fixtures in `common.ts`.  A `describe` per rule;
  every test name starts with its rule ID.  Each `describe` cites the
  older engine tests (in `typespec/tests/src/engine/`) that also check its
  rule.  `typespec/README.md` describes the layout under Tests.
- The TLA+ model that found D135 to D142: `tla/` (untracked, not its
  final home), with `tla/BUGS.md` describing each bug, fix, and test
  shape, and `tla/traces/` the counterexamples.  `tla/states/` holds
  TLC's 19 GB of working state, kept only for now.

## The layers

1. The numbered rule list: done (23 rules).
2. Hand-written scenarios organized by rule: done (56 scenarios, at
   least two per rule).  The regression tests for D135 to D141 moved in
   under their rules (D135 under P17; D136 and the boot purge under P8;
   D137 under P5; D140 and D141 under P10); `rules.test.ts` is gone.
3. A property-based layer: not started.  Decided (Human-directed): the
   Human reviews and commits layers 1 and 2 first, then sees the diff
   for layer 3 before agreeing to it.  The plan: a small reference
   server in the test harness modeling the database's protocol behavior
   (log, slices with seqs and lifecycle, a grantor whose answer changes,
   retention within its floor, snapshot cuts and tails); a generator of
   random event sequences (commits, grant changes, pruning, drops,
   reconnects, frame deliveries, backfill steps including stale and
   failure), with shrinking (fast-check or similar); and the P-rules
   checked against the real Engine after every step (continuous rules)
   or at quiescence (convergence, landing).  Roughly 800 to 1,200 lines
   of test code.  It replaces a TLA+ workflow for now: the Human prefers
   to rebuild a TLA+ model only before non-trivial Engine changes.

Scenarios per rule: P1 2, P2 2, P3 3, P4 2, P5 2, P6 2, P7 3, P8 3,
P9 3, P10 4, P11 2, P12 2, P13 3, P14 2, P15 2, P16 2, P17 3, P18 2,
P19 2, P20 3, P21 2, P22 3, P23 2.

## Bugs the suite found (open, each a `test.fails` scenario)

- P22, a query shows half of a mutation.  One frame carries p1 seq 3,
  which chains, and p2 seq 9, a gap.  Queries over p1 and p2 should go
  from [2,1] straight to [3,9]; they show [2,1], then [3,1], then [3,9].
  Cause: `#onEditsIn` applies the frame's edits ahead of the gap (its
  comment: "a frame that froze part way applied up to the edit before
  the gap"), and the freeze's status change then runs the query graph
  over those dirty base keys.  It contradicts `#refresh`'s comment that
  base changes reach queries only when not frozen.
- P13, a prediction disappears while its edit is still parked.  A
  `book:*` additive backfill is in flight; a mutation predicts a new
  `book:b9`, is acked ok at 12, and its birth parks under `book:*`; a
  vouch at 12 arrives.  The vouch counts the base as applied through 12,
  so the outbox releases the mutation and its prediction vanishes until
  `book:*` lands, then the item reappears.  It contradicts the
  `#applied` comment ("an acked mutation at or below it is in the base,
  edits or none").  `#settleOnline` reads the same applied position, so
  an `@online` mutation would settle early the same way (untested).

Proposed as D153: fix both, then drop their `test.fails` marks.  Not yet
approved.

## Doc claims stronger than the behavior (open, untested)

- "Every state shown is a prefix of the log" (the skeleton's resync
  paragraph) holds per slice, not across slices: an additive backfill
  can land a held slice ahead of the replay (a resumed client holding p1
  and b1 at 10 gets a view at 30 granting `patron:*`, whose blob carries
  p1 to seq 5 while b1 is still at 10), and a gap hides a slice's missed
  edits until it is seen.  P18 is stated per slice.
- "The first state queries see is complete" (first boot) fails when a
  second view frame arrives before the first land: narrowing it
  (`patron:*` to `patron:p1`) drops the replacing backfill, so the Engine
  unfreezes with `hasBase` true and `state` live while p1 downloads
  additively; widening it makes the added grant additive, so the first
  state lacks it.  P21 is worded to hold today.

Decision needed: weaken the wording, or make the behavior match.

## Recently landed, not yet committed when written

- D152: `state` is `live` only once the `live` frame has been seen and
  no replacing backfill is in flight, `syncing` otherwise while
  connected; `hasBase` tells a loading screen from showing the last
  known state under a syncing banner.  In `skeleton.ts`
  (`#connectionStatus`, the `ConnectionStatus` doc, the sync-kinds
  comment) and `freeze.test.ts`, `status.test.ts`.
- Layers 1 and 2 above.
- Earlier in the same round, already reviewed: D135 to D142 fixed (client
  in the skeleton, database in `db/server.go` with test hooks
  `heartbeat`, `beforePush`, `beforeStreaming`), and the bootstrap
  contract documented in `db/README.md` and `Backfill.until`.

## Other open items from the same session

- Mark D135 to D142 as fixed in `tla/BUGS.md` (asked, not answered).
- Smaller findings from the TLA+ work, deferred: a slice born during a
  freeze gets a needless exact backfill on its next normal edit in a
  later frame; which cut the retention floor refers to is unspecified.
- Docs still in old vocabulary, the Human's to update: the `class Engine`
  docstring's opening, diagram, and legend (its store-key list is
  current); `typespec/core/README.md`; the library's `Intro.tsx` link,
  which should point at `model/predictors.ts`'s `tryHold` after the
  commit; planning docs (`V0-DEBT.md`'s typed selectors entry,
  `PLUGINS.md`, `AUTH.md`).
- Suggested, not decided: a doc note where predictors are introduced
  that a predictor's logic often runs with authority inside its decider,
  so it must hold up against server state.

## Asking the agents follow-up questions

The agents that did this work can be resumed with their context, until
the session ends, through SendMessage; find them with ListAgents by
their descriptions:

- "Protocol rule list and conformance tests": layers 1 and 2, the rules,
  and the two bugs above.
- "Fix client sync bugs D135–D141" and "Fix database sync bugs
  D138–D139": the fixes and their tests.
- "Ask Fable its effort level": despite its name, the agent that built
  and ran the TLA+ model and found D135 to D142.
- "Unprimed naming opinion": the context-free naming answers (it chose
  decider, then predictor, and defended decide calling predict).

If the session has ended, start fresh agents from `db/README.md`'s rules,
`tla/BUGS.md`, and this file.

## A fresh review of the sync code (after D135 to D142)

The TLA+ agent reviewed the Engine (`typespec/ts/assets/skeleton.ts`) and
`db/server.go` and `db/pldb.c`, sharing uncertain findings too.  None is
fixed yet.  Line numbers are from `skeleton.ts` when the review ran.

Bugs and likely bugs:

1. P13 has four triggers.  `#applied` advances past edits parked under
   an additive backfill in `#onCursorIn` (vouch and live, 4692), at the
   end of `#onEditsIn` (`#appliedTo(last)` when not frozen, 4601: a
   frame whose `book:*` edits all parked still counts as applied through
   its position), and in `#unfreezeIn` (`#appliedTo(checkpoint)`, 4815);
   each releases acked outbox mutations (`#appliedTo` to `#releaseIn`),
   dropping their predictions until the backfill lands.
   `#settleOnline` (4639) resolves an `@online` mutation's promise
   (`ack.position <= #applied`) while its edit is parked, against its own
   doc.  Suggested rule: an acked mutation whose id has been parked is
   released only by its round trip.  A fix must cover all four.
2. P22 (known): `#onEditsIn` applies a frame's chained edits and parks
   the gapped one (4541 to 4601); the freeze's status change reruns the
   graph over the half-applied base in `#refresh` (4618 to 4634).
3. One gap repair freezes the whole base for an entire additive download
   (likely, UX).  `#onEditsIn`'s gap branch (4572) spawns the exact
   repair as a replacing child of `#parentOf(slice)`; `#tryLandIn` lands
   nothing while a replacing entry is outside a landing subtree (4004 to
   4011), and the child's subtree is the parent's.  A large additive
   `book:*` download plus one retention gap on a held `book:b1` stops
   every query update for the whole download and shows `syncing`.
   Suggested: spawn the repair top-level; at the parent's landing the
   repaired slice is held at or past the header's seq and kept (4185 to
   4188), and a newer parent blob correctly wins.
4. v0 resumes never succeed under write load (a design limit).  v0 cuts
   a fresh blob per request, so after any commit a Range resume answers
   `stale` (`client/ts/src/http.ts:427`) and the Engine restarts the blob
   from byte 0 (`#onBackfillOutcomes`, 3893 to 3910); a large bootstrap
   on a flaky link may never finish.  The README assumes stable blobs
   from a blob store.
5. A `since` above the head silently starves the connection (unsure,
   operational).  `handleStream` sets `cursor = since` with no check
   against the head (`server.go` 688 to 691); replay delivers nothing,
   `live` is written at `since`, and `forward` drops every commit frame
   at or below the cursor (797) until the log passes it.  Reachable by
   restoring an older backup without a new epoch.  Suggested: answer 400
   or clamp to the head.
6. An epoch mismatch ends the Engine for good (`#onInbox`, 4477, "until
   that exists this ends"): a restored or re-minted data directory bricks
   installed clients until the app clears its store.  A known TODO.
7. A failure outcome demotes a ready backfill (unsure, probably
   unreachable): `#onBackfillOutcomes` sets `entry.status =
   'downloading'` unconditionally (3914); a retry whose resume has both
   halves done pushes nothing, answers `done`, and the entry stays
   `downloading` until the next `#initialize`.  A guard costs nothing.
8. Backfill pushes carry no connection tag (unsure, low): outcomes are
   tagged, `#backfillWork` items only by selector (3946 to 3950, 3782 to
   3809).  A late push from an ended connection's call could mark a
   restarted tail done early; practically unreachable with the current
   transport, but the asymmetry looks unintended.
9. `#sent` clears only in `#onEnd` (3717 to 3721, 4826): a transport
   whose `sendMutations` rejects without ending the connection strands
   those outbox mutations on it.  The `Connection` contract forbids that
   and `http.ts` complies; the Engine has no fallback.

Latent until snapshots come from a blob store (v0 always cuts at head):

10. Cold replay sends view frames only at window boundaries
    (`handleStream`, 695 to 714 and 738 to 757): a grant at P mid-window
    leaves positions from P to the window's end for the new selector
    covered by neither the replay (old selectors) nor the backfill (its
    tail stops at the view position plus one).  The D141 family, wider.
11. A stale restart keeps `fromPosition` (3901 to 3907): if the fresh
    blob is older than the previous tail's progress, `#parkPushIn` takes
    `max(fromPosition, position)` (3827), the tail starts past the new
    cut, and (new cut, old from] is uncovered; the chain check restarts
    the download in a loop until a newer blob is served.

Performance and UX:

12. A slice born during a freeze gets a needless exact backfill on its
    next normal edit in a later frame (`#onEditsIn`, 4525 to 4537):
    `born` is per frame and the parked birth leaves no table entry.
13. `#initialize`'s purge can leave `#view` non-null with no selectors
    (3527 to 3530), so the next grants are additive, `hasBase` turns true
    on the first vouch before data lands, and the first frame is empty.
    Only after a build drops every wanted selector.
14. A predictor that throws because real edits moved the base drops its
    prediction until the round trip (`#rebuildOverlay`, 4864 to 4877):
    documented, still a flicker.
15. Redundant nested grants (`chat:*` with `chat:acme,*`, both kept by
    `intersect`, `server.go` 534 to 556) cause view frames and `!view`
    writes that leave coverage unchanged.  Harmless; README notes it.
16. Every `/snapshot` and `/edits` request registers an ephemeral grant
    through the transaction loop (`s.view(p, nil, true)`, 971 to 1005 and
    1024 to 1090), and `check_expect` re-runs the grantor per expecting
    mutation (`pldb.c` 609 to 690): a cost with many clients.
17. A client that cannot keep up gets `end overflow` (`server.go` 410 to
    417, 794) and replays from its checkpoint after backoff; a
    persistently slow client loops.

Dead, confusing, or duplicated code:

18. `#resetAhead` (4606) is unreachable (one edit per slice per frame);
    the comment in `#onEditsIn` describing that case (4551 to 4554)
    misleads.
19. The backfill tree is kept twice: parent pointers in memory (rebuilt
    by `#parentOf` at init, 3500 to 3504) and `children` on disk (3377,
    4232, 4391, 4411 to 4423); `#childrenOf` filtering names no longer in
    flight (4024 to 4026) would hide drift.
20. `#onEditsIn` writes the checkpoint record twice per frame
    (`#appliedTo`, then `#advanceCursorIn`, 4601 to 4602).
21. `#onBackfillOutcomes`, `#onViewIn`, and `#tryLandIn` call
    `#startBackfill` inside a store transaction: a side effect before the
    commit, safe today because pushes queue for a later pass.
22. The `class Engine` docstring's opening, diagram, and legend are in
    old vocabulary (known; the Human's text).

Doc and code mismatches:

23. (Already fixed when reported: the README's tail wording.)
24. The root assumption behind P13: the README's "an `ok` ... a client
    that has read that far has its answer" and the skeleton's "An acked
    mutation at or below it is in the base, edits or none" (3307 to
    3310) are false while edits are parked under an additive backfill.
25. (Already fixed when reported: the `Backfill.until` comment.)
26. The retention floor, "newer than its slice's latest cut snapshot",
    does not say which cut (per selector, per slice, latest served);
    items 10 and 11 and D141 turn on it.
27. The README's "every later change is a view frame in log order, ahead
    of the edits of the commit that caused it" holds for the hot catchup
    (D139) but not a cold window (item 10).

Checked and sound: D139's switch (each commit reaches a connection once,
by the hot catchup or the queue); D138's heartbeat (frames pushed between
reading the position and the drain are forwarded too); D136, D137, D140,
D141 match the model's fixed variants; an older in-flight child adopted
by a new prefix grant completes its slices through its own tail and
parked edits.

Proposed grouping for the next round (not decided): fix 1, 2, 3, 5, 7,
9, 10, 11; clean up 12, 13, 18 to 21; decide 4, 6, 14 to 17, 26.  Pending
first: the blocking-backfills design note (`BLOCKING-BACKFILLS.md`, being
written by a fresh agent), since a pause-and-replay backfill design would
remove most of the machinery several of these live in.
