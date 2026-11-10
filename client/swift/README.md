# PhaseLock client for Swift

The Swift host of PhaseLock: the HTTP transport, sessions, msgpack, the
Swift walk of the generated type registry, and the host that runs the
Engine in the native host (`../native`) through its C ABI binding
(`native/`).  A SwiftPM package for iOS 17, macOS 14, and Linux; the
transport is Apple's, written for Apple's URLSession, and Linux builds the
rest.  The Swift emitter,
`@phaselock/typespec-swift`, generates a model's types over it.

    Sources/PhaseLock/
      Host.swift       EngineHost, the engine thread that owns the native
                       host, and HostedEngine
      LiveQuery.swift  a query's latest result as observable state, for a
                       UI
      Lifecycle.swift  what a host follows of its app: the background, the
                       foreground, and network changes
      Registry.swift   the walk of the generated node table
      Msgpack.swift    msgpack
      Wire.swift       the transport contract
      Http.swift       the transport over URLSession: logins, the stream,
                       backfills, sends
      PrivacyInfo.xcprivacy
                       the privacy manifest of the package and the native
                       library it links into an app, for Apple's platforms
    native/            the C ABI binding of ../native, its header and
                       module map, and build-xcframework.sh, which builds
                       it for Apple's platforms

The engine thread is a `Thread` of its own, with an 8 MiB stack under a
6 MiB JS limit, running posted work in order and the native host's one
timer.  Every call into the native host happens on it; async callers wait
on continuations, so nothing blocks the thread that calls.  The
connections' hooks queue, and each drain of the queue is one call, so the
Engine commits the frames that arrive together in one transaction.  The
query starts queue the same way, so the queries a screen starts together are
answered by the Engine's same run.  Swift holds ids, never JS values, and
every argument and answer is msgpack.

A UI reads queries through `LiveQuery`, an `@Observable` whose query starts
the first time its value is read and stops when it is let go of.  While the
app is in the background the host ejects every LiveQuery's query, keeping
its last result, and when the app returns it registers them again in one
request and reconnects every Engine; a change of network path ends each
Engine's connection and reconnects it.  A host opened with `followsApp`
false hears these only from the app's calls to `enterBackground`,
`enterForeground`, and `networkChanged`.

The transport reads every body as it arrives, through `bytes(for:)`, so a
backfill that stops reading stops its download until the Engine has
committed what it pushed.

## Build and test

Needs a Rust toolchain, a C compiler, and Swift 6.  On Linux the package
links the static library cargo builds:

    cd native && cargo build --release
    swift test

On a Mac it links `native/PhaseLockNative.xcframework`, which
`native/build-xcframework.sh` builds for iOS devices, the iOS simulator,
and macOS, from the Rust targets it names:

    native/build-xcframework.sh
    swift test

The library example's model package (`examples/library/model/LibraryModel`)
holds the tests that use generated code; on a Mac they include the
transport's, against the database's release binary (`make -C db`).
