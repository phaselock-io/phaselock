//! Posting mutations: their outcomes, a series' dedup, expectations and conflicts, the limits on
//! a request, and the checks a mutation's shape and values pass before its decider runs.

mod common;

use std::time::SystemTime;

use common::*;
use phaselockdb::mp::Writer;

/// posts a request body as it is, answering the outcomes; any status but 200 fails the test
async fn mutations_raw(h: &Harness, token: &str, body: Vec<u8>) -> Vec<Outcome> {
    let r = h.req("POST", "/mutations", token, Some(body)).await;
    assert_eq!(r.status, 200, "mutations: status {}: {}", r.status, r.text());
    outcomes(&r.body)
}

/// a value's msgpack bytes, for raw_mutation
fn mp(v: impl Into<V>) -> Vec<u8> {
    encode(&v.into())
}

/// one unnumbered mutation whose data map holds the fields in order, each value's bytes as given
fn raw_mutation(id: &str, fields: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut w = Writer::new();
    w.array(4);
    w.nil();
    w.nil();
    w.bin(&label(id));
    w.map(fields.len());
    for (k, v) in fields {
        w.str(k.as_bytes());
        w.raw(v);
    }
    w.into_vec()
}

/// a UTC time, to the millisecond
fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> SystemTime {
    let t = chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap();
    let t = t.and_hms_milli_opt(h, mi, s, ms).unwrap();
    value::from_unix_ms(t.and_utc().timestamp_millis())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mutation_is_answered_ok_or_reject() {
    let h = start().await;
    let admin = h.admin().await;

    let dune = || mutation!("c1", "add-book", "id" => "b1", "title" => "Dune").in_series("s1", 1);
    let outs = h.mutations(&admin, &[dune()]).await;
    assert!(outs[0].kind == "ok" && outs[0].position >= 1, "expected ok, got {:?}", outs[0]);
    let first = outs[0].position;

    // a resend is decided already, at or before the position it is answered with
    let outs = h.mutations(&admin, &[dune()]).await;
    assert!(
        outs[0].kind == "ok" && outs[0].position >= first,
        "expected ok at {first} or later, got {:?}",
        outs[0]
    );

    // decider rejection, structural rejection, and a later ack in one post
    let outs = h
        .mutations(
            &admin,
            &[
                mutation!("c2", "add-book", "id" => "b1", "title" => "Dune again"),
                mutation!("c3", "add-book", "id" => "b2"),
                mutation!("c4", "add-book", "id" => "b2", "title" => "Emma"),
            ],
        )
        .await;
    assert!(
        outs[0].kind == "reject" && outs[0].reason == "book exists",
        "expected decider reject, got {:?}",
        outs[0]
    );
    assert!(
        outs[1].kind == "reject" && outs[1].reason.contains("$.title: missing required field"),
        "expected structural reject, got {:?}",
        outs[1]
    );
    assert!(
        outs[2].kind == "ok" && outs[2].position > first,
        "expected ok after rejects, got {:?}",
        outs[2]
    );

    // anonymous is a principal; the bundle says it may not add books
    let outs =
        h.mutations("", &[mutation!("c5", "add-book", "id" => "b3", "title" => "Nope")]).await;
    assert!(
        outs[0].kind == "reject" && outs[0].reason == "unauthorized",
        "expected unauthorized, got {:?}",
        outs[0]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resent_mutation_is_answered_ok() {
    let h = start().await;
    let admin = h.admin().await;
    let dune = |id: &str| mutation!(id, "add-book", "id" => "b1", "title" => "Dune");

    /* Two copies of one (S, n) in one group: the first runs, and the second sees its decision,
    where running it again would have been rejected. */
    let copies = [dune("c1").in_series("s1", 1), dune("c1").in_series("s1", 1)];
    let outs = h.mutations(&admin, &copies).await;
    assert!(
        outs[0].kind == "ok" && outs[1].kind == "ok" && outs[1].position == outs[0].position,
        "copies in one group: {outs:?}"
    );

    // a reject is a decision: its resend is decided already, and its reason is gone
    let o = h.mutations(&admin, &[dune("c2").in_series("s1", 2)]).await.remove(0);
    assert!(o.kind == "reject" && o.reason == "book exists", "first reply of a reject: {o:?}");
    let o = h.mutations(&admin, &[dune("c2").in_series("s1", 2)]).await.remove(0);
    assert!(o.kind == "ok", "resent reject: {o:?}");

    // so is a conflict, and a mutation whose decider threw
    let emma = mutation!("c3", "add-book", "id" => "b3", "title" => "Emma").in_series("s1", 3);
    let o = h.expecting(&admin, &emma, obj! {"book" => 0}).await;
    assert!(o.kind == "conflict", "first reply of a conflict: {o:?}");
    let o = h.mutations(&admin, std::slice::from_ref(&emma)).await.remove(0);
    assert!(o.kind == "ok", "resent conflict: {o:?}");
    let nul = mutation!("c4", "add-book", "id" => "b1\0x", "title" => "Emma").in_series("s1", 4);
    let o = h.mutations(&admin, std::slice::from_ref(&nul)).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("holds U+0000"),
        "first reply of a decider's throw: {o:?}"
    );
    let o = h.mutations(&admin, std::slice::from_ref(&nul)).await.remove(0);
    assert!(o.kind == "ok", "resent decider's throw: {o:?}");

    // numbers may skip, and a number at or below the mark is decided already, run or not
    let persuasion = mutation!("c5", "add-book", "id" => "b5", "title" => "Persuasion");
    let head = h.accept(&admin, persuasion.in_series("s1", 10)).await;
    let sanditon = mutation!("c6", "add-book", "id" => "b6", "title" => "Sanditon");
    let o = h.mutations(&admin, &[sanditon.in_series("s1", 7)]).await.remove(0);
    assert!(o.kind == "ok" && o.position == head, "a number below the mark: {o:?}");

    // none of the resends reached the log: the book slice holds b1 and b5 alone
    let (evs, _, _) = h.edits_range(&admin, "book", -1, -1, false, 100).await;
    assert!(
        evs.len() == 2
            && evs[0].sets.contains_key("book!book:b1")
            && evs[1].sets.contains_key("book!book:b5"),
        "the book slice: {evs:?}"
    );

    /* An unknown series runs from whatever number it starts at, and the numbers below it are
    then decided already. */
    let emma = mutation!("c7", "add-book", "id" => "b7", "title" => "Emma");
    h.accept(&admin, emma.in_series("s2", 5)).await;
    let sanditon = mutation!("c8", "add-book", "id" => "b8", "title" => "Sanditon");
    let o = h.mutations(&admin, &[sanditon.in_series("s2", 1)]).await.remove(0);
    assert!(o.kind == "ok", "a number below an unknown series' first: {o:?}");
    let o = h.mutations(&admin, &[dune("c8").in_series("s2", 6)]).await.remove(0);
    assert!(o.kind == "reject", "the next number of a series that started past 1: {o:?}");

    // an unnumbered mutation runs every time it is sent
    for _ in 0..2 {
        let o = h.mutations(&admin, &[dune("c9")]).await.remove(0);
        assert!(o.kind == "reject" && o.reason == "book exists", "an unnumbered mutation: {o:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_response_carries_the_databases_time() {
    let h = start().await;
    let body = mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann").encode(None);
    let r = h.req("POST", "/mutations", &h.admin().await, Some(body)).await;
    assert_eq!(r.status, 200, "mutations: status {}", r.status);

    // the header is db;dur= and a number of milliseconds to two decimal places
    let st = r.header("server-timing");
    let dur = st.strip_prefix("db;dur=").and_then(|d| d.split_once('.'));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    assert!(
        dur.is_some_and(|(whole, frac)| digits(whole) && digits(frac) && frac.len() == 2),
        "Server-Timing: {st:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unmet_expectation_is_a_conflict() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "p1", "name" => "Ann")).await; // seq 1

    /* Expectations are the slice's seq: exact, so a met one passes and the same one then
    conflicts, reporting the actual seq. */
    let anne = mutation!("c2", "rename-patron", "id" => "p1", "name" => "Anne").in_series("s1", 1);
    let o = h.expecting(&admin, &anne, obj! {"patron:p1" => 1}).await;
    assert!(o.kind == "ok", "matching expect: {o:?}");
    let annie = mutation!("c3", "rename-patron", "id" => "p1", "name" => "Annie");
    let o = h.expecting(&admin, &annie, obj! {"patron:p1" => 1}).await;
    assert!(o.kind == "conflict" && o.current.get("patron:p1") == Some(&2), "stale expect: {o:?}");

    // a conflicting mutation never entered the log
    let got = h.snapshot(&admin, "patron:p1").await.records["patron:p1!patron"]["name"].clone();
    assert!(got == "Anne", "a conflict should not write: {got:?}");

    // 0 asserts a slice was never born
    let dune = mutation!("c4", "add-book", "id" => "b1", "title" => "Dune");
    let o = h.expecting(&admin, &dune, obj! {"book" => 0}).await;
    assert!(o.kind == "ok", "expect 0 on an unborn slice: {o:?}");
    let bob = mutation!("c5", "add-patron", "id" => "p2", "name" => "Bob");
    let o = h.expecting(&admin, &bob, obj! {"patron:p2" => 1}).await;
    assert!(
        o.kind == "conflict" && o.current.get("patron:p2") == Some(&0),
        "expect on an unborn slice reports 0: {o:?}"
    );

    // several expectations: only the mismatches are reported
    let x = mutation!("c6", "rename-patron", "id" => "p1", "name" => "x");
    let o = h.expecting(&admin, &x, obj! {"patron:p1" => 2, "book" => 5}).await;
    assert!(
        o.kind == "conflict" && o.current.len() == 1 && o.current.get("book") == Some(&1),
        "mixed expect: {o:?}"
    );

    // the snapshot's seq is the token to expect for a slice with nothing after the cut
    let seq = h.snapshot(&admin, "book").await.slices["book"];
    let dune = mutation!("c6b", "add-book", "id" => "b1", "title" => "Dune");
    let o = h.expecting(&admin, &dune, obj! {"book" => seq}).await;
    // the decider's rejection: it got past expect
    assert!(o.kind == "reject" && o.reason == "book exists", "snapshot seq as expectation: {o:?}");

    // dedup wins over a stale expectation
    let o = h.expecting(&admin, &anne, obj! {"patron:p1" => 0}).await;
    assert!(o.kind == "ok", "resubmit with stale expect: {o:?}");

    // a hashed mutation keeps its expectation through intake
    let account = |id: &str| mutation!(id, "create-account", "user" => "p1", "password" => "pw");
    let o = h.expecting(&admin, &account("c7"), obj! {"account:p1" => 1}).await;
    assert!(
        o.kind == "conflict" && o.current.get("account:p1") == Some(&0),
        "expect survives hash intake: {o:?}"
    );
    let o = h.expecting(&admin, &account("c8"), obj! {"account:p1" => 0}).await;
    assert!(o.kind == "ok", "hashed mutation with matching expect: {o:?}");

    /* An expectation names only slices the sender may see, so it never learns another's seq, nor
    whether it exists: an anonymous sender sees the book alone. */
    let book = h.snapshot(&admin, "book").await.slices["book"];
    let p5 = mutation!("c8b", "create-account", "user" => "p5", "password" => "pw");
    let o = h.expecting("", &p5, obj! {"book" => book}).await;
    assert!(o.kind == "ok", "anonymous expect of a slice it may see: {o:?}");
    let p6 = |id: &str| mutation!(id, "create-account", "user" => "p6", "password" => "pw");
    for slice in ["account:p1", "account:p6"] {
        let o = h.expecting("", &p6("c8c"), obj! {slice => 0}).await;
        assert!(
            o.kind == "reject"
                && o.reason == format!("expect: {slice} is not a slice the sender may see"),
            "anonymous expect of {slice}: {o:?}"
        );
    }

    /* A slice name is checked by its syntax alone, so one in a family no slice type declares, or
    under too many parameters, names a slice never born, which the sender may see or not as any
    other. */
    for (i, slice) in ["nope:p1", "patron:p1,x"].into_iter().enumerate() {
        let x = mutation!(&format!("c8d-{i}"), "rename-patron", "id" => "p1", "name" => "x");
        let o = h.expecting(&admin, &x, obj! {slice => 0}).await;
        assert!(o.kind == "ok", "expect of {slice}: {o:?}");
        let o = h.expecting("", &p6(&format!("c8e-{i}")), obj! {slice => 0}).await;
        assert!(
            o.kind == "reject"
                && o.reason == format!("expect: {slice} is not a slice the sender may see"),
            "anonymous expect of {slice}: {o:?}"
        );
    }

    // expect names at most 1024 slices
    let mut many: std::collections::BTreeMap<String, V> =
        (0..1024).map(|i| (format!("patron:q{i}"), V::Int(0))).collect();
    let cy = mutation!("c9", "add-patron", "id" => "p3", "name" => "Cy");
    let o = h.expecting(&admin, &cy, V::Map(many.clone())).await;
    assert!(o.kind == "ok", "1024 expectations: {o:?}");
    many.insert("patron:q1024".into(), V::Int(0));
    let di = mutation!("c10", "add-patron", "id" => "p4", "name" => "Di");
    let o = h.expecting(&admin, &di, V::Map(many)).await;
    assert!(
        o.kind == "reject" && o.reason == "expect names 1025 slices, more than 1024",
        "1025 expectations: {o:?}"
    );

    // each an exact slice name and a seq from 0 to 2^53 - 1
    let seq = "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1";
    let malformed = [
        (obj! {"patron:" => 0}, "expect: patron: is not a slice name"),
        (obj! {"patron:p/1" => 0}, "expect: patron:p/1 is not a slice name"),
        (obj! {"patron:p1!" => 0}, "expect: patron:p1! is not a slice name"),
        (obj! {"patron:*" => 0}, "expect: patron:* is not a slice name"),
        (obj! {"patron:p1\0x" => 0}, "expect: patron:p1 is not a slice name"),
        (obj! {"patron:p1" => -1}, seq),
        (obj! {"patron:p1" => 1i64 << 53}, seq),
        (obj! {"patron:p1" => 3.0}, seq),
    ];
    for (i, (expect, reason)) in malformed.into_iter().enumerate() {
        let x = mutation!(&format!("c11-{i}"), "rename-patron", "id" => "p1", "name" => "x");
        let o = h.expecting(&admin, &x, expect.clone()).await;
        assert!(o.kind == "reject" && o.reason == reason, "expect {expect:?}: {o:?}");
    }

    // and each named once, in a map; these bodies are built by hand
    let rename = mutation!("c12", "rename-patron", "id" => "p1", "name" => "x");
    let mut twice = vec![0x82];
    twice.extend(mp("patron:p1"));
    twice.push(3);
    twice.extend(mp("patron:p1"));
    twice.push(3);
    for (expect, reason) in
        [(twice, "expect: patron:p1 is named twice"), (mp(arr!["x"]), "expect must be a map")]
    {
        let mut body = rename.encode(None);
        body[0] = 0x95; // the mutation's array gains expect
        body.extend(&expect);
        let (status, outs) = h.mutations_raw_status(&admin, body).await;
        assert_eq!(status, 200, "mutations: status {status}");
        let o = &outs[0];
        assert!(o.kind == "reject" && o.reason == reason, "expect {expect:02x?}: {o:?}");
    }
}

/* A request carries at most 128 mutations, and one without a session at most 8; a request past
its limit is refused whole with 413 and the limit it was held to, before any mutation is checked.
Options change both. */
#[tokio::test(flavor = "multi_thread")]
async fn a_request_past_its_mutation_limit_is_refused() {
    let books = |prefix: &str, n: usize| -> Vec<Mutation> {
        (0..n)
            .map(|i| {
                let id = format!("{prefix}{i}");
                mutation!(&id, "add-book", "id" => &id, "title" => "Dune")
            })
            .collect()
    };
    async fn post(h: &Harness, token: &str, muts: &[Mutation]) -> (u16, String) {
        let body: Vec<u8> = muts.iter().flat_map(|m| m.encode(None)).collect();
        let r = h.req("POST", "/mutations", token, Some(body)).await;
        (r.status, r.header("phaselock-max-mutations").to_string())
    }

    // the defaults: anonymous mutations are answered, if only with rejects, up to 8
    let h = start().await;
    let admin = h.admin().await;
    let (status, _) = post(&h, &admin, &books("a", 128)).await;
    assert_eq!(status, 200, "128 mutations: status {status}");
    let (status, limit) = post(&h, &admin, &books("b", 129)).await;
    assert!(status == 413 && limit == "128", "129 mutations: status {status}, limit {limit:?}");
    let (status, _) = post(&h, "", &books("c", 8)).await;
    assert_eq!(status, 200, "8 anonymous mutations: status {status}");
    let (status, limit) = post(&h, "", &books("d", 9)).await;
    assert!(
        status == 413 && limit == "8",
        "9 anonymous mutations: status {status}, limit {limit:?}"
    );

    // a refused request decided nothing
    let o = h.mutations(&admin, &books("b", 1)).await.remove(0);
    assert!(o.kind == "ok", "a mutation of a refused request: {o:?}");

    /* A mutation of 2^20 values at most is checked, and one of more refuses its request: an
    unnumbered mutation, its id, and data an array of nils, five values besides the nils. */
    let nils = |n: u32| -> Vec<u8> {
        let mut b = vec![0x94, 0xc0, 0xc0, 0xc4, 16];
        b.extend([0; 16]);
        b.push(0xdd);
        b.extend(n.to_be_bytes());
        b.extend(std::iter::repeat_n(0xc0, n as usize));
        b
    };
    let r = h.req("POST", "/mutations", &admin, Some(nils((1 << 20) - 5))).await;
    assert_eq!(r.status, 200, "a mutation of 2^20 values: {} {}", r.status, r.text());
    let r = h.req("POST", "/mutations", &admin, Some(nils((1 << 20) - 4))).await;
    assert!(
        r.status == 400 && r.text().contains("holds more than 1048576 values"),
        "a mutation of 2^20 + 1 values: {} {}",
        r.status,
        r.text()
    );

    // limits of the server's own
    let h = start_with(|o| {
        o.max_mutations = 4;
        o.max_anonymous_mutations = 2;
    })
    .await;
    let (status, limit) = post(&h, &h.admin().await, &books("e", 5)).await;
    assert!(status == 413 && limit == "4", "5 mutations under 4: status {status}, limit {limit:?}");
    let (status, limit) = post(&h, "", &books("f", 3)).await;
    assert!(
        status == 413 && limit == "2",
        "3 anonymous mutations under 2: status {status}, limit {limit:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_mutation_is_rejected_where_it_stands() {
    let h = start().await;
    let admin = h.admin().await;

    /* Each malformed mutation is rejected where it stands, naming the problem, and the
    well-formed ones around it are accepted. */
    let outs = h
        .mutations(
            &admin,
            &[
                mutation!("c1", "add-book", "id" => "b1", "title" => "Dune").in_series("s1", 1),
                mutation!("c2", "add-book", "id" => "b2").in_series("s1", 2),
                mutation!("c3", "add-book", "id" => 7, "title" => "Emma"),
                mutation!("c4", "add-book", "id" => "b4", "title" => "Emma", "extra" => true),
                mutation!("c5", "no-such-mutation", "id" => "x"),
                mutation!("c6", "add-book", "id" => "b6", "title" => "Persuasion"),
            ],
        )
        .await;
    for (i, k) in ["ok", "reject", "reject", "reject", "reject", "ok"].into_iter().enumerate() {
        assert!(outs[i].kind == k, "outcome {i}: {:?}, want {k}", outs[i]);
    }
    for (i, needle) in [
        (1, "$.title: missing required field"),
        (2, "$.id: expected a string"),
        (3, "$.extra: unknown field"),
        (4, "no-such-mutation"),
    ] {
        assert!(
            outs[i].reason.contains(needle),
            "outcome {i}: {:?} should mention {needle:?}",
            outs[i].reason
        );
    }
    assert!(outs[5].position > outs[0].position, "oks around the rejects: {outs:?}");

    /* A malformed mutation never reached dedup, so it was not a decision: its number is free for
    a good one, which runs and lands past everything before it. */
    let mansfield = mutation!("c2", "add-book", "id" => "b2", "title" => "Mansfield Park");
    let o = h.mutations(&admin, &[mansfield.in_series("s1", 2)]).await.remove(0);
    assert!(
        o.kind == "ok" && o.position > outs[5].position,
        "number of a malformed mutation reused: {o:?}"
    );

    // the discriminator may sit anywhere in the map
    let body =
        raw_mutation("c7", &[("id", mp("b7")), ("title", mp("Emma")), ("type", mp("add-book"))]);
    let r = h.req("POST", "/mutations", &admin, Some(body)).await;
    assert!(
        r.status == 200 && outcomes(&r.body)[0].kind == "ok",
        "discriminator last: {} {}",
        r.status,
        r.text()
    );

    // an empty body is fine; a body that is not msgpack is a 400
    let r = h.req("POST", "/mutations", &admin, Some(Vec::new())).await;
    assert_eq!(r.status, 200, "empty body: {}", r.status);
    let r = h.req("POST", "/mutations", &admin, Some(vec![0xc1])).await;
    assert_eq!(r.status, 400, "not msgpack: {}", r.status);

    // a mutation that is not [S, n, id, data, expect?] is a 400 too, since nothing can be answered
    let data = obj! {"type" => "add-book", "id" => "b9", "title" => "Emma"};
    let c9 = || label("c9");
    for (name, c) in [
        ("a string", V::from("just a string")),
        ("the old pair", arr!["c9", &data]),
        ("a series, no n", arr!["s1", (), c9(), &data]),
        ("an n, no series", arr![(), 3, c9(), &data]),
        ("an empty series", arr!["", 3, c9(), &data]),
        ("a long series", arr!["s".repeat(65), 3, c9(), &data]),
        ("a zero n", arr!["s1", 0, c9(), &data]),
        ("an n past 2^53 - 1", arr!["s1", 1i64 << 53, c9(), &data]),
        ("a string id", arr![(), (), "c9", &data]),
        ("a short id", arr![(), (), b"c9".to_vec(), &data]),
    ] {
        let r = h.req("POST", "/mutations", &admin, Some(encode(&c))).await;
        assert_eq!(r.status, 400, "{name}: {}", r.status);
    }

    // a series id of the longest length and the largest n are well-formed
    let big = arr!["s".repeat(64), (1i64 << 53) - 1, c9(), &data];
    let r = h.req("POST", "/mutations", &admin, Some(encode(&big))).await;
    assert!(
        r.status == 200 && outcomes(&r.body)[0].kind == "ok",
        "the largest series id and n: {} {}",
        r.status,
        r.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_date_travels_as_a_timestamp() {
    let h = start().await;
    let admin = h.admin().await;
    let added = utc(2026, 1, 2, 3, 4, 5, 678);

    // a date field travels as a timestamp: through the decider, into the edit, out of the store
    let dune = mutation!("c1", "add-book", "id" => "b1", "title" => "Dune", "added" => added);
    h.accept(&admin, dune).await;
    let mut s = h.connect(&admin, 0, &[]).await;
    let evs = edits(&s.next_tagged("edits").await);
    let got = evs[0].field("book!book:b1", "added");
    assert!(got == V::Time(added), "edit date: {got:?}");
    let book = h.snapshot(&admin, "book").await.records["book!book:b1"].clone();
    assert!(book["added"] == V::Time(added), "stored date: {:?}", book["added"]);

    // the stored value is the schema's shape: declaration order, nothing foreign
    let keys: Vec<&str> = book.map().keys().map(String::as_str).collect();
    assert_eq!(keys.join(","), "added,id,title", "stored keys: {keys:?}");

    // a date given as a string is rejected before anything runs
    let text = "2026-01-02T03:04:05Z";
    let emma = mutation!("c2", "add-book", "id" => "b2", "title" => "Emma", "added" => text);
    let o = h.mutations(&admin, &[emma]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("$.added: expected a timestamp"),
        "string date: {o:?}"
    );

    // a date reaches as far as a JS Date does either side of the epoch, and no further
    const DATE_MAX: i64 = 8_640_000_000_000_000;
    for (i, ms) in [DATE_MAX, -DATE_MAX].into_iter().enumerate() {
        let id = format!("e{i}");
        let added = value::from_unix_ms(ms);
        let emma = mutation!(&id, "add-book", "id" => &id, "title" => "Emma", "added" => added);
        h.accept(&admin, emma).await;
        let records = h.snapshot(&admin, "book").await.records;
        let stored = &records[&format!("book!book:{id}")]["added"];
        assert!(
            matches!(stored, V::Time(t) if value::unix_ms(*t) == ms),
            "date at {ms} ms: {stored:?}"
        );
    }
    for (i, ms) in [DATE_MAX + 1, -DATE_MAX - 1, 1 << 62].into_iter().enumerate() {
        let id = format!("f{i}");
        let added = value::from_unix_ms(ms);
        let emma = mutation!(&id, "add-book", "id" => &id, "title" => "Emma", "added" => added);
        let o = h.mutations(&admin, &[emma]).await.remove(0);
        assert!(
            o.kind == "reject" && o.reason == "$.added: a timestamp outside the range of a Date",
            "date at {ms} ms: {o:?}"
        );
    }

    // an optional field left out stays out
    h.accept(&admin, mutation!("c3", "add-book", "id" => "b3", "title" => "Emma")).await;
    let records = h.snapshot(&admin, "book").await.records;
    assert!(records["book!book:b3"].get("added").is_none(), "absent optional field written");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_password_reaches_the_decider_hashed() {
    let h = start().await;
    let admin = h.admin().await;
    h.accept(&admin, mutation!("c1", "add-patron", "id" => "ann", "name" => "Ann")).await;

    // a NewPassword is replaced by its argon2id hash before the decider sees it
    let ann = mutation!("c2", "create-account", "user" => "ann", "password" => "hunter2");
    h.accept("", ann).await;
    let acct = h.snapshot(&admin, "account:ann").await.records["account:ann!account"].clone();
    let hash = acct["hash"].str();
    assert!(hash.starts_with("$argon2id$"), "expected an argon2id hash, got {hash:?}");

    // and the check saw the wire type: a password that is not a string is rejected
    let bob = mutation!("c3", "create-account", "user" => "bob", "password" => 42);
    let o = h.mutations("", &[bob]).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason.contains("$.password: expected a string"),
        "non-string password: {o:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn new_passwords_in_a_large_request_are_hashed_into_place() {
    let h = start().await;
    let admin = h.admin().await;

    /* A request large enough to be checked off the request's task, with a password ahead of a
    long title, a rejected one, and another behind them: each hash goes into its own mutation,
    and the mutations after each hash still decode. */
    let title = "t".repeat(20 << 10);
    let muts = [
        mutation!("c1", "create-account", "user" => "ann", "password" => "pw-ann"),
        mutation!("c2", "add-book", "id" => "b1", "title" => &title),
        mutation!("c3", "create-account", "user" => "cat", "password" => 42),
        mutation!("c4", "create-account", "user" => "bob", "password" => "pw-bob"),
        mutation!("c5", "add-book", "id" => "b2", "title" => "Emma"),
    ];
    let got = h.mutations(&admin, &muts).await;
    let kinds: Vec<&str> = got.iter().map(|o| o.kind.as_str()).collect();
    assert_eq!(kinds, ["ok", "ok", "reject", "ok", "ok"], "outcomes: {got:?}");
    assert_eq!(h.login("ann", "pw-ann").await, 200, "ann's password");
    assert_eq!(h.login("bob", "pw-bob").await, 200, "bob's password");
    let records = h.snapshot(&admin, "book").await.records;
    assert!(records["book!book:b1"]["title"] == title.as_str(), "the long title");
    assert!(records["book!book:b2"]["title"] == "Emma", "the title after the second hash");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_value_no_type_accepts_is_rejected_by_name() {
    let h = start().await;
    let admin = h.admin().await;

    // a date in each of the timestamp's three sizes survives the decider, the edit, and the store
    let whole = utc(2026, 1, 2, 3, 4, 5, 0);
    let old = utc(1960, 6, 7, 8, 9, 10, 123);
    let dune = mutation!("c1", "add-book", "id" => "b1", "title" => "Dune", "added" => whole);
    h.accept(&admin, dune).await;
    let emma = mutation!("c2", "add-book", "id" => "b2", "title" => "Emma", "added" => old);
    h.accept(&admin, emma).await;
    let records = h.snapshot(&admin, "book").await.records;
    for (key, want) in [("book!book:b1", whole), ("book!book:b2", old)] {
        assert!(
            records[key]["added"] == V::Time(want),
            "{key}: stored date {:?}, want {want:?}",
            records[key]
        );
    }

    /* Values no type accepts are rejected by name, each in its own mutation of one request, and
    the mutations after each still check and ack. */
    let bad_stamp = vec![0xc7, 5, 0xff, 0, 0, 0, 0, 0]; // a timestamp extension of no valid size
    let bad_nanos = vec![0xd7, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];
    let other_ext = vec![0xd6, 5, 0, 0, 0, 0];
    let bin = vec![0xc4, 2, b'h', b'i'];
    let big_uint = vec![0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    let int_key = vec![0x81, 0x01, 0xa1, b'x'];
    let book = |id: &str, title: Vec<u8>, added: Option<Vec<u8>>| {
        let mut fields = vec![("type", mp("add-book")), ("id", mp(id)), ("title", title)];
        fields.extend(added.map(|a| ("added", a)));
        fields
    };
    let mut body = Vec::new();
    body.extend(raw_mutation("d1", &book("b3", mp("T"), Some(bad_stamp))));
    body.extend(raw_mutation("d2", &book("b4", mp("T"), Some(bad_nanos))));
    body.extend(raw_mutation("d3", &book("b5", mp("T"), Some(other_ext))));
    body.extend(raw_mutation("d4", &book("b6", bin, None)));
    body.extend(raw_mutation(
        "d5",
        &[("type", mp("add-book")), ("id", big_uint), ("title", mp("T"))],
    ));
    body.extend(raw_mutation("d6", &book("b8", mp("T"), Some(int_key))));
    body.extend(raw_mutation("d7", &book("b9", mp("T"), None)));
    let outs = mutations_raw(&h, &admin, body).await;
    for (i, want) in [
        "$.added: malformed timestamp",
        "$.added: malformed timestamp",
        "$.added: expected a timestamp, not an extension other than a timestamp",
        "$.title: expected a string, not a bin value",
        "$.id: expected a string, not an integer past int64",
        "$.added: expected a timestamp, not an object",
    ]
    .into_iter()
    .enumerate()
    {
        assert!(
            outs[i].kind == "reject" && outs[i].reason == want,
            "outcome {i}: {:?}, want reject {want:?}",
            outs[i]
        );
    }
    assert!(outs[6].kind == "ok", "the mutation after the rejects: {:?}", outs[6]);

    // a map key that is not a string, where the walk reads keys
    let mut w = Writer::new();
    w.array(4);
    w.nil();
    w.nil();
    w.bin(&label("e1"));
    w.map(4);
    for (k, v) in [("type", "add-book"), ("id", "b10"), ("title", "T")] {
        w.str(k.as_bytes());
        w.str(v.as_bytes());
    }
    w.raw(&[0x07, 0xc0]);
    let o = mutations_raw(&h, &admin, w.into_vec()).await.remove(0);
    assert!(
        o.kind == "reject" && o.reason == "$: a map key is not a string",
        "non-string key: {o:?}"
    );

    // elements a later protocol appends to a mutation are ignored
    let data = obj! {"type" => "add-book", "id" => "b11", "title" => "T"};
    let body = encode(&arr![(), (), label("e2"), data, obj! {}, "newer"]);
    let o = mutations_raw(&h, &admin, body).await.remove(0);
    assert!(o.kind == "ok", "a mutation with an appended element: {o:?}");
}
