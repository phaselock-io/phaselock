# Defining a data model

A PhaseLock app's data model is one TypeSpec file (conventionally
`model/model.tsp`) describing domain types, events, commands, store
layouts, engines, and (optionally) queries. Emitters generate typed code
for each target language.

Every model file starts:

```typespec
import "@phaselock/typespec-core";

using PhaseLock;
```

## Type primitives

| concept | TypeSpec |
|---------|----------|
| scalars | `string`, `int32`, `boolean`, `null` |
| literal | `"add-book"`, `true`, `1` |
| optional field | `expires?: utcDateTime` |
| array | `string[]` |
| map | `Record<T>` |
| tuple | `[string, utcDateTime]` |
| struct | `model X { a: string; b?: int32; }` |
| union | `union X { A, B }` or inline `A \| B` |
| date | `utcDateTime` |
| alias | `alias Uuid = string;` |
| store layout | `interface S extends Store<{...}> {}` |
| engine | `interface E extends Engine<Events, Commands, S> {}` |
| query contract | `interface Q extends Queries { ... }` |

`utcDateTime` maps to `Date` (TS), `datetime.datetime` (Python, UTC only),
and `time.Time` (Go). On the wire it is an ISO 8601 string.

Known gap (alpha): aliases have rough edges in code generation. Simple
scalar aliases like `alias Uuid = string;` work (the examples use them);
avoid aliasing complex types until ROADMAP's alias support lands.

## Events and commands

Events are models in a discriminated union. The `type` field, a string
literal, is the discriminator, and doubles as the reader-facing name of
the fact:

```typespec
model NewItem {
  type: "new-item";
  id: Uuid;
  list: Uuid;
  text: string;
}

model MarkItem {
  type: "mark-item";
  id: Uuid;
  done: boolean;
}

union TodoEvents {
  NewItem,
  MarkItem,
}
```

Unions compose by naming other unions as members (they flatten):

```typespec
union LibraryEvents {
  BookEvents,
  PatronEvents,
  StatusEvents,
  DeciderEvents,
}
```

Unions of string or int literals work directly
(`union Role { "admin", "patron" }`).  Struct members within a union should
use a shared discriminator field (like `type`).  "one-of" unions are also
possible as a special case, where each member of the union is a struct with
a single, distinct key.  The generator reports an error if the union solver
is not able to generate correct runtime discrimination logic.

Commands are declared the same way — a union of models.  In demo code,
the command union is the event union (what the client submits is
what gets stored), but in production the types are frequently different,
both because of authority (client can read events from the whole system but is
only authorized a subset of those as commands), and because of server-side
content augmentation (server may fill default fields or add fields when
generating an event from a command).

Example, illustrating authority-related narrowing:

```typespec
union UserCommands {
  RenamePatron,
  TryHold,
  CancelHold,
}
```

Naming conventions that pay off: `try-*` for commands whose acceptance is
decided later (races possible), plain verbs for commands that are stored
as-is.  Where commands differ by content, naming commands according to what
they are and events according to what happened can add clarity (e.g. `TryHold`
command to request a hold on a book and `TriedHold` for the event derived from
the command).

## Stores

A `Store` declares a key-value layout. Property names are key templates;
each `{param}` becomes a typed accessor parameter, and the template's
first segment (before the first `.`) names the accessor:

```typespec
interface TodoStore extends Store<{
  "all_lists": Uuid[];
  "list.{list_id}": List;
  "item.{item_id}": Item;
}> {}
```

This generates typed contexts with, e.g., `rx.get.list(id)`,
`rx.set.item(id, value)`, `qx.get.all_lists()`.

Write store specs inline as shown. Known gap: passing a named model as the
`Store` spec generates broken code — always use the inline `{...}` form.

Stores compose through a second parameter, a tuple of stores whose items
are all included. A reducer written against a dependency store also works
against any store that includes it:

```typespec
interface DeciderStore extends Store<{
  "decider_events": DeciderEvents[];
}, [BookStore, PatronStore, StatusStore]> {}
```

### Public, sharded, virtualized

Backend data falls into three visibility categories, decided per data
domain. One app usually mixes all three — the library example does;
its domain is described in `examples.md`:

- **Public**: frontend and backend hold the same data under the same
  Store definition. Same reducers everywhere, events broadcast to all.
  (Library: books.)
- **Sharded**: same Store definition and reducers, but each client's
  store is populated sparsely — it only receives the slice it is
  entitled to (per-owner streams, routed by the server). Reducers and
  queries must tolerate absent entries. (Library: patrons.)
- **Virtualized**: the frontend sees a different shape — its own Store
  definition and its own reducers, fed by rewritten events and usually
  decision events, because a client without the full picture cannot
  judge outcomes itself. (Library: status — `Hold` backend-side, `VHold`
  client-side.)

The categories compose at field grain too: the library's `VHold.patron?`
is present for the owner and stripped for everyone else — a field-level
shard inside a virtualized shape.

This taxonomy is why stores compose: components share the public and
sharded store definitions verbatim and plug in different virtualized
definitions. The library's client store is that assembly — public +
sharded + its own virtualized view:

```typespec
interface UserStore extends Store<{
  "messages": string[];
}, [BookStore, PatronStore, VStatusStore]> {}
```

Design rule: keep virtualized shapes as close to the real shapes as the
sanitization allows (same key templates, same field names, differing
only where data is withheld). Virtualization is what costs you
customized reducers; shared shapes let most reducers be written once
against the common subset (see `reducers.md` on `NoSet`), shrinking the
blast radius to the code that constructs the differing objects.

A component can also have a store shaped like none of the above: a
server doing reference validation may track bare existence
(`"book.{book_uuid}": true`). Declaring many small stores is normal and
cheap.

Modeling collections: there are no ordered indexes yet (see ROADMAP).
The working pattern is one key per entity plus a set-of-ids key
(`Record<true>;` gives `{"<id>": true}` sets), or an ordered `Uuid[]` when
insertion order is the order you want. A key whose value holds a very large,
frequently-changing collection must be small enough to fit in memory and
will be rewritten wholesale on every change.  This is a known limitation and
the reason for indexes in the roadmap.

## Engines

An `Engine` (short for "SyncEngine") will generate a typed sync engine in code.
It is defined by what a component consumes (events), what it may submit
(commands), and what state it keeps (a store):

```typespec
interface MyEngine extends Engine<MyEvents, MyCommands, MyStore> {}
```

Declare one engine per system component; they can share unions and
stores:

```typespec
interface UserEngine extends Engine<LibraryEvents, UserCommands, UserStore> {}
interface AdminEngine extends Engine<LibraryEvents, AdminCommands, AdminStore> {}
interface DeciderEngine extends Engine<LibraryEvents, DeciderEvents, DeciderStore> {}
```

## Queries (server-defined)

A `Queries` interface declares a typed query contract — names, argument
types, result types:

```typespec
model ListViewData {
  id: string;
  name: string;
  items: ItemViewData[];
}

interface TodoQueries extends Queries {
  allLists(): ListViewData[];
}
```

Arguments and results are ordinary data types; for server-side use they
cross the wire, so generation produces checkers and decoders alongside the
typed interfaces. See `queries.md` for the generated API and wiring.

## Wrapper types

Generated code wraps payloads in metadata:

- `Identified<T> = { id: string, data: T }` — anything with an assigned
  id: a command being sent, a forecast.
- `Committed<T> = Identified<T> & { position: number }` — an event that
  went through the log; `position` is its commit position.

You define only the inner `data` types in TypeSpec.  Commands sent through
`Engine.sendCommand()` are automatically wrapped in `Identified` so
the server can discard retries after reconnects.  `Committed` is the shape
that comes out of KurrentDB.

## Validation constraints

TypeSpec's standard constraint decorators (`@minLength`, `@maxLength`,
`@pattern`, ...) compile but are currently ignored by the emitters — the
generated checkers verify structure only. Enforce value constraints in
the server's semantic validation (see `server.md`), where write-time
policy belongs. History is never re-validated, so every backend
component that writes to the DB should do its own validation.

## Code generation

The model package's `package.json` depends on the vocabulary and the
emitters for the languages you target:

```json
{
  "devDependencies": {
    "@phaselock/typespec-core": "...",
    "@phaselock/typespec-ts": "...",
    "@typespec/compiler": "^1.0.0"
  },
  "scripts": { "gen": "tsp compile model.tsp" }
}
```

`tspconfig.yaml` declares which emitters run and where output lands:

```yaml
emit:
  - "@phaselock/typespec-ts"
options:
  "@phaselock/typespec-ts":
    emitter-output-dir: "{project-root}"
    out-file: "model.gen.ts"
```

Python (`out-file: model.py`) and Go (`package: model`,
`out-file: model.go`) emitters are configured the same way, usually
emitting directly into the consuming component's directory. Both are
proof-of-concept and not published as packages — they are available only
in source form from the PhaseLock repository; see `py.md` and `go.md`
for status.

Each emitter prepends its runtime skeleton (the engine, store, and query
machinery) to the generated model code, so the output file is
self-contained. Generated files are never hand-edited; change the `.tsp`
and rerun `pnpm gen`.

What each emitter produces:

| Emitter | Output | Contains |
|---------|--------|----------|
| `-ts` | `model.gen.ts` | types, `Decode*`, `check*`, typed RX/QX contexts, `<Name>Engine` classes, `<Name>ReducerTester`, query APIs |
| `-py` | `model.py` | typed dicts, `check*`, query contexts, `<Name>Engine` wrapper over QuickJS |
| `-go` | `model.go` | Go types, converters, `Check*`, typed query contexts, `New<Name>Engine` over goja |

Serde is one-directional: only *decoders* are generated per type (plain
JSON → runtime values, e.g. TypeScript's `decode*`). There are no
`Encode<Name>` functions — the encode direction is schema-free. Use
`encodeProto` to turn any runtime value (`Date`, `Map`, `Set` included)
back into plain JSON, or `protoStringify` to serialize it to a string
directly.
