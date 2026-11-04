//! Edits as bytes: an edit's envelope, read from its raw bytes, and the operations of an edit or a
//! snapshot page, split into byte spans without decoding a value.
//!
//! An edit on the wire is one msgpack array, its envelope and then its payload's items, flat:
//!
//! ```text
//! [[position, slice, seq, id, servertime, lifecycle, ...], 0, key, value, 1, key, ...]
//! ```
//!
//! The id is 16 bytes of bin, the server time a timestamp, and the lifecycle 0, 1, or 2.  The
//! payload is a stream of operations, each an opcode and the items it fixes: `0, key, value` sets
//! a key, and `1, key` deletes one.  A snapshot page is a run of operations with no envelope and
//! no array around them, all of them sets.

use phaselock_core::mp::{self, Node};

pub type Result<T> = std::result::Result<T, String>;

/// An edit's lifecycle: a birth or a death clears its slice before its operations apply.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lifecycle {
    Normal,
    Birth,
    Death,
}

impl Lifecycle {
    pub fn name(self) -> &'static str {
        match self {
            Lifecycle::Normal => "normal",
            Lifecycle::Birth => "birth",
            Lifecycle::Death => "death",
        }
    }
}

/// An edit's envelope.  Elements a later protocol appends are skipped.
#[derive(Debug)]
pub struct Envelope<'a> {
    pub position: i64,
    pub slice: &'a [u8],
    pub seq: i64,
    pub id: &'a [u8],
    pub servertime_ms: f64,
    pub lifecycle: Lifecycle,
}

fn bad(what: &str) -> String {
    format!("malformed edit: {what}")
}

/// The envelope of a raw edit, and the offset of the edit's first payload item with the count of
/// its payload's items.
pub fn envelope(raw: &[u8]) -> Result<(Envelope<'_>, usize, usize)> {
    let (n, at) = mp::array_header(raw).map_err(|e| bad(&e.to_string()))?;
    if n < 1 {
        return Err(bad("no envelope"));
    }
    let (env, used) = mp::parse(&raw[at..]).map_err(|e| bad(&e.to_string()))?;
    let Some(fields) = env.array().filter(|f| f.len() >= 6) else {
        return Err(bad("short envelope"));
    };
    let int = |i: usize| fields[i].as_i64().ok_or_else(|| bad("an envelope integer"));
    let Some(slice) = fields[1].as_str() else { return Err(bad("the slice")) };
    let Node::Bin(id) = fields[3] else { return Err(bad("the id")) };
    let Node::Ext(mp::EXT_TIMESTAMP, ts) = fields[4] else { return Err(bad("the server time")) };
    let lifecycle = match int(5)? {
        0 => Lifecycle::Normal,
        1 => Lifecycle::Birth,
        2 => Lifecycle::Death,
        l => return Err(bad(&format!("unknown lifecycle {l}"))),
    };
    let env = Envelope {
        position: int(0)?,
        slice,
        seq: int(2)?,
        id,
        servertime_ms: timestamp_ms(ts).ok_or_else(|| bad("the server time"))?,
        lifecycle,
    };
    Ok((env, at + used, n - 1))
}

// the milliseconds of a msgpack timestamp's payload, in any of its three sizes
fn timestamp_ms(ts: &[u8]) -> Option<f64> {
    let be = |b: &[u8]| b.iter().fold(0u64, |x, &c| x << 8 | c as u64);
    let (sec, nsec) = match ts.len() {
        4 => (be(ts) as i64, 0),
        8 => {
            let v = be(ts);
            ((v & 0x3_ffff_ffff) as i64, (v >> 34) as u32)
        }
        12 => (be(&ts[4..]) as i64, be(&ts[..4]) as u32),
        _ => return None,
    };
    Some(sec as f64 * 1000.0 + (nsec / 1_000_000) as f64)
}

/// one operation: a key, and the value's bytes for a set or None for a deletion
pub type Op<'a> = (&'a [u8], Option<&'a [u8]>);

/// The operations of a raw edit, its envelope skipped, or of a snapshot page, in order.  An
/// opcode this host does not know fails.
pub fn ops(bytes: &[u8], edit: bool) -> Result<Vec<Op<'_>>> {
    // an edit's operations are the items after its envelope; a page's run to the end of its bytes
    let (mut at, mut left) = if edit {
        let (_, at, items) = envelope(bytes)?;
        (at, items)
    } else {
        (0, usize::MAX)
    };

    // each operation, its opcode first
    let mut out = Vec::new();
    while if edit { left > 0 } else { at < bytes.len() } {
        let (op, used) = mp::parse(&bytes[at..]).map_err(|e| bad(&e.to_string()))?;
        at += used;
        let (key, used) = mp::parse(&bytes[at..]).map_err(|e| bad(&e.to_string()))?;
        at += used;
        let Some(key) = key.as_str() else { return Err(bad("an operation's key")) };
        match op.as_i64() {
            Some(0) => {
                let used = mp::skip(&bytes[at..]).map_err(|e| bad(&e.to_string()))?;
                out.push((key, Some(&bytes[at..at + used])));
                at += used;
                left =
                    left.checked_sub(3).ok_or_else(|| bad("an edit ends inside an operation"))?;
            }
            Some(1) => {
                out.push((key, None));
                left =
                    left.checked_sub(2).ok_or_else(|| bad("an edit ends inside an operation"))?;
            }
            _ => return Err(bad(&format!("unknown opcode {op:?}"))),
        }
    }
    Ok(out)
}

/// the slice a key is under: everything before its first `!`
pub fn slice_of(key: &[u8]) -> &[u8] {
    match key.iter().position(|&c| c == b'!') {
        Some(i) => &key[..i],
        None => key,
    }
}

/// The text every key a selector picks out starts with: a prefix selector's text before its
/// star, and an exact selector's slice with the `!` after it.
pub fn selector_prefix(selector: &[u8]) -> Vec<u8> {
    match selector.strip_suffix(b"*") {
        Some(p) => p.to_vec(),
        None => [selector, b"!"].concat(),
    }
}

/// the key of a slice's parked edit at a seq, which sorts the slice's chain in seq order
pub fn parked_edit_key(slice: &[u8], seq: i64) -> Vec<u8> {
    let mut k = b"!park-edit:".to_vec();
    k.extend_from_slice(slice);
    k.extend_from_slice(format!("!{seq:020}").as_bytes());
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_edit(life: i64, ops: &[(&str, Option<i64>)]) -> Vec<u8> {
        let mut w = mp::Writer::new();
        let items: usize = ops.iter().map(|(_, v)| if v.is_some() { 3 } else { 2 }).sum();
        w.array(1 + items);
        w.array(7);
        w.int(5);
        w.str(b"book:r");
        w.int(2);
        w.bin(&[7u8; 16]);
        w.timestamp(1_700_000_000, 5_000_000);
        w.int(life);
        w.str(b"appended later");
        for (k, v) in ops {
            match v {
                Some(v) => {
                    w.int(0);
                    w.str(k.as_bytes());
                    w.int(*v);
                }
                None => {
                    w.int(1);
                    w.str(k.as_bytes());
                }
            }
        }
        w.into_vec()
    }

    #[test]
    fn an_edit_reads_as_its_envelope_and_operations() {
        let raw = raw_edit(1, &[("book:r!a", Some(300)), ("book:r!b", None)]);
        let (env, _, items) = envelope(&raw).unwrap();
        assert_eq!((env.position, env.slice, env.seq), (5, &b"book:r"[..], 2));
        assert_eq!(env.lifecycle, Lifecycle::Birth);
        assert_eq!(env.servertime_ms, 1_700_000_000_005.0);
        assert_eq!(items, 5);
        let ops = ops(&raw, true).unwrap();
        assert_eq!(
            ops,
            vec![(&b"book:r!a"[..], Some(&[0xcd, 0x01, 0x2c][..])), (&b"book:r!b"[..], None)]
        );
    }

    #[test]
    fn a_page_reads_as_its_sets() {
        let mut w = mp::Writer::new();
        for (k, v) in [("a!x", "1"), ("a!y", "22")] {
            w.int(0);
            w.str(k.as_bytes());
            w.str(v.as_bytes());
        }
        let page = w.into_vec();
        let ops = ops(&page, false).unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1], (&b"a!y"[..], Some(&[0xa2, b'2', b'2'][..])));
    }

    #[test]
    fn keys_name_their_slice_and_selectors_their_prefix() {
        assert_eq!(slice_of(b"patron:r,p!patron"), b"patron:r,p");
        assert_eq!(selector_prefix(b"patron:r,*"), b"patron:r,");
        assert_eq!(selector_prefix(b"book:r"), b"book:r!");
        assert_eq!(parked_edit_key(b"book:r", 3), b"!park-edit:book:r!00000000000000000003");
    }
}
