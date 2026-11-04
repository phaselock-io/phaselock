//! phaselock-native: the native host of PhaseLock's clients.  QuickJS runs the Engine, as the
//! model's native bundle builds it, over an LMDB store.  A client, the host-language library that
//! drives it (`client/kotlin`, `client/swift`), reaches it through a thin binding, JNI or a C ABI,
//! that only moves the bytes of api.rs's three calls.  See ../README.md for the design.

pub mod api;
pub mod edits;
pub mod host;
pub mod lmdb;
pub mod registry;
pub mod store;
