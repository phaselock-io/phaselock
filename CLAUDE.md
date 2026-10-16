# PhaseLock — repo guide

PhaseLock is an event-sourcing sync engine: events live in the
PhaseLock database (`db/`), TypeScript reducers derive state in the
browser, in Node, and in the database, and live queries serve it.
Positioning and concepts: README.md. Status and planned work:
ROADMAP.md.

Two kinds of work happen here; orient first:

- **Building on PhaseLock** (examples, demo apps, anything app-shaped):
  follow the `phaselock` skill at `agents/skills/phaselock/SKILL.md` and
  its reference files. That skill is the product documentation for
  agents; it also ships to end users, so keep it repo-agnostic when
  editing it. The skill still describes the KurrentDB-shaped API and
  needs its own rewrite. The PhaseLockDB-shaped API was more than half a
  rewrite and assumes synchronous stores, which rules out IndexedDB and
  implies OPFS with SQLite or a custom KV store in the browser. Until
  the skill catches up, the current contract is the skeleton
  (`typespec/ts/assets/skeleton.ts`) and `client/ts`.
- **Changing PhaseLock itself** (`typespec/` — the TypeSpec vocabulary,
  the emitter, and its runtime skeleton): read `typespec/CLAUDE.md` for
  settled design decisions before touching anything there.

## Repo layout

```
typespec/         The product: TypeSpec vocabulary (core/), the
                  TypeScript emitter (ts/, with its runtime skeleton in
                  assets/), and their tests. See typespec/CLAUDE.md and
                  typespec/README.md.
examples/
  todo-basic/     Smallest loop: browser engines + the v0 database (db/).
  library/        Full architecture on the v0 database: signed-in patrons
                  and librarians, per-audience views, forecasts, and a
                  cron daily sheet, hosted as a demo with a room per
                  visitor.
client/ts/        @phaselock/client: the JS host's transport over HTTP
                  (logins, sessions, connections), its msgpack cursor,
                  and the Registry that walks the generated type
                  registry.
plugins/          @phaselock/plugins: the plugins we ship, as a
                  database's bundle installs them; cron so far.
db/               The v0 database: a C core (QuickJS, SQLite, the
                  conversion kernel) under a Go HTTP layer.  See
                  db/README.md.
agents/           The "phaselock" agent plugin; canonical skill at
                  agents/skills/phaselock/.
.claude-plugin/   marketplace.json cataloging the plugin.
```

The runtime skeleton (`typespec/ts/assets/skeleton.ts`) is the
canonical engine runtime — generated files embed a copy. Edit it in
`typespec/`, never in generated output.

The skeleton is the reference protocol.  `client/ts` and `db/` follow
it, never the reverse: a change to the Engine's contract, the `Bundle`,
or the store interface starts in the skeleton.

## Build and check

Setup is `pnpm install`, anywhere in the repo: one pnpm workspace, with
one lockfile, holds the tooling, the client, the plugins, `db/testdata`,
and the examples.  Nothing needs building first.

The examples depend on the tooling by version range (`^0.2.0`), as a
copy outside this repo would, and the workspace links those ranges to
the local packages; a version bump moves the examples' ranges with it.

Inside the repo, `typespec/core`, `typespec/ts`, `client/ts`, and
`plugins` load from their TypeScript source: each package's `exports`
names `src/`, and its `publishConfig` names the compiled `dist/`, which
pnpm swaps in when packing.  So:

- Publish with `pnpm publish`; `npm publish` would ship the `src/`
  entry points without the sources.
- The TypeSpec compiler runs `typespec/core` and `typespec/ts` under
  Node's type stripping (Node 22.18+): their relative imports name
  `.ts` files, and their syntax is erasable (`erasableSyntaxOnly`), so
  no parameter properties or enums.
- `typespec/core/lib/src.tsp` and `lib/dist.tsp` load the vocabulary's
  decorators from source or from `dist/`; the `typespec` export picks
  one, and both import `lib/main.tsp`.

TypeSpec tooling (`cd typespec`):

- `pnpm build` — compile the vocabulary and the TypeScript emitter to
  `dist/`, which only publishing uses
- `pnpm test` — regenerate fixtures, run the vitest suite

Database (`cd db`; Go 1.25+ and a C compiler):

- `make` — build `db/phaselockdb` (plain `go build` with
  `CGO_CFLAGS_ALLOW=-fwrapv`; no other build steps)
- `make test` — rebuild the test bundle, run the Go tests
- `make check` — the core's own C, warnings as errors

Examples (`cd examples/todo-basic` or `library`):

- `pnpm gen` — regenerate from the `.tsp` model
- `pnpm check` — tsc + eslint + prettier across the example's packages
- `pnpm dev` — run the stack: build and run the v0 database with the
  example's bundle beside the vite UI

After changing any `.tsp` model or any codegen in `typespec/`, regenerate
and read the regenerated files rather than assuming their shape.

An example's `pnpm gen` regenerates every time it runs, so after work on
`typespec/` it picks up the tooling's source as it stands.

## Conventions

- Generated files (`*.gen.ts`) are never hand-edited; change the `.tsp`
  or the emitter and regenerate.
- A model package (the `.tsp`, its generated code, its reducers, and its
  database's bundle source) depends on no host library: not
  `@phaselock/client`, nor whatever runtime a client or the database
  brings, since one model serves every client app and the database.
  `@phaselock/plugins` is allowed, for the bundle source's plugin
  installs.  Our code holds to this; for users' code it is a
  recommendation.
- Demo code is meant to be read: high quality, simple, and it
  intentionally omits things: todo-basic has no users, and the library
  signs its windows in itself, with no sign-up or sign-in screen.
  Don't "fix" an omission without asking; the omissions are the design.
- The generic query hook, `useLocalQuery.ts`, is library-quality.
- Wrap new documentation files at 80 columns.
- Vendored third-party code lives under a `vendor/` directory
  (`db/third_party/` in the database's Go module, where Go reserves
  `vendor/`), each file headed with its origin, version, commit, any
  modification, SPDX id, and full license text (see
  `client/ts/src/vendor/`), and gets an entry in the root `NOTICE`,
  mirrored in the `NOTICE` of any package that ships it.
- If a result contradicts your model of the system, stop and ask rather
  than iterating on guesses; this codebase has few but sharp invariants,
  and the user usually spots the mismatch immediately.
