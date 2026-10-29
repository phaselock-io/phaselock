//! The reads beside the stream: /snapshot's blobs and /edits' pages, and the grant they are
//! checked against.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use common::*;

/// the positions of edits, in order
fn positions(evs: &[Edit]) -> Vec<i64> {
    evs.iter().map(|e| e.position).collect()
}

/* A snapshot's visible is the last position any slice under its selector changed, a dead slice's
death included and other slices' edits not, so a client caught up to it holds what the blob
does. */
#[tokio::test(flavor = "multi_thread")]
async fn visible_is_the_last_change_under_the_selector() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let renamed =
        h.accept(&admin, mutation!("c2", "rename-patron", "id" => "p1", "name" => "Anne")).await;
    h.accept(&admin, mutation!("c3", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let removed = h.accept(&admin, mutation!("c4", "remove-patron", "id" => "p2")).await;
    let head = h.accept(&admin, mutation!("c5", "add-book", "id" => "b1", "title" => "Dune")).await;

    // the family's last change is p2's death, which its header does not name
    let fam = h.snapshot(&admin, "patron:*").await;
    assert!(
        fam.header["visible"].int() == removed && fam.position == head,
        "family: visible {:?}, position {}; want {removed}, {head}",
        fam.header["visible"],
        fam.position
    );
    assert!(!fam.slices.contains_key("patron:p2"), "the dead p2 is named: {:?}", fam.slices);

    // an exact selector's is its own slice's last edit, live or dead
    let p1 = h.snapshot(&admin, "patron:p1").await;
    assert_eq!(p1.header["visible"].int(), renamed, "p1: visible");
    let p2 = h.snapshot(&admin, "patron:p2").await;
    assert_eq!(p2.header["visible"].int(), removed, "p2: visible");

    // and a slice never born has none
    let p9 = h.snapshot(&admin, "patron:p9").await;
    assert_eq!(p9.header["visible"].int(), 0, "p9: visible");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_is_the_selectors_state_at_a_position() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c3", "rename-patron", "id" => "p1", "name" => "Anne")).await;
    let pos = h.accept(&admin, mutation!("c4", "add-patron", "id" => "p2", "name" => "Bob")).await;

    let one = h.snapshot(&admin, "patron:p1").await;
    assert!(
        one.header["selector"] == "patron:p1"
            && one.position >= pos
            && one.header["epoch"] == h.epoch(),
        "header: {:?}",
        one.header
    );

    // the snapshot response's epoch, which the blob's matches, is the stream's
    let s = h.connect(&admin, -1, &[]).await;
    let epoch = s.header("phaselock-epoch");
    assert!(
        one.header["epoch"] == epoch,
        "snapshot epoch {:?}, stream epoch {epoch:?}",
        one.header["epoch"]
    );
    assert_eq!(one.keys.join(","), "patron:p1!holds,patron:p1!messages,patron:p1!patron", "keys");
    assert!(one.records["patron:p1!patron"]["name"] == "Anne", "value: {:?}", one.records);

    // a family blob holds every slice, contiguous per slice, and names every live member with
    // its seq
    let fam = h.snapshot(&admin, "patron:*").await;
    assert!(
        fam.keys.len() == 6
            && fam.keys[0].starts_with("patron:p1!")
            && fam.keys[5].starts_with("patron:p2!"),
        "family keys: {:?}",
        fam.keys
    );
    assert!(
        fam.slices.len() == 2
            && fam.slices.get("patron:p1") == Some(&2)
            && fam.slices.get("patron:p2") == Some(&1),
        "family slices: {:?}",
        fam.slices
    );
    assert!(
        one.slices.get("patron:p1") == Some(&2) && one.slices.len() == 1,
        "exact slices: {:?}",
        one.slices
    );

    // the selector "*" is everything
    let all = h.snapshot(&admin, "*").await;
    assert!(
        all.keys.len() == 7 && all.slices.len() == 3 && all.header["selector"] == "*",
        "everything: {} keys, slices {:?}",
        all.keys.len(),
        all.slices
    );
    let p1 = h.token("p1").await;
    let status = h.req("GET", "/snapshot/*", &p1, None).await.status;
    assert_eq!(status, 403, "everything for p1");

    // the position is consistent with the log: a later write is not in an earlier cut
    let book = h.snapshot(&admin, "book").await;
    assert_eq!(book.keys.len(), 1, "book keys: {:?}", book.keys);
    let later =
        h.accept(&admin, mutation!("c5", "add-book", "id" => "b2", "title" => "Emma")).await;
    let book2 = h.snapshot(&admin, "book").await;
    assert!(
        book2.keys.len() == 2 && book2.position >= later,
        "book after write: {:?} @ {}",
        book2.keys,
        book2.position
    );

    // a value travels in store format: the blob holds the bytes the edit carried
    let (evs, _, _) = h.edits_range(&admin, "book", later - 1, -1, false, 0).await;
    assert!(
        decode(&book2.raw["book!book:b2"]) == evs[0].sets["book!book:b2"],
        "the blob's value {:?}, the edit's {:?}",
        book2.records["book!book:b2"],
        evs[0].sets
    );

    // snapshots are authorized against the view
    let anon = "";
    let status = h.req("GET", "/snapshot/patron:p1", anon, None).await.status;
    assert_eq!(status, 403, "anonymous snapshot of a patron");
    let status = h.req("GET", "/snapshot/book", anon, None).await.status;
    assert_eq!(status, 200, "anonymous snapshot of book");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_edits_page_is_a_range_of_the_selectors_edits() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await; // 1
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await; // 2
    for i in 0..5 {
        let m = mutation!(&format!("r{i}"), "rename-patron", "id" => "p1", "name" => i.to_string());
        h.accept(&admin, m).await; // 3..7
    }
    let m = mutation!("c3", "rename-patron", "id" => "p2", "name" => "Robert");
    let last = h.accept(&admin, m).await; // 8
    let head = last + 1; // a position the client does not have yet
    let at = |evs: &[Edit], want: &[i64]| positions(evs) == want;

    // forward: only p1's edits, ascending, range exhausted in one page
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, head, false, 0).await;
    assert!(
        at(&evs, &[1, 3, 4, 5, 6, 7]) && scanned == head,
        "forward: {:?}, scanned {scanned}",
        positions(&evs)
    );
    for i in 1..evs.len() {
        assert!(
            evs[i].slice == "patron:p1" && evs[i].seq == evs[i - 1].seq + 1,
            "forward order/seq: {evs:?}"
        );
    }

    // both bounds are exclusive: positions the client holds
    let (evs, _, _) = h.edits_range(&admin, "patron:p1", 3, 5, false, 0).await;
    assert!(at(&evs, &[4]), "bounds: {evs:?}");

    // reverse: descending, scanned is the next before
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, head, true, 0).await;
    assert!(
        at(&evs, &[7, 6, 5, 4, 3, 1]) && scanned == 0,
        "reverse: {:?} scanned {scanned}",
        positions(&evs)
    );

    // paging with max: the scanned value plugs straight into the next request, in both
    // directions, with no arithmetic
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, head, false, 3).await;
    assert!(
        at(&evs, &[1, 3, 4]) && scanned == 4,
        "forward page: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", scanned, head, false, 3).await;
    assert!(
        at(&evs, &[5, 6, 7]) && scanned == 7,
        "forward page 2: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", scanned, head, false, 3).await;
    assert!(
        evs.is_empty() && scanned == head,
        "forward page 3: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, head, true, 3).await;
    assert!(
        at(&evs, &[7, 6, 5]) && scanned == 5,
        "reverse page: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, scanned, true, 3).await;
    assert!(
        at(&evs, &[4, 3, 1]) && scanned == 1,
        "reverse page 2: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 0, scanned, true, 3).await;
    assert!(
        evs.is_empty() && scanned == 0,
        "reverse page 3: {:?} scanned {scanned}",
        positions(&evs)
    );

    // the slice must be visible to the principal
    let p1 = h.token("p1").await;
    let (_, _, status) = h.edits_range(&p1, "patron:p2", 0, head, false, 0).await;
    assert_eq!(status, 403, "invisible slice");
    let (_, _, status) = h.edits_range(&p1, "patron:p1", 0, head, false, 0).await;
    assert_eq!(status, 200, "own slice");

    /* Both bounds are optional: the start of the log and the head.  At the head, scanned is the
    last position delivered, or after if nothing was. */
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", -1, -1, false, 0).await;
    assert!(
        at(&evs, &[1, 3, 4, 5, 6, 7]) && scanned == 7,
        "unbounded forward: {:?}, scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", 7, -1, false, 0).await;
    assert!(
        evs.is_empty() && scanned == 7,
        "empty at head: {:?}, scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", -1, -1, true, 0).await;
    assert!(
        at(&evs, &[7, 6, 5, 4, 3, 1]) && scanned == 0,
        "unbounded reverse: {:?}, scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:p1", -1, 4, false, 0).await;
    assert!(at(&evs, &[1, 3]) && scanned == 4, "no after: {:?} scanned {scanned}", positions(&evs));

    // a family selector interleaves its slices in position order
    let (evs, scanned, _) = h.edits_range(&admin, "patron:*", 0, head, true, 4).await;
    assert!(
        at(&evs, &[8, 7, 6, 5]) && scanned == 5,
        "family reverse page: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "patron:*", 0, scanned, true, 0).await;
    assert!(
        at(&evs, &[4, 3, 2, 1]) && scanned == 0,
        "family reverse page 2: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, _, _) = h.edits_range(&admin, "patron:*", 0, 3, false, 0).await;
    assert!(
        at(&evs, &[1, 2]) && evs[0].slice == "patron:p1" && evs[1].slice == "patron:p2",
        "family bounds: {evs:?}"
    );

    // "*" is every slice; only a view granting "*" covers it, and a selector must be well formed
    let (evs, _, _) = h.edits_range(&admin, "*", 0, head, false, 0).await;
    assert!(
        evs.len() == 8 && evs[0].position == 1 && evs[7].position == 8,
        "everything: {:?}",
        positions(&evs)
    );
    let (_, _, status) = h.edits_range(&p1, "*", 0, head, false, 0).await;
    assert_eq!(status, 403, "everything for p1");
    let (_, _, status) = h.edits_range(&p1, "patron:*", 0, head, false, 0).await;
    assert_eq!(status, 403, "family for p1");
    for bad in ["", "patron:", "patron:p1!", "patron*", "patron:p*", "pat*ron", "*:patron"] {
        let (_, _, status) = h.edits_range(&admin, bad, 0, head, false, 0).await;
        assert_eq!(status, 400, "selector {bad:?}");
    }
}

/* A page of /edits holds max edits and the rest of the last one's position, so it never splits a
mutation's edits, in either direction. */
#[tokio::test(flavor = "multi_thread")]
async fn an_edits_page_never_splits_a_mutation() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await; // 1
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await; // 2
    let m = mutation!("c3", "try-hold", "id" => "h1", "book" => "b1", "patron" => "p1");
    let hold = h.accept(&admin, m).await; // 3, two edits

    let (evs, scanned, _) = h.edits_range(&admin, "*", 0, hold + 1, false, 3).await;
    assert!(
        positions(&evs) == [1, 2, 3, 3] && scanned == 3,
        "a page ending inside a mutation: {:?} scanned {scanned}",
        positions(&evs)
    );
    let (evs, scanned, _) = h.edits_range(&admin, "*", 2, hold + 1, false, 1).await;
    assert!(
        positions(&evs) == [3, 3] && evs[0].slice == "book" && scanned == 3,
        "a page of one mutation's edits: {evs:?} scanned {scanned}"
    );
    let (evs, scanned, _) = h.edits_range(&admin, "*", 0, hold + 1, true, 1).await;
    assert!(
        positions(&evs) == [3, 3]
            && evs[0].slice == "book"
            && evs[1].slice == "patron:p1"
            && scanned == 3,
        "a reverse page of one mutation's edits: {evs:?} scanned {scanned}"
    );
}

/* /snapshot and /edits check the grant as of what they read, so a revocation that lands after the
request registers and before the read hides the selector. */
#[tokio::test(flavor = "multi_thread")]
async fn a_read_after_a_revocation_is_refused() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("c3", "create-account", "user" => "p1", "password" => "hunter2"))
        .await;
    let ann = h.token("p1").await;
    let reads = ["/snapshot/patron:p2", "/edits/patron:p2"];

    // lands a mutation once, as an admin, when the next read is about to run
    let before_the_read = |m: Mutation| {
        let h2 = h.clone();
        let admin = admin.clone();
        let fired = Arc::new(AtomicBool::new(false));
        h.srv.hooks.before_read.set(phaselockdb::hooks::hook(move || {
            let h = h2.clone();
            let admin = admin.clone();
            let m = m.clone();
            let first = !fired.swap(true, Ordering::SeqCst);
            async move {
                if first {
                    h.req("POST", "/mutations", &admin, Some(m.encode(None))).await;
                }
            }
        }));
    };

    // each read lands between a grant and its revocation
    for (i, path) in reads.iter().enumerate() {
        let grant =
            mutation!(&format!("g{i}"), "grant-view", "user" => "p1", "prefix" => "patron:p2!");
        h.accept(&admin, grant).await;
        let r = h.req("GET", path, &ann, None).await;
        assert_eq!(r.status, 200, "{path} while granted: {}", r.text());
        before_the_read(mutation!(
            &format!("r{i}"),
            "revoke-view",
            "user" => "p1",
            "prefix" => "patron:p2!"
        ));
        let r = h.req("GET", path, &ann, None).await;
        assert_eq!(r.status, 403, "{path} revoked before the read: {}", r.text());
    }

    // a token revoked before the read is refused
    before_the_read(mutation!("rs", "revoke-sessions", "user" => "p1"));
    let r = h.req("GET", "/snapshot/patron:p1", &ann, None).await;
    assert_eq!(r.status, 401, "a snapshot whose token was revoked before the read: {}", r.text());

    h.stop().await;
}
