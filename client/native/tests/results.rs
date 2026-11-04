//! A query's results reach the client only when their bytes change: the first result always, and a
//! re-run whose encoding is byte for byte the last one's not at all.

use phaselock_core::mp;
use phaselock_native::host::{Host, Limits};

const BUNDLE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/library/model/native.dev.bundle.js");

fn eval(h: &Host, js: &str) {
    h.eval_json(js).unwrap_or_else(|e| panic!("{e}"));
}

// the bytes of each queryResult event among a call's answer, with the query's id
fn results(out: &[u8]) -> Vec<(i64, Vec<u8>)> {
    let node = mp::parse_whole(out).unwrap();
    let events = node.array().unwrap()[1].array().unwrap();
    let results = events.iter().map(|e| e.array().unwrap());
    results
        .filter(|e| e[0].as_str() == Some(b"queryResult"))
        .map(|e| match &e[2] {
            mp::Node::Bin(b) => (e[1].as_i64().unwrap(), b.to_vec()),
            other => panic!("a result that is not bin: {other:?}"),
        })
        .collect()
}

// what pl.encode writes for { n }
fn encoded(n: i64) -> Vec<u8> {
    let mut w = mp::Writer::new();
    w.map(1);
    w.str(b"n");
    w.int(n);
    w.into_vec()
}

/* The status query, its Engine's own query swapped for one the test runs by hand, so a re-run
can give a value equal to the last.  An Engine's real status and declared queries re-run only
when what they read changes, and the status publishes only the parts whose JSON changed, so
neither re-runs to the same bytes on demand. */
#[test]
fn a_result_is_sent_only_when_its_bytes_change() {
    let bundle = std::fs::read(BUNDLE).unwrap_or_else(|e| panic!("{BUNDLE}: {e}"));
    let h = Host::open(&bundle, "native.dev.bundle.js", Limits::default()).unwrap();

    // the Engine the bundle builds, kept where the test reaches it
    eval(
        &h,
        r#"(() => {
          const entry = __engines.UserEngine;
          const create = entry.create;
          entry.create = (...args) => (globalThis.engine = create.apply(entry, args));
          return 0;
        })()"#,
    );
    h.create_engine(1, "UserEngine", None, None).unwrap();

    // a query whose every run is a call of globalThis.run, serving as the status query
    eval(
        &h,
        r#"(() => {
          engine.newQuery = () => ({ subscribe(cb) { globalThis.run = cb; }, close() {} });
          return 0;
        })()"#,
    );
    assert_eq!(results(&h.status_query(5, 1).unwrap()), []);

    // the first result is sent
    eval(&h, "(run({ n: 1 }), 0)");
    assert_eq!(results(&h.pump().unwrap()), [(5, encoded(1))]);

    // the same bytes again are not
    eval(&h, "(run({ n: 1 }), 0)");
    assert_eq!(results(&h.pump().unwrap()), []);

    // bytes of the same length that differ are, and so are bytes of another length
    eval(&h, "(run({ n: 2 }), 0)");
    assert_eq!(results(&h.pump().unwrap()), [(5, encoded(2))]);
    eval(&h, "(run({ n: 300 }), 0)");
    assert_eq!(results(&h.pump().unwrap()), [(5, encoded(300))]);
    eval(&h, "(run({ n: 300 }), 0)");
    assert_eq!(results(&h.pump().unwrap()), []);
}
