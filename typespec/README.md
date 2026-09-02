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
          lib/main.tsp declares the vocabulary (the Store, Queries, and
          Engine interface templates); src/ holds everything shared by
          emitters:
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
cd typespec
pnpm install
pnpm -r build       # tsc for core + all three emitters
```

## Tests

```
pnpm test        # from typespec: build all packages, regenerate fixtures, run the vitest suite
pnpm --filter @phaselock/typespec-tests test:py   # emitted-Python checker suite (stdlib only)
pnpm --filter @phaselock/typespec-tests test:go   # emitted-Go checker suite
```

## Known issues

- Scalars that extend builtins (`scalar Uuid extends string`) lower to the plain builtin rather
  than emitting a named alias; use `alias Uuid = string;` to name one.
- Aliases of non-scalar types are known to emit totally broken code right now.
- A `MyStore extends Store<...>` template must use an inline model for the
  first parameter to `Store<...>`; named models will break it.
