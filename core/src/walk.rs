//! The conversion kernel: every typed value crosses as
//!
//! ```text
//! source -> schema walk -> sink
//! ```
//!
//! The sources are a parsed msgpack tree and a tokenization of a QuickJS value; the sinks build
//! JS values, write msgpack, or discard (a check).  The schema is the registry the bundle
//! carries, compiled once when the database opens, and the walk checks every value against it as
//! it converts.

use std::collections::HashMap;
use std::ffi::CString;

use crate::js::ffi::*;
use crate::mp::{self, Node};

const MAX_DEPTH: usize = 512;

// the furthest a JS Date reaches either side of the epoch, in milliseconds
const DATE_MAX_MS: f64 = 8.64e15;

// the largest integer every client holds exactly, 2^53
const EXACT: f64 = 9007199254740992.0;

// tokens ////////////////////////////////////////////////////////////////////

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Invalid,
    Obj,
    Arr,
    Key,
    Str,
    Int,
    Float,
    Bool,
    Null,
    Date,
}

/// One token of a JS value.  A string or key carries its bytes as a span of the arena; a container
/// carries its element count and the index just past its end, so skipping a value is a jump.
#[derive(Clone, Copy)]
pub struct Tok {
    pub kind: Kind,
    soff: u32,
    num: u32,
    end: u32,
    i: i64,
    f: f64,
}

impl Tok {
    fn new(kind: Kind) -> Tok {
        Tok { kind, soff: 0, num: 0, end: 0, i: 0, f: 0.0 }
    }
}

#[derive(Default)]
pub struct TokBuf {
    toks: Vec<Tok>,
    arena: Vec<u8>,
}

impl TokBuf {
    fn span(&self, t: &Tok) -> &[u8] {
        &self.arena[t.soff as usize..t.soff as usize + t.num as usize]
    }

    fn skip(&self, idx: usize) -> usize {
        let t = &self.toks[idx];
        match t.kind {
            Kind::Obj | Kind::Arr => t.end as usize,
            _ => idx + 1,
        }
    }

    fn push_str(&mut self, kind: Kind, s: &[u8]) {
        let soff = self.arena.len() as u32;
        self.arena.extend_from_slice(s);
        let mut t = Tok::new(kind);
        t.soff = soff;
        t.num = s.len() as u32;
        self.toks.push(t);
    }
}

/// The JS classes the tokenizer and the hosts' natives tell apart, learned once per context, so
/// that no type test throws.
#[derive(Clone, Copy)]
pub struct JsEnv {
    pub ctx: *mut JSContext,
    date: JSClassID,
    set: JSClassID,
    map: JSClassID,
    buffer: JSClassID,
}

impl JsEnv {
    pub fn new(ctx: *mut JSContext) -> Option<JsEnv> {
        let learn = |expr: &str| unsafe {
            let src = CString::new(expr).unwrap();
            let v = JS_Eval(ctx, src.as_ptr(), expr.len(), c"<class-id>".as_ptr(), 0);
            if is_exception(v) {
                return None;
            }
            let id = JS_GetClassID(v);
            JS_FreeValue(ctx, v);
            Some(id)
        };
        Some(JsEnv {
            ctx,
            date: learn("new Date(0)")?,
            set: learn("new Set()")?,
            map: learn("new Map()")?,
            buffer: learn("new ArrayBuffer(0)")?,
        })
    }

    /// whether a value is an ArrayBuffer
    pub fn is_array_buffer(&self, v: JSValue) -> bool {
        is_object(v) && unsafe { JS_GetClassID(v) } == self.buffer
    }
}

fn drop_exception(ctx: *mut JSContext) {
    unsafe { JS_FreeValue(ctx, JS_GetException(ctx)) }
}

/// a JS string's UTF-8 bytes, or None with the exception left pending
pub fn js_string(ctx: *mut JSContext, v: JSValue) -> Option<Vec<u8>> {
    unsafe {
        let mut len = 0usize;
        let p = JS_ToCStringLen2(ctx, &mut len, v, 0);
        if p.is_null() {
            return None;
        }
        let out = std::slice::from_raw_parts(p as *const u8, len).to_vec();
        JS_FreeCString(ctx, p);
        Some(out)
    }
}

struct Tokenizer<'a> {
    env: JsEnv,
    tb: &'a mut TokBuf,
    depth: usize,
}

impl Tokenizer<'_> {
    fn value(&mut self, v: JSValue) -> Result<(), String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err("nested too deeply".into());
        }
        let r = self.value_inner(v);
        self.depth -= 1;
        r
    }

    fn value_inner(&mut self, v: JSValue) -> Result<(), String> {
        let ctx = self.env.ctx;
        match tag(v) {
            JS_TAG_UNDEFINED | JS_TAG_NULL => self.tb.toks.push(Tok::new(Kind::Null)),
            JS_TAG_BOOL => {
                let mut t = Tok::new(Kind::Bool);
                t.i = (int_of(v) != 0) as i64;
                self.tb.toks.push(t);
            }
            JS_TAG_INT => {
                let mut t = Tok::new(Kind::Int);
                t.i = int_of(v) as i64;
                self.tb.toks.push(t);
            }
            JS_TAG_FLOAT64 => {
                let f = float64_of(v);
                if f.is_finite() && f == f.floor() && f.abs() < EXACT {
                    let mut t = Tok::new(Kind::Int);
                    t.i = f as i64;
                    self.tb.toks.push(t);
                } else {
                    let mut t = Tok::new(Kind::Float);
                    t.f = f;
                    self.tb.toks.push(t);
                }
            }
            JS_TAG_SHORT_BIG_INT | JS_TAG_BIG_INT => {
                let mut i = 0i64;
                if unsafe { JS_ToInt64Ext(ctx, &mut i, v) } < 0 {
                    drop_exception(ctx);
                    return Err("bigint out of range".into());
                }
                let mut t = Tok::new(Kind::Int);
                t.i = i;
                self.tb.toks.push(t);
            }
            JS_TAG_STRING | JS_TAG_STRING_ROPE => {
                let Some(s) = js_string(ctx, v) else {
                    drop_exception(ctx);
                    return Err("reading a string".into());
                };
                self.tb.push_str(Kind::Str, &s);
            }
            JS_TAG_OBJECT => {
                let cls = unsafe { JS_GetClassID(v) };
                if cls == self.env.date {
                    let mut ms = 0f64;
                    if unsafe { JS_ToFloat64(ctx, &mut ms, v) } < 0 {
                        drop_exception(ctx);
                        return Err("reading a Date".into());
                    }
                    let mut t = Tok::new(Kind::Date);
                    t.f = ms;
                    self.tb.toks.push(t);
                    return Ok(());
                }
                if cls == self.env.set || cls == self.env.map {
                    return Err("Set and Map values are not supported".into());
                }
                if unsafe { JS_IsFunction(ctx, v) } != 0 {
                    return Err("a function is not a value".into());
                }
                match unsafe { JS_IsArray(ctx, v) } {
                    r if r < 0 => {
                        drop_exception(ctx);
                        return Err("array check failed".into());
                    }
                    0 => self.object(v)?,
                    _ => self.array(v)?,
                }
            }
            _ => return Err("unsupported JS value".into()),
        }
        Ok(())
    }

    fn array(&mut self, v: JSValue) -> Result<(), String> {
        let ctx = self.env.ctx;
        let len = unsafe {
            let lenv = JS_GetPropertyStr(ctx, v, c"length".as_ptr());
            let mut len = 0i64;
            let rc = JS_ToInt64Ext(ctx, &mut len, lenv);
            JS_FreeValue(ctx, lenv);
            if rc < 0 || len < 0 || len > u32::MAX as i64 {
                drop_exception(ctx);
                return Err("bad array length".into());
            }
            len
        };
        let open = self.tb.toks.len();
        let mut t = Tok::new(Kind::Arr);
        t.num = len as u32;
        self.tb.toks.push(t);
        for i in 0..len {
            let item = unsafe { JS_GetPropertyUint32(ctx, v, i as u32) };
            if is_exception(item) {
                drop_exception(ctx);
                return Err("reading an array element".into());
            }
            let r = self.value(item);
            unsafe { JS_FreeValue(ctx, item) };
            r?;
        }
        self.tb.toks.push(Tok::new(Kind::Invalid));
        let end = self.tb.toks.len() as u32;
        self.tb.toks[open].end = end;
        Ok(())
    }

    fn object(&mut self, v: JSValue) -> Result<(), String> {
        let ctx = self.env.ctx;
        let mut props: *mut JSPropertyEnum = std::ptr::null_mut();
        let mut nprops = 0u32;
        if unsafe {
            JS_GetOwnPropertyNames(
                ctx,
                &mut props,
                &mut nprops,
                v,
                JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY,
            )
        } < 0
        {
            drop_exception(ctx);
            return Err("listing object keys".into());
        }
        let atoms: Vec<JSAtom> =
            (0..nprops as usize).map(|i| unsafe { (*props.add(i)).atom }).collect();
        let open = self.tb.toks.len();
        self.tb.toks.push(Tok::new(Kind::Obj));
        let mut n = 0u32;
        let mut out = Ok(());
        for atom in atoms {
            let val = unsafe { JS_GetProperty(ctx, v, atom) };
            if is_exception(val) {
                drop_exception(ctx);
                out = Err("reading an object property".into());
                break;
            }

            // a property holding undefined is absent
            if is_undefined(val) {
                continue;
            }
            let key = unsafe {
                let mut klen = 0usize;
                let k = JS_AtomToCStringLen(ctx, &mut klen, atom);
                if k.is_null() {
                    None
                } else {
                    let s = std::slice::from_raw_parts(k as *const u8, klen).to_vec();
                    JS_FreeCString(ctx, k);
                    Some(s)
                }
            };
            let Some(key) = key else {
                unsafe { JS_FreeValue(ctx, val) };
                drop_exception(ctx);
                out = Err("reading an object key".into());
                break;
            };
            self.tb.push_str(Kind::Key, &key);
            let r = self.value(val);
            unsafe { JS_FreeValue(ctx, val) };
            if let Err(e) = r {
                out = Err(e);
                break;
            }
            n += 1;
        }
        unsafe { JS_FreePropertyEnum(ctx, props, nprops) };
        out?;
        self.tb.toks.push(Tok::new(Kind::Invalid));
        let end = self.tb.toks.len() as u32;
        self.tb.toks[open].num = n;
        self.tb.toks[open].end = end;
        Ok(())
    }
}

/// Tokenizes one JS value into tb, emptied first.
pub fn tokenize(env: JsEnv, v: JSValue, tb: &mut TokBuf) -> Result<(), String> {
    tb.toks.clear();
    tb.arena.clear();
    Tokenizer { env, tb, depth: 0 }.value(v)
}

// the schema ////////////////////////////////////////////////////////////////

/// the intake kinds this database can run; a schema naming another cannot be loaded
const INTAKE_KINDS: [&str; 4] = ["NewPassword", "MutationAuth", "CaptchaToken", "IdentityProof"];

#[derive(Clone, Debug)]
enum Lit {
    Str(Vec<u8>),
    Int(i64),
    Bool(bool),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Jt {
    Null,
    Int,
    String,
    Boolean,
    Object,
    Array,
    Any,
    None,
}

#[derive(Debug)]
enum Sol {
    Match(u32),
    JsonType(Vec<(Jt, Sol)>),
    Literal(Vec<(Lit, Sol)>),
    Length(Vec<(i64, Sol)>, Option<Box<Sol>>),
    Index(i64, Box<Sol>),
    Field(Vec<u8>, Box<Sol>),
    HasField(Vec<(Vec<u8>, Sol)>),
}

#[derive(Debug)]
struct Field {
    key: Vec<u8>,
    ty: u32,
    optional: bool,
}

#[derive(Debug)]
enum SNode {
    Null,
    Int,
    Str,
    Bool,
    Date,
    Json,
    Lit(Lit),
    Struct { fields: Vec<Field>, disc: Option<usize> },
    Record(u32),
    Array(u32),
    Tuple(Vec<u32>),
    Union(Sol),
    Intake { kind: &'static str, child: u32 },
}

/// The registry data, compiled into a table the walk interprets.
pub struct Schema {
    nodes: Vec<SNode>,
    ids: HashMap<Vec<u8>, u32>,
    mutations: Option<u32>,
}

/// a schema as plain data, read out of its tokens
enum J {
    Null,
    Bool(bool),
    Int(i64),
    Other,
    Str(Vec<u8>),
    Arr(Vec<J>),
    Obj(Vec<(Vec<u8>, J)>),
}

fn tree(tb: &TokBuf, idx: usize) -> J {
    let t = &tb.toks[idx];
    match t.kind {
        Kind::Null => J::Null,
        Kind::Bool => J::Bool(t.i != 0),
        Kind::Int => J::Int(t.i),
        Kind::Str => J::Str(tb.span(t).to_vec()),
        Kind::Arr => {
            let mut v = Vec::new();
            let mut at = idx + 1;
            for _ in 0..t.num {
                v.push(tree(tb, at));
                at = tb.skip(at);
            }
            J::Arr(v)
        }
        Kind::Obj => {
            let mut v = Vec::new();
            let mut at = idx + 1;
            for _ in 0..t.num {
                let k = tb.span(&tb.toks[at]).to_vec();
                v.push((k, tree(tb, at + 1)));
                at = tb.skip(at + 1);
            }
            J::Obj(v)
        }
        _ => J::Other,
    }
}

type SResult<T> = Result<T, String>;

fn arr(j: &J) -> SResult<&[J]> {
    match j {
        J::Arr(v) => Ok(v),
        _ => Err("schema: expected an array".into()),
    }
}

fn s(j: &J) -> SResult<&[u8]> {
    match j {
        J::Str(v) => Ok(v),
        _ => Err("schema: expected a string".into()),
    }
}

fn nonneg(j: &J) -> SResult<i64> {
    match j {
        J::Int(i) if *i >= 0 => Ok(*i),
        _ => Err("schema: expected a non-negative int".into()),
    }
}

fn lit(j: &J) -> SResult<Lit> {
    match j {
        J::Str(v) => Ok(Lit::Str(v.clone())),
        J::Int(i) => Ok(Lit::Int(*i)),
        J::Bool(b) => Ok(Lit::Bool(*b)),
        _ => Err("schema: a literal must be a string, an int, or a bool".into()),
    }
}

fn at(v: &[J], i: usize) -> SResult<&J> {
    v.get(i).ok_or_else(|| "schema: unexpected end".to_string())
}

impl Schema {
    /// a schema with no types, which a host holds until its bundle's is compiled
    pub fn empty() -> Schema {
        Schema { nodes: Vec::new(), ids: HashMap::new(), mutations: None }
    }

    /// Compiles the registry data from a tokenized JS object ({nodes, ids, mutations}).  Fails on
    /// a malformed table and on an intake kind this database cannot run.
    pub fn compile(tb: &TokBuf) -> SResult<Schema> {
        let J::Obj(top) = tree(tb, 0) else { return Err("schema: expected an object".into()) };
        let find = |k: &str| top.iter().find(|(key, _)| key == k.as_bytes()).map(|(_, v)| v);
        let (Some(nodes), Some(ids), Some(muts)) = (find("nodes"), find("ids"), find("mutations"))
        else {
            return Err("schema: missing nodes, ids, or mutations".into());
        };

        // the nodes
        let raw = arr(nodes)?;
        let n = raw.len();
        let mut sc = Schema { nodes: Vec::with_capacity(n), ids: HashMap::new(), mutations: None };
        for node in raw {
            let node = sc.parse_node(node, n)?;
            sc.nodes.push(node);
        }

        // the identities
        let J::Obj(ids) = ids else { return Err("schema: ids must be an object".into()) };
        for (k, v) in ids {
            sc.ids.insert(k.clone(), Self::type_index(v, n)?);
        }

        // the mutations union
        match muts {
            J::Null => {}
            J::Str(name) => {
                sc.mutations = Some(
                    sc.lookup(name).ok_or("schema: mutations names an unknown type".to_string())?,
                )
            }
            _ => return Err("schema: expected a string".into()),
        }
        Ok(sc)
    }

    fn type_index(j: &J, n: usize) -> SResult<u32> {
        let i = nonneg(j)? as usize;
        if i >= n {
            return Err("schema: a type index is out of range".into());
        }
        Ok(i as u32)
    }

    fn parse_node(&self, j: &J, n: usize) -> SResult<SNode> {
        let v = arr(j)?;
        let kind = s(at(v, 0)?)?;
        let name_ok = |j: &J| match j {
            J::Null | J::Str(_) => Ok(()),
            _ => Err("schema: expected a string".to_string()),
        };
        Ok(match kind {
            b"null" => SNode::Null,
            b"int" => SNode::Int,
            b"str" => SNode::Str,
            b"bool" => SNode::Bool,
            b"date" => SNode::Date,
            b"json" => SNode::Json,
            b"lit" => SNode::Lit(lit(at(v, 1)?)?),
            b"struct" => {
                name_ok(at(v, 1)?)?;
                let mut fields = Vec::new();
                for f in arr(at(v, 2)?)? {
                    let f = arr(f)?;
                    if f.len() != 3 {
                        return Err("schema: expected a field triple".into());
                    }
                    let J::Bool(optional) = f[2] else {
                        return Err("schema: optional must be a bool".into());
                    };
                    fields.push(Field {
                        key: s(&f[0])?.to_vec(),
                        ty: Self::type_index(&f[1], n)?,
                        optional,
                    });
                }
                let disc = match at(v, 3)? {
                    J::Int(-1) => None,
                    J::Int(i) if *i >= 0 && (*i as usize) < fields.len() => Some(*i as usize),
                    _ => {
                        return Err(
                            "schema: a struct's discriminator must be a field index or -1".into()
                        );
                    }
                };
                SNode::Struct { fields, disc }
            }
            b"record" | b"array" => {
                name_ok(at(v, 1)?)?;
                let child = Self::type_index(at(v, 2)?, n)?;
                if kind == b"record" { SNode::Record(child) } else { SNode::Array(child) }
            }
            b"tuple" => {
                name_ok(at(v, 1)?)?;
                let items = arr(at(v, 2)?)?;
                SNode::Tuple(items.iter().map(|i| Self::type_index(i, n)).collect::<SResult<_>>()?)
            }
            b"union" => {
                name_ok(at(v, 1)?)?;
                SNode::Union(Self::parse_sol(at(v, 2)?, n)?)
            }
            b"intake" => {
                let k = s(at(v, 1)?)?;
                let child = Self::type_index(at(v, 2)?, n)?;
                let Some(kind) = INTAKE_KINDS.iter().find(|x| x.as_bytes() == k) else {
                    return Err(format!(
                        "schema names an intake kind this database does not know: {}",
                        String::from_utf8_lossy(k)
                    ));
                };
                SNode::Intake { kind, child }
            }
            _ => return Err("schema: unknown node kind".into()),
        })
    }

    fn parse_opts<K>(j: &J, n: usize, key: impl Fn(&J) -> SResult<K>) -> SResult<Vec<(K, Sol)>> {
        arr(j)?
            .iter()
            .map(|pair| {
                let p = arr(pair)?;
                if p.len() != 2 {
                    return Err("schema: expected a pair".to_string());
                }
                Ok((key(&p[0])?, Self::parse_sol(&p[1], n)?))
            })
            .collect()
    }

    fn parse_sol(j: &J, n: usize) -> SResult<Sol> {
        let v = arr(j)?;
        let kind = s(at(v, 0)?)?;
        Ok(match kind {
            b"match" => Sol::Match(Self::type_index(at(v, 1)?, n)?),
            b"jsontype" => Sol::JsonType(Self::parse_opts(at(v, 1)?, n, |k| {
                Ok(match s(k)? {
                    b"null" => Jt::Null,
                    b"int" => Jt::Int,
                    b"string" => Jt::String,
                    b"boolean" => Jt::Boolean,
                    b"object" => Jt::Object,
                    b"array" => Jt::Array,
                    b"*" => Jt::Any,
                    _ => return Err("schema: unknown json type".to_string()),
                })
            })?),
            b"literal" => Sol::Literal(Self::parse_opts(at(v, 1)?, n, lit)?),
            b"length" => {
                let opts = Self::parse_opts(at(v, 1)?, n, nonneg)?;
                let dflt = match at(v, 2)? {
                    J::Null => None,
                    d => Some(Box::new(Self::parse_sol(d, n)?)),
                };
                Sol::Length(opts, dflt)
            }
            b"index" => Sol::Index(nonneg(at(v, 1)?)?, Box::new(Self::parse_sol(at(v, 2)?, n)?)),
            b"field" => {
                Sol::Field(s(at(v, 1)?)?.to_vec(), Box::new(Self::parse_sol(at(v, 2)?, n)?))
            }
            b"hasfield" => Sol::HasField(Self::parse_opts(at(v, 1)?, n, |k| Ok(s(k)?.to_vec()))?),
            _ => return Err("schema: unknown solution kind".into()),
        })
    }

    /// a type identity's node
    pub fn lookup(&self, id: &[u8]) -> Option<u32> {
        self.ids.get(id).copied()
    }

    /// the mutations union's node, None when the database has no mutations
    pub fn mutations(&self) -> Option<u32> {
        self.mutations
    }
}

// sinks /////////////////////////////////////////////////////////////////////

/// A sink consumes the event sequence the walk emits for one value; each method fails with why.
pub trait Sink {
    fn begin_obj(&mut self, n: usize) -> Result<(), &'static str>;
    fn key(&mut self, k: &[u8]) -> Result<(), &'static str>;
    fn end_obj(&mut self) -> Result<(), &'static str>;
    fn begin_arr(&mut self, n: usize) -> Result<(), &'static str>;
    fn end_arr(&mut self) -> Result<(), &'static str>;
    fn str(&mut self, s: &[u8]) -> Result<(), &'static str>;
    fn int(&mut self, i: i64) -> Result<(), &'static str>;
    fn float(&mut self, f: f64) -> Result<(), &'static str>;
    fn bool(&mut self, b: bool) -> Result<(), &'static str>;
    fn null(&mut self) -> Result<(), &'static str>;
    fn date(&mut self, ms: f64) -> Result<(), &'static str>;

    /// a value the caller writes in later, which only a sink that keeps holes takes
    fn hole(&mut self) -> Result<(), &'static str> {
        Err("a hole in a value that keeps none")
    }
}

/// the sink of a check, which discards every event
pub struct NullSink;

impl Sink for NullSink {
    fn begin_obj(&mut self, _: usize) -> Result<(), &'static str> {
        Ok(())
    }
    fn key(&mut self, _: &[u8]) -> Result<(), &'static str> {
        Ok(())
    }
    fn end_obj(&mut self) -> Result<(), &'static str> {
        Ok(())
    }
    fn begin_arr(&mut self, _: usize) -> Result<(), &'static str> {
        Ok(())
    }
    fn end_arr(&mut self) -> Result<(), &'static str> {
        Ok(())
    }
    fn str(&mut self, _: &[u8]) -> Result<(), &'static str> {
        Ok(())
    }
    fn int(&mut self, _: i64) -> Result<(), &'static str> {
        Ok(())
    }
    fn float(&mut self, _: f64) -> Result<(), &'static str> {
        Ok(())
    }
    fn bool(&mut self, _: bool) -> Result<(), &'static str> {
        Ok(())
    }
    fn null(&mut self) -> Result<(), &'static str> {
        Ok(())
    }
    fn date(&mut self, _: f64) -> Result<(), &'static str> {
        Ok(())
    }
}

impl Sink for mp::Writer {
    fn begin_obj(&mut self, n: usize) -> Result<(), &'static str> {
        self.map(n);
        Ok(())
    }
    fn key(&mut self, k: &[u8]) -> Result<(), &'static str> {
        mp::Writer::str(self, k);
        Ok(())
    }
    fn end_obj(&mut self) -> Result<(), &'static str> {
        Ok(())
    }
    fn begin_arr(&mut self, n: usize) -> Result<(), &'static str> {
        self.array(n);
        Ok(())
    }
    fn end_arr(&mut self) -> Result<(), &'static str> {
        Ok(())
    }
    fn str(&mut self, s: &[u8]) -> Result<(), &'static str> {
        mp::Writer::str(self, s);
        Ok(())
    }
    fn int(&mut self, i: i64) -> Result<(), &'static str> {
        mp::Writer::int(self, i);
        Ok(())
    }
    fn float(&mut self, f: f64) -> Result<(), &'static str> {
        self.double(f);
        Ok(())
    }
    fn bool(&mut self, b: bool) -> Result<(), &'static str> {
        mp::Writer::bool(self, b);
        Ok(())
    }
    fn null(&mut self) -> Result<(), &'static str> {
        self.nil();
        Ok(())
    }
    fn date(&mut self, ms: f64) -> Result<(), &'static str> {
        let total = ms.floor() as i64;
        self.timestamp(total.div_euclid(1000), (total.rem_euclid(1000) * 1_000_000) as u32);
        Ok(())
    }
}

/// The sink that builds a JS value.  A container under construction is a frame; a value built is
/// attached to the innermost frame, or becomes the result.
pub struct JsSink {
    ctx: *mut JSContext,
    stack: Vec<(JSValue, bool, u32, JSAtom)>, // (container, is array, next index, pending key)
    result: Option<JSValue>,
}

impl JsSink {
    pub fn new(ctx: *mut JSContext) -> JsSink {
        JsSink { ctx, stack: Vec::new(), result: None }
    }

    fn attach(&mut self, v: JSValue) -> Result<(), &'static str> {
        if is_exception(v) {
            return Err("the JS heap failed");
        }
        let ctx = self.ctx;
        let Some(top) = self.stack.last_mut() else {
            if let Some(old) = self.result.replace(v) {
                unsafe { JS_FreeValue(ctx, old) };
            }
            return Ok(());
        };
        let rc = if top.1 {
            let i = top.2;
            top.2 += 1;
            unsafe { JS_DefinePropertyValueUint32(ctx, top.0, i, v, JS_PROP_C_W_E) }
        } else {
            if top.3 == JS_ATOM_NULL {
                unsafe { JS_FreeValue(ctx, v) };
                return Err("object value without a key");
            }
            let key = std::mem::replace(&mut top.3, JS_ATOM_NULL);
            let rc = unsafe { JS_DefinePropertyValue(ctx, top.0, key, v, JS_PROP_C_W_E) };
            unsafe { JS_FreeAtom(ctx, key) };
            rc
        };
        if rc < 0 { Err("the JS heap failed") } else { Ok(()) }
    }

    fn push(&mut self, obj: JSValue, is_arr: bool) -> Result<(), &'static str> {
        if is_exception(obj) {
            return Err("the JS heap failed");
        }
        self.stack.push((obj, is_arr, 0, JS_ATOM_NULL));
        Ok(())
    }

    fn pop(&mut self) -> Result<(), &'static str> {
        let Some((obj, _, _, key)) = self.stack.pop() else {
            return Err("unbalanced container events");
        };
        if key != JS_ATOM_NULL {
            unsafe { JS_FreeAtom(self.ctx, key) };
        }
        self.attach(obj)
    }

    /// the built value, if a whole one was built; the sink lets go of everything else
    pub fn finish(mut self) -> Option<JSValue> {
        for (obj, _, _, key) in self.stack.drain(..) {
            unsafe {
                JS_FreeValue(self.ctx, obj);
                if key != JS_ATOM_NULL {
                    JS_FreeAtom(self.ctx, key);
                }
            }
        }
        self.result.take()
    }
}

impl Drop for JsSink {
    fn drop(&mut self) {
        for (obj, _, _, key) in self.stack.drain(..) {
            unsafe {
                JS_FreeValue(self.ctx, obj);
                if key != JS_ATOM_NULL {
                    JS_FreeAtom(self.ctx, key);
                }
            }
        }
        if let Some(v) = self.result.take() {
            unsafe { JS_FreeValue(self.ctx, v) };
        }
    }
}

impl Sink for JsSink {
    fn begin_obj(&mut self, _: usize) -> Result<(), &'static str> {
        let o = unsafe { JS_NewObject(self.ctx) };
        self.push(o, false)
    }
    fn key(&mut self, k: &[u8]) -> Result<(), &'static str> {
        let ctx = self.ctx;
        let Some(top) = self.stack.last_mut() else { return Err("key outside an object") };
        if top.3 != JS_ATOM_NULL {
            unsafe { JS_FreeAtom(ctx, top.3) };
        }
        top.3 = unsafe { JS_NewAtomLen(ctx, k.as_ptr() as *const _, k.len()) };
        if top.3 == JS_ATOM_NULL { Err("the JS heap failed") } else { Ok(()) }
    }
    fn end_obj(&mut self) -> Result<(), &'static str> {
        self.pop()
    }
    fn begin_arr(&mut self, _: usize) -> Result<(), &'static str> {
        let a = unsafe { JS_NewArray(self.ctx) };
        self.push(a, true)
    }
    fn end_arr(&mut self) -> Result<(), &'static str> {
        self.pop()
    }
    fn str(&mut self, s: &[u8]) -> Result<(), &'static str> {
        let v = unsafe { JS_NewStringLen(self.ctx, s.as_ptr() as *const _, s.len()) };
        self.attach(v)
    }
    fn int(&mut self, i: i64) -> Result<(), &'static str> {
        self.attach(JS_NewInt64(i))
    }
    fn float(&mut self, f: f64) -> Result<(), &'static str> {
        self.attach(JS_NewFloat64(f))
    }
    fn bool(&mut self, b: bool) -> Result<(), &'static str> {
        self.attach(JS_NewBool(b))
    }
    fn null(&mut self) -> Result<(), &'static str> {
        self.attach(JS_NULL)
    }
    fn date(&mut self, ms: f64) -> Result<(), &'static str> {
        let v = unsafe { JS_NewDate(self.ctx, ms) };
        self.attach(v)
    }
}

// values ////////////////////////////////////////////////////////////////////

/// A value a walk reads: a node of a parsed msgpack tree, or the index of a token of a JS-heap
/// tokenization.
#[derive(Clone, Copy)]
enum V<'a> {
    Mp(&'a Node<'a>),
    Tok(usize),
}

/// One field the database prepares for the decider, met by a check: its kind, its key, and its
/// value.  The caller decides the result to write in its place: a string, a MutationAuthResult's
/// kind, written as {kind}, or a hole the sink marks, for a string the caller fills in later.
pub struct Intake<'a> {
    pub kind: &'static str,
    pub key: Vec<u8>,
    pub node: &'a Node<'a>,
    pub result: Option<String>,
    pub result_kind: Option<&'static str>,
    pub hole: bool,
}

struct Walk<'a, 's> {
    tb: &'a TokBuf,
    sc: &'a Schema,
    sink: &'s mut dyn Sink,
    strict: bool,
    depth: usize,
    path: Vec<u8>,
    seglens: Vec<usize>,
    // the field slots of the structs the walk is inside, innermost last
    slots: Vec<Option<V<'a>>>,
    // the prepared fields of the top-level value: collected by a check, written by a write
    intakes: Option<&'s mut Vec<Intake<'a>>>,
    results: Option<&'s [Intake<'a>]>,
    // whether the top-level value's prepared fields hold their results, converted as they are
    prepared: bool,
    top: bool,
    err: Option<String>,
}

static EMPTY_TB: TokBuf = TokBuf { toks: Vec::new(), arena: Vec::new() };

/// the elements of an array a walk reads, in order, read in place
enum Elems<'a> {
    Mp(std::slice::Iter<'a, Node<'a>>),
    Tok { tb: &'a TokBuf, at: usize, left: usize },
}

impl<'a> Iterator for Elems<'a> {
    type Item = V<'a>;

    fn next(&mut self) -> Option<V<'a>> {
        match self {
            Elems::Mp(it) => it.next().map(V::Mp),
            Elems::Tok { tb, at, left } => {
                if *left == 0 {
                    return None;
                }
                *left -= 1;
                let v = V::Tok(*at);
                *at = tb.skip(*at);
                Some(v)
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = match self {
            Elems::Mp(it) => it.len(),
            Elems::Tok { left, .. } => *left,
        };
        (n, Some(n))
    }
}

impl ExactSizeIterator for Elems<'_> {}

/// the entries of a map a walk reads, in order, each key None when it is not a string
enum Entries<'a> {
    Mp(std::slice::Iter<'a, (Node<'a>, Node<'a>)>),
    Tok { tb: &'a TokBuf, at: usize, left: usize },
}

impl<'a> Iterator for Entries<'a> {
    type Item = (Option<&'a [u8]>, V<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Entries::Mp(it) => it.next().map(|(k, v)| (k.as_str(), V::Mp(v))),
            Entries::Tok { tb, at, left } => {
                if *left == 0 {
                    return None;
                }
                *left -= 1;
                let e = (Some(tb.span(&tb.toks[*at])), V::Tok(*at + 1));
                *at = tb.skip(*at + 1);
                Some(e)
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let n = match self {
            Entries::Mp(it) => it.len(),
            Entries::Tok { left, .. } => *left,
        };
        (n, Some(n))
    }
}

impl ExactSizeIterator for Entries<'_> {}

impl<'a> Walk<'a, '_> {
    fn failed(&self) -> bool {
        self.err.is_some()
    }

    fn fail(&mut self, msg: impl AsRef<str>) {
        if self.err.is_some() {
            return;
        }
        self.err = Some(format!("${}: {}", String::from_utf8_lossy(&self.path), msg.as_ref()));
    }

    // pushes a path segment, the bytes of head and then tail: at most 127 of them, and none once
    // the path is long or deep
    fn path_push(&mut self, head: &[u8], tail: &[u8]) {
        let mut n = (head.len() + tail.len()).min(127);
        if self.path.len() + n > 1024 || self.seglens.len() > MAX_DEPTH {
            n = 0;
        }
        let h = head.len().min(n);
        self.path.extend_from_slice(&head[..h]);
        self.path.extend_from_slice(&tail[..n - h]);
        self.seglens.push(n);
    }

    fn path_index(&mut self, i: usize) {
        use std::io::Write;
        let mut seg = [0u8; 24];
        let n = {
            let mut w = &mut seg[..];
            let _ = write!(w, "[{i}]");
            24 - w.len()
        };
        self.path_push(&seg[..n], b"");
    }

    fn path_key(&mut self, k: &[u8], cap: bool) {
        let k = if cap && k.len() > 100 { &k[..100] } else { k };
        self.path_push(b".", k);
    }

    fn path_pop(&mut self) {
        if let Some(n) = self.seglens.pop() {
            self.path.truncate(self.path.len() - n);
        }
    }

    fn sink(&mut self, r: Result<(), &'static str>) {
        if let Err(e) = r
            && !self.failed()
        {
            self.fail(e);
        }
    }

    // the source's accessors

    fn kind(&self, v: V<'a>) -> Kind {
        match v {
            V::Tok(i) => self.tb.toks[i].kind,
            V::Mp(n) => match n {
                Node::Nil => Kind::Null,
                Node::Bool(_) => Kind::Bool,
                Node::Int(_) => Kind::Int,
                Node::Uint(u) => {
                    if *u > i64::MAX as u64 {
                        Kind::Invalid
                    } else {
                        Kind::Int
                    }
                }
                Node::F32(_) | Node::F64(_) => Kind::Float,
                Node::Str(_) => Kind::Str,
                Node::Array(_) => Kind::Arr,
                Node::Map(_) => Kind::Obj,
                Node::Ext(t, _) if *t == mp::EXT_TIMESTAMP => Kind::Date,
                _ => Kind::Invalid,
            },
        }
    }

    fn name(&self, v: V<'a>) -> &'static str {
        match self.kind(v) {
            Kind::Obj => "an object",
            Kind::Arr => "an array",
            Kind::Str => "a string",
            Kind::Int => "an int",
            Kind::Float => "a float",
            Kind::Bool => "a bool",
            Kind::Null => "null",
            Kind::Date => "a timestamp",
            _ => match v {
                V::Mp(Node::Bin(_)) => "a bin value",
                V::Mp(Node::Ext(..)) => "an extension other than a timestamp",
                V::Mp(Node::Uint(_)) => "an integer past int64",
                _ => "an invalid value",
            },
        }
    }

    fn int(&self, v: V<'a>) -> i64 {
        match v {
            V::Tok(i) => self.tb.toks[i].i,
            V::Mp(Node::Int(i)) => *i,
            V::Mp(Node::Uint(u)) => *u as i64,
            _ => 0,
        }
    }

    fn float(&self, v: V<'a>) -> f64 {
        match v {
            V::Tok(i) => self.tb.toks[i].f,
            V::Mp(Node::F32(f)) => *f as f64,
            V::Mp(Node::F64(f)) => *f,
            _ => 0.0,
        }
    }

    fn boolean(&self, v: V<'a>) -> bool {
        match v {
            V::Tok(i) => self.tb.toks[i].i != 0,
            V::Mp(Node::Bool(b)) => *b,
            _ => false,
        }
    }

    fn str(&self, v: V<'a>) -> &'a [u8] {
        match v {
            V::Tok(i) => self.tb.span(&self.tb.toks[i]),
            V::Mp(Node::Str(s)) => s,
            _ => b"",
        }
    }

    // a timestamp's milliseconds since the epoch; None for a malformed timestamp extension
    fn date(&self, v: V<'a>) -> Option<f64> {
        let p = match v {
            V::Tok(i) => return Some(self.tb.toks[i].f),
            V::Mp(Node::Ext(_, p)) => *p,
            _ => return None,
        };
        let be = |b: &[u8]| b.iter().fold(0u64, |x, &c| x << 8 | c as u64);
        let (sec, nsec) = match p.len() {
            4 => (be(p) as i64, 0u32),
            8 => {
                let x = be(p);
                ((x & 0x3_ffff_ffff) as i64, (x >> 34) as u32)
            }
            12 => (be(&p[4..]) as i64, be(&p[..4]) as u32),
            _ => return None,
        };
        if nsec > 999_999_999 {
            return None;
        }
        Some(sec as f64 * 1000.0 + (nsec as f64 / 1e6).floor())
    }

    fn count(&self, v: V<'a>) -> usize {
        match v {
            V::Tok(i) => self.tb.toks[i].num as usize,
            V::Mp(Node::Array(a)) => a.len(),
            V::Mp(Node::Map(m)) => m.len(),
            _ => 0,
        }
    }

    // an int, or a float with an integral value
    fn integral(&self, v: V<'a>) -> Option<i64> {
        match self.kind(v) {
            Kind::Int => Some(self.int(v)),
            Kind::Float => {
                let f = self.float(v);
                (f.is_finite() && f == f.floor() && f.abs() < EXACT).then_some(f as i64)
            }
            _ => None,
        }
    }

    // an array's elements; none for any other value
    fn elems(&self, v: V<'a>) -> Elems<'a> {
        match v {
            V::Mp(Node::Array(a)) => Elems::Mp(a.iter()),
            V::Tok(i) if self.tb.toks[i].kind == Kind::Arr => {
                Elems::Tok { tb: self.tb, at: i + 1, left: self.tb.toks[i].num as usize }
            }
            _ => Elems::Mp([].iter()),
        }
    }

    // a map's entries; none for any other value
    fn entries(&self, v: V<'a>) -> Entries<'a> {
        match v {
            V::Mp(Node::Map(m)) => Entries::Mp(m.iter()),
            V::Tok(i) if self.tb.toks[i].kind == Kind::Obj => {
                Entries::Tok { tb: self.tb, at: i + 1, left: self.tb.toks[i].num as usize }
            }
            _ => Entries::Mp([].iter()),
        }
    }

    fn find_field(&self, obj: V<'a>, key: &[u8]) -> Option<V<'a>> {
        self.entries(obj).find(|(k, _)| *k == Some(key)).map(|(_, v)| v)
    }

    fn jsontype(&self, v: V<'a>) -> Jt {
        match self.kind(v) {
            Kind::Null => Jt::Null,
            Kind::Int => Jt::Int,
            Kind::Float => {
                if self.integral(v).is_some() {
                    Jt::Int
                } else {
                    Jt::None
                }
            }
            Kind::Str | Kind::Date => Jt::String,
            Kind::Bool => Jt::Boolean,
            Kind::Obj => Jt::Object,
            Kind::Arr => Jt::Array,
            _ => Jt::None,
        }
    }

    fn matches_lit(&self, v: V<'a>, l: &Lit) -> bool {
        match l {
            Lit::Bool(b) => self.kind(v) == Kind::Bool && self.boolean(v) == *b,
            Lit::Int(i) => self.integral(v) == Some(*i),
            Lit::Str(s) => self.kind(v) == Kind::Str && self.str(v) == s.as_slice(),
        }
    }

    // the walk

    // a scalar, as it is
    fn scalar(&mut self, v: V<'a>) {
        let r = match self.kind(v) {
            Kind::Null => self.sink.null(),
            Kind::Bool => {
                let b = self.boolean(v);
                self.sink.bool(b)
            }
            Kind::Int => {
                let i = self.int(v);
                self.sink.int(i)
            }
            Kind::Float => {
                let f = self.float(v);
                self.sink.float(f)
            }
            Kind::Str => {
                let s = self.str(v);
                self.sink.str(s)
            }
            Kind::Date => {
                // a time a Date cannot hold, an invalid Date's NaN among them, has no timestamp
                match self.date(v) {
                    None => return self.fail("malformed timestamp"),
                    Some(ms) if ms.is_nan() || ms.abs() > DATE_MAX_MS => {
                        return self.fail("a timestamp outside the range of a Date");
                    }
                    Some(ms) => self.sink.date(ms),
                }
            }
            _ => {
                let name = self.name(v);
                return self.fail(format!("{name} is not allowed"));
            }
        };
        self.sink(r);
    }

    // the schema-free walk: copy one value to the sink as it is
    fn passthrough(&mut self, v: V<'a>) {
        if self.failed() {
            return;
        }
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return self.fail("nested too deeply");
        }
        match self.kind(v) {
            Kind::Arr => {
                let elems = self.elems(v);
                let r = self.sink.begin_arr(elems.len());
                self.sink(r);
                for (i, e) in elems.into_iter().enumerate() {
                    if self.failed() {
                        break;
                    }
                    self.path_index(i);
                    self.passthrough(e);
                    self.path_pop();
                }
                let r = self.sink.end_arr();
                self.sink(r);
            }
            Kind::Obj => {
                let entries = self.entries(v);
                let r = self.sink.begin_obj(entries.len());
                self.sink(r);
                for (k, e) in entries {
                    if self.failed() {
                        break;
                    }
                    let Some(k) = k else {
                        self.fail("a map key is not a string");
                        break;
                    };
                    let r = self.sink.key(k);
                    self.sink(r);
                    self.path_key(k, true);
                    self.passthrough(e);
                    self.path_pop();
                }
                let r = self.sink.end_obj();
                self.sink(r);
            }
            _ => self.scalar(v),
        }
        self.depth -= 1;
    }

    fn result_for(&self, key: &[u8]) -> Option<&Intake<'a>> {
        self.results?.iter().find(|i| i.key == key)
    }

    fn walk_struct(&mut self, fields: &'a [Field], disc: Option<usize>, v: V<'a>) {
        if self.kind(v) != Kind::Obj {
            let name = self.name(v);
            return self.fail(format!("expected an object, not {name}"));
        }
        let top = std::mem::replace(&mut self.top, false);

        // the struct's slots, one per declared field, above those of the structs it lies in
        let base = self.slots.len();
        self.slots.resize(base + fields.len(), None);
        self.struct_fields(fields, disc, v, top, base);
        self.slots.truncate(base);
    }

    // walks a struct's fields with its slots from base
    fn struct_fields(
        &mut self,
        fields: &'a [Field],
        disc: Option<usize>,
        v: V<'a>,
        top: bool,
        base: usize,
    ) {
        // find each declared field's value, and judge the rest
        let nf = fields.len();
        let mut present = 0;
        for (k, fv) in self.entries(v) {
            if self.failed() {
                break;
            }
            let Some(k) = k else {
                self.fail("a map key is not a string");
                break;
            };
            match fields.iter().position(|f| f.key == k) {
                None => {
                    // a field the schema does not name
                    if self.strict {
                        self.path_key(k, true);
                        self.fail("unknown field");
                        self.path_pop();
                    }
                }
                Some(i) if self.slots[base + i].is_some() => {
                    self.path_key(k, false);
                    self.fail("repeated field");
                    self.path_pop();
                }
                Some(i) => {
                    self.slots[base + i] = Some(fv);
                    present += 1;
                }
            }
        }
        if self.failed() {
            return;
        }

        // every required field is present
        for (i, f) in fields.iter().enumerate() {
            if self.slots[base + i].is_none() && !f.optional {
                self.path_key(&f.key, false);
                self.fail("missing required field");
                self.path_pop();
                return;
            }
        }

        // emit them, the discriminator first and then declaration order
        let r = self.sink.begin_obj(present);
        self.sink(r);
        let order = disc.into_iter().chain((0..nf).filter(|&i| Some(i) != disc));
        for i in order {
            if self.failed() {
                break;
            }
            let f = &fields[i];
            let Some(fv) = self.slots[base + i] else { continue };
            self.path_key(&f.key, false);
            let r = self.sink.key(&f.key);
            self.sink(r);

            // a prepared field of the top-level value: collect it, or write its result in its place
            if top && let SNode::Intake { kind, .. } = self.sc.nodes[f.ty as usize] {
                if let (Some(il), V::Mp(node)) = (self.intakes.as_deref_mut(), fv) {
                    il.push(Intake {
                        kind,
                        key: f.key.clone(),
                        node,
                        result: None,
                        result_kind: None,
                        hole: false,
                    });
                }
                let (res, res_kind, hole) = match self.result_for(&f.key) {
                    Some(r) => (r.result.clone(), r.result_kind, r.hole),
                    None => (None, None, false),
                };
                if hole {
                    let r = self.sink.hole();
                    self.sink(r);
                    self.path_pop();
                    continue;
                }
                if let Some(res) = res {
                    let r = self.sink.str(res.as_bytes());
                    self.sink(r);
                    self.path_pop();
                    continue;
                }
                if let Some(k) = res_kind {
                    for r in [
                        self.sink.begin_obj(1),
                        self.sink.key(b"kind"),
                        self.sink.str(k.as_bytes()),
                        self.sink.end_obj(),
                    ] {
                        self.sink(r);
                    }
                    self.path_pop();
                    continue;
                }
                if self.prepared {
                    self.passthrough(fv);
                    self.path_pop();
                    continue;
                }
            }
            self.value(f.ty, fv);
            self.path_pop();
        }
        let r = self.sink.end_obj();
        self.sink(r);
    }

    fn walk_record(&mut self, child: u32, v: V<'a>) {
        if self.kind(v) != Kind::Obj {
            let name = self.name(v);
            return self.fail(format!("expected an object, not {name}"));
        }
        let entries = self.entries(v);
        let r = self.sink.begin_obj(entries.len());
        self.sink(r);
        for (k, fv) in entries {
            if self.failed() {
                break;
            }
            let Some(k) = k else {
                self.fail("a map key is not a string");
                break;
            };
            let r = self.sink.key(k);
            self.sink(r);
            self.path_key(k, true);
            self.value(child, fv);
            self.path_pop();
        }
        let r = self.sink.end_obj();
        self.sink(r);
    }

    fn walk_array(&mut self, child: u32, v: V<'a>) {
        if self.kind(v) != Kind::Arr {
            let name = self.name(v);
            return self.fail(format!("expected an array, not {name}"));
        }
        let elems = self.elems(v);
        let r = self.sink.begin_arr(elems.len());
        self.sink(r);
        for (i, e) in elems.into_iter().enumerate() {
            if self.failed() {
                break;
            }
            self.path_index(i);
            self.value(child, e);
            self.path_pop();
        }
        let r = self.sink.end_arr();
        self.sink(r);
    }

    fn walk_tuple(&mut self, items: &'a [u32], v: V<'a>) {
        if self.kind(v) != Kind::Arr {
            let name = self.name(v);
            return self.fail(format!("expected an array, not {name}"));
        }
        let elems = self.elems(v);
        if elems.len() != items.len() {
            return self.fail(format!("expected {} items, not {}", items.len(), elems.len()));
        }
        let r = self.sink.begin_arr(elems.len());
        self.sink(r);
        for (i, e) in elems.into_iter().enumerate() {
            if self.failed() {
                break;
            }
            self.path_index(i);
            self.value(items[i], e);
            self.path_pop();
        }
        let r = self.sink.end_arr();
        self.sink(r);
    }

    /* Evaluates a solution.  obj is the container being navigated, subj the value being tested,
    and root the union value itself, which a match walks in full. */
    fn solution(&mut self, s: &'a Sol, obj: V<'a>, subj: V<'a>, root: V<'a>) {
        if self.failed() {
            return;
        }
        match s {
            Sol::Match(t) => self.value(*t, root),
            Sol::JsonType(opts) => {
                let jt = self.jsontype(subj);
                let mut any = None;
                for (k, sol) in opts {
                    if *k == jt {
                        return self.solution(sol, obj, subj, root);
                    }
                    if *k == Jt::Any {
                        any = Some(sol);
                    }
                }
                if let Some(sol) = any {
                    return self.solution(sol, obj, subj, root);
                }
                let name = self.name(subj);
                self.fail(format!("{name} is not allowed here"));
            }
            Sol::Literal(opts) => {
                for (l, sol) in opts {
                    if self.matches_lit(subj, l) {
                        return self.solution(sol, obj, subj, root);
                    }
                }
                if self.kind(subj) == Kind::Str {
                    let s = self.str(subj);
                    let s = &s[..s.len().min(100)];
                    self.fail(format!("unexpected value \"{}\"", String::from_utf8_lossy(s)));
                } else {
                    self.fail("unexpected value");
                }
            }
            Sol::Length(opts, dflt) => {
                if self.kind(subj) != Kind::Arr {
                    let name = self.name(subj);
                    return self.fail(format!("expected an array, not {name}"));
                }
                let len = self.count(subj) as i64;
                for (l, sol) in opts {
                    if *l == len {
                        return self.solution(sol, obj, subj, root);
                    }
                }
                match dflt {
                    Some(d) => self.solution(d, obj, subj, root),
                    None => self.fail(format!("unexpected length {len}")),
                }
            }
            Sol::Index(i, sub) => {
                let elem = if self.kind(subj) == Kind::Arr {
                    self.elems(subj).nth(*i as usize)
                } else {
                    None
                };
                match elem {
                    Some(e) => self.solution(sub, e, e, root),
                    None => self.fail(format!("missing index {i}")),
                }
            }
            Sol::Field(key, sub) => {
                let fv = if self.kind(obj) == Kind::Obj { self.find_field(obj, key) } else { None };
                match fv {
                    Some(fv) => self.solution(sub, obj, fv, root),
                    None => self.fail(format!(
                        "missing discriminator \"{}\"",
                        String::from_utf8_lossy(key)
                    )),
                }
            }
            Sol::HasField(opts) => {
                if self.kind(obj) == Kind::Obj {
                    for (key, sol) in opts {
                        if self.find_field(obj, key).is_some() {
                            return self.solution(sol, obj, obj, root);
                        }
                    }
                }
                self.fail("none of the fields a member needs is present");
            }
        }
    }

    fn value(&mut self, ty: u32, v: V<'a>) {
        if self.failed() {
            return;
        }
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return self.fail("nested too deeply");
        }
        let sc = self.sc;
        let k = self.kind(v);
        match &sc.nodes[ty as usize] {
            SNode::Null => {
                if k != Kind::Null {
                    let name = self.name(v);
                    self.fail(format!("expected null, not {name}"));
                } else {
                    self.scalar(v);
                }
            }
            SNode::Int => match self.integral(v) {
                None => {
                    let name = self.name(v);
                    self.fail(format!("expected an int, not {name}"));
                }
                Some(i) => {
                    let r = self.sink.int(i);
                    self.sink(r);
                }
            },
            SNode::Str => {
                if k != Kind::Str {
                    let name = self.name(v);
                    self.fail(format!("expected a string, not {name}"));
                } else {
                    self.scalar(v);
                }
            }
            SNode::Bool => {
                if k != Kind::Bool {
                    let name = self.name(v);
                    self.fail(format!("expected a bool, not {name}"));
                } else {
                    self.scalar(v);
                }
            }
            SNode::Date => {
                if k != Kind::Date {
                    let name = self.name(v);
                    self.fail(format!("expected a timestamp, not {name}"));
                } else {
                    self.scalar(v);
                }
            }
            SNode::Json => {
                self.depth -= 1;
                self.passthrough(v);
                self.depth += 1;
            }
            SNode::Lit(l) => {
                if !self.matches_lit(v, l) {
                    match l {
                        Lit::Str(s) => {
                            self.fail(format!("expected \"{}\"", String::from_utf8_lossy(s)))
                        }
                        Lit::Bool(b) => self.fail(format!("expected {b}")),
                        Lit::Int(i) => self.fail(format!("expected {i}")),
                    }
                } else if let Lit::Int(i) = l {
                    let r = self.sink.int(*i);
                    self.sink(r);
                } else {
                    self.scalar(v);
                }
            }
            SNode::Struct { fields, disc } => self.walk_struct(fields, *disc, v),
            SNode::Record(c) => self.walk_record(*c, v),
            SNode::Array(c) => self.walk_array(*c, v),
            SNode::Tuple(items) => self.walk_tuple(items, v),
            SNode::Union(sol) => self.solution(sol, v, v, v),
            SNode::Intake { child, .. } => self.value(*child, v),
        }
        self.depth -= 1;
    }

    fn run(mut self, v: V<'a>, ty: Option<u32>) -> Result<(), String> {
        self.top = true;
        match ty {
            None => self.passthrough(v),
            Some(t) => self.value(t, v),
        }
        match self.err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

fn walk<'a, 's>(
    sc: &'a Schema,
    tb: &'a TokBuf,
    sink: &'s mut dyn Sink,
    strict: bool,
) -> Walk<'a, 's> {
    Walk {
        tb,
        sc,
        sink,
        strict,
        depth: 0,
        path: Vec::new(),
        seglens: Vec::new(),
        slots: Vec::new(),
        intakes: None,
        results: None,
        prepared: false,
        top: false,
        err: None,
    }
}

/// Checks a msgpack value against a type.  strict rejects fields the schema does not name, as a
/// mutation's are; otherwise they are dropped.  When il is given, every prepared field of the
/// top-level value is appended to it.  Fails with the first error, which names the path.
pub fn check<'a>(
    sc: &'a Schema,
    node: &'a Node<'a>,
    ty: u32,
    strict: bool,
    il: Option<&mut Vec<Intake<'a>>>,
) -> Result<(), String> {
    let mut sink = NullSink;
    let mut w = walk(sc, &EMPTY_TB, &mut sink, strict);
    w.intakes = il;
    w.run(V::Mp(node), Some(ty))
}

/// Writes a msgpack value as checked under a type: the discriminator first, declaration order,
/// fields the schema does not name dropped, and each prepared field of the top-level value
/// replaced by its result in il when il is given.  No type copies the value untyped.
pub fn write<'a>(
    sc: &'a Schema,
    node: &'a Node<'a>,
    ty: Option<u32>,
    strict: bool,
    il: Option<&[Intake<'a>]>,
    out: &mut dyn Sink,
) -> Result<(), String> {
    let mut w = walk(sc, &EMPTY_TB, out, strict);
    w.results = il;
    w.run(V::Mp(node), ty)
}

/// The JS value of a msgpack value, or why the value fails its type.  A walk that fails for the
/// heap leaves its exception pending.
pub fn to_js(
    ctx: *mut JSContext,
    sc: &Schema,
    node: &Node<'_>,
    ty: u32,
    strict: bool,
) -> Result<JSValue, String> {
    let mut sink = JsSink::new(ctx);
    walk(sc, &EMPTY_TB, &mut sink, strict).run(V::Mp(node), Some(ty))?;
    sink.finish().ok_or_else(|| "nothing was built".to_string())
}

/// The JS value of a mutation `write` prepared: walked strictly under type as `to_js` walks it,
/// except that each prepared field of the top-level value holds the result written in its place
/// and is converted as it is.
pub fn prepared_to_js(
    ctx: *mut JSContext,
    sc: &Schema,
    node: &Node<'_>,
    ty: u32,
) -> Result<JSValue, String> {
    let mut sink = JsSink::new(ctx);
    let mut w = walk(sc, &EMPTY_TB, &mut sink, true);
    w.prepared = true;
    w.run(V::Mp(node), Some(ty))?;
    sink.finish().ok_or_else(|| "nothing was built".to_string())
}

/// A JS value as msgpack under a type, appended to out.
pub fn js_to_mpack(
    env: JsEnv,
    sc: &Schema,
    v: JSValue,
    ty: u32,
    strict: bool,
    out: &mut Vec<u8>,
) -> Result<(), String> {
    let mut tb = TokBuf::default();
    tokenize(env, v, &mut tb)?;
    let mut w = mp::Writer::new();
    walk(sc, &tb, &mut w, strict).run(V::Tok(0), Some(ty))?;
    out.extend_from_slice(&w.buf);
    Ok(())
}
