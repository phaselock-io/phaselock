# TypeSpec DSL — design decisions

Context for working on the TypeSpec model tooling (`@phaselock/typespec` + the three
emitters).  See README.md for layout, build commands, and the test suite.

## Design decisions

- **Declaration style: interface templates.**
  `interface BookStore extends Store<{"edition.{isbn}": Edition}> {}` and
  `interface RelayEngine extends Engine<LibraryEvents, RelayCommands, RelayStore> {}`.
  Quoted property names carry key templates directly, deps are a tuple template param
  (`Store<Spec, Deps = []>` — templates have no varargs), and interfaces don't pollute the
  data-type space.  Lowering discovers them via `sourceInterfaces` + `templateMapper.args`
  (unwrapping `Indeterminate` entities — model expressions and tuple literals arrive as
  type-or-value).
- **Queries are interfaces too**: `interface AdminQueries extends Queries { allPatrons(): AdminPatronInfo[]; }`
  declares a typed query contract — a message contract only, binding no store (which store backs
  an implementation is the implementation's business).  Lowering collects them as `PQueries`
  (one `PQuery` per op: name, args, result) on `LoweredProgram.queries` for the emitters to walk.
  The TS emitter generates the full query API from them: wire tuples, checkers/decoders, the
  `QueryDefs`/`Local*`/`Remote*`/`dispatch*` family.
- **Commands stay a union** (`Engine<Events, Commands, Store>`).  Someday: allow a
  null/omitted Commands argument, with commands declared as ops in the engine interface body
  instead — the endgame where the command union is *derived* from the interface:
  `interface UserEngine extends Engine<LibraryEvents, UserStore> { tryHold(cmd: TryHold): NewVHold | VHoldRejected; ... }`
  The op return type declares the command→event correlation that today lives only in decider code
  and forecasters.
- **`op` is reserved for that commands-as-operations future.**  Do not spend it as a generic
  `X = f(args)` binder for stores/engines (it works — `op X is store<...>` — but collides with
  the higher-value meaning).
- **Constraint validation (`@minLength`, `@pattern`, ...): decided, not implemented.**  The
  emitters currently ignore the constraint decorators entirely; the generated checkers verify
  structure only.  The decided placement, when implemented: JS-only, enforced at relay command
  ingress — morally json-schema-at-the-API-edge.  Not at store-write time (too late: the event
  is already durable).  Constraints are write-time ingress policy, not read-time type invariants
  (other writers like populate.py bypass the relay; history doesn't re-validate).  Keeping them out
  of decode/IR means they never affect type identity/interning, and the `@pattern` cross-runtime
  regex-dialect problem disappears (JS is the only dialect).  TypeSpec's std constraint decorators +
  compiler accessor functions (`getMinLength` etc.) mean no new vocabulary is needed.
- **Serde is one-directional: emitters generate decoders only.**  Per-type generated code exists
  for the decode direction (plain proto JSON → runtime values: `decode*` in TS, `to*` converters
  in Go).  The encode direction is schema-free — the TS skeleton's `encodeProto` (or
  `protoStringify` when serializing) structurally encodes any runtime value back to plain proto.
  Never add generated per-type encoders; route all encoding through `encodeProto`.
- **API design principle:** emitters being easy to read and write outranks any shorthand
  inside the core.  When core ergonomics (e.g. TS parameter-property shorthand) conflict with clean
  names at emitter call sites (e.g. `solution.default` vs `solution.dflt`), the call site wins.
- **Skeletons:** each emitter ships its runtime skeleton as `assets/skeleton.{ts,py,go}` (in the
  package `files`) and prepends it by default; `$onEmit` resolves it via `import.meta.url`.  The
  `skeleton` option overrides with a project-root-relative path; there is no skeleton-less mode
  (generated code requires the skeleton).  The assets are the canonical copies of the runtime
  skeletons — edit them here.
- **Naming convention: `P` prefix (for PhaseLock) on IR model nouns** — PType and subclasses, PStore,
  PStoreItem, PEngine, plus PTypeRegistry (which creates PTypes).  Machinery stays unprefixed
  (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the ptypes.ts header.

## Behavior notes / gaps

- All three emitters generate the structural checkers (`checkUserCommands` etc.) the servers
  use (ts checkers target node-hosted servers); semantic validation (`validateUserCommands` in
  `examples/library/model/reducers.ts`) is hand-written and separate.
- The Go emitter names slice/record converters after their builtin item type by convention
  (`sliceOfString`); anonymous non-builtin converters get path-derived numbers.
- `$onValidate` (`engine/src/validate.ts`) runs `lowerProgram()` (store collisions, not-a-store,
  invalid template args, ...) plus a solver pass over every union, so "union without discriminator"
  is a targeted diagnostic rather than an emitter crash.  It skips validation when the program
  already has checker errors, and all engine diagnostics are severity error, so emit never runs on a
  broken model.  Editor support for the interface idiom is first-class: completion, go-to-def, and
  hover (with the doc comments) work inside template-arg model expressions, and `tsp format` is
  idempotent (rewrites quoted keys to backticked identifiers, explodes inline anonymous unions to
  multi-line).
- Scalars extending builtins lower to the plain builtin (use `alias` to name one).
- A *named* model used as a `Store` spec emits broken code (see BUGS.md); write store specs
  inline (`Store<{...}>`).
- An interface extending multiple `Store<...>` instantiations, or extending another store interface
  directly, is not handled (only the first direct `Store` instance is read).
