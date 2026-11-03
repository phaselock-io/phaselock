//! A mutation's write buffer, the read-write layer a decider, bootstrap, or a plugin's run writes
//! through.  It holds each key written once, with its last value's msgpack bytes in store format
//! or a deletion, and the slices deleted, each with whether its history goes too.  Deleting a
//! slice drops the entries under it, so an entry under a deleted slice is a write made after the
//! deletion.  Reads see the buffer over the store: an entry wins, and a store key under a deleted
//! slice is absent.  Entries are kept in key order, which every slice's entries share: '!' sorts
//! below every character a slice name holds, so a slice's keys are contiguous and the slices come
//! in name order.

use std::collections::BTreeMap;
use std::ops::Bound;

#[derive(Default)]
pub struct WriteBuffer {
    // {key: value bytes, or None for a deletion}
    entries: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    // {slice deleted: whether its history goes too}
    dels: BTreeMap<Vec<u8>, bool>,
}

/// the text of a key before its first '!', when it has one
pub fn slice_of(key: &[u8]) -> Option<&[u8]> {
    key.iter().position(|&c| c == b'!').map(|i| &key[..i])
}

/// a walk of the buffer's entries: each key, and its value or None for a deletion
pub type Range<'a> = Box<dyn Iterator<Item = (&'a [u8], Option<&'a [u8]>)> + 'a>;

impl WriteBuffer {
    /// writes key's value, or deletes key for None
    pub fn put(&mut self, key: &[u8], val: Option<&[u8]>) {
        self.entries.insert(key.to_vec(), val.map(|v| v.to_vec()));
    }

    /// the entry for key: its value, or None for a deletion
    pub fn find(&self, key: &[u8]) -> Option<Option<&[u8]>> {
        self.entries.get(key).map(|v| v.as_deref())
    }

    pub fn delete_slice(&mut self, slice: &[u8], erase: bool) {
        // the entries under the slice go, since the deletion clears it
        let mut prefix = slice.to_vec();
        prefix.push(b'!');
        let under: Vec<Vec<u8>> = self
            .entries
            .range::<[u8], _>((Bound::Included(prefix.as_slice()), Bound::Unbounded))
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .collect();
        for k in under {
            self.entries.remove(&k);
        }

        // the deletion, which one made before it joins, erasing if either does
        let e = self.dels.entry(slice.to_vec()).or_insert(false);
        *e = *e || erase;
    }

    /// whether the buffer deleted the slice a key belongs to
    pub fn deleted(&self, key: &[u8]) -> bool {
        if self.dels.is_empty() {
            return false;
        }
        slice_of(key).is_some_and(|s| self.dels.contains_key(s))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.dels.is_empty()
    }

    /// the entries in key order from just past after, or from the first; forward or reverse
    pub fn range<'a>(&'a self, after: Option<&[u8]>, reverse: bool) -> Range<'a> {
        let map = |(k, v): (&'a Vec<u8>, &'a Option<Vec<u8>>)| (k.as_slice(), v.as_deref());
        match (after, reverse) {
            (None, false) => Box::new(self.entries.iter().map(map)),
            (None, true) => Box::new(self.entries.iter().rev().map(map)),
            (Some(a), false) => Box::new(
                self.entries.range::<[u8], _>((Bound::Excluded(a), Bound::Unbounded)).map(map),
            ),
            (Some(a), true) => Box::new(
                self.entries
                    .range::<[u8], _>((Bound::Unbounded, Bound::Excluded(a)))
                    .rev()
                    .map(map),
            ),
        }
    }

    /// Every slice the buffer touched, in name order: its name, its entries in key order, and
    /// its deletion, Some(erase) when the buffer deleted it.
    pub fn touched(&self) -> Vec<Touched<'_>> {
        let mut out: Vec<Touched<'_>> = Vec::new();
        for (k, v) in &self.entries {
            let slice = slice_of(k).unwrap_or(k);
            match out.last_mut() {
                Some(t) if t.name == slice => t.entries.push((k, v.as_deref())),
                _ => out.push(Touched { name: slice, entries: vec![(k, v.as_deref())], del: None }),
            }
        }
        for (s, erase) in &self.dels {
            match out.binary_search_by(|t| t.name.cmp(s)) {
                Ok(i) => out[i].del = Some(*erase),
                Err(i) => {
                    out.insert(i, Touched { name: s, entries: Vec::new(), del: Some(*erase) })
                }
            }
        }
        out
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.dels.clear();
    }
}

/// one slice a mutation's write buffer touched
pub struct Touched<'a> {
    pub name: &'a [u8],
    pub entries: Vec<(&'a [u8], Option<&'a [u8]>)>,
    pub del: Option<bool>,
}
