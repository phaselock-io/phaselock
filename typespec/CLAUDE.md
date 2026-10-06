# TypeSpec DSL — design decisions

Context for working on the TypeSpec model tooling (`@phaselock/typespec-core` + the TypeScript
emitter; the Python and Go emitters are set aside until they are rewritten).  See README.md for
layout, build commands, and the test suite.

## Design decisions

- **Declaration style: interface templates.**
  `interface PatronSlice extends Slice<"patron:{patron}", PatronEvents, {"patron": Patron}> {}`,
  `interface UserEngine extends Engine<[BookSlice, PatronSlice], UserCommands> {}`, and
  `interface LibraryDB extends Database<[UserEngine, AdminEngine], [LoginSlice], DbCommands> {}`.
  Quoted property names carry key templates directly, lists are tuple template params
  (templates have no varargs), and interfaces don't pollute the data-type space.  Lowering
  discovers them via `sourceInterfaces` + `templateMapper.args` (unwrapping `Indeterminate`
  entities — model expressions and tuple literals arrive as type-or-value).
- **Stream names and keys sort in tuple order.**  A template is a name, then optionally
  `:{param}` and `,{param}` for each further one (`chat:{org},{channel}`, `reply:{thread},{id}`,
  `meta`); a store key is `{stream}!{local key}`, its stream everything before the first `!`.
  Keys compare in code-point order, and each separator sorts below every character the
  parameter before it may hold (`,` below `-`, `!` below everything), so a walk visits a family's
  streams and a template's keys in the order of their parameters (`gen` before `gen-2`).  Wire
  refs are a stream name, `chat:*` or `chat:acme,*` (whole leading parameters only), or `*`;
  maySee returns them with an exact stream terminated, `name!`, so a bare name is malformed.
- **Queries are interfaces too**: `interface AdminQueries extends Queries { allPatrons(): AdminPatronInfo[]; }`
  declares a typed query contract — a message contract only, binding no store (which store backs
  an implementation is the implementation's business).  Lowering collects them as `PQueries`
  (one `PQuery` per op: name, args, result) on `LoweredProgram.queries` for the emitters to walk.
  The TS emitter generates the full query API from them: wire tuples, the
  `QueryDefs`/`Local*`/`Remote*`/`dispatch*` family, with the calls and results converted through
  the host's Registry under the wire type and the query id plus `#result`.
- **Commands are models carrying `@command(output)`**, where the output is the precommit
  handler's return type (see `@command` outputs below); an engine's commands are a named union of
  them, or one.  `@online` and `Death` are vocabulary too, and so are the intake types
  (`NewPassword`, `CommandAuth`, ...), which lower by identity to `PIntake` and `PResult`.
- **Constraint validation (`@minLength`, `@pattern`, ...): decided, not implemented.**  The
  emitters currently ignore the constraint decorators entirely; the registry walk checks
  structure only.  The decided placement, when implemented: JS-only, enforced at relay command
  ingress — morally json-schema-at-the-API-edge.  Not at store-write time (too late: the event
  is already durable).  Constraints are write-time ingress policy, not read-time type invariants
  (other writers like populate.py bypass the relay; history doesn't re-validate).  Keeping them out
  of decode/IR means they never affect type identity/interning, and the `@pattern` cross-runtime
  regex-dialect problem disappears (JS is the only dialect).  TypeSpec's std constraint decorators +
  compiler accessor functions (`getMinLength` etc.) mean no new vocabulary is needed.
- **Serde is one type registry as data, walked by an interpreter in every host.**  The TS emitter
  generates no per-type codec: it emits the model's types as a node table, with the union solver's
  decision tree inside each union node, and a `Schema` per engine and database naming the
  identities a Registry answers for (`{engine}Schema`, `{database}Schema`).  A host converts by
  walking it, reading and writing, checked against the schema both ways: `client/ts`'s
  `buildRegistry` in JS, `db/core/walk.c` in C.  A new type kind is a new node kind, handled in
  every walker.
- **`skeleton.ts` has no library dependencies.**  It is pure logic: every codec, transport, and
  store with outside dependencies comes from the host (`client/ts`, `db/core`), reaching the
  Engine through the `Registry`, `ConnectorFactory`, and `Store` interfaces.  A user's model may
  bring in whatever it likes.
- **The type registry's identities and walk rules.**  A named type's identity is its name, an
  intake result's its vocabulary kind, an unnamed store value's `family/name` (`catalog/count`),
  a database's command union when it has no name `{Database}Command`, and a query's result its
  id plus `#result`.  A walk rejects fields the schema does not name for a commands identity and
  drops them for any other; it writes a struct's discriminator first, which the emitter names in
  its node, then declaration order, and a record's keys in insertion order; dates are the
  msgpack timestamp extension at millisecond precision; and its error is the first mismatch with
  its path (`$.items[2].added: expected a timestamp`).  Clients check what they read too, since a
  client and the database can run different versions of the model.  Every store call names its type,
  and a scan's range lies within one key template; the two key-derived paths are a backfill
  blob's values (`storeTypes`) and an event's data (its family, through `eventTypes`).  A store
  call and a conversion take one representation each way as plain arguments (`JS`, `HOST`,
  `MSGPACK`); a caller wanting two asks twice.
- **Handler tables.**  User code is object literals typed by generated interfaces: one reducer
  handler per event of a slice (`{Slice}Reducers`), one forecaster per engine command
  (`{Engine}Forecasters`, entries optional), one precommit handler per database command
  (`{Database}Precommit`, all required), keyed by camelCased model name, so a missing or
  misspelled handler is a compile error.  The generated wrapper dispatches by the union solver's
  decision tree.  Helpers are plain functions outside the table; middleware wraps a handler.
- **Handler parameters.**  Reducer handlers take `(txn, event, pending)`, forecasters
  `(txn, cmd)`, precommit `(auth, txn, cmd)`; every context is named `txn`, and per-call data
  comes last.  A forecaster knows nothing about the sender, so it means the same thing on the
  client and inside precommit: a command states its targets and claimed author as fields
  (`TryHold.patron`), and precommit checks those claims against `auth`, usually before calling
  the engine's forecaster for the same command.
- **Rejection and authorization.**  A handler rejects by throwing `Reject(reason)`, whose reason
  goes to the client; any other throw is a bug, answered with a generic rejection, or in full by a
  dev bundle (the `Bundle`'s `dev`, the skeleton's `DEV`).  Authorization fails closed: each call
  gets a fresh `Auth`, and a handler that returns without `auth.authorize(condition, reason?)` or
  `auth.authorizeAnyone()` is rejected, loudly in dev mode, naming the handler.  An outcome
  someone must learn about, success or failure, is a modeled event on a synced slice, named in the
  command's `@command`.
- **`@command` outputs.**  The argument is the precommit handler's return type, taken
  literally, generated as `{Command}Output`: each event wrapped as `{stream, event}` with the
  stream of a slice that folds it (a singleton slice's label is its literal family name; an event
  several slices fold may go to any of their streams), unions as alternatives, tuples and arrays
  as lists, and `{stream, death: true}` to end a stream.  A passthrough names its own type.
- **Prepared fields.**  The intake types (`NewPassword`, `CommandAuth`, `CaptchaToken`,
  `IdentityProof`) are a closed vocabulary lowered by identity; each appears only as a top-level
  field of an `@online` command, and its result (`PasswordHash`, ...) is a plain alias of its
  shape that no command may carry.  A command with such a field gets `{Command}ForPrecommit`,
  with each field replaced by its result.  Outward-facing text says the database prepares the
  command for precommit; "intake" is an internal word.
- **`@online` routing.**  The generated engine takes `@online` commands through
  `sendOnlineCommand` and every other command through `sendCommand`, and passing one to the
  other is a compile error.  An online command is a web form: sent once, behind every command
  submitted before it, and never persisted, forecast, or resent.  Its promise settles on a reject
  or conflict at once, and on an ack at the round trip, like an outbox command's release.
- **Missing versus null.**  A get answers `undefined` for a missing key and `null` for a stored
  `null`, in every context and every language; a host whose language has one null needs a
  separate marker for missing.
- **API design principle:** emitters being easy to read and write outranks any shorthand
  inside the core.  When core ergonomics (e.g. TS parameter-property shorthand) conflict with clean
  names at emitter call sites (e.g. `solution.default` vs `solution.dflt`), the call site wins.
- **Skeletons:** each emitter ships its runtime skeleton as `assets/skeleton.{ts,py,go}` (in the
  package `files`) and prepends it by default; `$onEmit` resolves it via `import.meta.url`.  The
  `skeleton` option overrides with a project-root-relative path; there is no skeleton-less mode
  (generated code requires the skeleton).  The assets are the canonical copies of the runtime
  skeletons — edit them here.
- **Generated contexts are object types, never classes.**  A database's read context must pass
  where one of its engines' contexts is wanted, since a precommit handler is usually an
  authorization check plus a call to the engine's forecaster for the same command.  TypeScript
  compares classes with private fields nominally, so `{Engine}Txn` and `{Database}Txn` stay object
  types; `tests/src/ts/model.test.ts`'s `contexts` and `precommit` snippets hold the emitter to it.
- **Generated names keep the declaration's name whole, for now.**  `PatronSlice` gives
  `PatronSliceTxn`, `PatronSliceReducers`, and `patronSliceReducer`; `UserEngine` gives
  `UserEngineTxn`, `UserEngineForecasters`, and the `UserEngine` class; `LibraryDB` gives
  `LibraryDBTxn`, `LibraryDBPrecommit`, and `defineLibraryDB`.  Handler tables are keyed by their
  event or command model names, camelCased.  TypeSpec keeps interface names unique against every
  model, so these never collide; stripping the suffix would (`AdminSlice` and `AdminEngine`).
- **Naming convention: `P` prefix (for PhaseLock) on IR model nouns** — PType and subclasses,
  PSlice, PStore, PStoreItem, PCommand, PEngine, PDatabase, plus PTypeRegistry (which creates
  PTypes).  Machinery stays unprefixed
  (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the ptypes.ts header.

## Behavior notes / gaps

- Structural checking is the registry walk's: a command is checked against the commands union
  by the database before anything else happens to it, and by a client when it encodes one.
  Semantic validation is precommit's.
- The Go emitter names slice/record converters after their builtin item type by convention
  (`sliceOfString`); anonymous non-builtin converters get path-derived numbers.
- `$onValidate` (`core/src/validate.ts`) runs `lowerProgram()` (store collisions, invalid
  families and template args, commands without `@command`, ...), then the checks only the whole
  program shows (key and family collisions per engine and database, intake placement, outputs
  outside a database), plus a solver pass over every union, so "union without discriminator" is a
  targeted diagnostic rather than an emitter crash.  It skips validation when the program already
  has checker errors.  Every core diagnostic is an error except the two reachability warnings (a
  slice or command no database holds), so emit never runs on a broken model.  Editor support
  for the interface idiom is first-class: completion, go-to-def, and hover (with the doc comments)
  work inside template-arg model expressions, and `tsp format` is idempotent (rewrites quoted keys
  to backticked identifiers, explodes inline anonymous unions to multi-line).
- Scalars extending builtins lower to the plain builtin (use `alias` to name one), except the
  vocabulary's intake scalars, which lower by identity.
- A union of one member lowers to that member, so a one-event slice's events union collides by
  name with its only event (`duplicate-name`).
- An interface extending several vocabulary instantiations, or extending a slice or engine
  interface directly, is not handled (only the first direct instance is read).
