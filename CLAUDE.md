# PhaseLock — repo guide

PhaseLock is an event-sourcing sync engine: events live in KurrentDB,
TypeScript reducers derive state everywhere (browser, Node, Python, Go),
and live queries serve it. Positioning and concepts: README.md. Status
and planned work: ROADMAP.md.

Two kinds of work happen here; orient first:

- **Building on PhaseLock** (examples, demo apps, anything app-shaped):
  follow the `phaselock` skill at `agents/skills/phaselock/SKILL.md` and
  its reference files. That skill is the product documentation for
  agents; it also ships to end users, so keep it repo-agnostic when
  editing it.
- **Changing PhaseLock itself** (`typespec/` — the TypeSpec vocabulary,
  emitters, and runtime skeletons): read `typespec/CLAUDE.md` for settled
  design decisions before touching anything there.

## Repo layout

```
typespec/         The product: TypeSpec vocabulary (core/), emitters
                  ({ts,py,go}/ with runtime skeletons in assets/), and
                  their tests. See typespec/CLAUDE.md and typespec/README.md.
examples/
  todo-basic/     Smallest loop: browser engine + minimal TS relay server.
  todo-thin/      Same app, engine in the server, clients get query results.
  library/        Full architecture: Python relay, Go decider, forecasts,
                  per-audience stores. Root also has populate.py seed data.
agents/           The "phaselock" agent plugin; canonical skill at
                  agents/skills/phaselock/.
.claude-plugin/   marketplace.json cataloging the plugin.
```

The runtime skeletons (`typespec/{ts,py,go}/assets/skeleton.{ts,py,go}`)
are the canonical engine runtime — generated files embed a copy. Edit
skeletons in `typespec/`, never in generated output.

## Build and check

TypeSpec tooling (`cd typespec`):

- `pnpm install && pnpm -r build` — build vocabulary + emitters
- `pnpm test` — regenerate fixtures, run the vitest suite
- `pnpm --filter @phaselock/typespec-tests test:py` / `test:go` —
  emitted-Python / emitted-Go checker suites

Todo examples (`cd examples/todo-basic` or `todo-thin`):

- `pnpm i` then `pnpm gen` — install, regenerate from the `.tsp` model
- `pnpm check` — tsc + eslint + prettier across model/server/ui
- `pnpm dev` — run the stack (docker KurrentDB + server + vite UI)

Library example (`cd examples/library`):

- `make gen` — regenerate all generated sources from model.tsp
- `make` / `make check` — build everything / typecheck + lint + format
- `cd model && pnpm test` — reducer tests (jest, via ReducerTester)
- `./devstack.mts` — run the stack (KurrentDB + decider + relay + UI)

After changing any `.tsp` model or any codegen in `typespec/`, regenerate
and read the regenerated files rather than assuming their shape.

The example build files are meant for external readers, so their gen
steps don't depend on the contents of the tooling changing.  The tooling
also doesn't have a proper build system.  When you work on `typespec/` and
want to test an example, manually `(cd typespec && pnpm build)` and then
`touch examples/library/model/model.tsp` (or equivalent) to force the
example to regenerate.

## Conventions

- Generated files (`*.gen.ts`, generated `model.py`, `model.go`,
  `ui/src/model.*`) are never hand-edited; change the `.tsp` or the
  emitter and regenerate.
- Demo code is meant to be read: high quality, simple, and it
  intentionally omits things (auth, users, subscription sharing).
  Don't "fix" an omission without asking; the omissions are the design.
- The generic query hooks (`useLocalQuery.ts`, and todo-thin's
  keyof-based `useQuery.ts`) are library-quality; `usePhaseLock.ts` is
  app-specific by design — clarity over generality.
- Wrap new documentation files at 80 columns.
- If a result contradicts your model of the system, stop and ask rather
  than iterating on guesses; this codebase has few but sharp invariants,
  and the user usually spots the mismatch immediately.
