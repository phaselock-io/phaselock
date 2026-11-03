//! The edits a decider's writes make: a slice's births, deaths, and erasures, the write gate that
//! checks each key and slice name, and the counters and orders a slice's keys keep.

mod common;

use common::*;
use phaselockdb::mp::Writer;
use std::time::Duration;

/// a slice's edits, all of them
async fn slice_edits(h: &Harness, token: &str, slice: &str) -> Vec<Edit> {
    h.edits_range(token, slice, -1, -1, false, 0).await.0
}

/// a notify mutation for patron p1, whose decider acts on each reason
fn notify(id: &str, reasons: Vec<&str>) -> Mutation {
    mutation!(id, "notify", "patron" => "p1", "reasons" => reasons)
}

/// an add-book mutation whose book id is the bytes given, UTF-8 or not
fn add_book(id: &str, book: &[u8]) -> Vec<u8> {
    let mut w = Writer::new();
    w.array(4);
    w.nil();
    w.nil();
    w.bin(&label(id));
    w.map(3);
    w.str(b"type");
    w.str(b"add-book");
    w.str(b"id");
    w.str(book);
    w.str(b"title");
    w.str(b"T");
    w.into_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn an_erasure_deletes_the_slices_history() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "rename-patron", "id" => "p1", "name" => "Anne")).await;
    h.accept(&admin, mutation!("c3", "add-patron", "id" => "p2", "name" => "Bob")).await;
    let pos = h.accept(&admin, mutation!("c4", "forget-patron", "id" => "p1")).await;

    // the death is all that remains of the slice, at its seq; the other slice is untouched
    let evs = slice_edits(&h, &admin, "patron:p1").await;
    assert!(
        evs.len() == 1
            && evs[0].lifecycle == DEATH
            && evs[0].ops.is_empty()
            && evs[0].seq == 3
            && evs[0].position == pos,
        "after erasure: {evs:?}"
    );
    let evs = slice_edits(&h, &admin, "patron:p2").await;
    assert!(evs.len() == 1, "other slice: {evs:?}");

    /* The slice's state is gone, and its edit bytes are the death's alone: the /edits page of one
    edit is the edit inside ["edits", [edit]], whose framing is 8 bytes. */
    let dead = h.snapshot(&admin, "patron:p1").await;
    let page = h.req("GET", "/edits/patron:p1", &admin, None).await.body;
    assert!(
        dead.records.is_empty() && dead.header["edit_bytes"].int() == page.len() as i64 - 8,
        "dead slice: {:?} {:?}, the death {} bytes",
        dead.records,
        dead.header,
        page.len() - 8
    );

    // a replay from the start delivers the death alone, whose seq shows the gap
    let mut s = h.connect(&admin, 0, &[]).await;
    let mut p1 = Vec::new();
    loop {
        let f = s.next().await;
        if f[0] == "live" {
            break;
        }
        if f[0] != "edits" {
            continue;
        }
        p1.extend(edits(&f).into_iter().filter(|e| e.slice == "patron:p1"));
    }
    assert!(p1.len() == 1 && p1[0].seq == 3, "replayed: {p1:?}");

    // a rebirth takes the next seq, and a plain death keeps its slice's history
    h.accept(&admin, mutation!("c5", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let evs = slice_edits(&h, &admin, "patron:p1").await;
    assert!(
        evs.len() == 2 && evs[1].lifecycle == BIRTH && evs[1].seq == 4,
        "after rebirth: {evs:?}"
    );
    h.accept(&admin, mutation!("c6", "remove-patron", "id" => "p2")).await;
    let evs = slice_edits(&h, &admin, "patron:p2").await;
    assert!(evs.len() == 2, "after a plain death: {evs:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_slice_is_born_again_under_its_name() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p2", "name" => "Bob")).await;

    // a bootstrap presents no token and gets the view frame first
    let mut s = h.connect(&admin, -1, &[]).await;
    let v = &s.first;
    assert!(
        v.as_ref().is_some_and(|v| strs(&v[3]).join(",") == "*" && v[2].int() == 2),
        "first view frame: {v:?}"
    );
    s.live().await;
    let pos = h.accept(&admin, mutation!("c3", "remove-patron", "id" => "p1")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs.len() == 1
            && evs[0].lifecycle == DEATH
            && evs[0].slice == "patron:p1"
            && evs[0].position == pos
            && evs[0].ops.is_empty(),
        "expected death, got {evs:?}"
    );
    assert!(evs[0].seq == 2, "death takes the next seq: {evs:?}");

    // the deleted slice is gone from the family's blob and its keys are gone
    let fam = h.snapshot(&admin, "patron:*").await;
    assert!(
        fam.slices.len() == 1 && fam.slices.get("patron:p2") == Some(&1),
        "slices after death: {:?}",
        fam.slices
    );
    let blob = h.snapshot(&admin, "patron:p1").await;
    assert!(blob.records.is_empty(), "deleted slice still has state: {:?}", blob.records);

    // rebirth under the same name, its seqs dense across the death
    h.accept(&admin, mutation!("c4", "add-patron", "id" => "p1", "name" => "Ann II")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs.len() == 1
            && evs[0].lifecycle == BIRTH
            && evs[0].field("patron:p1!patron", "name") == "Ann II",
        "expected rebirth, got {evs:?}"
    );
    assert!(evs[0].seq == 3, "seq continues across lives: {evs:?}");
    let blob = h.snapshot(&admin, "patron:p1").await;
    assert!(
        blob.records.contains_key("patron:p1!patron"),
        "reborn slice has no state: {:?}",
        blob.records
    );
}

/* A mutation that deletes a slice and writes it again makes one edit, a birth, which clears the
slice and carries only what was written after the deletion. */
#[tokio::test(flavor = "multi_thread")]
async fn a_deletion_and_rewrite_is_one_birth() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let hold = mutation!("c3", "try-hold", "id" => "h1", "book" => "b1", "patron" => "p1");
    h.accept(&admin, hold).await;
    let mut s = h.connect(&admin, -1, &[]).await;
    s.live().await;

    let pos =
        h.accept(&admin, mutation!("c4", "reset-patron", "id" => "p1", "name" => "Bea")).await;
    let evs = edits(&s.next_tagged("edits").await);
    assert!(
        evs.len() == 1 && evs[0].lifecycle == BIRTH && evs[0].seq == 3 && evs[0].position == pos,
        "the reset: {evs:?}"
    );
    assert!(
        evs[0].dels.is_empty()
            && evs[0].ops.len() == 3
            && evs[0].field("patron:p1!patron", "name") == "Bea",
        "the reset's writes: {:?}",
        evs[0].ops
    );
    let holds = h.snapshot(&admin, "patron:p1").await.records["patron:p1!holds"].clone();
    assert!(holds.map().is_empty(), "the hold survived the reset: {holds:?}");
}

/* Deleting a slice that is unborn, or already deleted, is no edit, and a mutation that edits
nothing takes no position. */
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_slice_that_is_not_live_is_no_edit() {
    let h = start().await;
    let admin = h.admin().await;
    let head = h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    let at = h.accept(&admin, mutation!("c2", "close-shelf", "branch" => "x")).await;
    assert_eq!(at, head, "closing an unborn shelf landed at {at} after {head}");
    h.accept(&admin, mutation!("c3", "lend", "branch" => "x", "patron" => "p1")).await;
    let closed = h.accept(&admin, mutation!("c4", "close-shelf", "branch" => "x")).await;
    let at = h.accept(&admin, mutation!("c5", "close-shelf", "branch" => "x")).await;
    assert_eq!(at, closed, "closing a closed shelf landed at {at} after {closed}");
    let evs = slice_edits(&h, &admin, "shelf:x").await;
    assert!(
        evs.len() == 2 && evs[0].lifecycle == BIRTH && evs[1].lifecycle == DEATH,
        "the shelf's edits: {evs:?}"
    );
}

// a key a mutation writes twice appears in its edit once, with its last value
#[tokio::test(flavor = "multi_thread")]
async fn a_key_written_twice_is_one_operation() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    let pos = h.accept(&admin, notify("c2", vec!["first", "second"])).await;
    let (evs, _, _) = h.edits_range(&admin, "patron:p1", pos - 1, -1, false, 0).await;
    assert!(
        evs.len() == 1
            && evs[0].ops.len() == 1
            && strs(&evs[0].sets["patron:p1!messages"]).join(",") == "first,second,own",
        "the notice's edit: {evs:?}"
    );
}

// a decider that throws after writing, or writes a key under no slice name, leaves nothing
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_decider_leaves_nothing() {
    let h = start().await;
    let admin = h.admin().await;
    let head = h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // a key with a control character fails its write
    let dune = mutation!("c2", "add-book", "id" => "b\x01", "title" => "Dune");
    let o = h.mutations(&admin, &[dune]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("control character"),
        "a key with a control character: {o:?}"
    );

    // a key under no slice name fails its write, after another write
    let stray = notify("c5", vec!["first", "set patron:p1,!messages"]);
    let o = h.mutations(&admin, &[stray]).await.remove(0);
    assert!(
        o.kind == "reject"
            && o.reason.contains("key patron:p1,!messages has no slice name before its first '!'"),
        "a key under no slice name: {o:?}"
    );

    // so does deleting a slice by a malformed name
    let o = h.mutations(&admin, &[notify("c6", vec!["first", "delete patron:p1/x"])]).await;
    let o = &o[0];
    assert!(
        o.kind == "reject" && o.reason.contains("patron:p1/x is not a slice name"),
        "deleting a malformed slice name: {o:?}"
    );

    // a rejection after writes, the plugin's requests among them
    let reject =
        mutation!("c3", "notify", "patron" => "p1", "reasons" => vec!["x"], "reject" => true);
    let o = h.mutations(&admin, &[reject]).await.remove(0);
    assert!(o.kind == "reject", "a rejection after writes: {o:?}");
    let at = h.accept(&admin, mutation!("c4", "close-shelf", "branch" => "none")).await;
    assert_eq!(at, head, "the failures took positions: {at} after {head}");
    let m = h.snapshot(&admin, "patron:p1").await.records["patron:p1!messages"].clone();
    assert!(m.arr().is_empty(), "a rejection's writes landed: {m:?}");
}

// a key of a declared slice that no key template names lands as inert bytes beside its slice's keys
#[tokio::test(flavor = "multi_thread")]
async fn a_key_no_template_names_lands() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, notify("c2", vec!["stray"])).await;
    let records = h.snapshot(&admin, "patron:p1").await.records;
    let stray = &records["patron:p1!stray"];
    assert_eq!(strs(stray).join(","), "stray", "the stray key: {stray:?}");
    let messages = &records["patron:p1!messages"];
    assert_eq!(strs(messages).join(","), "own", "the messages beside it: {messages:?}");
}

/* The write gate checks a key's slice, and a slice deleted, by the syntax of a slice name alone: a
well-formed name lands whatever its family and number of parameters, and a malformed one fails its
write. */
#[tokio::test(flavor = "multi_thread")]
async fn the_write_gate_checks_slice_names_by_syntax() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // a key in a family no slice type declares, and one under too many parameters, land
    h.accept(&admin, notify("c2", vec!["set nope:a!k", "set patron:p1,x!k"])).await;
    for (slice, key) in [("nope:a", "nope:a!k"), ("patron:p1,x", "patron:p1,x!k")] {
        let got = strs(&h.snapshot(&admin, slice).await.records[key]);
        assert_eq!(got.join(","), format!("set {key}"), "the key {key}: {got:?}");
    }

    // and their slices delete
    h.accept(&admin, notify("c3", vec!["delete nope:a", "delete patron:p1,x"])).await;
    for slice in ["nope:a", "patron:p1,x"] {
        let b = h.snapshot(&admin, slice).await;
        assert!(
            b.records.is_empty() && b.slices.is_empty(),
            "the deleted slice {slice}: {:?} {:?}",
            b.records,
            b.slices
        );
    }

    // a key under no slice name fails its write
    for (i, key) in [
        "patron:p1",      // no '!'
        "!seq:patron:p1", // an engine-reserved key
        ":p1!k",          // an empty family
        "patron:!k",      // an empty parameter
        "patron:a,,b!k",  // an empty parameter between two others
        "patron:p/1!k",   // a character no parameter holds
        "patron:a.b,c!k", // a '.' in a parameter before the last
    ]
    .into_iter()
    .enumerate()
    {
        let set = format!("set {key}");
        let o =
            h.mutations(&admin, &[notify(&format!("k{i}"), vec![set.as_str()])]).await.remove(0);
        assert!(
            o.kind == "reject"
                && o.reason.contains(&format!("key {key} has no slice name before its first '!'")),
            "writing {key:?}: {o:?}"
        );
    }

    // and a malformed slice name fails its deletion
    for (i, slice) in ["", "patron:", "patron:p1!", "patron:p/1", "patron:a.b,c", "patron:*"]
        .into_iter()
        .enumerate()
    {
        let delete = format!("delete {slice}");
        let o =
            h.mutations(&admin, &[notify(&format!("d{i}"), vec![delete.as_str()])]).await.remove(0);
        assert!(
            o.kind == "reject" && o.reason.contains(&format!("{slice} is not a slice name")),
            "deleting {slice:?}: {o:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn keys_and_slice_names_hold_at_most_511_bytes() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;

    // a slice name of 510 bytes holds its shortest key, of 511, which lands
    let slice = format!("nope:{}", "a".repeat(505));
    let set = format!("set {slice}!");
    h.accept(&admin, notify("c2", vec![set.as_str()])).await;
    let got = strs(&h.snapshot(&admin, &slice).await.records[&format!("{slice}!")]);
    assert_eq!(got.join(","), set, "the key of 511 bytes: {got:?}");

    // a key of 512 bytes fails its write
    let set = format!("set {slice}!k");
    let o = h.mutations(&admin, &[notify("c3", vec![set.as_str()])]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("is 512 bytes, over 511"),
        "writing a key of 512 bytes: {o:?}"
    );

    // and a slice name of 511 fails its deletion
    let long = format!("{slice}a");
    let delete = format!("delete {long}");
    let o = h.mutations(&admin, &[notify("c4", vec![delete.as_str()])]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains(&format!("{} is not a slice name", &long[..200])),
        "deleting a slice name of 511 bytes: {o:?}"
    );

    // a selector naming one is malformed wherever a client gives one
    for path in [
        format!("/snapshot/{long}"),
        format!("/edits/{long}"),
        format!("/stream?since=0&want={long}"),
    ] {
        let status = h.req("GET", &path, &admin, None).await.status;
        assert_eq!(status, 400, "GET {}... with a selector of 511 bytes: {status}", &path[..20]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slice_snapshot_counts_its_bytes() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await;
    h.accept(&admin, mutation!("c2", "rename-patron", "id" => "p1", "name" => "Anne")).await;

    /* the slice's edits as the log holds them: the /edits page, less each frame's 8 bytes of
    ["edits", [edit]] */
    let page = h.req("GET", "/edits/patron:p1", &admin, None).await.body;
    let edit_bytes = page.len() as i64 - 2 * 8;

    let blob = h.snapshot(&admin, "patron:p1").await;
    let state_bytes: i64 = blob.keys.iter().map(|k| (k.len() + blob.raw[k].len()) as i64).sum();
    assert!(
        blob.slices.get("patron:p1") == Some(&2) && blob.slices.len() == 1,
        "slices in header: {:?}",
        blob.slices
    );
    assert_eq!(
        blob.header["edit_bytes"].int(),
        edit_bytes,
        "edit_bytes {:?}, expected {edit_bytes}",
        blob.header["edit_bytes"]
    );
    assert!(
        blob.header["state_bytes"].int() == state_bytes && state_bytes != 0,
        "state_bytes {:?}, expected {state_bytes}",
        blob.header["state_bytes"]
    );

    // family blobs carry no per-slice counters
    let fam = h.snapshot(&admin, "patron:*").await;
    assert!(fam.header.get("state_bytes").is_none(), "family blob should not carry slice counters");

    // a death zeroes state and still counts its own edit's bytes
    h.accept(&admin, mutation!("c3", "remove-patron", "id" => "p1")).await;
    let dead = h.snapshot(&admin, "patron:p1").await;
    assert!(
        dead.header["state_bytes"].int() == 0 && dead.header["edit_bytes"].int() > edit_bytes,
        "after death: {:?}",
        dead.header
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slice_name_fills_its_template() {
    let h = start().await;
    let admin = h.admin().await;

    // a family template's terminal parameter may hold . and ~
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p.1~x", "name" => "Ann")).await;
    let records = h.snapshot(&admin, "patron:p.1~x").await.records;
    assert!(records.contains_key("patron:p.1~x!patron"), "patron:p.1~x was not written");

    /* A decider reading through a parameter that no slice name could hold is rejected before it
    writes anything. */
    let outs = h
        .mutations(
            &admin,
            &[
                mutation!("c2", "add-patron", "id" => "p/1", "name" => "Bob"),
                mutation!("c3", "add-patron", "id" => "", "name" => "Cy"),
            ],
        )
        .await;
    for (i, id) in ["p/1", ""].into_iter().enumerate() {
        assert!(
            outs[i].kind == "reject" && outs[i].reason.contains(&format!("patron: patron {id:?}")),
            "add-patron {id:?}: {:?}",
            outs[i]
        );
    }

    // a dev bundle's error carries its stack, mapped through the bundle's source map
    assert!(
        outs[0].reason.contains("(db.ts:") && !outs[0].reason.contains("bundle.js:"),
        "an unmapped stack: {}",
        outs[0].reason
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_decider_past_its_deadline_reports_where_it_was() {
    let h = start_with(|o| o.call_limit = Duration::from_millis(200)).await;
    let admin = h.admin().await;

    // the interrupted call's error carries its stack, mapped through the bundle's source map
    let o = h.mutations(&admin, &[mutation!("c1", "spin")]).await.remove(0);
    assert!(o.kind == "reject" && o.reason.contains("interrupted"), "the spin: {o:?}");
    assert!(
        o.reason.contains("(db.ts:") && !o.reason.contains("bundle.js:"),
        "an unmapped stack: {}",
        o.reason
    );

    // and the writer goes on
    h.accept(&admin, mutation!("c2", "add-patron", "id" => "p1", "name" => "Ann")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_holds_no_control_character_or_lone_surrogate() {
    let h = start().await;
    let admin = h.admin().await;

    // a key's terminal parameter may hold any other text, the empty string included
    let ok = ["b\u{1F600}", "b\u{FF0C}c", "b\u{200D}c", "b\u{00A0}c", ""];
    for (i, id) in ok.into_iter().enumerate() {
        let book = mutation!(&format!("ok{i}"), "add-book", "id" => id, "title" => "T");
        h.accept(&admin, book).await;
    }
    let records = h.snapshot(&admin, "book").await.records;
    for id in ok {
        assert!(records.contains_key(&format!("book!book:{id}")), "book {id:?} was not written");
    }

    // a key holding a control character or a lone surrogate is refused, and its mutation with it
    let bad: [&[u8]; 6] =
        [b"a\nb", b"a\tb", b"a\x7fb", "a\u{85}b".as_bytes(), b"a\xed\xa0\x80b", b"a\xed\xb0\x80b"];
    for (i, id) in bad.into_iter().enumerate() {
        let (status, outs) = h.mutations_raw_status(&admin, add_book(&format!("bad{i}"), id)).await;
        assert_eq!(status, 200, "mutations: status {status}");
        let o = &outs[0];
        assert!(
            o.kind == "reject"
                && o.reason.contains("holds a control character or a lone surrogate"),
            "add-book {:?}: {o:?}",
            String::from_utf8_lossy(id)
        );
    }

    /* A key holding U+0000 is neither read short nor written: the decider's read of b1\0x finds
    nothing although b1 is held, and its write is refused. */
    h.accept(&admin, mutation!("c1", "add-book", "id" => "b1", "title" => "Dune")).await;
    let emma = mutation!("c2", "add-book", "id" => "b1\0x", "title" => "Emma");
    let o = h.mutations(&admin, &[emma]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("a key beginning book!book:b1 holds U+0000"),
        "add-book with U+0000: {o:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_family_walks_in_parameter_order() {
    let h = start().await;
    let admin = h.admin().await;

    // a slice whose parameter is another's followed by '-' or '.' sorts after it
    for (i, id) in ["gen.x", "gen-2", "gen"].into_iter().enumerate() {
        let patron = mutation!(&format!("c{i}"), "add-patron", "id" => id, "name" => "N");
        h.accept(&admin, patron).await;
    }
    let fam = h.snapshot(&admin, "patron:*").await;
    let want = [
        "patron:gen!holds",
        "patron:gen!messages",
        "patron:gen!patron",
        "patron:gen-2!holds",
        "patron:gen-2!messages",
        "patron:gen-2!patron",
        "patron:gen.x!holds",
        "patron:gen.x!messages",
        "patron:gen.x!patron",
    ];
    assert_eq!(fam.keys.join(","), want.join(","), "family keys");

    // and so does a key whose parameter is another's followed by '-'
    for (i, id) in ["2026-10-06", "2026-10"].into_iter().enumerate() {
        h.accept(&admin, mutation!(&format!("b{i}"), "add-book", "id" => id, "title" => "T")).await;
    }
    let keys = h.snapshot(&admin, "book").await.keys.join(",");
    assert_eq!(keys, "book!book:2026-10,book!book:2026-10-06", "book keys");
}
