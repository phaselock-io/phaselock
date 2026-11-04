//! phaselock-jni: the native host of PhaseLock's Kotlin client.  QuickJS runs the Engine, as the
//! model's native bundle builds it, over an LMDB store; Kotlin drives it through the JNI surface
//! in jni.rs.  See ../README.md for the design.

pub mod edits;
pub mod host;
pub mod jni;
pub mod lmdb;
pub mod registry;
pub mod store;
