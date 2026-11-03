//! Passwords checked at mutation time and at login: proofs against the sender's own credentials,
//! checked again when those credentials change before their turn, and the hashing budget each
//! client draws on.

mod common;

use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};

use phaselockdb::auth::client_of;
use phaselockdb::hooks::hook;
use tokio::sync::{mpsc, oneshot};

use common::*;

// mutation-time authentication

/// a password MutationAuth
fn proof(password: &str) -> V {
    obj! {"kind" => "password", "password" => password}
}

/// Arms the server to set a user's password, as an admin and once, right after the next login's
/// password or request's proofs are checked and before the server reads the credentials again;
/// the receiver answers how the change went.
async fn set_password_when_proved(
    h: &Harness,
    user: &str,
    password: &str,
) -> oneshot::Receiver<Result<(), String>> {
    let admin = h.admin().await;
    let (tx, rx) = oneshot::channel();
    let id = format!("hook-{password}");
    let m = mutation!(&id, "set-password", "user" => user, "password" => password);

    // the hook's first run takes what it needs, so later runs do nothing
    let armed = Arc::new(Mutex::new(Some((h.clone(), admin, m, tx))));
    h.srv.hooks.proved.set(hook(move || {
        let armed = armed.lock().unwrap().take();
        async move {
            let Some((h, admin, m, tx)) = armed else { return };
            let (status, outs) = h.mutations_status(&admin, &[m]).await;
            let r = if status == 200 && outs[0].kind == "ok" {
                Ok(())
            } else {
                Err(format!("set-password: {status} {outs:?}"))
            };
            let _ = tx.send(r);
        }
    }));
    rx
}

/// fails the test unless the armed password change ran and was accepted
fn changed(mut done: oneshot::Receiver<Result<(), String>>) {
    match done.try_recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => panic!("{e}"),
        Err(_) => panic!("the password change never ran"),
    }
}

/// a mutation proving a password for a user
fn proven(id: &str, user: &str, password: &str) -> Mutation {
    mutation!(id, "authenticated-mutation", "user" => user, "check" => proof(password))
}

/// ann's change of her password, proving the one it replaces
fn change(id: &str, old: &str, new: &str) -> Mutation {
    mutation!(id, "change-password", "user" => "ann", "check" => proof(old), "password" => new)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_proof_is_checked_against_the_senders_account() {
    let h = start().await;
    let tok = h.sign_up("ann", "hunter2").await;

    // the right password passes, and the decider sees only what it proved
    let o = h.mutations(&tok, &[proven("c1", "ann", "hunter2")]).await.remove(0);
    assert_eq!(o.kind, "ok", "the right password: {o:?}");
    let tok = h.sign_up("bob", "pw").await;

    // the proof is the sender's own: ann's password proves nothing for bob
    let o = h.mutations(&tok, &[proven("c2", "bob", "hunter2")]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason == "invalid credentials",
        "another account's password: {o:?}"
    );

    // a failed proof is rejected before its expectations are compared, so it learns no seq
    let stale = obj! {"patron:bob" => 99};
    let o = h.expecting(&tok, &proven("c3", "bob", "wrong"), stale.clone()).await;
    assert_eq!(o.kind, "reject", "a wrong password with a stale expectation: {o:?}");
    let o = h.expecting(&tok, &proven("c4", "bob", "pw"), stale).await;
    assert_eq!(o.kind, "conflict", "the right password with a stale expectation: {o:?}");

    // an account without a password, and the anonymous principal, prove nothing
    for sender in [h.token("p1").await, String::new()] {
        let o = h.mutations(&sender, &[proven("c5", "p1", "x")]).await.remove(0);
        assert!(
            o.kind == "reject" && o.reason == "invalid credentials",
            "a proof with no password to check it against: {o:?}"
        );
    }

    // the other kinds are refused at intake, after the wire shape is checked
    let totp = obj! {"kind" => "totp", "code" => "123456"};
    let m = mutation!("c6", "authenticated-mutation", "user" => "bob", "check" => totp);
    let o = h.mutations(&tok, &[m]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason == "totp proofs are not supported by this database yet",
        "a totp proof: {o:?}"
    );
    let pigeon = obj! {"kind" => "carrier-pigeon"};
    let m = mutation!("c7", "authenticated-mutation", "user" => "bob", "check" => pigeon);
    let o = h.mutations(&tok, &[m]).await.remove(0);
    assert!(o.kind == "reject" && o.reason.contains("$.check"), "a malformed proof: {o:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resent_password_change_that_landed_is_ok() {
    let h = start().await;
    let tok = h.sign_up("ann", "hunter2").await;
    let landed = change("c1", "hunter2", "fresh").in_series("s1", 1);

    /* the change lands, and its resend proves a password that is no longer ann's, but the resend
    is the decided mutation, so dedup answers it */
    let o = h.mutations(&tok, std::slice::from_ref(&landed)).await.remove(0);
    assert_eq!(o.kind, "ok", "the change: {o:?}");
    let o = h.mutations(&tok, &[landed]).await.remove(0);
    assert_eq!(o.kind, "ok", "the resend: {o:?}");
    let again = change("c2", "hunter2", "x").in_series("s1", 2);
    let o = h.mutations(&tok, &[again]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason == "invalid credentials",
        "a new mutation proving the old password: {o:?}"
    );
    let status = h.login("ann", "fresh").await;
    assert_eq!(status, 200, "login with the changed password: {status}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_proves_the_password_its_earlier_mutation_set() {
    let h = start().await;
    let tok = h.sign_up("ann", "hunter2").await;

    /* both proofs are checked against hunter2 before either runs; the second bounces when its
    turn comes and passes against the password the first set */
    let call = [change("c1", "hunter2", "fresh"), proven("c2", "ann", "fresh")];
    let outs = h.mutations(&tok, &call).await;
    assert!(outs[0].kind == "ok" && outs[1].kind == "ok", "outcomes: {outs:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_proof_is_checked_again_when_the_credentials_change_before_its_turn() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("p", "add-patron", "id" => "ann", "name" => "Ann")).await;
    let tok = h.sign_up("ann", "hunter2").await;

    // a proof that passed against the old password fails against the new one
    let done = set_password_when_proved(&h, "ann", "fresh").await;
    let o = h.mutations(&tok, &[proven("c1", "ann", "hunter2")]).await.remove(0);
    changed(done);
    assert!(
        o.kind == "reject" && o.reason == "invalid credentials",
        "the old password after a change: {o:?}"
    );

    /* a proof that failed against the old password passes against the new one, and the call's
    mutations are still decided once each, in order */
    let done = set_password_when_proved(&h, "ann", "fresher").await;
    let call = [
        mutation!("c2", "rename-patron", "id" => "ann", "name" => "A1").in_series("s1", 1),
        proven("c3", "ann", "fresher").in_series("s1", 2),
        mutation!("c4", "rename-patron", "id" => "ann", "name" => "A2").in_series("s1", 3),
    ];
    let outs = h.mutations(&tok, &call).await;
    changed(done);
    for (i, o) in outs.iter().enumerate() {
        assert_eq!(o.kind, "ok", "outcome {i}: {o:?}");
    }
    assert!(outs[0].position < outs[2].position, "decided out of order: {outs:?}");
    let b = h.snapshot(&admin, "patron:ann").await;
    let patron = &b.records["patron:ann!patron"];
    assert!(patron["name"] == "A2", "patron after the call: {patron:?}");

    // the proven mutation revoked the token, so the resend signs in again, and is answered by dedup
    let tok = h.sign_in("ann", "fresher").await;
    for (i, o) in h.mutations(&tok, &call).await.iter().enumerate() {
        assert_eq!(o.kind, "ok", "resent outcome {i}: {o:?}");
    }
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_login_is_checked_again_when_the_credentials_change() {
    let h = start().await;
    h.sign_up("ann", "hunter2").await;

    // the password that passed is replaced before the login is decided
    let done = set_password_when_proved(&h, "ann", "fresh").await;
    let status = h.login("ann", "hunter2").await;
    assert_eq!(status, 401, "the old password after a change: {status}");
    changed(done);

    // the password that failed becomes the account's before the login is decided
    let done = set_password_when_proved(&h, "ann", "fresher").await;
    let status = h.login("ann", "fresher").await;
    assert_eq!(status, 200, "the new password after a change: {status}");
    changed(done);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lookup_that_changes_on_every_read_is_a_bug() {
    let h = start().await;

    /* the core reads lookup once for the state it holds, so a proof is checked against that one
    answer, which no password matches */
    let tok = h.token("flaky").await;
    let o = h.mutations(&tok, &[proven("c1", "flaky", "x")]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason == "invalid credentials",
        "a proof against a flaky lookup: {o:?}"
    );

    // a login reads lookup again after its check, and gives up after a few answers that differ
    let status = h.login("flaky", "x").await;
    assert_eq!(status, 500, "a login against a flaky lookup: {status}");
    h.stop().await;
}

/* a proof whose sender's credentials change before every one of its turns is rejected once the
call has bounced as often as it may */
#[tokio::test(flavor = "multi_thread")]
async fn a_proof_whose_credentials_keep_changing_is_rejected() {
    let h = start().await;
    let tok = h.sign_up("ann", "hunter2").await;
    let admin = h.admin().await;

    // every check of the proof is followed by a change of the password
    let changes = Arc::new(AtomicI32::new(0));
    let (errs, mut errs_rx) = mpsc::unbounded_channel();
    let (hh, counted) = (h.clone(), changes.clone());
    h.srv.hooks.proved.set(hook(move || {
        let (h, admin, errs) = (hh.clone(), admin.clone(), errs.clone());
        let n = counted.fetch_add(1, Ordering::SeqCst) + 1;
        async move {
            let id = format!("hook-{n}");
            let m = mutation!(&id, "set-password", "user" => "ann", "password" => format!("pw{n}"));
            let (status, _) = h.mutations_status(&admin, &[m]).await;
            if status != 200 {
                let _ = errs.send(format!("set-password: {status}"));
            }
        }
    }));
    let o = h.mutations(&tok, &[proven("c1", "ann", "hunter2")]).await.remove(0);
    assert!(
        o.kind == "reject"
            && o.reason == "the sender's credentials changed 4 times while its proof was checked",
        "a proof whose credentials keep changing: {o:?}"
    );
    let n = changes.load(Ordering::SeqCst);
    assert_eq!(n, 4, "the proof was checked {n} times");
    if let Ok(e) = errs_rx.try_recv() {
        panic!("{e}");
    }
    h.stop().await;
}

// guards the core's own read-only check, which stops a lookup's write that slips past the bundle
#[tokio::test(flavor = "multi_thread")]
async fn the_core_refuses_a_write_from_lookup() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // the lookup fails, naming its slot, so the sign-in does
    let body = encode(&obj! {"kind" => "dev", "identity" => "raw-lookup"});
    let r = h.req("POST", "/auth/token", "", Some(body)).await;
    assert!(
        r.status == 500 && r.text().contains("lookup reads only, and made a write"),
        "a sign-in under a lookup that writes past the bundle: {} {}",
        r.status,
        r.text()
    );

    // the write it made reached neither the store nor the next mutation's edit
    let m = mutation!("c2", "notify", "patron" => "p1", "reasons" => arr!["only"]);
    h.accept(&admin, m).await;
    let got = h.messages("p1").await;
    assert_eq!(got.join(","), "only,own", "the messages of the next mutation: {got:?}");
    h.stop().await;
}

// password hashing

#[tokio::test(flavor = "multi_thread")]
async fn login_attempts_are_rate_limited_per_client() {
    let h = start_with(|o| {
        o.auth_burst = 3;
        o.auth_rate = 0.001;
    })
    .await;
    let admin = h.admin().await;
    let m = mutation!("c1", "create-account", "user" => "ann", "password" => "hunter2");
    h.accept(&admin, m).await;

    // the account's creation hashed once, so two attempts remain, right or wrong
    let status = h.login("ann", "wrong").await;
    assert_eq!(status, 401, "a wrong password: {status}");
    let status = h.login("ann", "hunter2").await;
    assert_eq!(status, 200, "the right password: {status}");
    let status = h.login("ann", "hunter2").await;
    assert_eq!(status, 429, "an attempt past the budget: {status}, want 429");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_login_for_an_unknown_account_costs_a_hash() {
    let h = start_with(|o| {
        o.auth_burst = 1;
        o.auth_rate = 0.001;
    })
    .await;

    // it verifies against a dummy hash, so it spends the budget like a wrong password
    let status = h.login("nobody", "x").await;
    assert_eq!(status, 401, "an unknown account: {status}");
    let status = h.login("nobody", "x").await;
    assert_eq!(status, 429, "an unknown account past the budget: {status}, want 429");
    h.stop().await;
}

#[test]
fn clients_are_named_by_address_or_their_slash_64() {
    // a server naming no client IP header, and one behind a proxy that names one
    let (direct, proxied) = ("", "CF-Connecting-IP");
    let cases = [
        (direct, "203.0.113.7:5000", "", "203.0.113.7"),
        (direct, "[2001:db8:1:2:aaaa::1]:5000", "", "2001:db8:1:2::/64"),
        (direct, "[::ffff:203.0.113.7]:5000", "", "203.0.113.7"),
        (direct, "203.0.113.7:5000", "198.51.100.1", "203.0.113.7"),
        (proxied, "127.0.0.1:5000", "198.51.100.1", "198.51.100.1"),
        (proxied, "127.0.0.1:5000", " 2001:db8:1:2:bbbb::9 ", "2001:db8:1:2::/64"),
        (proxied, "127.0.0.1:5000", "", "127.0.0.1"),
        (proxied, "127.0.0.1:5000", "198.51.100.1, 198.51.100.2", "127.0.0.1"),
    ];
    for (server, remote, header, want) in cases {
        let got = client_of(server, header, remote);
        assert_eq!(
            got, want,
            "{remote} with header {header:?} (server header {server:?}): {got}, want {want}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn intake_hashing_is_rate_limited_per_client() {
    let h = start_with(|o| {
        o.auth_burst = 1;
        o.auth_rate = 0.001;
    })
    .await;
    h.accept("", mutation!("c1", "create-account", "user" => "ann", "password" => "hunter2")).await;

    /* a request whose hash finds the budget spent is refused whole, so it can be retried later
    under the same ids */
    let m = mutation!("c2", "create-account", "user" => "bob", "password" => "pw");
    let r = h.req("POST", "/mutations", "", Some(m.encode(None))).await;
    assert_eq!(r.status, 429, "a hash past the budget: {}, want 429", r.status);
    assert!(!r.header("retry-after").is_empty(), "a 429 names how long to wait");
    assert_eq!(r.header("phaselock-safe-to-retry"), "", "a 429 carries no safe-to-retry header");

    // mutations that hash nothing are not limited
    let admin = h.admin().await;
    let m = mutation!("c3", "add-book", "id" => "b1", "title" => "Dune");
    let o = h.mutations(&admin, &[m]).await.remove(0);
    assert_eq!(o.kind, "ok", "a mutation with no password: {o:?}");
    h.stop().await;
}
