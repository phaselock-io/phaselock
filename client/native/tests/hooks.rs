//! Connection hooks that arrive together, delivered in one connHooks request: the Engine takes
//! every frame among them in one store write transaction.

use phaselock_core::mp;
use phaselock_native::api;
use phaselock_native::host::{Host, Limits};
use serde_json::{Value, json};

const BUNDLE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/library/model/native.dev.bundle.js");

fn eval(h: &Host, js: &str) -> Value {
    let out = h.eval_json(js).unwrap_or_else(|e| panic!("{e}"));
    serde_json::from_str(&out).unwrap()
}

// a frame's edits: one edit of slice at position and seq, carrying no operations
fn frame(position: i64, slice: &str, seq: i64, lifecycle: i64) -> Vec<u8> {
    let mut w = mp::Writer::new();
    w.array(1);
    w.array(1);
    w.array(6);
    w.int(position);
    w.str(slice.as_bytes());
    w.int(seq);
    w.bin(&[position as u8; 16]);
    w.timestamp(1_700_000_000, 0);
    w.int(lifecycle);
    w.into_vec()
}

#[test]
fn a_batch_of_frames_commits_in_one_write_transaction() {
    let bundle = std::fs::read(BUNDLE).unwrap_or_else(|e| panic!("{BUNDLE}: {e}"));
    let h = Host::open(&bundle, "native.dev.bundle.js", Limits::default()).unwrap();
    let dir = tempfile::tempdir().unwrap();

    // an engine over an LMDB store, and the connection it asks for
    let out = h.create_engine(1, "UserEngine", Some(7), Some(&dir.path().display().to_string()));
    let out = out.unwrap();
    let node = mp::parse_whole(&out).unwrap();
    let events = node.array().unwrap()[1].array().unwrap();
    let connect =
        events.iter().map(|e| e.array().unwrap()).find(|e| e[0].as_str() == Some(b"connect"));
    let conn = connect.expect("a connect event")[2].as_i64().unwrap();

    // every write transaction from here on, counted
    eval(
        &h,
        r#"(() => {
          const begin = __pl.begin;
          globalThis.writes = 0;
          __pl.begin = (store, reg, write) => { if (write) globalThis.writes++; return begin(store, reg, write); };
          return 0;
        })()"#,
    );

    // the open, a slice's birth and two edits after it, each its own frame, and live at the last
    let mut w = mp::Writer::new();
    w.array(2);
    w.str(b"connHooks");
    w.array(5);
    w.array(4);
    w.str(b"connOpen");
    w.int(conn);
    w.str(b"e1");
    w.int(3);
    for (position, lifecycle) in [(1, 1), (2, 0), (3, 0)] {
        w.array(3);
        w.str(b"connEdits");
        w.int(conn);
        w.bin(&frame(position, "room:r1", position, lifecycle));
    }
    w.array(3);
    w.str(b"connLive");
    w.int(conn);
    w.int(3);
    api::call(&h, &w.into_vec()).unwrap();

    // one transaction, which applied every frame and moved the cursor to the last
    let got = eval(
        &h,
        r#"(() => {
          const reg = __pl.registry({ nodes: [["str"]], ids: { s: 0 }, mutations: null });
          const t = __pl.begin(1, reg, false);
          const got = { writes: globalThis.writes, seq: __pl.get(t, '!seq:room:r1', '.json', 1),
                        cursor: __pl.get(t, '!checkpoint', '.json', 1).position };
          __pl.abort(t);
          return got;
        })()"#,
    );
    assert_eq!(got, json!({ "writes": 1, "seq": 3, "cursor": 3 }));
}
