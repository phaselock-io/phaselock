# TypeSpec model tooling

The model tooling for PhaseLock, built on [TypeSpec](https://typespec.io).
Data models are written in TypeSpec against the `@phaselock/typespec-core`
vocabulary; emitters produce typed bindings per language.

Currently-supported emitter languages are:
- TypeScript
- Go
- Python

Note that the Go and Python integrations will be fully re-written in the near
future.  They served their purpose: proving the concept and clearing up fuzzy
ideas.  The new versions will have better stores for native typing and serde.

Future emitter languages include:
- Swift, targeting iOS apps
- Kotlin, targeting Android apps
- almost anything; create a GitHub issue

## Layout

```
core/     @phaselock/typespec-core — the definition library apps import.
          lib/main.tsp declares the vocabulary (the Slice, Engine,
          Database, and Queries interface templates, @online, and the
          fields the database prepares for a decider); src/ holds
          everything shared by emitters:
            ptypes.ts  interned concrete-type IR
            solver.ts  union solver
            lower.ts   TypeSpec Program -> IR
            denter.ts  indent-aware printer
ts/       @phaselock/typespec-ts — TypeScript emitter.
py/       @phaselock/typespec-py — Python emitter.
go/       @phaselock/typespec-go — Go emitter.
          Each emitter is a package exporting $onEmit; it calls lowerProgram() from the
          core and walks the lowered IR.  Each ships its target-language runtime skeleton
          as assets/skeleton.{ts,py,go} (the canonical copy) and prepends it (override via
          the `skeleton` option).
tests/    Vitest suite for the tooling (see "Tests" below).
```

## Build and generate

```
pnpm install        # from the repo root, whose workspace holds these packages
cd typespec
pnpm build          # tsc for core and the TypeScript emitter, for publishing
```

## Tests

```
pnpm test        # from typespec: regenerate fixtures, run the vitest suite
pnpm --filter @phaselock/typespec-tests test:py   # emitted-Python checker suite (stdlib only)
pnpm --filter @phaselock/typespec-tests test:go   # emitted-Go checker suite
```

`tests/src/engine/conformance/` checks the Engine against the protocol rules in
`db/README.md`, P1 to P23: one file per group of rules, so related rules share their
fixtures and each file stays short, and a `describe` per rule, with each test's name starting
with its rule, so a failure names the rule it breaks.  Each rule's `describe` cites the tests
elsewhere in `tests/src/engine/` that check the same rule.

## Known issues

- Scalars that extend builtins (`scalar Uuid extends string`) lower to the plain builtin rather
  than emitting a named alias; use `alias Uuid = string;` to name one.
- Aliases of non-scalar types are known to emit totally broken code right now.
- A `MyStore extends Store<...>` template must use an inline model for the
  first parameter to `Store<...>`; named models will break it.
