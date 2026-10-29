//! The plugins a bundle installs, as deciders and grantors reach them: the notice plugin's
//! requests, crypto randomness, and the cron install's ticks and marks.

mod common;

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, TimeZone, Utc};

use common::*;

/// whether s is a version 4 uuid, in lower-case hex
fn is_v4_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    let lengths = groups.iter().map(|g| g.len()).collect::<Vec<_>>();
    let hex = groups.iter().all(|g| g.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));
    lengths == [8, 4, 4, 4, 12]
        && hex
        && groups[2].starts_with('4')
        && groups[3].starts_with(['8', '9', 'a', 'b'])
}

/// the core's number for the test bundle's cron entry of a name
fn entry(h: &Harness, name: &str) -> usize {
    h.srv
        .core
        .cron
        .iter()
        .position(|e| e.install == "cron" && e.name == name)
        .unwrap_or_else(|| panic!("no cron entry {name}"))
}

/// decides a slot, in Unix seconds, of a cron entry of the test bundle, failing the test on a
/// hook's failure
async fn tick(h: &Harness, name: &str, slot: i64) {
    let r = h.srv.tick(entry(h, name), slot).await;
    assert!(r.status == 0, "tick {name} at {slot}: {} {}", r.status, r.errmsg);
}

/// the first slot of 2030, in Unix seconds
fn slot_2030() -> i64 {
    Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap().timestamp()
}

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_land_in_the_mutations_edit() {
    let h = start().await;
    let admin = h.admin().await;
    let before =
        h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // the requests in call order, then the decider's own write, all in one edit of the mutation
    h.accept(
        &admin,
        mutation!("c2", "notify", "patron" => "p1", "reasons" => arr!["first", "second"]),
    )
    .await;
    let got = h.messages("p1").await;
    assert!(got.join(",") == "first,second,own", "the mutation's messages: {got:?}");
    let (evs, _, status) = h.edits_range(&admin, "patron:p1", before, -1, false, 0).await;
    assert_eq!(status, 200, "edits of patron:p1");
    assert!(evs.len() == 1 && evs[0].mutation == "c2", "the mutation's edits: {evs:?}");

    // a mutation rejected after its requests leaves none of them
    let outs = h
        .mutations(
            &admin,
            &[
                mutation!(
                    "c3", "notify", "patron" => "p1", "reasons" => arr!["dropped"], "reject" => true
                ),
                mutation!("c4", "notify", "patron" => "p1", "reasons" => arr!["after"]),
            ],
        )
        .await;
    assert!(
        outs[0].kind == "reject" && outs[0].reason == "rejected after its requests",
        "expected the rejection, got {:?}",
        outs[0]
    );
    assert!(outs[1].kind == "ok", "expected the next mutation to land, got {:?}", outs[1]);
    let got = h.messages("p1").await;
    assert!(
        got.join(",") == "first,second,own,after,own",
        "the messages after a rejection: {got:?}"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_grantor_that_writes_fails_and_its_write_is_lost() {
    let h = start().await;
    let r = h.req("GET", "/stream?since=-1", &h.token("requester").await, None).await;
    assert!(
        r.status == 500 && r.text().contains("this call reads only, and made a write"),
        "a connection under a writing grant: {} {}",
        r.status,
        r.text()
    );

    // the write it made reached no mutation's edit
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "notify", "patron" => "p1", "reasons" => arr!["only"])).await;
    let got = h.messages("p1").await;
    assert!(got.join(",") == "only,own", "the messages of the next mutation: {got:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn uuids_are_fresh_and_random() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(
        &admin,
        mutation!("c2", "notify", "patron" => "p1", "reasons" => arr!["uuid", "uuid"]),
    )
    .await;
    let got = h.messages("p1").await;
    assert!(
        got.len() == 3 && is_v4_uuid(&got[0]) && is_v4_uuid(&got[1]) && got[0] != got[1],
        "two fresh version 4 uuids, then the decider's own: {got:?}"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tick_runs_its_hook_as_one_mutation() {
    let h = start().await;
    let admin = h.admin().await;
    let before =
        h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let slot = slot_2030();
    tick(&h, "reap", slot).await;

    // the request the hook made, then its own write, one edit under a label of its own
    let (evs, _, status) = h.edits_range(&admin, "patron:p1", before, -1, false, 0).await;
    assert_eq!(status, 200, "edits of patron:p1");
    assert!(
        evs.len() == 1 && evs[0].id.len() == 16 && evs[0].mutation != "c1",
        "the tick's edit: {evs:?}"
    );
    let got = h.messages("p1").await;
    assert!(
        got.len() == 2 && got[0] == "requested 2030-01-01T00:00:00.000Z",
        "the tick's messages: {got:?}"
    );
    let reason: Vec<&str> = got[1].split_whitespace().collect();
    assert!(
        reason.len() == 3 && reason[0] == "reap" && reason[1] == "2030-01-01T00:00:00.000Z",
        "the tick's own write: {reason:?}"
    );
    let now = DateTime::parse_from_rfc3339(reason[2]).map(SystemTime::from);
    assert!(
        now.as_ref().is_ok_and(|t| *t == evs[0].servertime),
        "the tick's now, against its edit's server time {:?}: {}",
        evs[0].servertime,
        reason[2]
    );

    // a slot at or below the mark was decided already, and a later one runs
    tick(&h, "reap", slot).await;
    tick(&h, "reap", slot - 3600).await;
    let got = h.messages("p1").await;
    assert!(got.len() == 2, "a refired slot ran: {got:?}");
    tick(&h, "reap", slot + 60).await;
    let got = h.messages("p1").await;
    assert!(got.len() == 4, "the next slot did not run: {got:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hook_that_throws_leaves_nothing_but_its_mark() {
    let h = start().await;
    let admin = h.admin().await;
    let before =
        h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let slot = slot_2030();
    let r = h.srv.tick(entry(&h, "broken"), slot).await;
    assert!(
        r.status == 500 && r.errmsg.contains("the broken entry"),
        "a throwing hook: {} {:?}",
        r.status,
        r.errmsg
    );

    // the slot was decided, so it does not run again, and the log moved on without it
    tick(&h, "broken", slot).await;
    let at =
        h.accept(&admin, mutation!("c2", "rename-patron", "id" => "p1", "name" => "Bea")).await;
    assert!(at == before + 1, "the next mutation landed at {at} after {before}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn entries_are_armed_once_at_startup() {
    let dir = tempfile::tempdir().expect("a data directory");
    let earliest = now_unix() / 60 * 60;
    let h = start_in(dir.path()).await;
    let latest = now_unix();

    // every entry was armed at the minute the server started, which a later arm keeps
    let marks = h.srv.arm((latest + 3600) / 60 * 60).await.marks;
    assert!(marks.len() == 3, "three entries' marks: {marks:?}");
    for &m in &marks {
        assert!(
            m == marks[0] && m >= earliest && m <= latest,
            "the marks {marks:?}, armed between {earliest} and {latest}"
        );
    }

    // a restart keeps every mark, and the slot a tick decided stays decided
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let slot = slot_2030();
    tick(&h, "reap", slot).await;
    h.stop().await;
    let h = start_in(dir.path()).await;
    let again = h.srv.arm((now_unix() + 3600) / 60 * 60).await.marks;
    assert!(
        again[entry(&h, "zoned")] == marks[entry(&h, "zoned")] && again[entry(&h, "reap")] == slot,
        "the marks after a restart: {again:?}, from {marks:?}"
    );
    tick(&h, "reap", slot).await;
    let got = h.messages("p1").await;
    assert!(got.len() == 2, "a decided slot ran again after a restart: {got:?}");
    h.stop().await;
}
