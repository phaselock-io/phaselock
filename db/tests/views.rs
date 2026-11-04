//! views: what a grant lets a connection see, how wants narrow it, how view frames follow a grant
//! as it changes, and how a grant that fails or misbehaves fails closed

mod common;

use std::time::{Duration, Instant};

use tokio::sync::{Notify, mpsc, oneshot};

use phaselock_core::names::valid_selector;

use common::*;

// a view frame's selectors, joined by commas
fn selectors(f: &V) -> String {
    strs(&f[3]).join(",")
}

// whether a view frame's selectors include the selector
fn grants(f: &V, selector: &str) -> bool {
    strs(&f[3]).iter().any(|s| s == selector)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_sees_what_its_grant_and_its_wants_allow() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c3", "add-patron", "id" => "p2", "name" => "Bob")).await;

    // a patron sees the book slice and its own slice, from history
    let ann = h.token("p1").await;
    let mut s = h.connect(&ann, 0, &[]).await;
    let mut all = Vec::new();
    while all.len() < 2 {
        all.extend(edits(&s.next_tagged("edits").await));
    }
    for e in &all {
        assert!(e.slice == "book" || e.slice == "patron:p1", "leaked edit: {e:?}");
    }

    // the replay ended on p2's invisible edit, which a vouch covers
    let f = s.next().await;
    assert!(
        f[0] == "vouch" && f[1].int() == 3,
        "expected a vouch at 3 past the last frame, got {f:?}"
    );
    s.live().await;

    // other patrons' edits are invisible and produce no frame at all
    h.accept(&admin, mutation!("c4", "rename-patron", "id" => "p2", "name" => "Robert")).await;
    s.quiet().await;
    h.accept(&admin, mutation!("c5", "rename-patron", "id" => "p1", "name" => "Anne")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert_eq!(evs[0].slice, "patron:p1", "expected own edit, got {evs:?}");

    /* wants narrow the view: the frame carries the grant cut down to the wants, and the token
    hashes that set, so it differs from the unrestricted one */
    let mut s2 = h.connect(&ann, -1, &["book"]).await;
    assert!(
        s2.first.as_ref().is_some_and(|f| selectors(f) == "book"),
        "narrowed view frame: {:?}",
        s2.first
    );
    assert_ne!(
        s2.header("phaselock-view"),
        s.header("phaselock-view"),
        "token should reflect the wants"
    );
    s2.live().await;
    h.accept(&admin, mutation!("c6", "rename-patron", "id" => "p1", "name" => "Annie")).await;
    s2.quiet().await;
    h.accept(&admin, mutation!("c7", "add-book", "id" => "b2", "title" => "Emma")).await;
    let evs = edits(&s2.next_tagged("edits").await);
    assert_eq!(evs[0].slice, "book", "expected book edit, got {evs:?}");

    /* the narrower of a want and a grant is kept, and a want nothing grants vanishes: patron:*
    against patron:p1 is patron:p1, author:* is nothing */
    let mut s4 = h.connect(&ann, -1, &["patron:*", "author:*"]).await;
    assert!(
        s4.first.as_ref().is_some_and(|f| selectors(f) == "patron:p1"),
        "intersected view frame: {:?}",
        s4.first
    );
    s4.live().await;
    let mut s5 = h.connect(&admin, -1, &["patron:*"]).await;
    assert!(
        s5.first.as_ref().is_some_and(|f| selectors(f) == "patron:*"),
        "admin view cut down to a family: {:?}",
        s5.first
    );
    s5.live().await;

    // anonymous sees only the book slice
    let mut s3 = h.connect("", -1, &[]).await;
    s3.live().await;
    h.accept(&admin, mutation!("c8", "rename-patron", "id" => "p1", "name" => "Ann")).await;
    s3.quiet().await;
    h.stop().await;
}

/* a grant a connection holds always matches a fresh run of the grantor: a grantor that branches
on a scan's next depends on what the scan handed it, and a full batch hands it nothing past its
last key, so a write past that key changes neither */
#[tokio::test(flavor = "multi_thread")]
async fn a_grant_that_branches_on_a_scans_next_stays_what_a_fresh_run_answers() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let peeker = h.token("peeker").await;
    let mut s = h.connect(&peeker, -1, &[]).await;
    s.live().await;
    assert!(
        s.first.as_ref().is_some_and(|f| grants(f, "patron:p1")),
        "expected p1 granted, got {:?}",
        s.first
    );

    /* p2, past the one-row batch, goes; the held grant is what a fresh run, under another
    principal of the same grant, answers */
    h.accept(&admin, mutation!("c3", "remove-patron", "id" => "p2")).await;
    let fresh = h.connect(&h.token("peeker2").await, -1, &[]).await;
    assert_eq!(
        fresh.header("phaselock-view"),
        s.header("phaselock-view"),
        "a fresh run answers {:?}, the held view is {:?}",
        fresh.first,
        s.first
    );
    s.quiet().await;

    // p1, inside the batch, goes too, and the grant follows
    h.accept(&admin, mutation!("c4", "remove-patron", "id" => "p1")).await;
    let f = s.next_tagged("view").await;
    assert!(!grants(&f, "patron:p1"), "expected p1 revoked, got {f:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_to_a_grant_reaches_its_connections_as_a_view_frame() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("c3", "create-account", "user" => "p1", "password" => "hunter2"))
        .await;

    let ann = h.token("p1").await;
    let mut s = h.connect(&ann, -1, &[]).await;
    s.live().await;
    let token0 = s.header("phaselock-view").to_string();

    // two connections of the same principal with narrower wants
    let mut sb = h.connect(&ann, -1, &["book"]).await;
    sb.live().await;
    let mut sp = h.connect(&ann, -1, &["patron:*"]).await;
    sp.live().await;

    /* granting a view rewrites the grantor's read-set key: a view frame arrives, before any edits
    of the same commit, carrying the whole set of selectors */
    let grant = mutation!("c4", "grant-view", "user" => "p1", "prefix" => "patron:p2!");
    let grant_pos = h.accept(&admin, grant).await;
    let f = s.next_tagged("view").await;
    assert!(f[1].str() != token0, "token should change on grant");

    // the frame names the last position sent under the old view, the one before the grant's
    assert_eq!(f[2].int(), grant_pos - 1, "view position {:?}, want {}", f[2], grant_pos - 1);
    let got = selectors(&f);
    assert_eq!(got, "book,patron:p1,patron:p2", "grant frame selectors: {got}");
    let token1 = f[1].str().to_string();

    /* the grant is inside one connection's wants and outside the other's: the first gets its own
    view, the second's view is as it was, so no frame */
    let f = sp.next_tagged("view").await;
    let got = selectors(&f);
    assert_eq!(got, "patron:p1,patron:p2", "grant frame selectors under wants: {got}");
    sb.quiet().await;

    // now p2's edits flow
    h.accept(&admin, mutation!("c5", "rename-patron", "id" => "p2", "name" => "Robert")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert_eq!(evs[0].slice, "patron:p2", "expected the granted slice, got {evs:?}");

    /* a connection presenting a stale token gets the view frame first, with the current
    selectors; one presenting the current token goes straight to live */
    let mut s2 = h.connect_view(&ann, -1, &token0).await;
    let v = s2.next_tagged("view").await;
    assert!(
        v[1].str() == token1 && v[2].int().to_string() == s2.header("phaselock-position"),
        "first view frame: {v:?} (connection token {token1})"
    );
    let got = selectors(&v);
    assert_eq!(got, "book,patron:p1,patron:p2", "first view selectors: {got}");
    drop(s2);
    let mut s3 = h.connect_view(&ann, -1, &token1).await;
    let f = s3.next().await;
    assert!(f[0] == "live", "current token: expected live first, got {f:?}");
    drop(s3);

    // revocation: a view frame, and the same commit's edits are withheld
    h.accept(&admin, mutation!("c6", "revoke-view", "user" => "p1", "prefix" => "patron:p2!"))
        .await;
    let f = s.next_tagged("view").await;
    let got = selectors(&f);
    assert_eq!(got, "book,patron:p1", "revoke frame selectors: {got}");
    assert!(f[1].str() == token0, "token should return to the original after revoke");
    h.accept(&admin, mutation!("c7", "rename-patron", "id" => "p2", "name" => "Bob")).await;
    s.quiet().await;

    /* selectors are never expanded: a family grant is one selector, and the client learns the
    members from the blob */
    h.accept(&admin, mutation!("c8", "add-patron", "id" => "p3", "name" => "Cy")).await;
    h.accept(&admin, mutation!("c9", "grant-view", "user" => "p1", "prefix" => "patron:*")).await;
    let f = s.next_tagged("view").await;
    let got = selectors(&f);
    assert_eq!(got, "book,patron:*,patron:p1", "wildcard grant frame selectors: {got}");
    let token_family = f[1].str().to_string();

    /* every change to the set is sent, even one that leaves coverage as it was: patron:p2 is
    inside the held patron:* */
    h.accept(&admin, mutation!("c9b", "grant-view", "user" => "p1", "prefix" => "patron:p2!"))
        .await;
    let f = s.next_tagged("view").await;
    assert!(
        selectors(&f) == "book,patron:*,patron:p1,patron:p2" && f[1].str() != token_family,
        "grant inside a held family: {f:?}"
    );
    h.accept(&admin, mutation!("c9c", "revoke-view", "user" => "p1", "prefix" => "patron:p2!"))
        .await;
    let f = s.next_tagged("view").await;
    assert!(f[1].str() == token_family, "revoke inside a held family: {f:?}");
    h.accept(&admin, mutation!("c10", "add-patron", "id" => "p4", "name" => "Di")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs[0].slice == "patron:p4" && evs[0].lifecycle == BIRTH,
        "births under a held wildcard arrive on the connection: {evs:?}"
    );
    h.accept(&admin, mutation!("c11", "revoke-view", "user" => "p1", "prefix" => "patron:*")).await;
    let f = s.next_tagged("view").await;
    let got = selectors(&f);
    assert_eq!(got, "book,patron:p1", "wildcard revoke frame selectors: {got}");
    h.stop().await;
}

/* a view change reaches the client ahead of the edits of the commit that caused it, even when
the view changes while the connection switches from its replay to streaming */
#[tokio::test(flavor = "multi_thread")]
async fn a_view_frame_leads_the_edits_it_grants_into_streaming() {
    // the connection pauses once its replay is done, before it switches to streaming
    let (paused_tx, mut paused) = mpsc::unbounded_channel::<()>();
    let resume = std::sync::Arc::new(Notify::new());
    let h = start().await;
    let r = resume.clone();
    h.srv.hooks.before_streaming.set(phaselockdb::hooks::hook(move || {
        let (paused_tx, r) = (paused_tx.clone(), r.clone());
        async move {
            let _ = paused_tx.send(());
            r.notified().await;
        }
    }));
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let mut s = h.connect(&h.token("p1").await, -1, &[]).await;

    // while it is paused, a lend births a shelf and grants it to the patron in one mutation
    paused.recv().await.unwrap();
    let pos = h.accept(&admin, mutation!("c2", "lend", "branch" => "x", "patron" => "p1")).await;
    resume.notify_one();

    /* the view frame granting the shelf comes before the shelf's edits, which the hot catchup
    replays, at the last position the replay sent, the one before the lend's */
    let (mut granted, mut shelved) = (false, false);
    loop {
        let f = s.next().await;
        if f[0] == "live" {
            break;
        }
        if f[0] == "view" {
            assert!(
                f[2].int() == pos - 1 && grants(&f, "shelf:x"),
                "expected the view at {} granting shelf:x, got {f:?}",
                pos - 1
            );
            granted = true;
        } else if f[0] == "edits" {
            let e = &edits(&f)[0];
            if e.slice == "shelf:x" {
                assert!(granted, "the shelf's edits at {} came before its grant", e.position);
                shelved = true;
            }
        }
    }
    assert!(shelved, "the shelf's edits never came");
    h.stop().await;
}

/* a view frame's position is the last position the connection sent under the previous view: on a
reconnect whose token is stale, nothing has been sent yet, so it is the since presented, and the
replay after it is filtered by the new view */
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_tokens_view_frame_is_at_the_since_presented() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let since =
        h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("c3", "lend", "branch" => "x", "patron" => "p1")).await;
    let mut s = h.connect_view(&h.token("p1").await, since, "stale").await;
    let f = s.next().await;
    assert!(
        f[0] == "view" && f[2].int() == since && grants(&f, "shelf:x"),
        "expected the view at {since} granting shelf:x, got {f:?}"
    );
    let e = edits(&s.next_tagged("edits").await).remove(0);
    assert!(
        e.slice == "shelf:x" && e.position == since + 1,
        "expected the replay to bring the shelf at {} under the new view, got {e:?}",
        since + 1
    );
    h.stop().await;
}

/* a live view frame's position is the last position before the batch that changed the view, past
commits the old view could not see, which no frame told the connection of: the new view's edits
at or below it are the backfill's, through its tail */
#[tokio::test(flavor = "multi_thread")]
async fn a_live_view_frames_position_passes_commits_the_old_view_could_not_see() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let mut s = h.connect(&h.token("p1").await, -1, &[]).await;
    s.live().await;

    // a commit the connection cannot see, then a lend that grants it a shelf
    let unseen =
        h.accept(&admin, mutation!("c3", "rename-patron", "id" => "p2", "name" => "Robert")).await;
    h.accept(&admin, mutation!("c4", "lend", "branch" => "x", "patron" => "p1")).await;
    let f = s.next_tagged("view").await;
    assert!(
        f[2].int() == unseen && grants(&f, "shelf:x"),
        "expected the view at {unseen} granting shelf:x, got {f:?}"
    );
    h.stop().await;
}

/* a connection registered in the batch whose writes grant it a slice streams under the view as
of the batch's end, the slice included */
#[tokio::test(flavor = "multi_thread")]
async fn a_registration_in_the_batch_that_grants_it_a_slice_gets_the_slice() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-book", "id" => "b1", "title" => "Dune")).await;

    // the connection registers in the lend's batch
    let p1 = h.token("p1").await;
    let (tx, rx) = oneshot::channel();
    let (hc, hm, a) = (h.clone(), h.clone(), admin.clone());
    h.together(vec![
        call(async move {
            let _ = tx.send(hc.connect(&p1, -1, &[]).await);
        }),
        call(async move {
            hm.accept(&a, mutation!("c3", "lend", "branch" => "x", "patron" => "p1")).await;
        }),
    ])
    .await;
    let mut s = rx.await.unwrap();
    assert!(
        s.first.as_ref().is_some_and(|f| grants(f, "shelf:x")),
        "expected the view granting shelf:x, got {:?}",
        s.first
    );
    s.live().await;

    // the shelf's edits flow
    h.accept(&admin, mutation!("c4", "shelve", "branch" => "x", "book" => "b1")).await;
    let e = edits(&s.next_tagged("edits").await).remove(0);
    assert_eq!(e.slice, "shelf:x", "expected the shelf's edit, got {e:?}");
    h.stop().await;
}

/* a connection registered in the batch whose writes revoke one of its slices streams under the
view as of the batch's end, and none of that slice's later edits reach it */
#[tokio::test(flavor = "multi_thread")]
async fn a_registration_in_the_batch_that_revokes_a_slice_never_gets_its_edits() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("c3", "lend", "branch" => "x", "patron" => "p1")).await;

    // the connection registers in the batch that closes the shelf
    let p1 = h.token("p1").await;
    let (tx, rx) = oneshot::channel();
    let (hc, hm, a) = (h.clone(), h.clone(), admin.clone());
    h.together(vec![
        call(async move {
            let _ = tx.send(hc.connect(&p1, -1, &[]).await);
        }),
        call(async move {
            hm.accept(&a, mutation!("c4", "close-shelf", "branch" => "x")).await;
        }),
    ])
    .await;
    let mut s = rx.await.unwrap();
    assert!(
        s.first.as_ref().is_some_and(|f| !grants(f, "shelf:x")),
        "expected the view without shelf:x, got {:?}",
        s.first
    );
    s.live().await;

    // the shelf, written again with no lend, is no longer the patron's
    h.accept(&admin, mutation!("c5", "shelve", "branch" => "x", "book" => "b1")).await;
    s.quiet().await;
    h.stop().await;
}

/* a principal's registration outlives its last connection for the TTL, so a reconnect is
answered from it, and past the TTL the grant runs again */
#[tokio::test(flavor = "multi_thread")]
async fn a_registration_outlives_its_connections_for_the_ttl() {
    for ttl in [Duration::from_secs(60), Duration::from_millis(1)] {
        let h = start_with(|o| o.principal_ttl = ttl).await;
        let admin = h.admin().await;
        let r1 = h.token("r1").await;

        // the audited user's every grant run changes its view
        let mut s = h.connect(&r1, -1, &[]).await;
        s.live().await;
        let view = s.header("phaselock-view").to_string();
        drop(s);

        // the connection closes, and the TTL runs from then
        let deadline = Instant::now() + Duration::from_secs(5);
        while h.srv.conns() != 0 {
            assert!(Instant::now() < deadline, "the connection never closed");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;

        // a reconnect, answered from the registration while the TTL lasts
        let s = h.connect_view(&r1, -1, &view).await;
        let same = s.header("phaselock-view") == view;
        drop(s);
        assert_eq!(
            same,
            ttl == Duration::from_secs(60),
            "under a TTL of {ttl:?}, the reconnect's view was the same: {same}"
        );
        h.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_grant_grants_nothing() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "create-account", "user" => "p1", "password" => "hunter2"))
        .await;
    let ann = h.token("p1").await;
    let mut s = h.connect(&ann, -1, &[]).await;
    s.live().await;

    // a granted wildcard that cuts into a parameter ends the connection
    h.accept(&admin, mutation!("c3", "grant-view", "user" => "p1", "prefix" => "patron:p1*")).await;
    let f = s.next_tagged("end").await;
    assert!(
        f[1].int() == END_GRANTOR_FAILED && f[2].str().contains("malformed selector: patron:p1*"),
        "end frame: {f:?}"
    );
    match s.try_next(Duration::from_secs(5)).await {
        Some(Err(_)) => {}
        Some(Ok(f)) => panic!("a frame after end: {f:?}"),
        None => panic!("the connection stayed open after end"),
    }

    // and a new connection is refused with the failure
    let r = h.req("GET", "/stream?since=-1", &ann, None).await;
    assert!(
        r.status == 500 && r.text().contains("malformed selector: patron:p1*"),
        "a connection under a failing grant: {} {}",
        r.status,
        r.text()
    );
    h.stop().await;
}

// guards the core's own read-only check, which stops a grant's write that slips past the bundle
#[tokio::test(flavor = "multi_thread")]
async fn the_core_refuses_a_write_from_grant() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // the grant fails closed, naming its slot, so the connection is refused
    let r = h.req("GET", "/stream?since=-1", &h.token("raw-requester").await, None).await;
    assert!(
        r.status == 500 && r.text().contains("grant reads only, and made a write"),
        "a connection under a grant that writes past the bundle: {} {}",
        r.status,
        r.text()
    );

    // the write it made reached neither the store nor the next mutation's edit
    h.accept(&admin, mutation!("c2", "notify", "patron" => "p1", "reasons" => vec!["only"])).await;
    let got = h.messages("p1").await;
    assert_eq!(got.join(","), "only,own", "the messages of the next mutation: {got:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_grants_selectors_carry_a_terminator() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("c3", "create-account", "user" => "p1", "password" => "hunter2"))
        .await;
    let ann = h.token("p1").await;

    // an exact slice is "name!", which grants the slice
    h.accept(&admin, mutation!("c4", "grant-view", "user" => "p1", "prefix" => "patron:p2!")).await;
    let r = h.req("GET", "/edits/patron:p2?after=0&before=100", &ann, None).await;
    assert_eq!(r.status, 200, "a granted slice: status {}", r.status);
    h.accept(&admin, mutation!("c5", "revoke-view", "user" => "p1", "prefix" => "patron:p2!"))
        .await;

    /* a selector is checked by its syntax alone, so one in a family no slice type declares, or
    under more parameters than its family has, is well-formed and grants what it names */
    for (i, (selector, covered)) in [
        ("nope:x!", "nope:x"),
        ("patron:p2,x!", "patron:p2,x"),
        ("patron:p2,*", "patron:p2,x"),
        ("book:*", "book"),
    ]
    .into_iter()
    .enumerate()
    {
        let grant = mutation!(&format!("w{i}"), "grant-view", "user" => "p1", "prefix" => selector);
        h.accept(&admin, grant).await;
        let r = h.req("GET", &format!("/snapshot/{covered}"), &ann, None).await;
        assert_eq!(r.status, 200, "grant returning {selector:?}: {} {}", r.status, r.text());
        let revoke =
            mutation!(&format!("v{i}"), "revoke-view", "user" => "p1", "prefix" => selector);
        h.accept(&admin, revoke).await;
    }

    /* a bare name, a malformed name, and a wildcard cutting into a parameter or after a value no
    leading parameter holds are malformed, so the registration fails closed */
    for (i, selector) in [
        "patron:p2",    // a bare name
        "patron:p2/",   // a bare name with a character no parameter holds
        "!",            // an empty name
        "patron:!",     // an empty parameter
        "patron:p/2!",  // a character no parameter holds
        "patron:*!",    // a star in a name
        "patron:p*",    // a wildcard cutting into a parameter
        "patron:p.2,*", // a '.' in a leading parameter
        ":*",           // a wildcard after an empty family
    ]
    .into_iter()
    .enumerate()
    {
        let grant = mutation!(&format!("g{i}"), "grant-view", "user" => "p1", "prefix" => selector);
        h.accept(&admin, grant).await;
        let r = h.req("GET", "/stream?since=-1", &ann, None).await;
        assert!(
            r.status == 500 && r.text().contains(&format!("malformed selector: {selector}")),
            "grant returning {selector:?}: {} {}",
            r.status,
            r.text()
        );
        let revoke =
            mutation!(&format!("r{i}"), "revoke-view", "user" => "p1", "prefix" => selector);
        h.accept(&admin, revoke).await;
    }
    h.stop().await;
}

#[test]
fn a_selector_is_valid_by_its_syntax_and_length() {
    let cases: Vec<(String, bool)> = [
        ("*", true),
        ("book", true),
        ("login", true),
        ("patron:p1", true),
        ("patron:*", true),
        ("chat:*", true),
        ("chat:acme,*", true),
        ("chat:acme,gen,*", true),
        ("chat:acme,gen.e~1", true),
        ("chat:acme-2,gen-2", true),
        ("patron:p1.", true),
        ("pa-tron:p1", true),
        ("", false),
        (":*", false),
        ("*:*", false),
        ("chat,*", false),
        ("chat*", false),
        ("chat::*", false),
        ("chat:ac*", false),
        ("chat:acme,g*", false),
        ("chat:acme,,*", false),
        ("chat:a.b,*", false),
        ("chat:a.b,gen", false),
        ("chat:acme,", false),
        ("chat:,gen", false),
        ("chat:acme:gen", false),
        ("patron:", false),
        ("patron.p1", false),
        ("patron:p1!", false),
        ("patron!", false),
        ("pa~tron:p1", false),
        ("pa.tron", false),
        ("patron:p/1", false),
        ("patron:p 1", false),
        ("patron:p%2F1", false),
    ]
    .into_iter()
    .map(|(s, want)| (s.to_string(), want))
    .chain([
        // a slice name of 510 bytes, the most there is, and one longer
        (format!("nope:{}", "a".repeat(505)), true),
        (format!("nope:{}", "a".repeat(506)), false),
        (format!("nope:{},*", "a".repeat(503)), true),
        (format!("nope:{},*", "a".repeat(504)), false),
    ])
    .collect();
    let mut failed = Vec::new();
    for (selector, want) in &cases {
        let got = valid_selector(selector);
        if got != *want {
            failed.push(format!("valid_selector({selector:?}) = {got}, want {want}"));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
