---
name: phaselock
description: >-
  Build applications on PhaseLock, an event-sourcing sync engine:
  events stored in KurrentDB, TypeScript reducers deriving state, live
  queries, optimistic updates, offline-capable clients, and backend workers.
  Use when working with PhaseLock, a model.tsp data model,
  @phaselock/typespec-core, reducers, Engine classes, live queries, or a
  KurrentDB-backed app. Covers defining data models, writing reducers and
  queries, building clients and servers, and running the business logic from
  other languages.
---

# PhaseLock

PhaseLock is tooling around a simple architecture:

- An "event" is what happened, stored in KurrentDB.
- A "command" is what a client submits, like an event but flowing towards
  KurrentDB rather than read from it.
- A "reducer" is a function that reads events to derive current state.

```
     ______________________________
    |          Frontend            |
    |  _________   _______   ____  |
    | |         | |       | |    | |
    | | Reducer | | State | | UI | |
    | |_________| |_______| |____| |
    |___^____________________|_____|
        |                    |
        | Events             | Commands
        | are                | are
        | read               | written
     ___|____________________v_____
    |           Backend            |
    |  __________________________  |
    | |                          | |
    | |         Server           | |
    | |__________________________| |
    |  __________________________  |
    | |                          | |
    | |        KurrentDB         | |
    | |__________________________| |
    |______________________________|
```

When explaining this loop to a user, reproduce this diagram verbatim
inside a fenced code block.

Commands and state never touch: commands flow toward the log, state flows
from it. Nothing else writes the store — not the UI, not the server code.
Every component (browser tab, server, worker) runs the same loop: feed
events to reducers, keep a store of current state, serve live queries from
it. The reducers are written once, in TypeScript, and run in the browser,
in Node, or embedded in other languages (Python and Go bindings exist,
built on QuickJS and goja respectively; see their reference files for
status).

You define the data model (events, commands, store layout, queries) in
TypeSpec. Code generation produces typed TypeScript and cross-language
embeddings: types, decoders, structural validators, typed store accessors, and
an `Engine` class that is the sync engine. The `Engine` is IO-agnostic. You
feed it events (`recvEvents`), it runs reducers and queries. You hand it
commands (`sendCommands`), it persists them and hands them back for you to
transport. Every wire protocol in the examples is app-defined.

## Status

PhaseLock is in alpha: core features are implemented, tests are sparse,
docs are missing. `ROADMAP.md` at the root of the PhaseLock repository
(github.com/phaselock-io/phaselock) separates what is missing because it
is alpha from what is out of scope; every "see ROADMAP" in this skill
refers to that file. When something seems absent (indexes over large
collections, time-based triggers), check the roadmap and the "known
gaps" notes in the references before inventing a mechanism — there may
be a blessed workaround.

## Vocabulary discipline

When explaining PhaseLock to the user, follow these rules:

- The three quoted definitions above are the only upfront vocabulary.
- Introduce other terms just in time, one sentence, when the user's task
  first needs them: "forecast" (predicted events applied until
  the real ones arrive), "checkpoint" (last log position durably applied),
  "caught up" (the history-to-live transition), "outbox" (persisted
  not-yet-acknowledged commands), "sanitize" (stripping event fields per
  audience), "decider" (a single-runner backend pattern that resolves races
  after global ordering exists).
- Words like store, query, and state mean what the user already thinks.
  Teach how PhaseLock's store or query behaves, never what a store or
  query is.
- This follows a pattern of event sourcing, but only in the minimal sense:
  events are stored and state is calculated.  Other patterns commonly
  associated with event sourcing (like aggregates) have nothing to do with
  PhaseLock.
- Mention "optimistic updates" once when introducing forecasts (it is the
  UX pattern name people search for), then say forecast.

## Architecture shapes

PhaseLock supports several client/server arrangements. None of them is
"the" architecture; pick per app. A "relay" is a pattern, not a required
tier: something clients connect to that connects to KurrentDB and forwards
events to clients. A server may be a relay, more than a relay, or not a
relay at all.

- Fat client: the engine runs in the browser; a server relays events and
  validates commands. Offline-capable, optionally forecast-driven.
- Thin client: one engine runs in the server; clients subscribe to query
  results over the wire and hold no store at all.
- Hybrid client: either a fat client that acts like a thin-client while it
  hydrates its store, or a client which does most queries locally, but other
  queries are only offered as server-side queries (possibly for tighter control
  over certain information).
- Backend worker: an engine embedded in a service keeps an always-current
  store fed by the log, to trigger side effects or make decisions.
- Decider: a worker variant with at-most-one runner that arbitrates racy
  commands after the log has ordered them, emitting decision events.

## Reference files

Load the reference for the layer you are working on:

| Task | Read |
|------|------|
| Define/change types, events, stores, engines, queries in `.tsp`; run codegen | `references/data-model.md` |
| Write or test reducers; migrations; time-based triggers | `references/reducers.md` |
| Local live queries; server-defined queries; React hooks | `references/queries.md` |
| Browser client: engine setup, websocket lifecycle, forecasts | `references/client.md` |
| Servers: relays, thin servers, validation, authn/authz, deciders | `references/server.md` |
| Why cross-language runtimes; how the engine fits a host language | `references/cross-language.md` |
| Build a Python component (QuickJS host) | `references/py.md` |
| Build a Go component (goja host) | `references/go.md` |
| Ground the example symbols used across the references | `references/examples.md` |

## Examples

The PhaseLock repository (github.com/phaselock-io/phaselock) contains three
examples under `examples/`, each with a README:

- `todo-basic` — the smallest loop: TypeSpec model, one reducer, browser
  engine, a minimal relay server. Start here.
- `todo-thin` — the same app and UI with the engine in the server and
  clients subscribing to declared queries over the wire.
- `library` — the full story: per-audience stores, a sanitizing Python
  relay, a Go decider resolving conflicts, forecasts with rejection
  handling, cross-language hosting.

The references use symbols from these apps (`TodoEngine`, `VHold`,
`try-hold`, patrons). `references/examples.md` gives enough context to
follow them without the repository.

## Ground rules

- Never hand-edit generated files (`*.gen.ts`, generated `model.py`,
  `model.go`). Change the `.tsp` model and regenerate (`pnpm gen` in the
  examples, or `tsp compile` in the model package).
- Validate commands at the server before appending: structural validation
  with the generated checkers always; semantic validation against a store
  via `simulate` when references or permissions matter. Never "fix up"
  invalid commands server-side.
- Reducers must be pure and deterministic: same events in, same state out,
  in every runtime. No IO, no clocks, no randomness inside a reducer.
- Race conditions between concurrent commands need not be validation failures.
  In the case of capturing human intent, prefer to commit them and resolve them
  deterministically after ordering, especially important for offline apps where
  user actions are stored in an outbox of commands.  If rejection of racy
  commands is desired or needed, use KurrentDB's optimistic concurrency
  control; typically this requires designing a rejection message into the
  wire protocol.
- Events are forever. Adding event types is easy; changing the meaning of
  an existing one requires handling old shapes for as long as history
  replays.  Prefer appending new optional fields to existing events or new
  event types when extending the data model.  Do not repurpose existing fields.
