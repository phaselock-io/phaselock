// Compiles the vendored LMDB under third_party/lmdb.  An Android build defines ANDROID, which
// LMDB's own build expects there: it picks fsync and turns robust mutexes off.

use std::path::Path;

fn main() {
    let dir = Path::new("third_party/lmdb");
    let mut build = cc::Build::new();
    build
        .include(dir)
        .warnings(false)
        .opt_level(2)
        .file(dir.join("mdb.c"))
        .file(dir.join("midl.c"));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        build.define("ANDROID", "1");
    }
    build.compile("lmdb");
    println!("cargo:rerun-if-changed=third_party/lmdb");
    println!("cargo:rerun-if-changed=build.rs");
}
