# PhaseLock client for Kotlin

The Kotlin host of PhaseLock: the HTTP transport, sessions, msgpack, the
Kotlin walk of the generated type registry, and the native host that runs
the Engine.  A plain JVM library, so an Android app and a JVM test use the
same jar.  The Kotlin emitter, `@phaselock/typespec-kt`, generates a
model's classes over it.

## Design

The Engine is the skeleton's own, in TypeScript, running in QuickJS: the
model's native bundle (`installEngines` in the skeleton) builds each Engine
with its predictors and the declared queries it serves.  Queries are written
in TypeScript too; Kotlin calls them by name and gets each result as a
`Flow` of the model's classes.

    src/main/kotlin/   the library
      Http.kt          the transport: logins, the stream, backfills, sends
      Host.kt          EngineHost, the engine thread that owns the native
                       host, and HostedEngine
      Registry.kt      the walk of the generated node table
      Msgpack.kt       msgpack, and reading values off a stream
    native/            the JNI binding of ../native, the native host shared
                       by every client

The native host is sans-IO.  One thread, the engine thread, calls into it;
each call answers with the events the JS side raised (connect, backfill,
send, query results) and when its next timer is due.  `EngineHost` acts on
the events, running the transport's work on the IO dispatcher and handing
its results back to the engine thread.  The connections' hooks queue, and
each drain of the queue is one call, so the Engine commits the frames that
arrive together in one transaction.  Kotlin holds ids, never JS values, and
no string crosses JNI: every argument and answer is msgpack.

## Build and test

Needs a Rust toolchain, a C compiler, JDK 21, and pnpm; the tests also need
the database's release binary (`make -C db`).

    ./gradlew test     build the native host for this machine, regenerate
                       the library example, and run the tests against the
                       database
    cd ../native && cargo test --release

An Android app builds the native host per ABI with cargo-ndk, as
`examples/library/android` does.
