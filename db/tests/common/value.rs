//! A msgpack value as the tests build and read it: the JSON projection, a timestamp, and bin.  A
//! map's keys are strings, kept in order, so an encoded map is the same bytes every time.

use std::collections::BTreeMap;
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use phaselockdb::mp::{self, Node};

#[derive(Clone, PartialEq)]
pub enum V {
    Nil,
    Bool(bool),
    Int(i64),
    /// an integer past i64
    Uint(u64),
    Float(f64),
    Str(String),
    Bin(Vec<u8>),
    Time(SystemTime),
    Arr(Vec<V>),
    Map(BTreeMap<String, V>),
}

pub static NIL: V = V::Nil;

impl V {
    /// the integer a value holds, an integral float's included; panics on any other value
    pub fn int(&self) -> i64 {
        match self {
            V::Int(i) => *i,
            V::Uint(u) => *u as i64,
            V::Float(f) => *f as i64,
            _ => panic!("not an integer: {self:?}"),
        }
    }

    pub fn str(&self) -> &str {
        match self {
            V::Str(s) => s,
            _ => panic!("not a string: {self:?}"),
        }
    }

    pub fn bin(&self) -> &[u8] {
        match self {
            V::Bin(b) => b,
            _ => panic!("not bin: {self:?}"),
        }
    }

    pub fn time(&self) -> SystemTime {
        match self {
            V::Time(t) => *t,
            _ => panic!("not a timestamp: {self:?}"),
        }
    }

    pub fn arr(&self) -> &[V] {
        match self {
            V::Arr(a) => a,
            _ => panic!("not an array: {self:?}"),
        }
    }

    pub fn map(&self) -> &BTreeMap<String, V> {
        match self {
            V::Map(m) => m,
            _ => panic!("not a map: {self:?}"),
        }
    }

    pub fn is_nil(&self) -> bool {
        matches!(self, V::Nil)
    }

    /// a map's entry, None for a key it lacks or for a value that is not a map
    pub fn get(&self, key: &str) -> Option<&V> {
        match self {
            V::Map(m) => m.get(key),
            _ => None,
        }
    }

    /// whether the value is the string s
    pub fn is(&self, s: &str) -> bool {
        matches!(self, V::Str(x) if x == s)
    }
}

/// an array's element; panics past its end
impl std::ops::Index<usize> for V {
    type Output = V;
    fn index(&self, i: usize) -> &V {
        &self.arr()[i]
    }
}

/// a map's entry, nil for a key it lacks
impl std::ops::Index<&str> for V {
    type Output = V;
    fn index(&self, k: &str) -> &V {
        self.get(k).unwrap_or(&NIL)
    }
}

impl PartialEq<&str> for V {
    fn eq(&self, s: &&str) -> bool {
        self.is(s)
    }
}

impl fmt::Debug for V {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            V::Nil => f.write_str("nil"),
            V::Bool(b) => write!(f, "{b}"),
            V::Int(i) => write!(f, "{i}"),
            V::Uint(u) => write!(f, "{u}"),
            V::Float(x) => write!(f, "{x:?}"),
            V::Str(s) => write!(f, "{s:?}"),
            V::Bin(b) => write!(f, "bin{:?}", String::from_utf8_lossy(b)),
            V::Time(t) => write!(f, "time({}ms)", unix_ms(*t)),
            V::Arr(a) => f.debug_list().entries(a).finish(),
            V::Map(m) => f.debug_map().entries(m).finish(),
        }
    }
}

macro_rules! from {
    ($($t:ty => $e:expr),* $(,)?) => {
        $(impl From<$t> for V {
            fn from(x: $t) -> V {
                let f: fn($t) -> V = $e;
                f(x)
            }
        })*
    };
}

from! {
    &str => |s| V::Str(s.to_string()),
    String => V::Str,
    &String => |s| V::Str(s.clone()),
    bool => V::Bool,
    i64 => V::Int,
    i32 => |i| V::Int(i as i64),
    u32 => |i| V::Int(i as i64),
    usize => |i| V::Int(i as i64),
    u64 => |u| if u <= i64::MAX as u64 { V::Int(u as i64) } else { V::Uint(u) },
    f64 => V::Float,
    SystemTime => V::Time,
    Vec<V> => V::Arr,
    Vec<u8> => V::Bin,
    &[u8] => |b| V::Bin(b.to_vec()),
    Vec<String> => |v| V::Arr(v.into_iter().map(V::Str).collect()),
    Vec<&str> => |v| V::Arr(v.into_iter().map(V::from).collect()),
    BTreeMap<String, V> => V::Map,
    () => |()| V::Nil,
}

impl From<&V> for V {
    fn from(v: &V) -> V {
        v.clone()
    }
}

impl<T: Into<V>> From<Option<T>> for V {
    fn from(o: Option<T>) -> V {
        o.map_or(V::Nil, Into::into)
    }
}

/// an array of values, each converted: `arr!["set", key, 3]`
#[macro_export]
macro_rules! arr {
    ($($x:expr),* $(,)?) => {
        $crate::common::value::V::Arr(vec![$($crate::common::value::V::from($x)),*])
    };
}

/// a map of string keys to values, each converted: `obj!{"kind" => "dev", "identity" => "p1"}`
#[macro_export]
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = std::collections::BTreeMap::new();
        $(m.insert(String::from($k), $crate::common::value::V::from($v));)*
        $crate::common::value::V::Map(m)
    }};
}

/// a time as Unix milliseconds
pub fn unix_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// the time of Unix milliseconds
pub fn from_unix_ms(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    }
}

fn of(n: &Node<'_>) -> Result<V, String> {
    Ok(match n {
        Node::Nil => V::Nil,
        Node::Bool(b) => V::Bool(*b),
        Node::Int(i) => V::Int(*i),
        Node::Uint(u) => V::from(*u),
        Node::F32(f) => V::Float(*f as f64),
        Node::F64(f) => V::Float(*f),
        Node::Str(s) => V::Str(String::from_utf8_lossy(s).into_owned()),
        Node::Bin(b) => V::Bin(b.to_vec()),
        Node::Ext(t, p) if *t == mp::EXT_TIMESTAMP => {
            let be = |b: &[u8]| b.iter().fold(0u64, |x, &c| x << 8 | c as u64);
            let (sec, nsec) = match p.len() {
                4 => (be(p) as i64, 0u32),
                8 => ((be(p) & 0x3_ffff_ffff) as i64, (be(p) >> 34) as u32),
                12 => (be(&p[4..]) as i64, be(&p[..4]) as u32),
                n => return Err(format!("a timestamp of {n} bytes")),
            };
            let t = if sec >= 0 {
                UNIX_EPOCH + Duration::from_secs(sec as u64)
            } else {
                UNIX_EPOCH - Duration::from_secs(sec.unsigned_abs())
            };
            V::Time(t + Duration::from_nanos(nsec as u64))
        }
        Node::Ext(t, _) => return Err(format!("an extension of type {t}")),
        Node::Array(a) => V::Arr(a.iter().map(of).collect::<Result<_, _>>()?),
        Node::Map(m) => {
            let mut out = BTreeMap::new();
            for (k, v) in m {
                let Some(k) = k.as_str() else { return Err("a map key is not a string".into()) };
                out.insert(String::from_utf8_lossy(k).into_owned(), of(v)?);
            }
            V::Map(out)
        }
    })
}

/// The value b starts with and the bytes it took; None when b holds only part of one.  Panics on
/// a malformed value.
pub fn decode_prefix(b: &[u8]) -> Option<(V, usize)> {
    match mp::parse(b) {
        Ok((n, used)) => Some((of(&n).unwrap_or_else(|e| panic!("decode: {e}")), used)),
        Err(mp::ParseError::Truncated) => None,
        Err(e) => panic!("decode: {e} ({b:02x?})"),
    }
}

/// b as exactly one value; panics on anything else
pub fn decode(b: &[u8]) -> V {
    let n = mp::parse_whole(b).unwrap_or_else(|e| panic!("decode: {e} ({b:02x?})"));
    of(&n).unwrap_or_else(|e| panic!("decode: {e}"))
}

fn write(w: &mut mp::Writer, v: &V) {
    match v {
        V::Nil => w.nil(),
        V::Bool(b) => w.bool(*b),
        V::Int(i) => w.int(*i),
        V::Uint(u) => w.uint(*u),
        V::Float(f) => w.double(*f),
        V::Str(s) => w.str(s.as_bytes()),
        V::Bin(b) => w.bin(b),
        V::Time(t) => {
            // at millisecond precision, as every PhaseLock host writes a time
            let ms = unix_ms(*t);
            w.timestamp(ms.div_euclid(1000), (ms.rem_euclid(1000) * 1_000_000) as u32);
        }
        V::Arr(a) => {
            w.array(a.len());
            for x in a {
                write(w, x);
            }
        }
        V::Map(m) => {
            w.map(m.len());
            for (k, x) in m {
                w.str(k.as_bytes());
                write(w, x);
            }
        }
    }
}

/// a value's encoding: the smallest of each integer, string, and container
pub fn encode(v: &V) -> Vec<u8> {
    let mut w = mp::Writer::new();
    write(&mut w, v);
    w.into_vec()
}
