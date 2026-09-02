# The worked examples

The other reference files use symbols from two example apps in the
PhaseLock repository (github.com/phaselock-io/phaselock, under
`examples/`). This file gives enough context to follow those symbols
without the repository.

## todo (todo-basic and todo-thin)

A collaborative todo app: shared lists of checkable items. The model is
`List {id, name, items, archived}` and `Item {id, text, done, archived}`;
the store is `all_lists`, `list.{list_id}`, `item.{item_id}`. The
commands are the events (`TodoEvents`: `new-list`, `rename-list`,
`archive-list`, `new-item`, `edit-item`, `mark-item`, `archive-item`) —
nothing needs judging, so what a client submits is what gets stored.

One engine, `TodoEngine`, with contexts `TodoRX`/`TodoQX` and reducers
`migrateTodos`/`reduceTodos`. todo-basic runs the engine in the browser
behind a minimal relay server; todo-thin runs the same UI against the
engine in the server, subscribing to `TodoQueries` (`allLists()`
returning `ListViewData[]`). The pair exists to show the same model and
UI under both client shapes.

## library

A public library ("a place to check out books"), chosen because its
domain has the three pressures that exercise PhaseLock's harder
features: scarcity (two patrons want the last copy), privilege (admins,
researchers, regular patrons), and privacy (patrons must not learn about
each other).

Domain rules: books belong to editions (by isbn). Patrons place holds on
a specific book or on any book of an edition, then check the book out at
the front desk (admin). Researchers may hold restricted books and
open-ended holds; regular patrons get neither and are capped at five
holds plus checkouts. Too many overdue checkouts blocks new holds.
Because copies are scarce, individually-valid holds race.

### Visibility mapping

- Books and editions: public. `BookStore` (`Edition`, `Book`) is shared
  by every component.
- Patrons: sharded. `PatronStore` (`Patron {id, name, researcher,
  holds, checkouts}`) has the same shape everywhere, but each client
  receives only its own patron; admins receive all.
- Status (holds and checkouts): virtualized. The backend `StatusStore`
  holds `Hold` and `Checkout` with full information; clients hold
  `VStatusStore` with sanitized `VHold`/`VCheckout` shapes (the `patron`
  field is present only for the owner; `forecasted?: true` marks a
  pending optimistic hold).

### The hold flow

1. A patron's client sends a `try-hold` command; its forecaster
   (`userForecaster`) predicts a `new-vhold` with `forecasted: true`, so
   the UI shows a pending hold immediately.
2. The relay (`RelayEngine`, Python) validates references and authority
   (`validateUserCommands`) against a minimal existence store, then
   appends to the log. It does not judge races.
3. The decider (`DeciderEngine`, Go, single runner) folds global state
   and judges each `try-hold`: accepted emits `new-vhold`, refused emits
   `vhold-rejected {reason}`. Later invalidation (book removed or
   restricted, patron demoted) emits `end-vhold`.
4. Clients reduce the decision events into their virtualized store. The
   owner's UI resolves the pending hold or shows the rejection reason;
   other patrons see the hold without knowing whose it is.

### Symbols

- Engines: `UserEngine` (patron client), `AdminEngine` (front desk),
  `RelayEngine` (server validation), `DeciderEngine`.
- Stores compose per audience: `UserStore` = BookStore + PatronStore +
  VStatusStore; `AdminStore` and `DeciderStore` = BookStore +
  PatronStore + StatusStore. Contexts are named after them (`BookRX`,
  `StatusRX`, `VStatusRX`, `UserRX`, ...).
- Events: `try-hold`, `cancel-hold`, `expire-hold`, `try-checkout`,
  `end-checkout`, `overdue-checkout`; decision events: `new-vhold`,
  `vhold-rejected`, `end-vhold`, `new-vcheckout`.
- Streams: `books`, `patron.{id}`, `status` (privileged), `vstatus`
  (decisions; sanitized per client by the relay).
- Reducers named in other files: `reduceTryHold` (judges and applies a
  hold, returns a rejection reason or empty string), `reduceNewVHold`
  (client-side creator of a `VHold`), `rebalanceEditionHolds` (shared
  mutator: ends excess edition-level holds when the pool of available
  unrestricted books shrinks).
