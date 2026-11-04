# PhaseLock client for Swift

The Swift host of PhaseLock: msgpack, the Swift walk of the generated type
registry, sessions, and the host that runs the Engine in the native host
(`../native`) through its C ABI binding (`native/`).  A SwiftPM package for
iOS 17, macOS 14, and Linux.  The Swift emitter,
`@phaselock/typespec-swift`, generates a model's types over it.

    Sources/PhaseLock/
      Host.swift       EngineHost, the engine thread that owns the native
                       host, and HostedEngine
      Registry.swift   the walk of the generated node table
      Msgpack.swift    msgpack
      Wire.swift       the transport contract
    native/            the C ABI binding of ../native, and its header and
                       module map

The engine thread is a `Thread` of its own, with an 8 MiB stack under a
6 MiB JS limit, running posted work in order and the native host's one
timer.  Every call into the native host happens on it; async callers wait
on continuations, so nothing blocks the thread that calls.  The
connections' hooks queue, and each drain of the queue is one call, so the
Engine commits the frames that arrive together in one transaction.  Swift
holds ids, never JS values, and every argument and answer is msgpack.

## Build and test

Needs a Rust toolchain, a C compiler, and Swift 6.  On Linux the package
links the static library cargo builds:

    cd native && cargo build --release
    swift test

The library example's model package (`examples/library/model/LibraryModel`)
holds the tests that use generated code.
