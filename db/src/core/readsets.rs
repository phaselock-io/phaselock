//! What the registrations' cached calls read, the grantor's and lookup's, filed so that a write
//! finds the calls it touched without looking at any other call.  A key a call got is filed by
//! the key and by its slice, which a slice's clear looks up.  A span is filed under its bucket:
//! the longest prefix every key it covers starts with that ends at a separator of a slice name
//! (':', ',', or the '!' that ends the slice), so "" for every slice, "fam:" for a family scan
//! bounded by nothing, "fam:p1," for one bounded by its first parameter, and "slice!" for one
//! slice.  A written key looks only in the buckets of its own such prefixes, and a cleared slice
//! in those of "<slice>!".  Entries change only when a call runs again, is forgotten, or expires
//! with its registration, so a write never changes the index it looks in.

use std::collections::{HashMap, HashSet};

use phaselock_core::scan::Span;

use crate::js::Reads;

/// which of a registration's cached calls
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Cached {
    Grant,
    Account,
}

/// one registration's cached call
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct Call {
    pub reg: usize,
    pub what: Cached,
}

/// What a cached call read, and whether a write since it ran touched any of it.  A spurious
/// touch costs only a run, so a cleared slice touches a span whenever the span may hold a key
/// under it.
#[derive(Default)]
pub(super) struct ReadSet {
    pub keys: HashSet<Vec<u8>>,
    pub spans: Vec<Span>,
    pub dirty: bool,
}

impl ReadSet {
    pub fn of(reads: Reads) -> ReadSet {
        ReadSet { keys: reads.keys, spans: reads.spans, dirty: false }
    }
}

#[derive(Default, Debug, PartialEq)]
pub(super) struct ReadIndex {
    // {key: the calls that got it}
    keys: HashMap<Vec<u8>, HashSet<Call>>,
    // {slice, as "<slice>!": the calls that got a key under it}
    slices: HashMap<Vec<u8>, HashSet<Call>>,
    // {bucket: each span filed under it, as its call and its place among the call's spans}
    spans: HashMap<Vec<u8>, HashSet<(Call, usize)>>,
}

// the slice a key lies in, as "<slice>!"; None for a key under no slice
fn slice_of(key: &[u8]) -> Option<&[u8]> {
    key.iter().position(|&c| c == b'!').map(|i| &key[..=i])
}

// the prefixes of text a bucket can be: "", then each one ending at a separator, up to and
// including the '!' that ends the slice
fn boundaries(text: &[u8]) -> impl Iterator<Item = &[u8]> {
    let end = slice_of(text).map_or(text.len(), |s| s.len());
    let seps = text[..end].iter().enumerate().filter(|&(_, &c)| matches!(c, b':' | b',' | b'!'));
    std::iter::once(&text[..0]).chain(seps.map(move |(i, _)| &text[..=i]))
}

// the bucket of a span: the longest of the boundaries of what every key it covers starts with
fn bucket(s: &Span) -> &[u8] {
    boundaries(s.prefix()).last().unwrap_or_default()
}

// removes a call's entry from a map of sets, dropping the set once it is empty
fn remove<T: Eq + std::hash::Hash>(m: &mut HashMap<Vec<u8>, HashSet<T>>, at: &[u8], entry: &T) {
    if let Some(set) = m.get_mut(at) {
        set.remove(entry);
        if set.is_empty() {
            m.remove(at);
        }
    }
}

impl ReadIndex {
    /// files what a call read
    pub fn link(&mut self, c: Call, r: &ReadSet) {
        for k in &r.keys {
            self.keys.entry(k.clone()).or_default().insert(c);
            if let Some(s) = slice_of(k) {
                self.slices.entry(s.to_vec()).or_default().insert(c);
            }
        }
        for (i, s) in r.spans.iter().enumerate() {
            self.spans.entry(bucket(s).to_vec()).or_default().insert((c, i));
        }
    }

    /// drops what link filed for a call that read r
    pub fn unlink(&mut self, c: Call, r: &ReadSet) {
        for k in &r.keys {
            remove(&mut self.keys, k, &c);
            if let Some(s) = slice_of(k) {
                remove(&mut self.slices, s, &c);
            }
        }
        for (i, s) in r.spans.iter().enumerate() {
            remove(&mut self.spans, bucket(s), &(c, i));
        }
    }

    /// Pushes onto out each call a written key touched: a call that got the key, or whose span
    /// covers it.  read answers a call's read-set while the call is clean, and a dirty call is
    /// passed over; a call may be pushed more than once.
    pub fn written<'r>(
        &self,
        key: &[u8],
        read: impl Fn(Call) -> Option<&'r ReadSet>,
        out: &mut Vec<Call>,
    ) {
        if let Some(calls) = self.keys.get(key) {
            out.extend(calls.iter().filter(|&&c| read(c).is_some()));
        }
        for b in boundaries(key) {
            let Some(spans) = self.spans.get(b) else { continue };
            for &(c, i) in spans {
                if read(c).is_some_and(|r| r.spans[i].covers(key)) {
                    out.push(c);
                }
            }
        }
    }

    /// Pushes onto out each call a cleared slice, its prefix "<slice>!", touched: a call that got
    /// a key under it, or whose span may hold one; as written does.
    pub fn cleared<'r>(
        &self,
        prefix: &[u8],
        read: impl Fn(Call) -> Option<&'r ReadSet>,
        out: &mut Vec<Call>,
    ) {
        if let Some(calls) = self.slices.get(prefix) {
            out.extend(calls.iter().filter(|&&c| read(c).is_some()));
        }
        for b in boundaries(prefix) {
            let Some(spans) = self.spans.get(b) else { continue };
            for &(c, i) in spans {
                if read(c).is_some_and(|r| r.spans[i].may_hold(prefix)) {
                    out.push(c);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phaselock_core::scan::test_span;

    const A: Call = Call { reg: 0, what: Cached::Grant };
    const B: Call = Call { reg: 1, what: Cached::Account };

    fn keys(ks: &[&str]) -> ReadSet {
        ReadSet { keys: ks.iter().map(|k| k.as_bytes().to_vec()).collect(), ..Default::default() }
    }

    // a span of the keys starting with head, from just past from through to
    fn spans(head: &str, from: Option<&str>, to: Option<&str>) -> ReadSet {
        let b = |s: Option<&str>| s.map(|s| s.as_bytes().to_vec());
        ReadSet { spans: vec![test_span(head, b(from), b(to))], ..Default::default() }
    }

    // the read-set of each call while it is clean
    fn read<'r>(sets: &'r [(Call, &'r ReadSet)]) -> impl Fn(Call) -> Option<&'r ReadSet> {
        move |c| sets.iter().find(|(x, r)| *x == c && !r.dirty).map(|(_, r)| *r)
    }

    // the calls a write touched, each once, in order
    fn once(mut out: Vec<Call>) -> Vec<Call> {
        out.sort_by_key(|c| c.reg);
        out.dedup();
        out
    }

    fn written(ix: &ReadIndex, sets: &[(Call, &ReadSet)], key: &str) -> Vec<Call> {
        let mut out = Vec::new();
        ix.written(key.as_bytes(), read(sets), &mut out);
        once(out)
    }

    fn cleared(ix: &ReadIndex, sets: &[(Call, &ReadSet)], prefix: &str) -> Vec<Call> {
        let mut out = Vec::new();
        ix.cleared(prefix.as_bytes(), read(sets), &mut out);
        once(out)
    }

    #[test]
    fn a_written_key_touches_the_calls_that_got_it() {
        let (a, b) = (keys(&["s!x"]), keys(&["s!y", "t!x"]));
        let mut ix = ReadIndex::default();
        ix.link(A, &a);
        ix.link(B, &b);
        let sets = [(A, &a), (B, &b)];
        assert_eq!(written(&ix, &sets, "s!x"), [A]);
        assert_eq!(written(&ix, &sets, "t!x"), [B]);
        assert_eq!(written(&ix, &sets, "s!z"), []);
    }

    #[test]
    fn a_cleared_slice_touches_the_calls_that_got_a_key_under_it() {
        let (a, b) = (keys(&["s!x"]), keys(&["st!x"]));
        let mut ix = ReadIndex::default();
        ix.link(A, &a);
        ix.link(B, &b);
        let sets = [(A, &a), (B, &b)];
        assert_eq!(cleared(&ix, &sets, "s!"), [A]);
        assert_eq!(cleared(&ix, &sets, "st!"), [B]);
        assert_eq!(cleared(&ix, &sets, "u!"), []);
    }

    #[test]
    fn a_span_is_filed_at_the_slice_boundary_its_keys_share() {
        let cases = [
            // every slice
            (spans("", None, None), ""),
            // a family, unbounded and bounded within its first parameter
            (spans("fam:", None, None), "fam:"),
            (spans("fam:", Some("fam:p1,a!x"), Some("fam:p1,b!x")), "fam:p1,"),
            (spans("fam:", Some("fam:p1,a!x"), Some("fam:p2,a!x")), "fam:"),
            // one slice, whatever stretch of its keys
            (spans("s!", Some("s!a"), Some("s!ab")), "s!"),
            (spans("s!", None, None), "s!"),
        ];
        for (r, want) in &cases {
            assert_eq!(bucket(&r.spans[0]), want.as_bytes(), "{want:?}");
        }
    }

    #[test]
    fn a_written_key_touches_the_spans_that_cover_it() {
        let every = spans("", None, None);
        let fam = spans("fam:", Some("fam:p1,a!"), Some("fam:p1,c!"));
        let mut ix = ReadIndex::default();
        ix.link(A, &every);
        ix.link(B, &fam);
        let sets = [(A, &every), (B, &fam)];

        // a key in the family's stretch, one past it, and one in another slice
        assert_eq!(written(&ix, &sets, "fam:p1,b!x"), [A, B]);
        assert_eq!(written(&ix, &sets, "fam:p1,d!x"), [A]);
        assert_eq!(written(&ix, &sets, "other!x"), [A]);
    }

    #[test]
    fn a_cleared_slice_touches_the_spans_that_may_hold_it() {
        let fam = spans("fam:", Some("fam:p1,a!"), Some("fam:p1,c!"));
        let one = spans("s!", None, None);
        let mut ix = ReadIndex::default();
        ix.link(A, &fam);
        ix.link(B, &one);
        let sets = [(A, &fam), (B, &one)];
        assert_eq!(cleared(&ix, &sets, "fam:p1,b!"), [A]);
        assert_eq!(cleared(&ix, &sets, "fam:p2,b!"), []);
        assert_eq!(cleared(&ix, &sets, "s!"), [B]);
    }

    #[test]
    fn a_dirty_call_is_passed_over() {
        let mut a = keys(&["s!x"]);
        let mut ix = ReadIndex::default();
        ix.link(A, &a);
        a.dirty = true;
        assert_eq!(written(&ix, &[(A, &a)], "s!x"), []);
    }

    #[test]
    fn unlinking_drops_every_entry() {
        let (a, b) = (keys(&["s!x", "t!y"]), spans("fam:", Some("fam:p1,a!"), Some("fam:p1,c!")));
        let mut ix = ReadIndex::default();
        ix.link(A, &a);
        ix.link(A, &b);
        ix.link(B, &a);
        ix.unlink(A, &a);
        ix.unlink(A, &b);

        // what is left is what B alone filed
        let mut only_b = ReadIndex::default();
        only_b.link(B, &a);
        assert_eq!(ix, only_b);
        ix.unlink(B, &a);
        assert_eq!(ix, ReadIndex::default());
    }
}
