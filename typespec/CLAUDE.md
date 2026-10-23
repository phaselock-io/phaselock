# TypeSpec DSL — design decisions

Context for working on the TypeSpec model tooling (`@phaselock/typespec-core` + the TypeScript
emitter; the Python and Go emitters are set aside until they are rewritten).  See README.md for
layout, build commands, and the test suite.

## Design decisions

- **Declaration style: interface templates.**
  `interface PatronSlice extends Slice<"patron:{patron}", {"patron": Patron}> {}`,
  `interface UserEngine extends Engine<[BookSlice, PatronSlice], UserMutations> {}`, and
  `interface LibraryDB extends Database<[UserEngine, AdminEngine], [LoginSlice], DbMutations> {}`.
  Quoted property names carry key templates directly, lists are tuple template params
  (templates have no varargs), and interfaces don't pollute the data-type space.  Lowering
  discovers them via `sourceInterfaces` + `templateMapper.args` (unwrapping `Indeterminate`
  entities — model expressions and tuple literals arrive as type-or-value).
- **Slice names and keys sort in tuple order.**  A template is a name, then optionally
  `:{param}` and `,{param}` for each further one (`chat:{org},{channel}`, `reply:{thread},{id}`,
  `meta`); a store key is `{slice}!{local key}`, its slice everything before the first `!`.
  Keys compare in code-point order, and each separator sorts below every character the
  parameter before it may hold (`,` below `-`, `!` below everything), so a walk visits a family's
  slices and a template's keys in the order of their parameters (`gen` before `gen-2`).  A slice
  selector picks out slices: an exact selector, a slice name, names one slice, and a prefix
  selector, `chat:*` or `chat:acme,*` (whole leading parameters only) or `*`, every slice under
  its text before the star.  The grantor returns selectors, a client's wants are selectors, and
  snapshots, tails, and backfills are fetched and keyed by one; a grantor terminates an exact
  selector, `name!`, so a bare name is malformed.
- **Mutations are models a mutations union lists.**  There is no decorator: a model is a mutation
  because an Engine's or a Database's mutations argument lists it, a named union of named models
  (nested unions flatten) or one named model; a Database's own mutations may also be an unnamed
  union.  `@online` marks a mutation, and the intake types (`NewPassword`, `MutationAuth`, ...)
  are vocabulary too, lowering by identity to `PIntake` and `PResult`.  A model is lowered as a
  mutation (`PMutation`) once, however many unions list it.
- **Every context is global, and typed per key template.**  Predictors, deciders, queries, the
  grantor, lookup, bootstrap, and plugin hooks all reach keys through accessors named for their
  key template's name (`txn.get.note(org, user, note)`), each taking its family's parameters and
  then its template's, checked by `$asSegment` and `$asSliceRest`.  A context with `get` also has
  `scan.X` for each key template with a parameter.  `scan.X(match?, { reverse?, keys? })` takes a
  match by parameter name (an exact value, checked as `get` checks it; a range; a prefix; or, left
  out, any value), walks in parameter order, and yields `[params, value]` with every parameter
  named, or the parameters alone with `keys: true`.  Beneath it is the one store scan, a
  `KeyPattern` each store walks natively as a skip scan, in batches resumed past a key; a query's
  read set holds each walk's pattern and the stretch of keys it covered, up to the last entry the
  query took.
- **Writes are accessors too.**  A write context, a predictor's or the database's, adds `set.X`,
  `del.X`, `update.X` (for values that change in place: structs, records, arrays, tuples), and
  `deleteSlice.F(...familyParams, { erase?: true })`, a group keyed by family that deletes one
  slice, and with `erase` also drops its history from the edit log.  Every write names a key whose
  slice fills its family's template; the database captures a decider's writes as the mutation's
  edits, and the Engine writes a prediction onto its overlay.
- **Queries are interfaces too**: `interface AdminQueries extends Queries { allPatrons(): AdminPatronInfo[]; }`
  declares a typed query contract — a message contract only, binding no store (which store backs
  an implementation is the implementation's business).  Lowering collects them as `PQueries`
  (one `PQuery` per op: name, args, result) on `LoweredProgram.queries` for the emitters to walk.
  The TS emitter generates the full query API from them: wire tuples, the
  `QueryDefs`/`Local*`/`Remote*`/`dispatch*` family, with the calls and results converted through
  the host's Registry under the wire type and the query id plus `#result`.
- **Constraint validation (`@minLength`, `@pattern`, ...): decided, not implemented.**  The
  emitters currently ignore the constraint decorators entirely; the registry walk checks
  structure only.  The decided placement, when implemented: JS-only, enforced at the database's
  mutation intake, before the decider — morally json-schema-at-the-API-edge.  Not at store-write
  time (too late: the decider has already run).  Constraints are write-time ingress policy, not
  read-time type invariants (a bootstrap or a plugin hook writes keys without intake, and stored
  state doesn't re-validate).  Keeping them out of decode/IR means they never affect type
  identity/interning, and the `@pattern` cross-runtime regex-dialect problem disappears (JS is the
  only dialect).  TypeSpec's std constraint decorators + compiler accessor functions (`getMinLength`
  etc.) mean no new vocabulary is needed.
- **Serde is one type registry as data, walked by an interpreter in every host.**  The TS emitter
  generates no per-type codec: it emits the model's types as a node table, with the union solver's
  decision tree inside each union node, and a `Schema` per engine and database naming the
  identities a Registry answers for and its mutations union (`{engine}Schema`,
  `{database}Schema`, each `{ nodes, ids, mutations }`).  A host converts by walking it, reading
  and writing, checked against the schema both ways: `client/ts`'s `buildRegistry` in JS,
  `db/walk.c` in C.  A new type kind is a new node kind, handled in every walker.
- **`skeleton.ts` has no library dependencies.**  It is pure logic: every codec, transport, and
  store with outside dependencies comes from the host (`client/ts`, `db/`), reaching the
  Engine through the `Registry`, `Transport`, and `Store` interfaces.  A session is opaque here:
  the host library that signed the user in owns its shape and refreshes it in place, and
  generated code only hands it back to the transport.  A user's model may bring in whatever it
  likes.
- **The type registry's identities and walk rules.**  A named type's identity is its name, an
  intake result's its vocabulary kind, an unnamed store value's `family/name` (`catalog/count`),
  a database's mutations union when it has no name `{Database}Mutation`, and a query's result its
  id plus `#result`.  The reserved identities `.json`, `.mutation`, `.edits`, and `.page` are the
  host's, with no node.  A walk rejects fields the schema does not name for a mutations identity
  and drops them for any other; it writes a struct's discriminator first, which the emitter names
  in its node, then declaration order, and a record's keys in insertion order; dates are the
  msgpack timestamp extension at millisecond precision; and its error is the first mismatch with
  its path (`$.items[2].added: expected a timestamp`).  Every read names its type through a typed
  accessor, and a scan's range lies within one key template, so stores keep applied values as
  bytes and decode them with the reader's type; a key from a newer vocabulary is inert bytes that
  nothing reads.  Clients check what they read too, since a client and the database can run
  different versions of the model.  A store call and a conversion take one representation each
  way as plain arguments (`JS`, `HOST`, `MSGPACK`); a caller wanting two asks twice.
- **Handler tables.**  User code is object literals typed by generated interfaces: one predictor
  per engine mutation that is not `@online` (`{Engine}Predictors`), and one decider per database
  mutation (`{Database}Deciders`), keyed by camelCased model name.  Every entry of both is
  required, so a missing or misspelled handler is a compile error; an Engine takes a
  `Partial<{Engine}Predictors>`, so an app that predicts only some mutations says so by typing
  its table `Partial`, and a mutation left out predicts nothing.  The generated wrapper dispatches
  by the union solver's decision tree.  Helpers are plain functions outside the table; middleware
  wraps a handler.  A function is named with the plain verb (`predict`, `decide`, `grant`), and
  its type with the agent noun (`Predictor`, `Decider`, `Grantor`).
- **Handler parameters.**  Predictors take `(txn, mutation, pending?)`, deciders
  `(auth, txn, mutation)`, and the grantor `(txn, principal)`; every context is named `txn`, and
  per-call data comes last.  The Engine passes `pending` as `true`, and a decider calling a
  predictor leaves it out; it is for marking what a prediction writes, and a predictor that
  branches on it otherwise makes prediction and decision diverge.  A predictor knows nothing about
  the sender, so it means the same thing on the client and inside the decider: a mutation states
  its targets and claimed author as fields (`TryHold.patron`), and the decider checks those claims
  against `auth`, usually before calling the engine's predictor for the same mutation with its
  own `txn`.
- **Rejection and authorization.**  A decider rejects by throwing `Reject(reason)`, whose reason
  goes to the client; any other throw is a bug, answered with a generic rejection, or in full by a
  dev bundle (the `Bundle`'s `dev`, the skeleton's `DEV`).  Authorization fails closed: each call
  gets a fresh `Auth` through `runDecider`, and a decider that returns without
  `auth.authorize(condition, reason?)` or `auth.authorizeAnyone()` is rejected, loudly in dev
  mode, naming the decider.  A decider returns nothing; an outcome someone must learn about,
  success or failure, is a key the decider writes on a synced slice.
- **Prepared fields.**  The intake types (`NewPassword`, `MutationAuth`, `CaptchaToken`,
  `IdentityProof`) are a closed vocabulary lowered by identity; each appears only as a top-level
  field of an `@online` mutation, and its result (`PasswordHash`, ...) is a plain alias of its
  shape that no mutation may carry.  A mutation with such a field gets `{Mutation}ForDecider`,
  with each field replaced by its result, which its decider receives.  No store value or query
  type holds an intake type anywhere inside it.  Outward-facing text says the database prepares
  the mutation for its decider; "intake" is an internal word.
- **A database's mutations can be posted outside any Engine.**  A database with mutations gets
  `post{Name}Mutation(transport, mutation, { session? })`, its name with a trailing `DB` or
  `Database` trimmed (`LibraryDB` gives `postLibraryMutation`), taking any of its mutations: an
  account's creation before anyone has signed in, or a script's.  Each mutation goes alone under
  a fresh id, numbered 1 in a series of its own, so the transport may retry it, as a session or
  as anonymous.  The Engine and the post share the skeleton's registry cache, one Registry per
  transport and schema.
- **`@online` routing.**  The generated engine takes `@online` mutations through
  `sendOnlineMutation` and every other mutation through `sendMutation`, and passing one to the
  other is a compile error.  An online mutation is a web form: sent once, behind every mutation
  submitted before it, and never persisted, predicted, or resent.  Its promise settles on a reject
  or conflict at once, and on an ack at the round trip, like an outbox mutation's release.
- **Slice declarations are family templates, which only generated code holds.**  Generated
  accessors build each slice name from its family template and check every parameter, and the
  database checks a slice name by its syntax alone, the shape every generated name has: a written
  key's slice, a deleted slice, the grantor's selectors, and the slices a mutation's `expect`
  names.  A well-formed name in a family no slice type declares, or with too few or too many
  parameters, is a mistake typed code cannot make; in a hand-written grant selector it names no
  slice that exists, so it grants less, never more.  Typed grant builders (V0-DEBT.md) will check
  family and arity at compile time.  The generated Engine subclass hands the Engine only the
  selectors it wants, inline, one per slice type: `family:*`, or the bare family for a slice type
  without parameters (`wants: ["catalog", "patron:*"]`).  A prediction writes through generated
  accessors, and the Engine discards it after the round trip.  Key templates stay in generated
  code too: its accessors build well-formed keys, and a raw write to a key that no key template
  names lands as inert bytes under a well-formed slice name.
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
- **Generated contexts are object types, built from per-slice fragments.**  A database's context
  must pass where one of its engines' predict contexts is wanted, write accessors included, since
  a decider is usually an authorization check plus a call to the engine's predictor for the same
  mutation over its own `txn`.  So every context of an engine or a database is assembled from the
  same per-slice fragment functions (`{slice}Get`, `{slice}Scan`, `{slice}Set`, `{slice}Del`,
  `{slice}Update`, `{slice}DeleteSlice`), a database's over more slices, and TypeScript compares
  them structurally; contexts stay object types, never classes, since classes with private
  fields compare nominally.  The types are `{X}ReadTxn` (get and scan), `{Engine}Txn` (the
  predict context: reads and writes), `{Engine}QueryTxn` (reads and the Engine's status), and
  `{Database}Txn<P>` (reads, writes, and plugin APIs); every one passes as its `ReadTxn`, and a
  predict context holds nothing client-only.  `tests/src/ts/model.test.ts`'s `contexts` and
  `deciders` snippets hold the emitter to it.
- **Generated contexts are singletons, bound by assignment.**  Every context is built once,
  never per call: `create{Context}()` answers `{ ctx, $ref }`, where `$ref` is `{ txn }`, the one
  box every accessor reads the raw transaction through, and binding is `$ref.txn = txn`.  The
  fragments take the box as `$ref`, a name no template parameter can take, since a parameter
  holds no `$`.  The Engine takes the pairs for its queries and its predictions, and rebinds
  them for every store transaction it runs them over.  `define{Database}` builds two contexts and
  the plugins once and exposes binding as the `Bundle`'s hooks: `bindWrite(txn)` binds the write
  context of the deciders, bootstrap, and plugin runs, and every plugin, and `bindRead(txn)` the
  one read context grant and lookup share, over `readOnlyTxn`, whose writes throw a message
  naming no slot.  The entry points take no transaction (`decide(data, principal)`,
  `grant(principal)`, `lookup(ident)`, `bootstrap(ctx)`, a plugin's `run(mutation)`), and the
  database binds once, at load, since its transaction objects are singletons.  Building a context
  costs about 650 ns per accessor in QuickJS, so a per-call build grows with the model; a scan
  reads the box when it is called and keeps that transaction for its walk.
- **A database takes a plugin set**, a TypeScript type the app names once (`type MyPlugins = {
  email: EmailPlugin }`), as the parameter `P` of `{Database}Txn<P>`, `{Database}Deciders<P>`,
  `{Database}Slots<P>`, and `define{Database}<P>`, all defaulting to none.  The txn of deciders,
  bootstrap, and plugin hooks is the database context plus each plugin's request API under its
  name; the grantor's and lookup's is typed `{Database}ReadTxn`.  `{Database}Types<P>` is
  `{ txn }`, which an installed plugin's marker (`DbMarker`) names bare so that `install` infers
  it from the plugins slot (`PluginSlots`), which holds exactly the set's plugins.  The set lists
  installs (`PluginInstall`, `{ kind, create(name, ctx) }`), which `define{Database}` turns into
  plugins (`Plugin`, `{ name, api, config?, bind, run? }`) eagerly, over its context and under
  names that are JS identifiers without `$` and never `get`, `scan`, `set`, `del`, `update`,
  `deleteSlice`, `status`, or `__proto__`.  `installPlugins(ctx, installs)` attaches every
  plugin's API to the write context, hands it that context, and answers the plugins with one
  binder for them all, which `bindWrite` calls; `Plugin.bind(txn)` points a plugin's own contexts
  at the transaction.  The `Bundle` holds each plugin as a host calls it (`BundlePlugin`,
  `{ kind, config?, run? }`, a built-in's `config` being what the host reads of it, and
  `run(mutation)` handing the plugin its mutation over the bound transaction).  A plugin request
  is a write to the plugin's own slice, committed with the rest of the transaction.  The app's
  emitter knows no plugin: a plugin's types come from its own package.
- **A plugin calls the app's hooks through its own context**, as the app makes requests through
  its own.  Each hook is a field of the plugin's context whose wrapper calls the app's hook over
  the database context the plugin was created with, and the hook writes through that context, so
  only those wrappers hold the app's context.  A plugin's `run` handles one of its own mutations
  and calls any of its hooks, any number of times; hook names share the plugin's context with its
  own fields, so `get`, `scan`, `set`, and the like are reserved there.  A hook that throws is a
  bug, which drops its mutation's whole transaction.  The plugin emitter that will generate the
  wrappers is not written; a hand-written plugin writes its own.
- **Generated names keep the declaration's name whole, for now.**  `PatronSlice` gives the
  fragments `patronSliceGet` and the rest; `UserEngine` gives
  `UserEngineReadTxn`, `UserEngineTxn`, `UserEngineQueryTxn`, `UserEnginePredictors`,
  `userEnginePredictor`, `userEngineSchema`, and the `UserEngine` class; `LibraryDB` gives
  `LibraryDBReadTxn`, `LibraryDBTxn`, `LibraryDBTypes`, `LibraryDBGrantor`, `LibraryDBDeciders`,
  `LibraryDBSlots`, `libraryDBSchema`, and `defineLibraryDB`.  Handler tables are keyed by their
  mutation model names, camelCased.  TypeSpec keeps interface names unique against every model,
  so these never collide; stripping the suffix would (`AdminSlice` and `AdminEngine`).
- **Naming convention: `P` prefix (for PhaseLock) on IR model nouns** — PType and subclasses,
  PSlice, PStore, PStoreItem, PMutation, PEngine, PDatabase, plus PTypeRegistry (which creates
  PTypes).  Machinery stays unprefixed
  (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the ptypes.ts header.

## Behavior notes / gaps

- Structural checking is the registry walk's: a mutation is checked against the mutations union
  by the database before anything else happens to it, and by a client when it encodes one.
  Semantic validation is the decider's.
- The Go emitter names slice/record converters after their builtin item type by convention
  (`sliceOfString`); anonymous non-builtin converters get path-derived numbers.
- `$onValidate` (`core/src/validate.ts`) runs `lowerProgram()` (store collisions, invalid
  families and template args, mutations that are not named models, ...), then the checks only the
  whole program shows (key and family collisions per engine and database, intake placement,
  `@online` on a model no union lists), plus a solver pass over every union, so "union without
  discriminator" is a targeted diagnostic rather than an emitter crash.  It skips validation when
  the program already has checker errors.  Every core diagnostic is an error except the warnings
  `unreachable-slice` and `unreachable-mutation` (a slice or mutation no database holds) and
  `online-not-mutation`, so emit never runs on a broken model.  Editor support for the interface
  idiom is first-class: completion, go-to-def, and hover (with the doc comments) work inside
  template-arg model expressions, and `tsp format` is idempotent (rewrites quoted keys to
  backticked identifiers, explodes inline anonymous unions to multi-line).
- Scalars extending builtins lower to the plain builtin (use `alias` to name one), except the
  vocabulary's intake scalars, which lower by identity.
- A union of one member lowers to that member, so a one-member mutations union collides by name
  with its only member (`duplicate-name`); name the model itself as the mutations argument.
- An intake type's vocabulary name is its kind in the schema, and the database matches kinds by
  name (`INTAKE_KINDS` in `db/walk.c`), so renaming an intake type changes the database too.
- An interface extending several vocabulary instantiations, or extending a slice or engine
  interface directly, is not handled (only the first direct instance is read).
