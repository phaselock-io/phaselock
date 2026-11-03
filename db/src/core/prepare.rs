//! The check of a request's mutations: every mutation is checked against the bundle's registry,
//! and the fields the database prepares for the decider are prepared, before anything reaches the
//! writer.  The check is plain CPU work over the body, so the caller decides where it runs; it
//! waits on nothing, and each password it needs hashed is left as a hole the caller fills.

use super::ID_LEN;
use super::writer::{EXPECT_MAX, series_key};
use crate::mp::{self, Node};
use crate::names;
use crate::walk::{self, Intake, Schema};

/// the longest series id a mutation may carry, in bytes
const SERIES_MAX: usize = 64;

/// the most values one mutation's msgpack may hold, which bounds the memory of its parse
const MUTATION_MAX_NODES: usize = 1 << 20;

/// A request as the check prepared it: body holds the mutations that passed, in order, each
/// series replaced by its key in the series table; reasons has one entry per mutation of the
/// request, None for one that passed and why it was rejected otherwise; offsets has each passing
/// mutation's start in body, and proofs the password of each MutationAuth proof it carries.  Each
/// NewPassword of a passing mutation is a hole in body, with its password in passwords, until fill
/// writes the hashes in.
pub struct Prepared {
    pub body: Vec<u8>,
    pub reasons: Vec<Option<String>>,
    pub offsets: Vec<usize>,
    pub proofs: Vec<Vec<String>>,
    pub passwords: Vec<String>,
    // each hole, in order, as the passing mutation it lies in and its place in body
    holes: Vec<(usize, usize)>,
}

impl Prepared {
    /// Writes each of hashes, the hashes of passwords in its order, into its hole, moving the
    /// mutations after it to make room.
    pub fn fill(&mut self, hashes: &[String]) {
        assert_eq!(hashes.len(), self.holes.len(), "a hash for every hole");
        if hashes.is_empty() {
            return;
        }

        // the body with each hash in its hole, and the room each mutation's holes took
        let mut body =
            Vec::with_capacity(self.body.len() + hashes.iter().map(|h| h.len() + 5).sum::<usize>());
        let mut grew = vec![0; self.offsets.len()];
        let mut at = 0;
        for (&(m, pos), h) in self.holes.iter().zip(hashes) {
            body.extend_from_slice(&self.body[at..pos]);
            let before = body.len();
            let mut w = mp::Writer::new();
            w.str(h.as_bytes());
            body.extend_from_slice(&w.buf);
            grew[m] += body.len() - before;
            at = pos;
        }
        body.extend_from_slice(&self.body[at..]);

        // each mutation starts later by the room every mutation before it took
        let mut shift = 0;
        for (o, g) in self.offsets.iter_mut().zip(grew) {
            *o += shift;
            shift += g;
        }
        self.body = body;
        self.holes.clear();
    }
}

pub enum PrepareError {
    /// the request is not a sequence of [S, n, id, data, expect?] values
    Malformed(String),
    /// the request carries more mutations than its limit, refused before any is checked
    TooMany,
}

// a writer that keeps the place of each hole the walk leaves
struct HoleWriter {
    w: mp::Writer,
    holes: Vec<usize>,
}

impl walk::Sink for HoleWriter {
    fn begin_obj(&mut self, n: usize) -> Result<(), &'static str> {
        self.w.begin_obj(n)
    }
    fn key(&mut self, k: &[u8]) -> Result<(), &'static str> {
        walk::Sink::key(&mut self.w, k)
    }
    fn end_obj(&mut self) -> Result<(), &'static str> {
        self.w.end_obj()
    }
    fn begin_arr(&mut self, n: usize) -> Result<(), &'static str> {
        self.w.begin_arr(n)
    }
    fn end_arr(&mut self) -> Result<(), &'static str> {
        self.w.end_arr()
    }
    fn str(&mut self, s: &[u8]) -> Result<(), &'static str> {
        walk::Sink::str(&mut self.w, s)
    }
    fn int(&mut self, i: i64) -> Result<(), &'static str> {
        walk::Sink::int(&mut self.w, i)
    }
    fn float(&mut self, f: f64) -> Result<(), &'static str> {
        self.w.float(f)
    }
    fn bool(&mut self, b: bool) -> Result<(), &'static str> {
        walk::Sink::bool(&mut self.w, b)
    }
    fn null(&mut self) -> Result<(), &'static str> {
        self.w.null()
    }
    fn date(&mut self, ms: f64) -> Result<(), &'static str> {
        self.w.date(ms)
    }
    fn hole(&mut self) -> Result<(), &'static str> {
        self.holes.push(self.w.buf.len());
        Ok(())
    }
}

// whether an integer is a mutation number: from 1 to 2^53 - 1, so that every client's numbers
// are exact
fn is_number(n: &Node<'_>) -> bool {
    n.as_u64().is_some_and(|v| (1..1u64 << 53).contains(&v))
}

// whether an integer is a seq an expectation may name: from 0 to 2^53 - 1
fn is_seq(n: &Node<'_>) -> bool {
    n.as_u64().is_some_and(|v| v < 1u64 << 53)
}

/// Whether a parsed request element is [S, n, id, data, expect?]: S a string of 1 to SERIES_MAX
/// bytes and n a mutation number, or both nil, and id ID_LEN bytes of bin.  Elements a later
/// protocol appends are ignored.
fn is_mutation(c: &Node<'_>) -> bool {
    let Some(items) = c.array() else { return false };
    if items.len() < 4 {
        return false;
    }

    // the series and the number
    match &items[0] {
        Node::Nil => {
            if !items[1].is_nil() {
                return false;
            }
        }
        Node::Str(s) => {
            if s.is_empty() || s.len() > SERIES_MAX || !is_number(&items[1]) {
                return false;
            }
        }
        _ => return false,
    }

    // the id
    matches!(items[2], Node::Bin(id) if id.len() == ID_LEN)
}

// a name as a reason shows it: its first 100 bytes, up to any U+0000
fn shown(s: &[u8]) -> String {
    let s = &s[..s.len().min(100)];
    let s = s.split(|&c| c == 0).next().unwrap_or(s);
    String::from_utf8_lossy(s).into_owned()
}

/// Why a mutation's expectations are malformed, or None when they are a map from at most
/// EXPECT_MAX distinct exact slice names to seqs.
fn expect_reason(e: &Node<'_>) -> Option<String> {
    let Some(m) = e.map() else { return Some("expect must be a map".into()) };
    if m.len() > EXPECT_MAX {
        return Some(format!("expect names {} slices, more than {EXPECT_MAX}", m.len()));
    }

    // each entry an exact slice name and a seq
    let mut names = Vec::with_capacity(m.len());
    for (k, v) in m {
        let Some(s) = k.as_str() else {
            return Some("expect: a slice name is not a string".into());
        };
        if s.contains(&0) || !names::slice_name_ok(s) {
            return Some(format!("expect: {} is not a slice name", shown(s)));
        }
        if !is_seq(v) {
            return Some(format!(
                "expect: the seq of {} is not an integer from 0 to 2^53 - 1",
                shown(s)
            ));
        }
        names.push(s);
    }

    // no slice named twice
    names.sort();
    names
        .windows(2)
        .find(|w| w[0] == w[1])
        .map(|w| format!("expect: {} is named twice", shown(w[0])))
}

// one mutation as the check prepared it: its encoding, its proofs' passwords, and each password
// to hash with the place of its hole in the encoding
struct PreparedMutation {
    buf: Vec<u8>,
    proofs: Vec<String>,
    passwords: Vec<String>,
    holes: Vec<usize>,
}

/// Checks one mutation's data and prepares its fields: a NewPassword is left as a hole with its
/// password set aside to hash, and a password MutationAuth is replaced by its result and its
/// password set aside in proofs; any other kind cannot be verified yet.  Answers the prepared
/// [key, n, id, data, expect?], its series replaced by its key, or why the mutation is rejected.
fn prepare_mutation(sc: &Schema, c: &Node<'_>) -> Result<PreparedMutation, String> {
    let Some(mutations) = sc.mutations() else {
        return Err("this database takes no mutations".into());
    };
    let items = c.array().unwrap();
    let data = &items[3];
    let mut il: Vec<Intake<'_>> = Vec::new();
    walk::check(sc, data, mutations, true, Some(&mut il))?;
    if items.len() > 4
        && let Some(r) = expect_reason(&items[4])
    {
        return Err(r);
    }

    // each proof, whose password the caller checks
    let mut proofs = Vec::new();
    for i in il.iter_mut().filter(|i| i.kind == "MutationAuth") {
        let kind = i.node.get("kind").and_then(|k| k.as_str()).unwrap_or(b"");
        if kind != b"password" {
            return Err(format!(
                "{} proofs are not supported by this database yet",
                String::from_utf8_lossy(kind)
            ));
        }
        let pw = i.node.get("password").and_then(|p| p.as_str()).unwrap_or(b"");
        proofs.push(String::from_utf8_lossy(pw).into_owned());
        i.result_kind = Some("password");
    }

    // each other prepared field: a hole for its hash, which the caller makes
    let mut passwords = Vec::new();
    for i in il.iter_mut().filter(|i| i.kind != "MutationAuth") {
        if i.kind != "NewPassword" {
            return Err(format!("{} fields are not supported by this database yet", i.kind));
        }
        passwords.push(String::from_utf8_lossy(i.node.as_str().unwrap_or(b"")).into_owned());
        i.hole = true;
    }

    // the mutation as checked, its prepared fields replaced
    let mut w = mp::Writer::new();
    let len = if items.len() > 4 { 5 } else { 4 };
    w.array(len);
    match &items[0] {
        Node::Str(s) => {
            w.str(series_key(s).as_bytes());
            w.uint(items[1].as_u64().unwrap_or(0));
        }
        _ => {
            w.nil();
            w.nil();
        }
    }
    if let Node::Bin(id) = items[2] {
        w.bin(id);
    }
    let mut hw = HoleWriter { w, holes: Vec::new() };
    walk::write(sc, data, Some(mutations), true, Some(&il), &mut hw)?;
    let HoleWriter { mut w, holes } = hw;
    if len > 4 {
        let m = items[4].map().unwrap_or(&[]);
        w.map(m.len());
        for (k, v) in m {
            w.str(k.as_str().unwrap_or(b""));
            w.uint(v.as_u64().unwrap_or(0));
        }
    }
    Ok(PreparedMutation { buf: w.into_vec(), proofs, passwords, holes })
}

/// Checks and prepares a request of at most max mutations.  Hashing a NewPassword is the
/// caller's, after the check, and a refused hash refuses the whole request, so the client can
/// retry it later under the same series and numbers.
pub fn prepare(sc: &Schema, body: &[u8], max: usize) -> Result<Prepared, PrepareError> {
    // the request is a sequence of at most max [S, n, id, data, expect?] values: parse them,
    // refusing the whole request when any is not one, since nothing can be answered for it
    let mut nodes = Vec::new();
    let mut consumed = 0;
    while consumed < body.len() {
        let (n, used) = match mp::parse_limited(&body[consumed..], MUTATION_MAX_NODES) {
            Ok(parsed) => parsed,
            Err(mp::ParseError::TooBig) => {
                return Err(PrepareError::Malformed(format!(
                    "a mutation holds more than {MUTATION_MAX_NODES} values"
                )));
            }
            Err(_) => return Err(PrepareError::Malformed("malformed msgpack".into())),
        };
        consumed += used;
        if !is_mutation(&n) {
            return Err(PrepareError::Malformed(
                "mutation must be [S, n, id, data, expect?]".into(),
            ));
        }
        if nodes.len() == max {
            return Err(PrepareError::TooMany);
        }
        nodes.push(n);
    }

    // check and prepare each mutation; a mutation that does not pass carries no proofs and leaves
    // no holes
    let mut p = Prepared {
        body: Vec::new(),
        reasons: Vec::new(),
        offsets: Vec::new(),
        proofs: Vec::new(),
        passwords: Vec::new(),
        holes: Vec::new(),
    };
    for n in &nodes {
        match prepare_mutation(sc, n) {
            Ok(m) => {
                let start = p.body.len();
                let index = p.offsets.len();
                p.holes.extend(m.holes.iter().map(|h| (index, start + h)));
                p.passwords.extend(m.passwords);
                p.body.extend_from_slice(&m.buf);
                p.reasons.push(None);
                p.offsets.push(start);
                p.proofs.push(m.proofs);
            }
            Err(r) => p.reasons.push(Some(r)),
        }
    }
    Ok(p)
}
