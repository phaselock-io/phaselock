//! Sign-in and tokens: password and dev sign-in, the token keys that sign and verify tokens across
//! rotations and restarts, and how a revocation or an expiry ends what a token was doing.

mod common;

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use serde_json::{Value as Json, json};
use tokio::sync::oneshot;

use common::*;

/// a refresh's request body
fn refresh() -> Vec<u8> {
    encode(&obj! {"kind" => "refresh"})
}

/// a dev sign-in as identity, answering the status and, for a 200, the reply
async fn dev_sign_in(h: &Harness, identity: &str) -> (u16, V) {
    let body = encode(&obj! {"kind" => "dev", "identity" => identity});
    let r = h.req("POST", "/auth/token", "", Some(body)).await;
    if r.status != 200 {
        return (r.status, V::Nil);
    }
    (r.status, decode(&r.body))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_password_signs_in_until_it_changes_or_its_sessions_are_revoked() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "ann", "name" => "Ann")).await;

    // anyone may create an account; the password is hashed at intake
    h.accept("", mutation!("c2", "create-account", "user" => "ann", "password" => "hunter2")).await;
    let acct = h.snapshot(&admin, "account:ann").await.records["account:ann!account"].clone();
    let hash = acct["hash"].str();
    assert!(hash != "hunter2" && hash.starts_with('$'), "password not hashed at intake: {hash:?}");

    // login
    let r = h.req("POST", "/auth/token", "", Some(login_body("ann", "hunter2"))).await;
    assert_eq!(r.status, 200, "login: {} {}", r.status, r.text());
    let reply = decode(&r.body);
    let tok = reply["token"].str().to_string();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    assert!(reply["user"] == "ann" && reply["exp"].int() >= now, "login reply: {reply:?}");
    let r = h.req("POST", "/auth/token", "", Some(login_body("ann", "wrong"))).await;
    assert_eq!(r.status, 401, "wrong password: {} {}", r.status, r.text());

    // the token acts as ann
    let m = mutation!("c3", "rename-patron", "id" => "ann", "name" => "Anne");
    let o = h.mutations(&tok, &[m]).await.remove(0);
    assert_eq!(o.kind, "ok", "rename as ann: {o:?}");
    let m = mutation!("c4", "add-book", "id" => "b1", "title" => "Dune");
    let o = h.mutations(&tok, &[m]).await.remove(0);
    assert!(o.kind == "reject" && o.reason == "unauthorized", "ann is not an admin: {o:?}");
    let mut s = h.connect(&tok, -1, &[]).await;
    s.live().await;

    // refresh re-issues
    let r = h.req("POST", "/auth/token", &tok, Some(refresh())).await;
    assert_eq!(r.status, 200, "refresh: {} {}", r.status, r.text());
    let tok2 = decode(&r.body)["token"].str().to_string();
    assert_ne!(tok2, tok, "refresh should mint a new token");

    // password change through the ordinary mutation path, as the user
    let m = mutation!("c5", "set-password", "user" => "ann", "password" => "correct horse");
    h.accept(&tok2, m).await;
    let r = h.req("POST", "/auth/token", "", Some(login_body("ann", "hunter2"))).await;
    assert_eq!(r.status, 401, "old password still works");
    let r = h.req("POST", "/auth/token", "", Some(login_body("ann", "correct horse"))).await;
    assert_eq!(r.status, 200, "new password rejected");

    // logout everywhere: existing tokens die on mutations, connections, refresh
    h.accept(&tok2, mutation!("c6", "revoke-sessions", "user" => "ann")).await;
    let m = mutation!("c7", "rename-patron", "id" => "ann", "name" => "x");
    let (status, _) = h.mutations_status(&tok2, &[m]).await;
    assert_eq!(status, 401, "stale token accepted for mutations: {status}");
    let r = h.req("GET", "/stream?since=-1", &tok2, None).await;
    assert_eq!(r.status, 401, "stale token accepted for a connection: {}", r.status);
    let r = h.req("POST", "/auth/token", &tok2, Some(refresh())).await;
    assert_eq!(r.status, 401, "stale token refreshed: {}", r.status);

    // a fresh login carries the new generation and works
    let r = h.req("POST", "/auth/token", "", Some(login_body("ann", "correct horse"))).await;
    assert_eq!(r.status, 200, "login after revoke: {}", r.status);
    let tok3 = decode(&r.body)["token"].str().to_string();
    h.accept(&tok3, mutation!("c8", "rename-patron", "id" => "ann", "name" => "Ann")).await;

    // an account an admin creates as an admin is one
    let m =
        mutation!("c9", "create-account", "user" => "boss", "password" => "pw", "admin" => true);
    h.accept(&admin, m).await;
    let r = h.req("POST", "/auth/token", "", Some(login_body("boss", "pw"))).await;
    assert_eq!(r.status, 200, "boss login: {}", r.status);
    let boss = decode(&r.body)["token"].str().to_string();
    h.accept(&boss, mutation!("c10", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.stop().await;
}

// token keys

/// a token's header and claims, decoded
fn token_parts(token: &str) -> (Json, Json) {
    let parts: Vec<&str> = token.split('.').collect();
    let part = |i: usize| -> Json {
        B64.decode(parts[i])
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_else(|| panic!("token part {i}: {:?}", parts[i]))
    };
    (part(0), part(1))
}

/// the id of the key that signed a token
fn kid(token: &str) -> String {
    token_parts(token).0["kid"].as_str().unwrap_or_default().to_string()
}

/// the ids of the stored token keys, oldest first
async fn kids(h: &Harness) -> Vec<String> {
    let keys = h.srv.core.reader.keys().await.unwrap_or_else(|e| panic!("keys: {e}"));
    keys.into_iter().map(|k| k.kid).collect()
}

/// whether a token is accepted for a mutation
async fn works(h: &Harness, token: &str) -> bool {
    let id = format!("w-{}", &token[token.len() - 8..]);
    let m = mutation!(&id, "rename-patron", "id" => "nobody", "name" => "x");
    h.mutations_status(token, &[m]).await.0 == 200
}

/// a server over the data directory, reading the clock
async fn start_at(dir: &Path, clk: &TestClock) -> Harness {
    let (dir, clock) = (dir.display().to_string(), clk.clock());
    start_with(move |o| {
        o.data_dir = dir;
        o.clock = Some(clock);
    })
    .await
}

/// 2030-01-01T00:00:00Z
fn t0() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_893_456_000)
}

const HOUR: Duration = Duration::from_secs(3600);
const MINUTE: Duration = Duration::from_secs(60);

#[tokio::test(flavor = "multi_thread")]
async fn a_token_is_ed25519_and_names_its_key() {
    let h = start().await;
    let tok = h.admin().await;
    let (hd, claims) = token_parts(&tok);
    let k = hd["kid"].as_str().unwrap_or_default().to_string();
    assert!(
        hd["alg"] == "EdDSA" && hd["typ"] == "JWT" && k.len() == 32 && claims["sub"] == "root",
        "token: {hd} {claims}"
    );
    let ok = works(&h, &tok).await;
    let stored = kids(&h).await;
    assert!(ok && stored == [k.clone()], "the token's key: {stored:?}");

    // a token naming another algorithm, another key, or other claims is refused
    let parts: Vec<&str> = tok.split('.').collect();
    let reheader = |v: Json| format!("{}.{}.{}", B64.encode(v.to_string()), parts[1], parts[2]);
    let other = B64.encode(r#"{"sub":"p1","gen":0,"exp":9999999999}"#);
    let forged = [
        ("HS256", reheader(json!({"alg": "HS256", "typ": "JWT", "kid": k}))),
        ("none", reheader(json!({"alg": "none", "typ": "JWT", "kid": k}))),
        ("unknown kid", reheader(json!({"alg": "EdDSA", "typ": "JWT", "kid": "0".repeat(32)}))),
        ("other claims", format!("{}.{other}.{}", parts[0], parts[2])),
    ];
    for (name, f) in forged {
        let m = mutation!("f", "rename-patron", "id" => "x", "name" => "x");
        let (status, _) = h.mutations_status(&f, &[m]).await;
        assert_eq!(status, 401, "a token with {name}: {status}");
    }
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_outlives_its_process() {
    let dir = tempfile::tempdir().unwrap();
    let h = start_in(dir.path()).await;
    let before = h.admin().await;
    h.stop().await;

    // the new process verifies the old token by its stored key, and signs with a key of its own
    let h = start_in(dir.path()).await;
    assert!(works(&h, &before).await, "a token from before the restart is refused");
    let after = h.admin().await;
    let (old, fresh) = (kid(&before), kid(&after));
    let stored = kids(&h).await;
    assert!(
        old != fresh && stored == [old.clone(), fresh.clone()],
        "keys after a restart: {old} then {fresh}, stored {stored:?}"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn token_keys_rotate_and_are_swept() {
    let dir = tempfile::tempdir().unwrap();
    let clk = TestClock::new(t0());
    let h = start_at(dir.path(), &clk).await;

    // a key signs for a day
    let tok1 = h.admin().await;
    let k1 = kid(&tok1);
    clk.set(t0() + 23 * HOUR);
    assert_eq!(kid(&h.admin().await), k1, "rotated within a day");
    clk.set(t0() + 25 * HOUR);
    let k2 = kid(&h.admin().await);
    assert!(k2 != k1 && works(&h, &tok1).await, "after a day: {k1} then {k2}");

    /* a key retired for longer than a token lives, plus the grace, is swept when the next key is
    minted; the key it retired stays */
    clk.set(t0() + 25 * HOUR + TOKEN_LIFETIME + KEY_GRACE + MINUTE);
    let k3 = kid(&h.admin().await);
    let got = kids(&h).await;
    assert_eq!(got, [k2.clone(), k3.clone()], "after the sweep: {got:?}, want {k2} {k3}");

    // across a restart, a past process's newest key is retired by the new process's start
    h.stop().await;
    clk.set(clk.now() + TOKEN_LIFETIME + KEY_GRACE + MINUTE);
    let h = start_at(dir.path(), &clk).await;
    let k4 = kid(&h.admin().await);
    let got = kids(&h).await;
    assert_eq!(got, [k3.clone(), k4.clone()], "after a restart's sweep: {got:?}, want {k3} {k4}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_grace_keeps_a_key_across_a_clock_stepped_back() {
    let dir = tempfile::tempdir().unwrap();
    let clk = TestClock::new(t0());
    let h = start_at(dir.path(), &clk).await;
    let tok = h.admin().await;
    h.stop().await;

    /* the next process starts on a clock twelve hours behind, so the old key's retirement is
    recorded before its last signature; near the token's expiry a new key's sweep keeps it */
    clk.set(t0() - 12 * HOUR);
    let h = start_at(dir.path(), &clk).await;
    clk.set(t0() + TOKEN_LIFETIME - MINUTE);
    h.admin().await;
    assert!(works(&h, &tok).await, "a live token's key was swept");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dev_auth_can_be_disabled() {
    let h = start_with(|o| o.dev_auth = false).await;
    let body = encode(&obj! {"kind" => "dev", "identity" => "root"});
    let r = h.req("POST", "/auth/token", "", Some(body)).await;
    assert_eq!(r.status, 403, "dev auth without --dev-auth: {}", r.status);
    h.stop().await;
}

// permissions

/* a revocation ends the token's connections ahead of the edits of its batch, and the server
refuses the token from then on without a trip to the writer */
#[tokio::test(flavor = "multi_thread")]
async fn a_revocation_ends_the_tokens_connections() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "ann", "name" => "Ann")).await;
    let tok = h.sign_up("ann", "hunter2").await;
    let mut s = h.connect(&tok, -1, &[]).await;
    s.live().await;

    let (a, b) = (h.clone(), h.clone());
    let (admin_a, admin_b) = (admin.clone(), admin.clone());
    h.together(vec![
        call(async move {
            a.accept(&admin_a, mutation!("c2", "revoke-sessions", "user" => "ann")).await;
        }),
        call(async move {
            let m = mutation!("c3", "rename-patron", "id" => "ann", "name" => "Anne");
            b.accept(&admin_b, m).await;
        }),
    ])
    .await;
    let f = s.next_tagged("end").await;
    assert!(
        f[1].int() == END_REVOKED && f[2] == "token revoked",
        "expected the revocation's end, got {f:?}"
    );

    // the writer takes no request while the token is refused
    h.srv.core.hold_batches(true);
    let m = mutation!("c4", "rename-patron", "id" => "ann", "name" => "x");
    let (status, _) = h.mutations_status(&tok, &[m]).await;
    let queued = h.srv.core.queued();
    h.srv.core.hold_batches(false);
    assert!(status == 401 && queued == 0, "a revoked token: status {status}, {queued} queued");

    // a fresh sign-in carries the new generation
    let tok = h.sign_in("ann", "hunter2").await;
    h.accept(&tok, mutation!("c5", "rename-patron", "id" => "ann", "name" => "Ann")).await;
    h.stop().await;
}

// a revocation applies to the mutations after it in its own batch
#[tokio::test(flavor = "multi_thread")]
async fn a_revocation_stops_the_mutations_after_it_in_its_batch() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "ann", "name" => "Ann")).await;
    let tok = h.sign_up("ann", "hunter2").await;

    // the writer holds ann's account from her first mutation, so the revocation must reach it
    h.accept(&tok, mutation!("c2", "rename-patron", "id" => "ann", "name" => "Anne")).await;
    let (a, b) = (h.clone(), h.clone());
    let (status_tx, status_rx) = oneshot::channel();
    h.together(vec![
        call(async move {
            a.accept(&admin, mutation!("c3", "revoke-sessions", "user" => "ann")).await;
        }),
        call(async move {
            let m = mutation!("c4", "rename-patron", "id" => "ann", "name" => "x");
            let _ = status_tx.send(b.mutations_status(&tok, &[m]).await.0);
        }),
    ])
    .await;
    let status = status_rx.await.unwrap();
    assert_eq!(status, 401, "a token revoked earlier in the batch: {status}");
    h.stop().await;
}

// a grant applies to the expectations after it in its own batch
#[tokio::test(flavor = "multi_thread")]
async fn a_grant_covers_the_expectations_after_it_in_its_batch() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let m = mutation!("c3", "create-account", "user" => "p1", "password" => "hunter2");
    h.accept(&admin, m).await;
    let ann = h.token("p1").await;

    // the writer holds ann's grant from her first expectation, so the grant must reach it
    let m = mutation!("c4", "rename-patron", "id" => "p1", "name" => "y");
    let o = h.expecting(&ann, &m, obj! {"patron:p2" => 99}).await;
    assert_eq!(o.kind, "reject", "an expectation outside the grant: {o:?}");
    let (a, b) = (h.clone(), h.clone());
    let (out_tx, out_rx) = oneshot::channel();
    h.together(vec![
        call(async move {
            let m = mutation!("c5", "grant-view", "user" => "p1", "prefix" => "patron:p2!");
            a.accept(&admin, m).await;
        }),
        call(async move {
            let m = mutation!("c6", "rename-patron", "id" => "p1", "name" => "x");
            let _ = out_tx.send(b.expecting(&ann, &m, obj! {"patron:p2" => 99}).await);
        }),
    ])
    .await;
    let o = out_rx.await.unwrap();
    assert_eq!(o.kind, "conflict", "an expectation the batch's grant covers: {o:?}");
    h.stop().await;
}

// a connection ends shortly before its token expires, while its client can still refresh it
#[tokio::test(flavor = "multi_thread")]
async fn a_stream_ends_before_its_token_expires() {
    let clk = TestClock::new(SystemTime::now());
    let clock = clk.clock();
    let h = start_with(move |o| o.clock = Some(clock)).await;
    let tok = h.token("p1").await;
    let exp = token_parts(&tok).1["exp"].as_i64().expect("an exp claim");
    let exp = UNIX_EPOCH + Duration::from_secs(exp as u64);
    clk.set(exp - EXPIRY_LEAD - Duration::from_millis(300));

    let mut s = h.connect(&tok, -1, &[]).await;
    s.live().await;
    let f = s.next_tagged("end").await;
    assert!(
        f[1].int() == END_REVOKED && f[2] == "token expiring",
        "expected the expiry's end, got {f:?}"
    );
    let r = h.req("POST", "/auth/token", &tok, Some(refresh())).await;
    assert_eq!(r.status, 200, "refreshing the token after the end: {} {}", r.status, r.text());
    h.stop().await;
}

// sign-in

#[tokio::test(flavor = "multi_thread")]
async fn dev_sign_in_is_an_existing_account() {
    let h = start().await;

    // a name with no account is refused
    let (status, _) = dev_sign_in(&h, "nobody").await;
    assert_eq!(status, 401, "dev sign-in with no account: {status}");

    // a name with an account signs in as it
    let (status, reply) = dev_sign_in(&h, "p1").await;
    assert!(status == 200 && reply["user"] == "p1", "dev sign-in as p1: {status} {reply:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_generation_is_a_non_negative_safe_integer() {
    let h = start().await;

    // a lookup answering any other generation fails, so its account signs in nowhere
    for user in ["negative", "fractional"] {
        let (status, _) = dev_sign_in(&h, user).await;
        assert_eq!(status, 500, "dev sign-in as {user}: {status}");
        let (token, _) = h.srv.mint(user, 0).await.unwrap_or_else(|e| panic!("mint: {e}"));
        let m = mutation!("c1", "add-book", "id" => "b1", "title" => "Dune");
        let (status, _) = h.mutations_status(&token, &[m]).await;
        assert_eq!(status, 401, "mutations as {user}: {status}");
    }

    // and a token carrying a negative generation is malformed, whatever its account
    let (token, _) = h.srv.mint("p1", -1).await.unwrap_or_else(|e| panic!("mint: {e}"));
    let m = mutation!("c2", "add-book", "id" => "b2", "title" => "Dune");
    let (status, _) = h.mutations_status(&token, &[m]).await;
    assert_eq!(status, 401, "mutations with a negative generation: {status}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_for_no_account_is_refused_everywhere() {
    let h = start().await;
    let (ghost, _) = h.srv.mint("ghost", 0).await.unwrap_or_else(|e| panic!("mint: {e}"));

    let m = mutation!("c1", "add-book", "id" => "b1", "title" => "Dune");
    let (status, _) = h.mutations_status(&ghost, &[m]).await;
    assert_eq!(status, 401, "mutations: {status}");
    let r = h.req("GET", "/stream?since=-1", &ghost, None).await;
    assert_eq!(r.status, 401, "connection: {}", r.status);
    let r = h.req("POST", "/auth/token", &ghost, Some(refresh())).await;
    assert_eq!(r.status, 401, "refresh: {}", r.status);
    h.stop().await;
}
