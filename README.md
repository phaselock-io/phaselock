# PhaseLock: live apps that work offline

PhaseLock is a sync-first backend with generated, typed clients that work
offline.

Compared to a standard CRUD app, PhaseLockDB replaces both your database and
your REST API server.  The PhaseLock sync engine replaces your HTTP client and
enables offline mode, optimistic updates, and live sync.

## How does PhaseLock work?

In PhaseLock, your app populates its UI from a local client-side **store**.

When a user takes an action, it gets encoded as a **mutation** and sent to
PhaseLockDB.  You declare the types of mutations allowed in your system ahead of
time.

In the database, a **decider** function that you write receives that mutation
and updates the server-side store.  Changes made by the decider function are
captured in PhaseLockDB's **edit log**.

The PhaseLock sync engine streams edits from the log and applies them to your
client's store, updating your UI in real-time.

     _____________________________
    |          Frontend           |
    |  __________     __________  |
    | |          |   |          | |
    | |  Store   |-->|    UI    | |
    | |__________|   |__________| |
    |_____^________________|______|
          |                |
          | Edits          | Mutations
     _____|________________|______
    |     |   PhaseLockDB  |      |
    |     |           _____v____  |
    |     |          |          | |
    |     |          | Decider  | |
    |  ___|______    |__________| |
    | |          |         |      |
    | | Edit log |<--------|      |
    | |__________|    _____v____  |
    |                |          | |
    |                |   Store  | |
    |                |__________| |
    |_____________________________|

Next step: check out one of our [examples][examples].

## How is a PhaseLock app built?

You declare ahead of time, in TypeSpec:
- your store schema
- what mutations your clients will send
- what queries your clients will make

From those declarations, PhaseLock generates type signatures for everything you
need to implement:
- A decider function for each declared mutation.  These are basically your POST
  handlers: they take the mutation, check authorization, validate against
  current state, and finally make updates to state.
- A query function for each declared query.  These are like your GET handlers,
  but they run in the client against a local store, not the server.  They are
  functions with read-only access to the client's store, and PhaseLock
  automatically reruns them whenever the data changes so you get not one
  result, but a stream of live results that you can plug into your UI.
- Optionally: a predictor function for each declared mutation to enable
  optimistic updates.  Like a decider function, a predictor takes a mutation,
  checks current state, and makes updates to state.  Unlike a decider, this
  runs client-side and does not do authorization checks.  Typically the
  predictor is simply factored out of the decider, rather than requiring net
  new code.

Then PhaseLock provides:
- A live, sync-based UI.  PhaseLock captures the edits made by the decider
  functions and streams them to your clients.  The edits are applied to a
  client-side store, then queries are rerun, and the UI is updated to reflect
  fresh state.
- Zero-latency page loads.  PhaseLock queries run locally on your client so new
  pages load from disk, not across the network.
- Offline mode.  If you provided predictor functions, then your UI continues to
  work in read/write mode while offline.  User actions are encoded as mutations
  and stored in an outbox until resync, meanwhile predictor functions run
  locally to provide optimistic UI updates.
- Cross-platform support.  Non-TypeScript PhaseLock client libraries run your
  business logic unmodified in an embedded JavaScript engine, and generated
  query wrappers return their results in the host language representation.

## How do I start using PhaseLock?

PhaseLock is still in alpha, and docs are missing.

Your coding agent can help until our docs are ready.  Try:

- For Claude (as a plugin):

  ```
  /plugin marketplace add phaselock-io/phaselock
  /plugin install phaselock@phaselock
  ```

- For any agent (as a skill):
  ```
  npx skills add phaselock-io/phaselock
  ```

Then ask your agent: "How do I use PhaseLock to build \<describe your app\>?"

Also check out our [examples][examples], which demonstrate many of the core
capabilities.

Finally, skim through [skeleton.ts][skeleton-ts], the backbone of all of PhaseLock.

Open issues when you find them, and [send us a 'hello' email](mailto:hello@phaselock.io)!

## We're building a cloud!

Deploy a PhaseLock app with a single command.  [Sign up][mailing-list] for
development updates and to be the first to try it out.

[examples]: https://github.com/phaselock-io/phaselock/tree/master/examples
[mailing-list]: https://buttondown.com/phaselock
[skeleton-ts]: https://github.com/phaselock-io/phaselock/blob/master/typespec/ts/assets/skeleton.ts
