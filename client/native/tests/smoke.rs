//! The host runs the library's native bundle: an Engine it builds asks the client to connect.

use phaselock_core::mp;
use phaselock_native::host::{Host, Limits};

const BUNDLE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/library/model/native.dev.bundle.js");

#[test]
fn an_engine_starts_and_asks_to_connect() {
    let bundle = std::fs::read(BUNDLE).unwrap_or_else(|e| panic!("{BUNDLE}: {e}"));
    let h = Host::open(&bundle, "native.dev.bundle.js", Limits::default()).unwrap();
    let out = h.create_engine(1, "UserEngine", Some(7), None).unwrap();

    // [delay, [["connect", engine, connection, since, view, wants, session]]]
    let node = mp::parse_whole(&out).unwrap();
    let events = node.array().unwrap()[1].array().unwrap();
    assert_eq!(events.len(), 1);
    let e = events[0].array().unwrap();
    assert_eq!(e[0].as_str(), Some(&b"connect"[..]));
    assert_eq!((e[1].as_i64(), e[3].as_i64(), e[6].as_i64()), (Some(1), Some(-1), Some(7)));
    assert!(e[4].is_nil(), "a fresh store has no view token");
    let wants: Vec<_> = e[5].array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
    assert_eq!(wants, [&b"book:*"[..], b"patron:*", b"room:*"]);
}
