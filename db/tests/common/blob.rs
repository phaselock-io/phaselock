//! A snapshot blob, parsed and checked per the README's layout.

use std::collections::BTreeMap;

use super::value::{V, decode, decode_prefix};

pub struct Blob {
    pub header: V,
    /// every live slice the blob holds, with its seq
    pub slices: BTreeMap<String, i64>,
    pub position: i64,
    /// each key's value, decoded
    pub records: BTreeMap<String, V>,
    /// each key's value as the blob holds it
    pub raw: BTreeMap<String, Vec<u8>>,
    /// the keys, in the blob's order
    pub keys: Vec<String>,
}

fn crc32c(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0x82F6_3B78 ^ (c >> 1) } else { c >> 1 };
        }
    }
    c ^ 0xFFFF_FFFF
}

fn fnv1a(data: &[u8]) -> u64 {
    data.iter().fold(14695981039346656037u64, |h, &b| (h ^ b as u64).wrapping_mul(1099511628211))
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

/// the length of the msgpack value b starts with
fn size(b: &[u8]) -> usize {
    decode_prefix(b).unwrap_or_else(|| panic!("a truncated value in a blob")).1
}

/// Parses a blob, checking its magic, version, both crcs, the footer's count and hash, and that
/// its keys are in order; any mismatch fails the test.
pub fn parse(b: &[u8]) -> Blob {
    assert!(
        b.len() >= 9 && &b[..4] == b"PLSN" && b[4] == 1,
        "bad magic/version: {:02x?}",
        &b[..b.len().min(9)]
    );
    let hlen = u32_at(b, 5) as usize;
    assert_eq!(u32_at(b, 9 + hlen), crc32c(&b[9..9 + hlen]), "header crc mismatch");
    let header = decode(&b[9..9 + hlen]);
    let slices = header["slices"].map().iter().map(|(k, v)| (k.clone(), v.int())).collect();
    let mut out = Blob {
        position: header["position"].int(),
        header,
        slices,
        records: BTreeMap::new(),
        raw: BTreeMap::new(),
        keys: Vec::new(),
    };

    // the set operations, back to back, up to the end marker
    let mut p = 13 + hlen;
    let ops_start = p;
    let mut count = 0u32;
    while u32_at(b, p) != 0xFFFF_FFFF {
        assert_eq!(b[p], 0, "opcode {:x} in a snapshot", b[p]);
        p += 1;
        let kn = size(&b[p..]);
        let key = decode(&b[p..p + kn]).str().to_string();
        p += kn;
        let vn = size(&b[p..]);
        let val = &b[p..p + vn];
        p += vn;
        out.records.insert(key.clone(), decode(val));
        out.raw.insert(key.clone(), val.to_vec());
        out.keys.push(key);
        count += 1;
    }
    let ops_end = p;

    // the footer: the count, the hash of the operations' bytes, and its crc
    let footer = &b[p + 4..];
    assert_eq!(footer.len(), 16, "footer length");
    assert_eq!(u32_at(footer, 0), count, "footer count");
    assert_eq!(
        u64::from_be_bytes(footer[4..12].try_into().unwrap()),
        fnv1a(&b[ops_start..ops_end]),
        "content hash mismatch"
    );
    assert_eq!(u32_at(footer, 12), crc32c(&footer[..12]), "footer crc mismatch");
    assert!(out.keys.windows(2).all(|w| w[0] < w[1]), "keys not sorted: {:?}", out.keys);
    out
}
