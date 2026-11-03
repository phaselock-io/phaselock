//! Pattern scans: the JS host's walk against the scan conformance fixture and its refusals, and
//! the scans deciders and grantors make.

mod common;

use std::rc::Rc;

use serde_json::{Value, json};

use phaselockdb::js::{Host, Options};
use phaselockdb::store::Store;

use common::*;

/// the store type the conformance keys are written under: a plain string, so each key's value is
/// its own name
const CONFORMANCE_TYPE: &str = "shelf/lend";

const FIXTURE: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../typespec/tests/fixtures/scan-conformance.json");

struct Case {
    name: String,
    pattern: Value,
    expect: Vec<String>,
}

/// the bundle's JS host over a store of its own, in a directory that outlives the host
struct ConformanceStore {
    host: Host,
    _dir: tempfile::TempDir,
}

/* Opens the bundle's JS host over a fresh store that holds every key of the TypeScript
skeleton's scan conformance fixture, each with its own name as its value, and answers the
fixture's cases.  Its scans step through budget keys before a seek, or the core's own number for
None. */
fn conformance_store(budget: Option<usize>) -> (ConformanceStore, Vec<Case>) {
    let raw = std::fs::read_to_string(FIXTURE).unwrap_or_else(|e| panic!("{FIXTURE}: {e}"));
    let fixture: Value = serde_json::from_str(&raw).expect("the fixture's JSON");
    let dir = tempfile::tempdir().expect("a store directory");
    let path = dir.path().join("scan.db");
    let store = Rc::new(Store::open(&path.display().to_string(), true, 0).expect("the store"));
    let o = Options {
        store,
        env_names: Vec::new(),
        hasher: Box::new(|pw| Some(phaselockdb::hash::hash_password(pw))),
        call_limit: phaselockdb::js::CALL_LIMIT,
    };
    let host = Host::open(&testdata("bundle.js"), o).unwrap_or_else(|e| panic!("the host: {e}"));
    host.bind_thread();
    if let Some(b) = budget {
        host.set_scan_budget(b);
    }

    // every key, its own name its value
    for k in fixture["keys"].as_array().expect("the fixture's keys") {
        let k = k.as_str().expect("a key");
        host.put_raw(k, CONFORMANCE_TYPE, k).unwrap_or_else(|e| panic!("put {k:?}: {e}"));
    }

    // each case: its name, its pattern, and the keys it visits
    let cases = fixture["cases"]
        .as_array()
        .expect("the fixture's cases")
        .iter()
        .map(|c| Case {
            name: c["name"].as_str().expect("a case's name").to_string(),
            pattern: c["pattern"].clone(),
            expect: c["expect"]
                .as_array()
                .expect("a case's expect")
                .iter()
                .map(|k| k.as_str().expect("an expected key").to_string())
                .collect(),
        })
        .collect();
    (ConformanceStore { host, _dir: dir }, cases)
}

/// Walks a pattern batch by batch, each batch resuming from the last one's next, and checks each
/// batch's shape on the way.
fn scan_all(
    st: &ConformanceStore,
    pattern: &Value,
    ty: &Value,
    reverse: bool,
    limit: usize,
) -> Vec<Value> {
    let mut all = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut req = json!({"pattern": pattern, "type": ty, "reverse": reverse, "limit": limit});
        if let Some(a) = &after {
            req["after"] = json!(a);
        }
        let out = st.host.scan_json(&req.to_string()).unwrap_or_else(|e| panic!("scan {req}: {e}"));
        let b: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("batch {out}: {e}"));
        let entries = b["entries"].as_array().unwrap_or_else(|| panic!("batch {out}"));
        assert!(entries.len() <= limit, "a batch of {} at limit {limit}", entries.len());
        all.extend(entries.iter().cloned());
        let Some(next) = b["next"].as_str() else { return all };
        assert!(
            entries.len() == limit && entries[entries.len() - 1][0] == next,
            "next {next:?} after a batch of {entries:?} at limit {limit}"
        );
        after = Some(next.to_string());
    }
}

/// every case, forward and reversed, whole and resumed at every batch boundary
fn check_conformance(st: &ConformanceStore, cases: &[Case]) {
    let mut failures = Vec::new();
    let mut checks = 0;
    for c in cases {
        let named = !c.pattern["name"].is_null();
        let ty = if named { json!(CONFORMANCE_TYPE) } else { json!(false) };
        for reverse in [false, true] {
            let mut want = c.expect.clone();
            if reverse {
                want.reverse();
            }
            for limit in [1, 2, 3, 1000] {
                let entries = scan_all(st, &c.pattern, &ty, reverse, limit);
                let mut got = Vec::new();
                for e in &entries {
                    got.push(e[0].as_str().expect("an entry's key").to_string());

                    /* The value is the key's own name when the pattern names a template, and
                    absent for keys only. */
                    if named && e[1] != e[0] {
                        failures.push(format!("{}: the value at {} is {}", c.name, e[0], e[1]));
                    }
                    if !named && !e[1].is_null() {
                        failures.push(format!(
                            "{}: a keys-only scan answered {} at {}",
                            c.name, e[1], e[0]
                        ));
                    }
                }
                if got != want {
                    failures.push(format!(
                        "{} (reverse {reverse}, limit {limit}):\n got {got:?}\nwant {want:?}",
                        c.name
                    ));
                }
                checks += 1;
            }
        }
    }
    println!("{} cases, {checks} walks", cases.len());
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/* The fixture's gaps between matches are short enough that the core's own budget steps over
every one, so the cases run again seeking at every gap. */
#[test]
fn walks_match_the_conformance_fixture() {
    for budget in [None, Some(0)] {
        let (st, cases) = conformance_store(budget);
        check_conformance(&st, &cases);
    }
}

#[test]
fn malformed_requests_are_refused() {
    let (st, _) = conformance_store(None);
    let mut failures = Vec::new();
    for (pattern, ty, limit, want) in [
        (
            json!({"slice": "chat:acme,gen", "name": null, "local": []}),
            json!("shelf/lend"),
            1,
            "a scan of every local key reads keys only",
        ),
        (
            json!({"slice": null, "name": "post", "local": []}),
            json!(false),
            1,
            "a pattern over every slice picks out every local key",
        ),
        (
            json!({"slice": "login", "name": null, "local": [null]}),
            json!(false),
            1,
            "a pattern over every local key matches no parameter",
        ),
        (
            json!({"slice": "login", "name": "user", "local": [null]}),
            json!("nope"),
            1,
            "no registry entry for type nope",
        ),
        (
            json!({"slice": "login", "name": "user", "local": [null]}),
            json!(false),
            0,
            "a scan's limit is at least 1",
        ),
    ] {
        let req = json!({"pattern": pattern, "type": ty, "limit": limit});
        let r = st.host.scan_json(&req.to_string());
        if !matches!(&r, Err(e) if e.contains(want)) {
            failures.push(format!("{req}: {r:?}, want {want:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decider_reads_a_shelfs_copies() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("b1", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("b2", "add-book", "id" => "b2", "title" => "Emma")).await;
    h.accept(&admin, mutation!("b3", "add-book", "id" => "b3", "title" => "Dune")).await;

    // shelve reads the shelf's copies, with their values
    h.accept(&admin, mutation!("s1", "shelve", "branch" => "x", "book" => "b1")).await;
    h.accept(&admin, mutation!("s2", "shelve", "branch" => "x", "book" => "b2")).await;
    let o =
        h.mutations(&admin, &[mutation!("s3", "shelve", "branch" => "x", "book" => "b3")]).await;
    assert!(
        o[0].kind == "reject" && o[0].reason == "title on shelf",
        "a title already on the shelf: {:?}",
        o[0]
    );

    // and only that shelf's
    h.accept(&admin, mutation!("s4", "shelve", "branch" => "y", "book" => "b3")).await;
    h.stop().await;
}

/// the copies a shelf's shelved key lists, joined with commas
async fn shelved(h: &Harness, token: &str, branch: &str) -> String {
    let b = h.snapshot(token, &format!("shelf:{branch}")).await;
    match b.records.get(&format!("shelf:{branch}!shelved")) {
        Some(v) if !v.is_nil() => strs(v).join(","),
        _ => panic!("shelf:{branch} has no shelved key"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decider_scan_sees_its_own_writes() {
    let h = start().await;
    let admin = h.admin().await;
    for (id, title) in [("b1", "Dune"), ("b2", "Emma"), ("b3", "Ivanhoe")] {
        h.accept(&admin, mutation!(id, "add-book", "id" => id, "title" => title)).await;
    }

    // the decider's scan sees the copy it set just before it
    h.accept(&admin, mutation!("s1", "shelve", "branch" => "x", "book" => "b1")).await;
    let got = shelved(&h, &admin, "x").await;
    assert!(got == "copy:b1", "after the first copy: {got}");

    // and its own shelf's copies only, not a neighbour's whose name extends its own
    h.accept(&admin, mutation!("s2", "shelve", "branch" => "x-2", "book" => "b2")).await;
    h.accept(&admin, mutation!("s3", "shelve", "branch" => "x", "book" => "b3")).await;
    let got = shelved(&h, &admin, "x").await;
    assert!(got == "copy:b1,copy:b3", "shelf:x: {got}");
    let got = shelved(&h, &admin, "x-2").await;
    assert!(got == "copy:b2", "shelf:x-2: {got}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_grantor_reruns_for_keys_its_walk_covers() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("l1", "lend", "branch" => "x", "patron" => "r1")).await;

    /* r1 is audited, so each run of its grantor changes its view; it sees the shelves that lend
    to it, from a walk of every shelf's lend key for r1. */
    let r1 = h.token("r1").await;
    let mut s = h.connect(&r1, -1, &[]).await;
    assert!(
        s.first
            .as_ref()
            .is_some_and(|f| strs(&f[3]).join(",") == "book,patron:r1,shelf:run-1,shelf:x"),
        "first view frame: {:?}",
        s.first
    );
    s.live().await;

    // a key inside the walk re-runs the grantor, and the grant arrives ahead of the edits
    h.accept(&admin, mutation!("l2", "lend", "branch" => "y", "patron" => "r1")).await;
    let f = s.next_tagged("view").await;
    let got = strs(&f[3]).join(",");
    assert!(got == "book,patron:r1,shelf:run-2,shelf:x,shelf:y", "a lend to r1: {got}");
    let evs = edits(&s.next_tagged("edits").await);
    assert!(evs[0].slice == "shelf:y", "the granted shelf's edits: {evs:?}");

    /* Keys outside it do not, in a shelf r1 sees, whose edits come with no view frame ahead of
    them, or in one it does not. */
    h.accept(&admin, mutation!("l3", "lend", "branch" => "x", "patron" => "p9")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(evs[0].slice == "shelf:x", "a lend to another patron: {evs:?}");
    h.accept(&admin, mutation!("l4", "lend", "branch" => "z", "patron" => "p9")).await;
    s.quiet().await;
    h.accept(&admin, mutation!("s1", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("s2", "shelve", "branch" => "x", "book" => "b1")).await;
    edits(&s.next_tagged("edits").await); // the book
    edits(&s.next_tagged("edits").await); // the copy

    // nor does a death outside the walk's slices
    h.accept(&admin, mutation!("p1", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("p2", "remove-patron", "id" => "p2")).await;
    s.quiet().await;

    // the death of a shelf r1 lends at deletes a key the walk read, so the grantor runs again
    h.accept(&admin, mutation!("c1", "close-shelf", "branch" => "y")).await;
    let f = s.next_tagged("view").await;
    let got = strs(&f[3]).join(",");
    assert!(got == "book,patron:r1,shelf:run-3,shelf:x", "a closed shelf: {got}");
    h.stop().await;
}
