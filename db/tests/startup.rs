//! Opening a server: the options it refuses, the bundle and bootstrap it runs, and the log it
//! reopens.

mod common;

use std::ffi::OsString;

use common::*;

// the tests that set the bootstrap's variables, which are the process's, take turns
static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Variables set in the process's environment until the guard drops, which restores what they
/// were.  A test holds ENV while it holds one.
struct Env(Vec<(&'static str, Option<OsString>)>);

impl Env {
    fn set(vars: &[(&'static str, &str)]) -> Env {
        let mut old = Vec::new();
        for (name, value) in vars {
            old.push((*name, std::env::var_os(name)));
            // SAFETY: ENV serializes the tests that touch these variables
            unsafe { std::env::set_var(name, value) };
        }
        Env(old)
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            // SAFETY: ENV serializes the tests that touch these variables
            unsafe {
                match value {
                    Some(v) => std::env::set_var(name, v),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

// the routes answer under the path prefix and nowhere else, and a malformed prefix is refused
#[tokio::test(flavor = "multi_thread")]
async fn the_routes_answer_under_the_path_prefix_only() {
    let h = start_with(|o| o.path_prefix = "/phaselock".into()).await;
    let body = encode(&obj! {"kind" => "dev", "identity" => "root"});
    for (path, want) in [("/phaselock/auth/token", 200), ("/auth/token", 404)] {
        let status = h.req("POST", path, "", Some(body.clone())).await.status;
        assert_eq!(status, want, "{path}");
    }
    for bad in ["phaselock", "/phaselock/", "/"] {
        let r = try_start_with(|o| o.path_prefix = bad.into()).await;
        assert!(r.is_err(), "path prefix {bad:?} was accepted");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_everything() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_in(dir.path()).await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    let m = mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann").in_series("s1", 1);
    let pos = h.accept(&admin, m).await;
    h.accept("", mutation!("c3", "create-account", "user" => "p1", "password" => "pw")).await;
    h.stop().await;

    let h = start_in(dir.path()).await;
    let admin = h.admin().await;

    // dedup survives: the resend is not run again, which the decider would reject
    let m = mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann").in_series("s1", 1);
    let outs = h.mutations(&admin, &[m]).await;
    assert!(
        outs[0].kind == "ok" && outs[0].position >= pos,
        "dedup lost across restart: {:?}",
        outs[0]
    );

    // history survives and positions continue
    let mut s = h.connect(&admin, 0, &[]).await;
    let mut all = Vec::new();
    while all.len() < 3 {
        all.extend(edits(&s.next_tagged("edits").await));
    }
    assert!(all[2].slice == "account:p1" && all[2].position == 3, "history after restart: {all:?}");
    let next = h.accept(&admin, mutation!("c4", "add-patron", "id" => "p2", "name" => "Bob")).await;
    assert_eq!(next, 4, "positions should continue at 4");

    // state survives
    let b = h.snapshot(&admin, "patron:p1").await;
    let state = b.records.get("patron:p1!patron").is_some_and(|v| !v.is_nil());
    assert!(state, "state lost across restart");

    // login survives
    assert_eq!(h.login("p1", "pw").await, 200, "login after restart");

    // the data directory holds the store
    let names = std::fs::read_dir(dir.path()).unwrap().count();
    assert!(names > 0, "empty data dir");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_intake_kind_refuses_to_open() {
    let src = std::fs::read_to_string(testdata("bundle.js")).unwrap();
    assert!(
        src.contains(r#""NewPassword""#),
        "the test bundle should name NewPassword in its schema"
    );
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("bundle.js");
    std::fs::write(&bundle, src.replace(r#""NewPassword""#, r#""NewThing""#)).unwrap();
    let r = try_start_with(|o| o.bundle = bundle.display().to_string()).await;
    match r {
        Err(e) if e.contains("NewThing") => {}
        Err(e) => panic!("expected a refusal naming the kind, got {e}"),
        Ok(_) => panic!("expected a refusal naming the kind, got an open server"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_ip_header_that_holds_a_list_is_refused() {
    for name in ["X-Forwarded-For", "x-forwarded-for", "Forwarded"] {
        let r = try_start_with(|o| o.client_ip_header = name.into()).await;
        assert!(r.is_err(), "{name} accepted");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sqlite_cache_size_over_what_sqlite_takes_is_refused() {
    let r = try_start_with(|o| o.sqlite_cache_size = 1 << 21).await;
    assert!(r.is_err(), "accepted");
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_seeds_an_empty_log() {
    let _turn = ENV.lock().await;
    let _env = Env::set(&[("BOOTSTRAP_ADMIN", "boss"), ("BOOTSTRAP_PASSWORD", "pw")]);
    let dir = tempfile::tempdir().unwrap();
    let env = vec!["BOOTSTRAP_ADMIN".to_string(), "BOOTSTRAP_PASSWORD".to_string()];
    let open = |o: &mut phaselockdb::server::Options| {
        o.data_dir = dir.path().display().to_string();
        o.bootstrap_env = env.clone();
    };
    let h = start_with(open).await;

    // one mutation, under the id the core minted for it: the account slice's birth
    let mut s = h.connect(&h.admin().await, 0, &[]).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs.len() == 1
            && evs[0].lifecycle == BIRTH
            && evs[0].slice == "account:boss"
            && evs[0].id.len() == 16,
        "bootstrap's edit: {evs:?}"
    );
    let hash = evs[0].field("account:boss!account", "hash");
    assert!(
        matches!(&hash, V::Str(s) if s.starts_with("$argon2id$")),
        "bootstrap's hash: {hash:?}"
    );

    // the seeded admin signs in with the password
    let body = encode(&obj! {"kind" => "password", "identity" => "boss", "password" => "pw"});
    let r = h.req("POST", "/auth/token", "", Some(body)).await;
    assert_eq!(r.status, 200, "seeded admin sign-in: {}", r.text());
    let boss = decode(&r.body)["token"].str().to_string();

    // a log that is not empty is not seeded again, and the seeded account acts as an admin
    drop(s);
    h.stop().await;
    let h = start_with(open).await;
    let next = h.accept(&boss, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    assert_eq!(
        next, 2,
        "after a restart, the next mutation lands at {next}, want 2: bootstrap ran again"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_reads_only_the_variables_it_is_given() {
    let _turn = ENV.lock().await;
    let _env = Env::set(&[("BOOTSTRAP_ADMIN", "boss"), ("BOOTSTRAP_PASSWORD", "pw")]);
    let h = start().await;
    let status = h.login("boss", "pw").await;
    assert_eq!(status, 401, "an admin seeded from variables nobody named");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bootstrap_that_fails_stops_the_open() {
    let _turn = ENV.lock().await;
    let _env = Env::set(&[("BOOTSTRAP_ADMIN", "bad/name")]);
    let r = try_start_with(|o| o.bootstrap_env = vec!["BOOTSTRAP_ADMIN".into()]).await;
    match r {
        Err(e) if e.contains("bootstrap") => {}
        Err(e) => panic!("a bootstrap writing to a malformed slice: {e}"),
        Ok(_) => panic!("a bootstrap writing to a malformed slice: the server opened"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_production_bundle_answers_bugs_with_internal_error() {
    let h = start_with(|o| o.bundle = testdata("bundle.prod.js")).await;
    let admin = h.admin().await;
    let m = mutation!("c1", "add-patron", "id" => "p/1", "name" => "Bob");
    let outs = h.mutations(&admin, &[m]).await;
    assert_eq!(outs[0].reason, "internal error", "a bug in a production bundle: {:?}", outs[0]);

    // a rejection's reason is still the app's own
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let m = mutation!("c3", "add-patron", "id" => "p1", "name" => "Ann");
    let outs = h.mutations(&admin, &[m]).await;
    assert_eq!(
        outs[0].reason, "patron exists",
        "a rejection in a production bundle: {:?}",
        outs[0]
    );
}
