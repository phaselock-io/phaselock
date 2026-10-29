//! Msgpack: a parser of one value into a tree that borrows the input, and a writer that picks the
//! smallest encoding of every integer, string, and container, so the bytes it writes are the
//! encoding every PhaseLock host writes.  A timestamp is the msgpack timestamp extension, type -1.

use std::fmt;

/// One parsed value.  Integers keep the signedness of their encoding; a reader that wants an
/// i64 asks `as_i64`, which takes either.
#[derive(Debug, Clone)]
pub enum Node<'a> {
    Nil,
    Bool(bool),
    Int(i64),
    Uint(u64),
    F32(f32),
    F64(f64),
    Str(&'a [u8]),
    Bin(&'a [u8]),
    Ext(i8, &'a [u8]),
    Array(Vec<Node<'a>>),
    Map(Vec<(Node<'a>, Node<'a>)>),
}

pub const EXT_TIMESTAMP: i8 = -1;

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    Truncated,
    Invalid,
    TooDeep,
    /// the value holds more values than the parse allows
    TooBig,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ParseError::Truncated => "msgpack: truncated",
            ParseError::Invalid => "msgpack: invalid",
            ParseError::TooDeep => "msgpack: nested too deeply",
            ParseError::TooBig => "msgpack: too many values",
        })
    }
}

// a parse nests no deeper than this, so a hostile body cannot exhaust the stack
const MAX_PARSE_DEPTH: usize = 2048;

// the most elements a container's header reserves room for before they parse, since a header's
// count is the sender's claim
const PREALLOC_MAX: usize = 256;

impl<'a> Node<'a> {
    pub fn as_str(&self) -> Option<&'a [u8]> {
        match self {
            Node::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_nil(&self) -> bool {
        matches!(self, Node::Nil)
    }

    /// the integer an int or uint node holds, when it fits an i64
    pub fn as_i64(&self) -> Option<i64> {
        match *self {
            Node::Int(i) => Some(i),
            Node::Uint(u) if u <= i64::MAX as u64 => Some(u as i64),
            _ => None,
        }
    }

    /// the integer an int or uint node holds, when it is not negative
    pub fn as_u64(&self) -> Option<u64> {
        match *self {
            Node::Int(i) if i >= 0 => Some(i as u64),
            Node::Uint(u) => Some(u),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Node<'a>]> {
        match self {
            Node::Array(v) => Some(v),
            _ => None,
        }
    }

    pub fn map(&self) -> Option<&[(Node<'a>, Node<'a>)]> {
        match self {
            Node::Map(v) => Some(v),
            _ => None,
        }
    }

    /// the value of a map's entry whose key is the string key
    pub fn get(&self, key: &str) -> Option<&Node<'a>> {
        self.map()?.iter().find(|(k, _)| k.as_str() == Some(key.as_bytes())).map(|(_, v)| v)
    }
}

/// Parses the msgpack value data starts with, answering it and the bytes it took.
pub fn parse(data: &[u8]) -> Result<(Node<'_>, usize), ParseError> {
    parse_limited(data, usize::MAX)
}

/// Parses the msgpack value data starts with, as parse does, failing with TooBig past max values,
/// each container and each scalar one, which bounds the memory of the tree.
pub fn parse_limited(data: &[u8], max: usize) -> Result<(Node<'_>, usize), ParseError> {
    let mut p = Parser { data, at: 0, left: max };
    let n = p.value(0)?;
    Ok((n, p.at))
}

/// Parses data as exactly one msgpack value.
pub fn parse_whole(data: &[u8]) -> Result<Node<'_>, ParseError> {
    let (n, used) = parse(data)?;
    if used != data.len() {
        return Err(ParseError::Invalid);
    }
    Ok(n)
}

struct Parser<'a> {
    data: &'a [u8],
    at: usize,
    // the values the parse may still take
    left: usize,
}

impl<'a> Parser<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        if self.data.len() - self.at < n {
            return Err(ParseError::Truncated);
        }
        let s = &self.data[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }

    fn be(&mut self, n: usize) -> Result<u64, ParseError> {
        Ok(self.take(n)?.iter().fold(0u64, |x, &b| x << 8 | b as u64))
    }

    fn value(&mut self, depth: usize) -> Result<Node<'a>, ParseError> {
        if depth > MAX_PARSE_DEPTH {
            return Err(ParseError::TooDeep);
        }
        if self.left == 0 {
            return Err(ParseError::TooBig);
        }
        self.left -= 1;
        let c = self.take(1)?[0];
        Ok(match c {
            0x00..=0x7f => Node::Uint(c as u64),
            0xe0..=0xff => Node::Int(c as i8 as i64),
            0x80..=0x8f => self.map_n((c & 0x0f) as usize, depth)?,
            0x90..=0x9f => self.array_n((c & 0x0f) as usize, depth)?,
            0xa0..=0xbf => Node::Str(self.take((c & 0x1f) as usize)?),
            0xc0 => Node::Nil,
            0xc2 => Node::Bool(false),
            0xc3 => Node::Bool(true),
            0xc4 => {
                let n = self.be(1)? as usize;
                Node::Bin(self.take(n)?)
            }
            0xc5 => {
                let n = self.be(2)? as usize;
                Node::Bin(self.take(n)?)
            }
            0xc6 => {
                let n = self.be(4)? as usize;
                Node::Bin(self.take(n)?)
            }
            0xc7..=0xc9 => {
                let n = self.be(1 << (c - 0xc7))? as usize;
                let t = self.take(1)?[0] as i8;
                Node::Ext(t, self.take(n)?)
            }
            0xca => Node::F32(f32::from_bits(self.be(4)? as u32)),
            0xcb => Node::F64(f64::from_bits(self.be(8)?)),
            0xcc => Node::Uint(self.be(1)?),
            0xcd => Node::Uint(self.be(2)?),
            0xce => Node::Uint(self.be(4)?),
            0xcf => Node::Uint(self.be(8)?),
            0xd0 => Node::Int(self.be(1)? as u8 as i8 as i64),
            0xd1 => Node::Int(self.be(2)? as u16 as i16 as i64),
            0xd2 => Node::Int(self.be(4)? as u32 as i32 as i64),
            0xd3 => Node::Int(self.be(8)? as i64),
            0xd4..=0xd8 => {
                let t = self.take(1)?[0] as i8;
                Node::Ext(t, self.take(1 << (c - 0xd4))?)
            }
            0xd9 => {
                let n = self.be(1)? as usize;
                Node::Str(self.take(n)?)
            }
            0xda => {
                let n = self.be(2)? as usize;
                Node::Str(self.take(n)?)
            }
            0xdb => {
                let n = self.be(4)? as usize;
                Node::Str(self.take(n)?)
            }
            0xdc => {
                let n = self.be(2)? as usize;
                self.array_n(n, depth)?
            }
            0xdd => {
                let n = self.be(4)? as usize;
                self.array_n(n, depth)?
            }
            0xde => {
                let n = self.be(2)? as usize;
                self.map_n(n, depth)?
            }
            0xdf => {
                let n = self.be(4)? as usize;
                self.map_n(n, depth)?
            }
            _ => return Err(ParseError::Invalid),
        })
    }

    fn array_n(&mut self, n: usize, depth: usize) -> Result<Node<'a>, ParseError> {
        // every element takes a byte at least, so a count past the bytes left is truncated
        if n > self.data.len() - self.at {
            return Err(ParseError::Truncated);
        }
        let mut v = Vec::with_capacity(n.min(PREALLOC_MAX));
        for _ in 0..n {
            v.push(self.value(depth + 1)?);
        }
        Ok(Node::Array(v))
    }

    fn map_n(&mut self, n: usize, depth: usize) -> Result<Node<'a>, ParseError> {
        if n > (self.data.len() - self.at) / 2 {
            return Err(ParseError::Truncated);
        }
        let mut v = Vec::with_capacity(n.min(PREALLOC_MAX));
        for _ in 0..n {
            let k = self.value(depth + 1)?;
            let val = self.value(depth + 1)?;
            v.push((k, val));
        }
        Ok(Node::Map(v))
    }
}

/// A msgpack writer over a growable buffer.
#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Writer {
        Writer { buf: Vec::new() }
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }

    pub fn nil(&mut self) {
        self.buf.push(0xc0);
    }

    pub fn bool(&mut self, b: bool) {
        self.buf.push(if b { 0xc3 } else { 0xc2 });
    }

    pub fn uint(&mut self, v: u64) {
        let b = &mut self.buf;
        if v <= 0x7f {
            b.push(v as u8);
        } else if v <= 0xff {
            b.extend_from_slice(&[0xcc, v as u8]);
        } else if v <= 0xffff {
            b.push(0xcd);
            b.extend_from_slice(&(v as u16).to_be_bytes());
        } else if v <= 0xffff_ffff {
            b.push(0xce);
            b.extend_from_slice(&(v as u32).to_be_bytes());
        } else {
            b.push(0xcf);
            b.extend_from_slice(&v.to_be_bytes());
        }
    }

    pub fn int(&mut self, v: i64) {
        if v >= 0 {
            return self.uint(v as u64);
        }
        let b = &mut self.buf;
        if v >= -32 {
            b.push(v as i8 as u8);
        } else if v >= i8::MIN as i64 {
            b.extend_from_slice(&[0xd0, v as i8 as u8]);
        } else if v >= i16::MIN as i64 {
            b.push(0xd1);
            b.extend_from_slice(&(v as i16).to_be_bytes());
        } else if v >= i32::MIN as i64 {
            b.push(0xd2);
            b.extend_from_slice(&(v as i32).to_be_bytes());
        } else {
            b.push(0xd3);
            b.extend_from_slice(&v.to_be_bytes());
        }
    }

    pub fn double(&mut self, f: f64) {
        self.buf.push(0xcb);
        self.buf.extend_from_slice(&f.to_bits().to_be_bytes());
    }

    pub fn str(&mut self, s: &[u8]) {
        let n = s.len();
        let b = &mut self.buf;
        if n <= 31 {
            b.push(0xa0 | n as u8);
        } else if n <= 0xff {
            b.extend_from_slice(&[0xd9, n as u8]);
        } else if n <= 0xffff {
            b.push(0xda);
            b.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            b.push(0xdb);
            b.extend_from_slice(&(n as u32).to_be_bytes());
        }
        b.extend_from_slice(s);
    }

    pub fn bin(&mut self, s: &[u8]) {
        let n = s.len();
        let b = &mut self.buf;
        if n <= 0xff {
            b.extend_from_slice(&[0xc4, n as u8]);
        } else if n <= 0xffff {
            b.push(0xc5);
            b.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            b.push(0xc6);
            b.extend_from_slice(&(n as u32).to_be_bytes());
        }
        b.extend_from_slice(s);
    }

    /// the smallest timestamp extension that holds the time
    pub fn timestamp(&mut self, sec: i64, nsec: u32) {
        let b = &mut self.buf;
        if !(0..1i64 << 34).contains(&sec) {
            b.extend_from_slice(&[0xc7, 12, 0xff]);
            b.extend_from_slice(&nsec.to_be_bytes());
            b.extend_from_slice(&sec.to_be_bytes());
        } else if sec > u32::MAX as i64 || nsec > 0 {
            b.extend_from_slice(&[0xd7, 0xff]);
            b.extend_from_slice(&(((nsec as u64) << 34) | sec as u64).to_be_bytes());
        } else {
            b.extend_from_slice(&[0xd6, 0xff]);
            b.extend_from_slice(&(sec as u32).to_be_bytes());
        }
    }

    pub fn array(&mut self, n: usize) {
        let b = &mut self.buf;
        if n <= 15 {
            b.push(0x90 | n as u8);
        } else if n <= 0xffff {
            b.push(0xdc);
            b.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            b.push(0xdd);
            b.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    pub fn map(&mut self, n: usize) {
        let b = &mut self.buf;
        if n <= 15 {
            b.push(0x80 | n as u8);
        } else if n <= 0xffff {
            b.push(0xde);
            b.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            b.push(0xdf);
            b.extend_from_slice(&(n as u32).to_be_bytes());
        }
    }

    /// bytes that are already one or more encoded values
    pub fn raw(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }
}

/// Writes one value of a small dynamic shape, for frames and replies the server builds itself.
pub enum Val<'a> {
    Int(i64),
    Str(&'a str),
    Strs(&'a [String]),
    Array(Vec<Val<'a>>),
    Map(Vec<(&'a str, Val<'a>)>),
}

impl Writer {
    pub fn val(&mut self, v: &Val<'_>) {
        match v {
            Val::Int(i) => self.int(*i),
            Val::Str(s) => self.str(s.as_bytes()),
            Val::Strs(ss) => {
                self.array(ss.len());
                for s in ss.iter() {
                    self.str(s.as_bytes());
                }
            }
            Val::Array(items) => {
                self.array(items.len());
                for i in items {
                    self.val(i);
                }
            }
            Val::Map(entries) => {
                self.map(entries.len());
                for (k, v) in entries {
                    self.str(k.as_bytes());
                    self.val(v);
                }
            }
        }
    }
}

/// one value's encoding
pub fn encode(v: &Val<'_>) -> Vec<u8> {
    let mut w = Writer::new();
    w.val(v);
    w.into_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    // an array of n nils
    fn nils(n: usize) -> Vec<u8> {
        let mut w = Writer::new();
        w.array(n);
        for _ in 0..n {
            w.nil();
        }
        w.into_vec()
    }

    #[test]
    fn a_parse_takes_at_most_its_values() {
        // the array counts as a value beside its nils
        assert!(parse_limited(&nils(9), 10).is_ok());
        assert_eq!(parse_limited(&nils(10), 10).unwrap_err(), ParseError::TooBig);
    }

    #[test]
    fn a_header_reserves_little_before_its_elements_parse() {
        // nested headers, each claiming every byte left, nest too deeply long before what they
        // claim would be reserved: 5 bytes a level, each level's claim the bytes after its header
        let levels = 4096;
        let mut b = Vec::new();
        for i in 0..levels {
            b.push(0xdd);
            b.extend_from_slice(&(5 * (levels - 1 - i) as u32).to_be_bytes());
        }
        assert_eq!(parse(&b).unwrap_err(), ParseError::TooDeep);
    }
}
