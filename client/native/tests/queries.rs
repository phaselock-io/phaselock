//! The queries a `queries` request starts are answered together, by the Engine's one run after
//! them, and the queries it closes are closed.

use phaselock_core::mp;
use phaselock_native::host::{Host, Limits, QueryOp};

/* A native bundle of one Engine whose queries run as the skeleton's do: a new query waits for the
Engine's next run, which a timer schedules, and each run answers every query that waited for
it with the run's number and how many queries are open. */
const BATCHER: &str = r#"
globalThis.__engines = {
  Batcher: {
    create: () => {
      const waiting = [];
      const open = new Set();
      let runs = 0;
      let scheduled = false;
      const run = () => {
        scheduled = false;
        runs += 1;
        for (const q of waiting.splice(0)) q.cb({ run: runs, open: open.size });
      };
      return {
        newQuery: () => ({
          subscribe(cb) {
            this.cb = cb;
            open.add(this);
            waiting.push(this);
            if (!scheduled) {
              scheduled = true;
              setTimeout(run, 0);
            }
          },
          close() {
            open.delete(this);
          },
        }),
      };
    },
  },
};
"#;

// each queryResult among a call's answer, as its query's id, the run that answered it, and how
// many queries were open then
fn results(out: &[u8]) -> Vec<(i64, i64, i64)> {
    let node = mp::parse_whole(out).unwrap();
    let events = node.array().unwrap()[1].array().unwrap();
    let mut got = Vec::new();
    for e in events.iter().map(|e| e.array().unwrap()) {
        if e[0].as_str() != Some(b"queryResult") {
            continue;
        }
        let mp::Node::Bin(b) = &e[2] else { panic!("a result that is not bin") };
        let value = mp::parse_whole(b).unwrap();
        let field = |name: &[u8]| {
            let entries = value.map().unwrap();
            let (_, v) = entries.iter().find(|(k, _)| k.as_str() == Some(name)).unwrap();
            v.as_i64().unwrap()
        };
        got.push((e[1].as_i64().unwrap(), field(b"run"), field(b"open")));
    }
    got
}

#[test]
fn queries_started_together_are_answered_by_one_run() {
    let h = Host::open(BATCHER.as_bytes(), "batcher.js", Limits::default()).unwrap();
    h.create_engine(1, "Batcher", None, None).unwrap();

    // three started in one request share the Engine's first run
    let ops: Vec<QueryOp> = (1..=3).map(|id| QueryOp::Status { id, engine: 1 }).collect();
    assert_eq!(results(&h.queries(&ops).unwrap()), [(1, 1, 3), (2, 1, 3), (3, 1, 3)]);

    // one started on its own has a run of its own
    assert_eq!(results(&h.status_query(4, 1).unwrap()), [(4, 2, 4)]);

    // the three closed in one request leave the fourth, and a start that fails fails alone
    let ops = [
        QueryOp::Close { id: 1 },
        QueryOp::Close { id: 2 },
        QueryOp::Status { id: 6, engine: 9 },
        QueryOp::Close { id: 3 },
        QueryOp::Status { id: 5, engine: 1 },
    ];
    let out = h.queries(&ops).unwrap();
    assert_eq!(results(&out), [(5, 3, 2)]);
    let node = mp::parse_whole(&out).unwrap();
    let failed: Vec<i64> = node.array().unwrap()[1]
        .array()
        .unwrap()
        .iter()
        .map(|e| e.array().unwrap())
        .filter(|e| e[0].as_str() == Some(b"queryFailed"))
        .map(|e| e[1].as_i64().unwrap())
        .collect();
    assert_eq!(failed, [6]);
}
