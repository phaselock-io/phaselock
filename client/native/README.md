# PhaseLock native host

The Rust crate every native client runs the Engine in: one QuickJS runtime
holding the skeleton's TypeScript Engine, as the model's native bundle builds
it, over LMDB stores.  A client, the host-language library around it
(`client/kotlin`, `client/swift`), reaches it through a thin binding that
only moves bytes: JNI for Kotlin (`client/kotlin/native`) and a C ABI for
Swift (`client/swift/native`).

    src/
      api.rs        the request protocol every binding serves
      host.rs       the QuickJS runtime, its natives, and its timers
      store.rs      the skeleton's store over LMDB
      registry.rs   the Registry the Engine converts through
      edits.rs      applying edits and snapshot pages to a store
      lmdb.rs       LMDB environments and transactions
    host.js         the JS half: the Engine's host globals, and the
                    Transport and Store that hand off to the client and Rust
    third_party/    LMDB, vendored by update.py
    tests/          the host driven directly, with no client

## Design

The host is sans-IO and never calls back into the client.  The protocol
(`api.rs`) is three calls: `open` loads a bundle, `call` runs one request,
and `close` frees the host.  Every argument and answer is msgpack, so no
platform string crosses a binding.  Each call answers with the events the
JS side raised meanwhile (connect, backfill, send, query results, engine
ended, log) and the delay until the next timer is due; the client acts on
the events and calls `pump` when the timer fires.  One thread, the client's
engine thread, makes every call.  The client holds ids, never JS values, so
no reference cycle crosses its collector and QuickJS's.

The connection hooks the client has queued travel in one `connHooks`
request, which settles once, so the frames that arrive together commit in
one store transaction.

Each Engine's store is an LMDB environment in a directory of its own, with
LMDB's lock file, so LMDB itself keeps one writer at a time and frees no page
a reader still uses.

## Build and test

Needs a Rust toolchain and a C compiler; the tests read the library
example's native development bundle (`pnpm bundle:native:dev` in
`examples/library/model`).

    cargo test --release
