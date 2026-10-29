// Compiles the QuickJS the database runs bundles in: upstream QuickJS, not the quickjs-ng fork,
// vendored under third_party/quickjs, with the defines its own build passes.  -fwrapv makes
// signed overflow wrap, which QuickJS relies on.

use std::path::Path;

fn main() {
    let dir = Path::new("third_party/quickjs");
    let files = ["cutils.c", "dtoa.c", "libregexp.c", "libunicode.c", "quickjs.c"];

    // the version third_party/update.py stamps on every vendored file's header
    let head = std::fs::read_to_string(dir.join("quickjs.c")).expect("the vendored quickjs.c");
    let version = head
        .split_once("(version ")
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(v, _)| v.to_string())
        .expect("quickjs.c's header names its version");

    let mut build = cc::Build::new();
    build
        .include(dir)
        .define("_GNU_SOURCE", None)
        .define("CONFIG_VERSION", format!("\"{version}\"").as_str())
        .flag_if_supported("-fwrapv")
        .flag_if_supported("-Wno-discarded-qualifiers")
        .flag_if_supported("-Wno-incompatible-pointer-types-discards-qualifiers")
        .warnings(false)
        .opt_level(2);
    for f in files {
        build.file(dir.join(f));
    }
    build.compile("quickjs");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rerun-if-changed=third_party/quickjs");
    println!("cargo:rerun-if-changed=build.rs");
}
