# phaselock-core

The Rust code every Rust host of PhaseLock builds on: the database
(`../db/`) depends on it by path.

    src/js/ffi.rs     the QuickJS C API, declared by hand, with the
                      header's inline functions written out over the
                      64-bit JSValue
    src/js/mod.rs     owned values, and the errors a host throws
    src/js/mpjs.rs    untyped msgpack <-> plain JS values
    src/walk.rs       the conversion kernel: a schema walk from a
                      msgpack tree or a QuickJS value to a JS value,
                      msgpack, or a check
    src/mp.rs         msgpack: a borrowing parser and a writer of the
                      smallest encodings
    src/names.rs      slice names, selectors, the characters of a key
    src/scan.rs       key patterns, their skip-scan walk over a store's
                      cursor, and the spans a scan reads
    build.rs          compiles the vendored QuickJS
    third_party/      QuickJS, each file headed with its origin and
                      license; update.py vendors a new one and rewrites
                      its NOTICE entry

Building needs a Rust toolchain with edition 2024 and a C compiler.
build.rs compiles upstream QuickJS, not the quickjs-ng fork, with
`-fwrapv`, which QuickJS relies on, so every host runs the same JS
engine.  A host builds with `panic = "abort"`, so that no panic unwinds
across the FFI.

The unit tests run in release, as `make -C db test` runs them: the
msgpack parser's depth test needs more stack than a debug build gives a
test thread.

    cargo test --release
