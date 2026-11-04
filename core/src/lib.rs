//! phaselock-core: the code every Rust host of PhaseLock builds on.  It holds the QuickJS that runs
//! bundles, built from the vendored source; the conversion kernel that walks typed values between
//! msgpack and JS; msgpack itself; slice names and selectors; and key patterns with their
//! skip-scan walk over a store's cursor.

pub mod js;
pub mod mp;
pub mod names;
pub mod scan;
pub mod walk;
