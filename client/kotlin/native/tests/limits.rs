//! The limits the host runs JS under: recursion past the stack limit throws, a call that runs past
//! its deadline is interrupted, and an allocation past the heap limit fails, each without taking
//! the host down.

use std::time::{Duration, Instant};

use phaselock_core::mp;
use phaselock_jni::host::{Host, Limits};
use phaselock_jni::jni;
use serde_json::{Value, json};

const BUNDLE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../examples/library/model/native.dev.bundle.js");

fn open(limits: Limits) -> Host {
    let bundle = std::fs::read(BUNDLE).unwrap_or_else(|e| panic!("{BUNDLE}: {e}"));
    Host::open(&bundle, "native.dev.bundle.js", limits).unwrap()
}

fn eval(h: &Host, js: &str) -> Value {
    let out = h.eval_json(js).unwrap_or_else(|e| panic!("{e}"));
    serde_json::from_str(&out).unwrap()
}

fn pump() -> Vec<u8> {
    let mut w = mp::Writer::new();
    w.array(1);
    w.str(b"pump");
    w.into_vec()
}

// the engine thread's stack and the JS limit within it, as EngineHost sets them
#[test]
fn deep_recursion_throws_a_stack_overflow() {
    let thread = std::thread::Builder::new().stack_size(8 << 20).spawn(|| {
        let h = open(Limits { stack: 6 << 20, ..Limits::default() });
        let got = eval(
            &h,
            r#"(() => {
              function f(n) { return f(n + 1) + 1; }
              try { f(0); } catch (e) { return String(e); }
            })()"#,
        );
        assert_eq!(got, json!("InternalError: stack overflow"));
        assert_eq!(eval(&h, "1 + 1"), json!(2));
    });
    thread.unwrap().join().unwrap();
}

/* A loop that never ends, run from a timer while a write transaction is open, is interrupted at
the deadline.  The interrupt is uncatchable: it unwinds every try in the JS, and it ends the
host.  The transaction is aborted, the call fails naming the limit and the loop's backtrace, and
every call after it fails the same, whatever it asks. */
#[test]
fn a_call_past_its_deadline_ends_the_host() {
    let h = open(Limits { call: Duration::from_millis(200), ..Limits::default() });
    let dir = tempfile::tempdir().unwrap();
    h.open_store(1, &dir.path().display().to_string()).unwrap();
    eval(
        &h,
        r#"(setTimeout(function spin() {
          const reg = __pl.registry({ nodes: [["str"]], ids: { s: 0 }, mutations: null });
          globalThis.txn = __pl.begin(1, reg, true);
          try { for (;;) {} } catch (e) { globalThis.caught = String(e); }
        }, 0), 0)"#,
    );
    let started = Instant::now();
    let err = jni::call(&h, &pump()).unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "interrupted late: {:?}",
        started.elapsed()
    );
    assert!(
        err.starts_with("the call ran past its limit of 200ms: InternalError: interrupted\n"),
        "{err}"
    );
    assert!(err.contains("at spin"), "no backtrace: {err}");
    assert_eq!(eval(&h, "globalThis.caught ?? null"), json!(null));
    assert_eq!(h.open_transactions(), 0);
    assert_eq!(h.ended().as_deref(), Some(err.as_str()));

    // every later call, of any op, fails at once with the same
    let mut close_query = mp::Writer::new();
    close_query.array(2);
    close_query.str(b"closeQuery");
    close_query.int(1);
    for request in [pump(), close_query.into_vec()] {
        let started = Instant::now();
        assert_eq!(jni::call(&h, &request).unwrap_err(), err);
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}

// an allocation past the heap limit throws, which JS may catch, and the host runs on
#[test]
fn an_allocation_past_the_heap_limit_fails() {
    let h = open(Limits { memory: 64 << 20, ..Limits::default() });
    let got = eval(
        &h,
        r#"(() => {
          const held = [];
          try { for (;;) held.push(new ArrayBuffer(1 << 20)); } catch (e) { return String(e); }
        })()"#,
    );
    assert_eq!(got, json!("InternalError: out of memory"));
    assert_eq!(eval(&h, "[1, 2, 3].map((x) => x * 2)"), json!([2, 4, 6]));
}
