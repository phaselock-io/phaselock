//! the /stream connection: live edits, history replay, the catchups' hand-off to live, vouches,
//! the backlog and its overflow, and the connection's end with the server's

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, SystemTime};

use tokio::sync::{Notify, mpsc};

use common::*;

#[tokio::test(flavor = "multi_thread")]
async fn edits_arrive_live_one_frame_per_mutation() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;

    let mut s = h.connect(&admin, -1, &[]).await;
    assert!(
        s.header("phaselock-protocol") == "1" && s.header("phaselock-epoch").len() == 32,
        "bad headers: {:?}",
        s.headers
    );
    assert!(
        !s.header("phaselock-view").is_empty() && !s.header("phaselock-time").is_empty(),
        "missing view or time header: {:?}",
        s.headers
    );
    let live = s.live().await;

    // a new patron: one birth edit, its writes in key order, one frame
    let pos = h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert_eq!(evs.len(), 1, "expected one edit, got {evs:?}");
    let e = &evs[0];
    assert!(
        e.slice == "patron:p1"
            && e.lifecycle == BIRTH
            && e.seq == 1
            && e.position == pos
            && pos == live + 1,
        "the birth: live={live} ack={pos} {e:?}"
    );
    let keys: Vec<&str> = e.ops.iter().map(|op| op.key.as_str()).collect();
    assert!(
        keys.join(",") == "patron:p1!holds,patron:p1!messages,patron:p1!patron"
            && e.field("patron:p1!patron", "name") == "Ann",
        "the birth's writes: {:?}",
        e.ops
    );
    assert_eq!(e.mutation, "c2", "the edit carries the mutation id: {e:?}");
    let now = SystemTime::now();
    assert!(
        e.servertime >= now - Duration::from_secs(60) && e.servertime <= now,
        "servertime looks wrong: {e:?}"
    );

    // a mutation that edits two slices arrives as one frame, its edits at one position
    let pos = h
        .accept(&admin, mutation!("c3", "try-hold", "id" => "h1", "book" => "b1", "patron" => "p1"))
        .await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs.len() == 2 && evs[0].slice == "book" && evs[1].slice == "patron:p1",
        "expected book + patron edits, got {evs:?}"
    );
    for e in &evs {
        assert!(
            e.mutation == "c3" && e.position == pos && e.lifecycle == NORMAL && e.seq == 2,
            "the hold's edits: {evs:?}"
        );
    }
    assert!(
        evs[0].field("book!book:b1", "hold") == V::Bool(true)
            && evs[1].field("patron:p1!holds", "b1") == V::Bool(true),
        "the hold's writes: {evs:?}"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_commit_of_two_mutations_arrives_as_two_frames() {
    let h = start().await;
    let admin = h.admin().await;
    let pos = h.accept(&admin, mutation!("c0", "add-book", "id" => "b0", "title" => "Zero")).await;
    let mut s = h.connect(&admin, -1, &[]).await;
    assert_eq!(
        s.header("phaselock-position"),
        pos.to_string(),
        "PhaseLock-Position {:?}, want {pos}",
        s.header("phaselock-position")
    );
    s.next_tagged("live").await;

    // one POST, two mutations, one group commit: two frames on the wire
    h.mutations(
        &admin,
        &[
            mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann"),
            mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob"),
        ],
    )
    .await;
    let first = edits(&s.next_tagged("edits").await);
    let second = edits(&s.next_tagged("edits").await);
    assert!(
        first[0].slice == "patron:p1" && second[0].slice == "patron:p2",
        "expected both mutations live: {first:?} then {second:?}"
    );
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn history_replays_from_the_since_and_then_goes_live() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    let p2 = h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let p3 =
        h.accept(&admin, mutation!("c3", "rename-patron", "id" => "p1", "name" => "Anne")).await;

    // from genesis: the book's birth, the patron's birth, the rename
    let mut s = h.connect(&admin, 0, &[]).await;
    let mut all = Vec::new();
    while all.len() < 3 {
        all.extend(edits(&s.next_tagged("edits").await));
    }
    let want = ["book", "patron:p1", "patron:p1"];
    let want_seq = [1, 1, 2];
    let want_life = [BIRTH, BIRTH, NORMAL];
    for (i, e) in all.iter().enumerate() {
        assert!(
            e.slice == want[i]
                && e.position == i as i64 + 1
                && e.seq == want_seq[i]
                && e.lifecycle == want_life[i],
            "history[{i}] = {e:?}, want slice {} pos {} seq {}",
            want[i],
            i + 1,
            want_seq[i]
        );
    }
    assert_eq!(s.live().await, p3, "live frame should carry the position history ended at");

    // then live
    h.accept(&admin, mutation!("c4", "rename-patron", "id" => "p1", "name" => "Annie")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs[0].field("patron:p1!patron", "name") == "Annie",
        "expected live rename, got {evs:?}"
    );

    // resume after p2: only the rename, at p3
    let mut s2 = h.connect(&admin, p2, &[]).await;
    let evs = edits(&s2.next_tagged("edits").await);
    assert!(
        evs.len() == 1
            && evs[0].position == p3
            && evs[0].field("patron:p1!patron", "name") == "Anne",
        "resume from {p2}: got {evs:?}"
    );
    s2.next_tagged("edits").await; // the live rename
    s2.live().await;
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bootstrap_delivers_everything_above_the_view_position() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c0", "add-patron", "id" => "p0", "name" => "Ann")).await;

    // a commit lands after the view is registered and before the connection streams, once the
    // view frame is handed over
    let pos = Arc::new(AtomicI64::new(0));
    let (lander, landed, at) = (h.clone(), admin.clone(), pos.clone());
    h.srv.hooks.after_first_frame.set(phaselockdb::hooks::hook(move || {
        let (h, admin, at) = (lander.clone(), landed.clone(), at.clone());
        async move {
            let m = mutation!("c1", "rename-patron", "id" => "p0", "name" => "Anne");
            at.store(h.accept(&admin, m).await, Ordering::SeqCst);
        }
    }));
    let mut s = h.connect(&admin, -1, &[]).await;
    h.srv.hooks.after_first_frame.clear();
    let view = s.first.clone().expect("a view frame first");
    let (edited, live) = (s.next().await, s.next().await);

    // the view frame, then the commit's edits, then live at its position
    let pos = pos.load(Ordering::SeqCst);
    assert!(view[2].int() == pos - 1, "expected the view at {}, got {view:?}", pos - 1);
    assert!(
        edited[0] == "edits" && edits(&edited)[0].position == pos,
        "expected the edits at {pos}, got {edited:?}"
    );
    assert!(live[0] == "live" && live[1].int() == pos, "expected live at {pos}, got {live:?}");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cold_replay_keeps_each_mutation_in_one_frame() {
    let h = start_with(|o| o.max_mutations = COLD_BATCH as usize).await;
    let admin = h.admin().await;

    /* a book and a hold on it per pair of positions, so the hold at COLD_BATCH+1, which edits two
    slices, opens the replay's second window */
    h.accept(&admin, mutation!("c0", "add-patron", "id" => "p0", "name" => "Ann")).await;
    let mut muts = Vec::new();
    for i in 1..=COLD_BATCH / 2 + 1 {
        let book = format!("b{i}");
        muts.push(mutation!(&format!("a{book}"), "add-book", "id" => &book, "title" => &book));
        muts.push(mutation!(
            &format!("h{book}"),
            "try-hold",
            "id" => &book,
            "book" => &book,
            "patron" => "p0"
        ));
    }
    for chunk in muts.chunks(COLD_BATCH as usize) {
        h.mutations(&admin, chunk).await;
    }

    // every frame is one whole mutation: its edits share a position and an id no other frame has
    let mut s = h.connect(&admin, 0, &[]).await;
    let mut seen = std::collections::HashSet::new();
    let mut whole = false;
    loop {
        let f = s.next().await;
        if f[0] == "live" {
            break;
        }
        if f[0] != "edits" {
            continue;
        }
        let evs = edits(&f);
        let id = evs[0].mutation.clone();
        assert!(seen.insert(id.clone()), "mutation {id} split across frames");
        for e in &evs {
            assert!(
                e.mutation == id && e.position == evs[0].position,
                "frame mixes mutations: {evs:?}"
            );
        }
        if evs[0].position == COLD_BATCH + 1 && evs.len() == 2 {
            whole = true;
        }
    }
    assert!(whole, "no hold of two edits at position {}", COLD_BATCH + 1);
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_catchup_delivers_every_position_once_and_never_overflows() {
    /* the connection is held once its cold catchup is done, before it switches to streaming, while
    more commits land than its backlog holds */
    let paused = Arc::new(Notify::new());
    let resume = Arc::new(Notify::new());
    let h = start_with(|o| {
        o.max_mutations = 1500;
        o.max_stream_backlog = 4;
    })
    .await;
    let (p, r) = (paused.clone(), resume.clone());
    h.srv.hooks.before_streaming.set(phaselockdb::hooks::hook(move || {
        let (p, r) = (p.clone(), r.clone());
        async move {
            p.notify_one();
            r.notified().await;
        }
    }));
    let admin = h.admin().await;
    let muts: Vec<Mutation> = (0..1500)
        .map(
            |i| mutation!(&format!("h{i}"), "add-patron", "id" => format!("p{i}"), "name" => "Ann"),
        )
        .collect();
    let outs = h.mutations(&admin, &muts).await;
    let history = outs.last().unwrap().position;
    assert_eq!(history, 1500, "expected 1500 history positions, got {history}");

    // the cold catchup replays the history; then, while the connection is held, more commits land
    let mut s = h.connect(&admin, 0, &[]).await;
    paused.notified().await;
    let mut last = 0;
    for i in 0..300 {
        let m = mutation!(&format!("l{i}"), "rename-patron", "id" => "p1", "name" => i.to_string());
        last = h.accept(&admin, m).await;
    }
    resume.notify_one();

    /* every position arrives exactly once, in order, across the cold catchup and the hot catchup,
    and the live frame comes once, at the position the hot catchup reached, past the commits that
    landed while the connection was held */
    let mut next = 1;
    loop {
        let f = s.next().await;
        match f[0].str() {
            "edits" => {
                for e in edits(&f) {
                    assert_eq!(e.position, next, "expected position {next}, got {}", e.position);
                }
                next += 1;
            }
            "live" => {
                let at = f[1].int();
                assert_eq!(at, next - 1, "live at {at} but replay reached {}", next - 1);
                break;
            }
            "vouch" | "view" => {}
            _ => panic!("unexpected frame {f:?}"),
        }
    }
    assert_eq!(next - 1, last, "the hot catchup reached {}, the head is {last}", next - 1);

    // still connected and still live
    let m = mutation!("final", "rename-patron", "id" => "p1", "name" => "done");
    let pos = h.accept(&admin, m).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert_eq!(evs[0].position, pos, "expected live edit at {pos}, got {evs:?}");
    h.stop().await;
}

// the frame a connection read, checked against the highest vouch before it
async fn read_vouched(s: &mut Conn, vouched: &mut i64) -> V {
    let f = s.next().await;
    match f[0].str() {
        "vouch" | "live" => *vouched = (*vouched).max(f[1].int()),
        "edits" => {
            let at = edits(&f)[0].position;
            assert!(at > *vouched, "an edits frame at {at} follows a vouch at {vouched}");
        }
        _ => {}
    }
    f
}

// a vouch at N follows every edit at or below N that the connection can see
#[tokio::test(flavor = "multi_thread")]
async fn a_vouch_never_overtakes_an_edit_it_covers() {
    /* the dispatcher holds the commit it is armed for before pushing its frames, while heartbeats
    keep firing */
    let armed = Arc::new(AtomicBool::new(false));
    let (held_tx, mut held) = mpsc::unbounded_channel::<i64>();
    let release = Arc::new(Notify::new());
    let h = start_with(|o| o.heartbeat = Duration::from_millis(1)).await;
    let (a, r) = (armed.clone(), release.clone());
    h.srv.hooks.before_push.set(phaselockdb::hooks::position_hook(move |p| {
        let (a, r, held_tx) = (a.clone(), r.clone(), held_tx.clone());
        async move {
            if a.compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                let _ = held_tx.send(p as i64);
                r.notified().await;
            }
        }
    }));
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let mut s = h.connect(&h.token("p1").await, -1, &[]).await;

    // every frame read is checked against the highest vouch before it
    let mut vouched = -1;
    while read_vouched(&mut s, &mut vouched).await[0] != "live" {}

    // a visible commit is held before its frames are pushed, for many heartbeats
    armed.store(true, Ordering::SeqCst);
    let (poster, token) = (h.clone(), admin.clone());
    let posted = tokio::spawn(async move {
        let m = mutation!("c3", "rename-patron", "id" => "p1", "name" => "Anne");
        poster.mutations(&token, &[m]).await;
    });
    let pos = held.recv().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    release.notify_one();

    // its edits arrive after no vouch at or above their position
    loop {
        let f = read_vouched(&mut s, &mut vouched).await;
        if f[0] == "edits" && edits(&f)[0].position == pos {
            break;
        }
    }
    posted.await.unwrap();

    // a commit the connection cannot see is vouched for on a heartbeat
    let invisible =
        h.accept(&admin, mutation!("c4", "rename-patron", "id" => "p2", "name" => "Robert")).await;
    let mut i = 0;
    while vouched < invisible {
        assert!(i != 1000, "no vouch at {invisible}, the last at {vouched}");
        let f = read_vouched(&mut s, &mut vouched).await;
        assert!(f[0] != "edits", "an invisible commit's edits: {f:?}");
        i += 1;
    }
    assert_eq!(vouched, invisible, "vouched {vouched} past the head {invisible}");
    h.stop().await;
}

// a commit takes one place in a connection's backlog, however many mutations it carries
#[tokio::test(flavor = "multi_thread")]
async fn a_commit_of_more_mutations_than_the_backlog_holds_keeps_its_connection() {
    let h = start_with(|o| o.max_stream_backlog = 1).await;
    let admin = h.admin().await;
    let mut s = h.connect(&admin, -1, &[]).await;
    s.live().await;

    // one request's mutations commit together, each in its own edits frame
    let outs = h
        .mutations(
            &admin,
            &[
                mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann"),
                mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob"),
                mutation!("c3", "add-patron", "id" => "p3", "name" => "Cy"),
            ],
        )
        .await;
    for o in &outs {
        let at = edits(&s.next_tagged("edits").await)[0].position;
        assert_eq!(at, o.position, "expected the edits at {}, got {at}", o.position);
    }

    // the connection is still live
    let pos =
        h.accept(&admin, mutation!("c4", "rename-patron", "id" => "p1", "name" => "Anne")).await;
    let at = edits(&s.next_tagged("edits").await)[0].position;
    assert_eq!(at, pos, "expected the edits at {pos}, got {at}");
    h.stop().await;
}

/* a connection whose backlog is full when a commit comes ends with an overflow, after what was
queued before it, and the commits after it pass the connection by */
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_cannot_keep_up_ends_with_an_overflow() {
    /* the connection is held as it wakes for the commit it is armed for, before it takes its
    backlog */
    let armed = Arc::new(AtomicBool::new(false));
    let (held_tx, mut held) = mpsc::unbounded_channel::<()>();
    let release = Arc::new(Notify::new());
    let h = start_with(|o| o.max_stream_backlog = 1).await;
    let (a, r) = (armed.clone(), release.clone());
    h.srv.hooks.before_forward.set(phaselockdb::hooks::hook(move || {
        let (a, r, held_tx) = (a.clone(), r.clone(), held_tx.clone());
        async move {
            if a.compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                let _ = held_tx.send(());
                r.notified().await;
            }
        }
    }));
    let admin = h.admin().await;
    let mut s = h.connect(&admin, -1, &[]).await;
    s.live().await;

    /* while the connection is held with one commit in its backlog, the next overflows it, and the
    one after that finds it ended */
    armed.store(true, Ordering::SeqCst);
    let first =
        h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    held.recv().await.unwrap();
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;
    h.accept(&admin, mutation!("c3", "add-patron", "id" => "p3", "name" => "Cy")).await;
    release.notify_one();

    // the connection sends the first commit's edits, then the overflow
    let at = edits(&s.next_tagged("edits").await)[0].position;
    assert_eq!(at, first, "expected the edits at {first}, got {at}");
    let f = s.next_tagged("end").await;
    assert_eq!(f[1].int(), END_OVERFLOW, "expected an overflow, got {f:?}");

    // the server goes on
    h.accept(&admin, mutation!("c4", "add-patron", "id" => "p4", "name" => "Di")).await;
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_servers_end_ends_its_open_connections() {
    let h = start().await;
    let mut s = h.connect(&h.admin().await, -1, &[]).await;
    s.live().await;

    // the server's lifetime ends, and so does every request under it, at once
    h.srv.cancel();
    assert!(
        s.ends_within(Duration::from_secs(2)).await,
        "an open connection outlived the server's lifetime"
    );

    // the server then closes cleanly
    h.stop().await;
}
