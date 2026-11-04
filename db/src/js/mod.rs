//! The QuickJS host: loads host.js and the bundle, compiles the bundle's registry, exposes the
//! store natives, which convert every value through it and read through the write buffer of the
//! call running, and calls the bundle's slots through `__host`.  The runtime is single-threaded:
//! the core thread creates the host and is the only thread that touches it.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::ffi::{CStr, c_int, c_void};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use phaselock_core::js::ffi::*;
use phaselock_core::js::{
    Owned, cstring, mpjs, new_string, throw_error, throw_internal, throw_range, throw_type,
};
use phaselock_core::mp;
use phaselock_core::names;
use phaselock_core::scan::{self, Pattern, Span, Visit};
use phaselock_core::walk::{self, JsEnv, Schema, js_string};

use crate::buffer::WriteBuffer;
use crate::store::{SCAN_STEP_BUDGET, Store};

/// the JS host's own source, which runs before the bundle
const HOST_JS: &str = include_str!("../../host.js");

/// what a bundle expects of its environment and QuickJS lacks
const ENV_SHIM: &str = concat!(
    "if (typeof globalThis.process === 'undefined') {",
    "  globalThis.process = { env: { NODE_ENV: 'production' } };",
    "}"
);

/// how long one call into the bundle may run before it is interrupted unless the host is given
/// another; bootstrap has no limit
pub const CALL_LIMIT: Duration = Duration::from_secs(30);

/// what bootstrap's hashPassword hashes with: the password's PHC string, None when it fails
pub type HashFn = Box<dyn Fn(&str) -> Option<String> + Send>;

/// how long mapping an error's stack through the source map may run
const MAP_STACK_LIMIT: Duration = Duration::from_millis(100);

/// the most memory the bundle's heap may hold
const MEMORY_LIMIT: usize = 4 << 30;

// values /////////////////////////////////////////////////////////////////////

/// A name (a key, a slice, a variable) and whether it holds U+0000.  Its text stops at the first
/// U+0000, as a message naming it shows it.
fn name_arg(ctx: *mut JSContext, v: JSValue) -> Option<(Vec<u8>, bool)> {
    let s = js_string(ctx, v)?;
    match s.iter().position(|&c| c == 0) {
        Some(i) => Some((s[..i].to_vec(), true)),
        None => Some((s, false)),
    }
}

fn lossy(b: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(b)
}

// a name's first n bytes, as a message shows it, since QuickJS formats a thrown message into 256
fn cut(b: &[u8], n: usize) -> std::borrow::Cow<'_, str> {
    lossy(&b[..b.len().min(n)])
}

// the host's state ///////////////////////////////////////////////////////////

/// What a cached read-only call read: each key it got, once, and the stretch each of its scan
/// batches walked.
#[derive(Default)]
pub struct Reads {
    pub keys: HashSet<Vec<u8>>,
    pub spans: Vec<Span>,
}

/// The state the natives reach through the context's opaque pointer.  Every field that changes
/// while the bundle runs is a cell, borrowed only inside one native, so a native that reenters
/// the bundle fails loudly rather than aliasing.
pub struct State {
    pub store: Rc<Store>,
    pub schema: Arc<Schema>,
    env: Cell<Option<JsEnv>>,
    /// the write buffer of the mutation running, which reads see over the store while a slot
    /// that writes runs
    pub wb: RefCell<WriteBuffer>,
    writing: Cell<bool>,
    // the slot a write fails, naming it, while a slot that only reads runs
    slot: Cell<Option<&'static str>>,
    /// what the call running reads, when its reads are recorded
    pub track: RefCell<Option<Reads>>,
    scan_budget: Cell<usize>,
    env_names: Vec<String>,
    hasher: HashFn,
    deadline: Cell<Option<Instant>>,
}

/// The QuickJS runtime with the bundle loaded.
pub struct Host {
    rt: *mut JSRuntime,
    pub ctx: *mut JSContext,
    host: JSValue,
    state: *mut State,
    /// the bundle's DEV: its errors go to clients in full
    pub dev: bool,
    bundle_file: String,
    source_map: JSValue,
    map_stack: JSValue,
    call_limit: Duration,
}

unsafe fn state<'a>(ctx: *mut JSContext) -> &'a State {
    unsafe { &*(JS_GetContextOpaque(ctx) as *const State) }
}

unsafe extern "C" fn interrupt(_rt: *mut JSRuntime, opaque: *mut c_void) -> c_int {
    let st = unsafe { &*(opaque as *const State) };
    st.deadline.get().is_some_and(|d| Instant::now() > d) as c_int
}

// the natives ////////////////////////////////////////////////////////////////

/// the node of the type a call names; throws for one the registry does not know
fn type_arg(ctx: *mut JSContext, st: &State, v: JSValue) -> Option<u32> {
    let id = js_string(ctx, v)?;
    let t = st.schema.lookup(&id);
    if t.is_none() {
        throw_type(ctx, &format!("no registry entry for type {}", lossy(&id)));
    }
    t
}

/// the rich JS value of a stored value
fn decode_stored(ctx: *mut JSContext, st: &State, key: &[u8], ty: u32, val: &[u8]) -> JSValue {
    let Ok(node) = mp::parse_whole(val) else {
        return throw_type(ctx, &format!("stored value at {}: malformed msgpack", lossy(key)));
    };
    match walk::to_js(ctx, &st.schema, &node, ty, false) {
        Ok(v) => v,
        Err(e) => {
            if unsafe { JS_HasException(ctx) } == 0 {
                throw_type(ctx, &format!("stored value at {}: {}", lossy(key), e));
            }
            JS_EXCEPTION
        }
    }
}

unsafe extern "C" fn native_get(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let argv = unsafe { std::slice::from_raw_parts(argv, 2) };
    let Some((key, nul)) = name_arg(ctx, argv[0]) else { return JS_EXCEPTION };

    // no stored key holds U+0000, so a key that does is absent rather than read short
    if nul {
        return JS_UNDEFINED;
    }
    let Some(ty) = type_arg(ctx, st, argv[1]) else { return JS_EXCEPTION };
    if let Some(r) = st.track.borrow_mut().as_mut() {
        r.keys.insert(key.clone());
    }

    // the write buffer's answer, if it has one
    if st.writing.get() {
        let wb = st.wb.borrow();
        if let Some(val) = wb.find(&key) {
            return match val {
                Some(v) => decode_stored(ctx, st, &key, ty, v),
                None => JS_UNDEFINED,
            };
        }
        if wb.deleted(&key) {
            return JS_UNDEFINED;
        }
    }

    // otherwise the store's
    match st.store.get(&key) {
        Err(e) => throw_internal(ctx, &format!("store get {}: {e}", lossy(&key))),
        Ok(None) => JS_UNDEFINED,
        Ok(Some(v)) => decode_stored(ctx, st, &key, ty, &v),
    }
}

/// whether the call running may write; throws when not
fn writing(ctx: *mut JSContext, st: &State) -> bool {
    if st.writing.get() {
        return true;
    }
    throw_type(
        ctx,
        &format!("{} reads only, and made a write", st.slot.get().unwrap_or("this call")),
    );
    false
}

/// Whether key may be written: it holds KEY_MAX bytes at most, no control character, and no lone
/// surrogate, and its slice, the text before its first '!', is a slice name; throws when not.
fn key_writable(ctx: *mut JSContext, key: &[u8], nul: bool) -> bool {
    if nul {
        throw_type(ctx, &format!("a key beginning {} holds U+0000", cut(key, 200)));
        return false;
    }
    if key.len() > names::KEY_MAX {
        let n = key.len();
        throw_type(ctx, &format!("key {}... is {n} bytes, over {}", cut(key, 64), names::KEY_MAX));
        return false;
    }
    if !names::key_chars_ok(key) {
        throw_type(
            ctx,
            &format!("key {} holds a control character or a lone surrogate", cut(key, 200)),
        );
        return false;
    }
    let ok = crate::buffer::slice_of(key).is_some_and(names::slice_name_ok);
    if !ok {
        throw_type(ctx, &format!("key {} has no slice name before its first '!'", cut(key, 200)));
    }
    ok
}

unsafe extern "C" fn native_set(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let argv = unsafe { std::slice::from_raw_parts(argv, 3) };
    if !writing(ctx, st) {
        return JS_EXCEPTION;
    }
    let Some((key, nul)) = name_arg(ctx, argv[0]) else { return JS_EXCEPTION };
    if !key_writable(ctx, &key, nul) {
        return JS_EXCEPTION;
    }
    let Some(ty) = type_arg(ctx, st, argv[1]) else { return JS_EXCEPTION };

    // the value in store format, into the buffer
    let mut val = Vec::new();
    if let Err(e) =
        walk::js_to_mpack(st.env.get().unwrap(), &st.schema, argv[2], ty, false, &mut val)
    {
        return throw_type(ctx, &format!("value for {}: {e}", lossy(&key)));
    }
    st.wb.borrow_mut().put(&key, Some(&val));
    JS_UNDEFINED
}

unsafe extern "C" fn native_del(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let argv = unsafe { std::slice::from_raw_parts(argv, 1) };
    if !writing(ctx, st) {
        return JS_EXCEPTION;
    }
    let Some((key, nul)) = name_arg(ctx, argv[0]) else { return JS_EXCEPTION };
    if !key_writable(ctx, &key, nul) {
        return JS_EXCEPTION;
    }
    st.wb.borrow_mut().put(&key, None);
    JS_UNDEFINED
}

/// __pl_delete_slice(slice, erase): every key under the slice goes, and with erase its history
unsafe extern "C" fn native_delete_slice(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let argv = unsafe { std::slice::from_raw_parts(argv, 2) };
    if !writing(ctx, st) {
        return JS_EXCEPTION;
    }
    let Some((slice, nul)) = name_arg(ctx, argv[0]) else { return JS_EXCEPTION };
    if nul || !names::slice_name_ok(&slice) {
        return throw_type(ctx, &format!("{} is not a slice name", cut(&slice, 200)));
    }
    let erase = unsafe { JS_ToBool(ctx, argv[1]) } == 1;
    st.wb.borrow_mut().delete_slice(&slice, erase);
    JS_UNDEFINED
}

/// one scan batch as it is collected: the entries the walk visits up to the batch's limit, and
/// whether it filled
struct Batch<'a> {
    ctx: *mut JSContext,
    st: &'a State,
    ty: Option<u32>, // the values' type, or None for keys only
    limit: usize,
    entries: JSValue,
    n: u32,
    full: bool,
    last: Vec<u8>,
}

impl Batch<'_> {
    // takes a key into the batch with its value's bytes, stopping the walk once the batch is full
    fn take(&mut self, key: &[u8], val: &[u8]) -> Visit {
        // the key's value, decoded under the batch's type
        let v = match self.ty {
            Some(ty) => {
                let v = decode_stored(self.ctx, self.st, key, ty, val);
                if is_exception(v) {
                    return Visit::Fail;
                }
                v
            }
            None => JS_UNDEFINED,
        };

        // the entry, and the key the batch would end with
        unsafe {
            let pair = JS_NewArray(self.ctx);
            JS_DefinePropertyValueUint32(
                self.ctx,
                pair,
                0,
                new_string(self.ctx, key),
                JS_PROP_C_W_E,
            );
            JS_DefinePropertyValueUint32(self.ctx, pair, 1, v, JS_PROP_C_W_E);
            JS_DefinePropertyValueUint32(self.ctx, self.entries, self.n, pair, JS_PROP_C_W_E);
        }
        self.n += 1;
        self.last = key.to_vec();
        if (self.n as usize) < self.limit {
            return Visit::Next;
        }
        self.full = true;
        Visit::Stop
    }
}

/* One batch of a walk of the keys a pattern picks out, the skeleton's ReadScan answered with
{entries, next}: the keys from just past after, with their values decoded under the type the
request names, or keys only for a type of false.  It walks no further than the batch: next is
the last key of a full batch, and whether more follow is the next batch's answer, so the batch
depends on no key it does not hand out.  A call with a write buffer walks the buffer merged
with the store: the buffer's entries the pattern picks out go into the batch at their place
among the store's keys, and a store key the buffer holds, or whose slice it deleted, is passed
over, since the buffer's answer wins.  While a recorded call runs, the batch's span is part of
its read-set. */
unsafe extern "C" fn native_scan(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let req = unsafe { *argv };
    if !is_object(req) {
        return throw_type(ctx, "a scan's request is an object");
    }

    // the pattern, compiled
    let pv = Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, req, c"pattern".as_ptr()) });
    if is_exception(pv.v) {
        return JS_EXCEPTION;
    }
    let Ok(p) = Pattern::from_js(ctx, pv.v) else { return JS_EXCEPTION };

    // keys only, or values of the type it names, which one local template's keys share
    let tv = Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, req, c"type".as_ptr()) });
    let values = !(is_bool(tv.v) && unsafe { JS_ToBool(ctx, tv.v) } == 0);
    let mut ty = None;
    if values && !p.named() {
        throw_error(ctx, "a scan of every local key reads keys only");
        return JS_EXCEPTION;
    } else if values {
        ty = type_arg(ctx, st, tv.v);
        if ty.is_none() {
            return JS_EXCEPTION;
        }
    }

    // its direction, where it resumes, and the batch's size
    let rv = Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, req, c"reverse".as_ptr()) });
    let reverse = is_bool(rv.v) && unsafe { JS_ToBool(ctx, rv.v) } == 1;
    let av = Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, req, c"after".as_ptr()) });
    if is_exception(av.v) {
        return JS_EXCEPTION;
    }
    let after = if is_undefined(av.v) || is_null(av.v) {
        None
    } else {
        match js_string(ctx, av.v) {
            Some(a) => Some(a),
            None => return JS_EXCEPTION,
        }
    };
    let lv = Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, req, c"limit".as_ptr()) });
    let mut limit = 0f64;
    if unsafe { JS_ToFloat64(ctx, &mut limit, lv.v) } != 0 {
        return JS_EXCEPTION;
    }
    if limit.is_nan() || limit < 1.0 {
        return throw_range(ctx, "a scan's limit is at least 1");
    }
    let limit = if limit >= usize::MAX as f64 { usize::MAX } else { limit as usize };

    // walk the batch, through the write buffer when the call has one
    let entries = unsafe { JS_NewArray(ctx) };
    let mut b = Batch { ctx, st, ty, limit, entries, n: 0, full: false, last: Vec::new() };
    let mut cur = match st.store.cursor(ty.is_some()) {
        Ok(c) => c,
        Err(e) => {
            unsafe { JS_FreeValue(ctx, entries) };
            return throw_internal(ctx, &format!("store scan: {e}"));
        }
    };
    let rc = if st.writing.get() && !st.wb.borrow().is_empty() {
        let wb = st.wb.borrow();
        let mut pending = wb
            .range(after.as_deref(), reverse)
            .filter(|(k, v)| v.is_some() && p.matches(k))
            .peekable();
        let walked = scan::walk(
            &mut cur,
            &p,
            reverse,
            after.as_deref(),
            st.scan_budget.get(),
            |key, val| {
                // the entries ahead of the store's key in walk order go first
                while let Some(&(k, v)) = pending.peek() {
                    let d = k.cmp(key);
                    let ahead = if reverse { d.is_gt() } else { d.is_lt() };
                    if !ahead {
                        break;
                    }
                    pending.next();
                    match b.take(k, v.unwrap()) {
                        Visit::Next => {}
                        other => return other,
                    }
                }

                // the store's key, unless the buffer answers for it
                if wb.find(key).is_some() || wb.deleted(key) {
                    return Visit::Next;
                }
                b.take(key, val)
            },
        );

        // then the entries past the store's last
        walked.and_then(|()| {
            while !b.full {
                let Some((k, v)) = pending.next() else { break };
                if let Visit::Fail = b.take(k, v.unwrap()) {
                    return Err("the walk's visit failed".into());
                }
            }
            Ok(())
        })
    } else {
        scan::walk(&mut cur, &p, reverse, after.as_deref(), st.scan_budget.get(), |key, val| {
            b.take(key, val)
        })
    };
    if let Err(e) = rc {
        if unsafe { JS_HasException(ctx) } == 0 {
            throw_internal(ctx, &format!("store scan: {e}"));
        }
        unsafe { JS_FreeValue(ctx, entries) };
        return JS_EXCEPTION;
    }

    // the batch, and what it walked for the read-set
    unsafe {
        let out = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, out, c"entries".as_ptr(), entries);
        let next = if b.full { new_string(ctx, &b.last) } else { JS_NULL };
        JS_SetPropertyStr(ctx, out, c"next".as_ptr(), next);
        if let Some(r) = st.track.borrow_mut().as_mut() {
            let to = b.full.then_some(b.last.as_slice());
            scan::push_span(&mut r.spans, p, reverse, after.as_deref(), to);
        }
        out
    }
}

/// bootstrap's hashPassword: the hash intake would make
unsafe extern "C" fn native_hash(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let Some(pw) = js_string(ctx, unsafe { *argv }) else { return JS_EXCEPTION };
    match (st.hasher)(&String::from_utf8_lossy(&pw)) {
        Some(h) => new_string(ctx, h.as_bytes()),
        None => throw_internal(ctx, "password hashing failed"),
    }
}

/// bootstrap's env: a variable the operator named, or "" for any other or an unset one
unsafe extern "C" fn native_env(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let st = unsafe { state(ctx) };
    let Some((name, nul)) = name_arg(ctx, unsafe { *argv }) else { return JS_EXCEPTION };
    let name = String::from_utf8_lossy(&name).into_owned();
    let v = if !nul && st.env_names.contains(&name) { std::env::var(&name).ok() } else { None };
    new_string(ctx, v.unwrap_or_default().as_bytes())
}

/// __pl_random(n): an ArrayBuffer of n bytes from the kernel's CSPRNG, the source of the host's
/// crypto.getRandomValues; n is at most 65536, as the Web Crypto API allows
unsafe extern "C" fn native_random(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let mut n = 0i32;
    if unsafe { JS_ToInt32(ctx, &mut n, *argv) } != 0 {
        return JS_EXCEPTION;
    }
    if !(0..=65536).contains(&n) {
        return throw_range(ctx, &format!("random bytes: {n} is not in 0..65536"));
    }
    let mut buf = vec![0u8; n as usize];
    if let Err(e) = getrandom::fill(&mut buf) {
        return throw_internal(ctx, &format!("random bytes: {e}"));
    }
    unsafe { JS_NewArrayBufferCopy(ctx, buf.as_ptr(), buf.len()) }
}

unsafe extern "C" fn native_log(
    ctx: *mut JSContext,
    _: JSValue,
    argc: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let args = unsafe { std::slice::from_raw_parts(argv, argc as usize) };
    let mut line = String::from("bundle:");
    for &a in args {
        let s = js_string(ctx, a);
        line.push(' ');
        line.push_str(&s.map(|s| String::from_utf8_lossy(&s).into_owned()).unwrap_or("?".into()));
    }
    eprintln!("{line}");
    JS_UNDEFINED
}

// the host ///////////////////////////////////////////////////////////////////

/// What opening the host needs besides the bundle: the store it reads, the variables bootstrap's
/// env may read, and bootstrap's password hasher.
pub struct Options {
    pub store: Rc<Store>,
    pub env_names: Vec<String>,
    pub hasher: HashFn,
    pub call_limit: Duration,
}

impl Host {
    /// Opens the host over the store and evaluates the bundle at bundle_path.
    pub fn open(bundle_path: &str, o: Options) -> Result<Host, String> {
        unsafe {
            let rt = JS_NewRuntime();
            JS_SetMemoryLimit(rt, MEMORY_LIMIT);
            let ctx = JS_NewContext(rt);
            let st = Box::into_raw(Box::new(State {
                store: o.store,
                schema: Arc::new(Schema::empty()),
                env: Cell::new(None),
                wb: RefCell::new(WriteBuffer::default()),
                writing: Cell::new(false),
                slot: Cell::new(None),
                track: RefCell::new(None),
                scan_budget: Cell::new(SCAN_STEP_BUDGET),
                env_names: o.env_names,
                hasher: o.hasher,
                deadline: Cell::new(None),
            }));
            JS_SetContextOpaque(ctx, st as *mut c_void);
            JS_SetInterruptHandler(rt, Some(interrupt), st as *mut c_void);
            let mut h = Host {
                rt,
                ctx,
                host: JS_UNDEFINED,
                state: st,
                dev: false,
                bundle_file: bundle_path.to_string(),
                source_map: JS_UNDEFINED,
                map_stack: JS_UNDEFINED,
                call_limit: o.call_limit,
            };
            h.load(bundle_path)?;
            Ok(h)
        }
    }

    pub fn state(&self) -> &State {
        unsafe { &*self.state }
    }

    fn load(&mut self, bundle_path: &str) -> Result<(), String> {
        let ctx = self.ctx;
        unsafe {
            let global = Owned::new(ctx, JS_GetGlobalObject(ctx));
            let natives: [(&CStr, JSCFunction, c_int); 8] = [
                (c"__pl_get", native_get, 2),
                (c"__pl_set", native_set, 3),
                (c"__pl_del", native_del, 1),
                (c"__pl_delete_slice", native_delete_slice, 2),
                (c"__pl_scan", native_scan, 1),
                (c"__pl_hash", native_hash, 1),
                (c"__pl_env", native_env, 1),
                (c"__pl_random", native_random, 1),
            ];
            for (name, f, n) in natives {
                let fv = JS_NewCFunction2(ctx, f, name.as_ptr(), n, JS_CFUNC_GENERIC, 0);
                JS_SetPropertyStr(ctx, global.v, name.as_ptr(), fv);
            }
            let console = JS_NewObject(ctx);
            let log = JS_NewCFunction2(ctx, native_log, c"log".as_ptr(), 1, JS_CFUNC_GENERIC, 0);
            JS_SetPropertyStr(ctx, console, c"log".as_ptr(), log);
            JS_SetPropertyStr(ctx, global.v, c"console".as_ptr(), console);

            let Some(env) = JsEnv::new(ctx) else {
                return Err(format!("js environment: {}", self.exception()));
            };
            self.state().env.set(Some(env));
            self.eval(ENV_SHIM.as_bytes(), "<env>").map_err(|e| format!("host.js: {e}"))?;
            self.eval(HOST_JS.as_bytes(), "host.js").map_err(|e| format!("host.js: {e}"))?;

            // the bundle, then the source map it carries
            let src = std::fs::read(bundle_path)
                .map_err(|e| format!("bundle: open {bundle_path}: {e}"))?;
            self.eval(&src, bundle_path).map_err(|e| format!("bundle: {e}"))?;
            self.load_source_map(&src);

            let bundle = Owned::new(ctx, JS_GetPropertyStr(ctx, global.v, c"__bundle".as_ptr()));
            self.host = JS_GetPropertyStr(ctx, global.v, c"__host".as_ptr());
            if !is_object(bundle.v) {
                return Err("bundle did not set globalThis.__bundle".into());
            }

            // the bundle's registry, compiled from the schema it installed
            let schema = Owned::new(ctx, JS_GetPropertyStr(ctx, bundle.v, c"schema".as_ptr()));
            if !is_object(schema.v) {
                return Err("bundle has no schema".into());
            }
            let mut tb = walk::TokBuf::default();
            walk::tokenize(env, schema.v, &mut tb).map_err(|e| format!("bundle schema: {e}"))?;
            let sc = Schema::compile(&tb).map_err(|e| format!("bundle schema: {e}"))?;
            (*self.state).schema = Arc::new(sc);

            // its mode and its stack mapper
            let dev = Owned::new(ctx, JS_GetPropertyStr(ctx, bundle.v, c"dev".as_ptr()));
            self.dev = JS_ToBool(ctx, dev.v) == 1;
            self.map_stack = JS_GetPropertyStr(ctx, bundle.v, c"mapStack".as_ptr());

            // its contexts, bound once to host.js's transaction
            self.call_host("load", &[]).map_err(|e| format!("bundle: {e}"))?;
        }
        Ok(())
    }

    fn eval(&self, text: &[u8], name: &str) -> Result<(), String> {
        // JS_Eval wants its input NUL-terminated
        let mut b = text.to_vec();
        b.push(0);
        let cname = cstring(name);
        let r = unsafe {
            JS_Eval(
                self.ctx,
                b.as_ptr() as *const _,
                text.len(),
                cname.as_ptr(),
                JS_EVAL_TYPE_GLOBAL,
            )
        };
        if is_exception(r) {
            return Err(self.exception());
        }
        unsafe { JS_FreeValue(self.ctx, r) };
        Ok(())
    }

    /// the source map a bundle carries inline, as its last sourceMappingURL comment, parsed; a
    /// bundle without one leaves it undefined
    fn load_source_map(&mut self, text: &[u8]) {
        const MARK: &[u8] = b"//# sourceMappingURL=data:application/json;base64,";
        let Some(at) = text.windows(MARK.len()).rposition(|w| w == MARK) else { return };
        let found = &text[at + MARK.len()..];
        let end = found.iter().position(|&c| c == b'\n' || c == b'\r').unwrap_or(found.len());

        // decoded and parsed; a map that will not parse is reported and left out
        let b64 = &found[..end];
        let b64 = b64.split(|&c| c == b'=').next().unwrap_or(b64);
        let json = base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64);
        let map = json.ok().map(|mut j| {
            let n = j.len();
            j.push(0);
            unsafe { JS_ParseJSON(self.ctx, j.as_ptr() as *const _, n, c"sourcemap".as_ptr()) }
        });
        match map {
            Some(m) if is_object(m) => self.source_map = m,
            other => {
                if let Some(m) = other {
                    if is_exception(m) {
                        unsafe { JS_FreeValue(self.ctx, JS_GetException(self.ctx)) };
                    } else {
                        unsafe { JS_FreeValue(self.ctx, m) };
                    }
                }
                eprintln!("pldb: the bundle's source map is malformed; stacks stay unmapped");
            }
        }
    }

    // a stack with its frames in the bundle mapped through the bundle's source map, or the stack
    // as it is when the bundle has no map or the mapping throws; takes stack
    fn map_stack(&self, stack: JSValue) -> JSValue {
        let ctx = self.ctx;
        unsafe {
            if JS_IsFunction(ctx, self.map_stack) == 0 || !is_object(self.source_map) {
                return stack;
            }
            let file = new_string(ctx, self.bundle_file.as_bytes());
            let args = [stack, file, self.source_map];
            let mapped = JS_Call(ctx, self.map_stack, JS_UNDEFINED, 3, args.as_ptr());
            JS_FreeValue(ctx, file);
            if is_exception(mapped) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                return stack;
            }
            JS_FreeValue(ctx, stack);
            mapped
        }
    }

    /* The pending exception, formatted with its stack.  Formatting runs JS, the message's
    conversion and the source map's mapping, under a deadline of its own, since the exception is
    often the call's deadline passing; a formatting that runs past it leaves the message or the
    stack as they are. */
    fn exception(&self) -> String {
        let st = self.state();
        let deadline = st.deadline.replace(Some(Instant::now() + MAP_STACK_LIMIT));
        let out = self.format_exception();
        st.deadline.set(deadline);
        out
    }

    fn format_exception(&self) -> String {
        let ctx = self.ctx;
        unsafe {
            let exc = Owned::new(ctx, JS_GetException(ctx));
            let msg = js_string(ctx, exc.v);
            if msg.is_none() {
                JS_FreeValue(ctx, JS_GetException(ctx));
            }
            let mut out =
                msg.map(|m| String::from_utf8_lossy(&m).into_owned()).unwrap_or("exception".into());
            if JS_IsError(ctx, exc.v) != 0 {
                let st = JS_GetPropertyStr(ctx, exc.v, c"stack".as_ptr());
                if !is_undefined(st) {
                    let st = Owned::new(ctx, self.map_stack(st));
                    if !is_undefined(st.v)
                        && let Some(s) = js_string(ctx, st.v)
                    {
                        out.push('\n');
                        out.push_str(&String::from_utf8_lossy(&s));
                    }
                }
            }
            if out.len() > 4095 {
                let mut cut = 4095;
                while !out.is_char_boundary(cut) {
                    cut -= 1;
                }
                out.truncate(cut);
            }
            out
        }
    }

    // calls __host[name](args...)
    fn call_host(&self, name: &str, args: &[JSValue]) -> Result<Owned, String> {
        let ctx = self.ctx;
        let cname = cstring(name);
        unsafe {
            let f = Owned::new(ctx, JS_GetPropertyStr(ctx, self.host, cname.as_ptr()));
            let r = JS_Call(ctx, f.v, self.host, args.len() as c_int, args.as_ptr());
            if is_exception(r) {
                return Err(self.exception());
            }
            Ok(Owned::new(ctx, r))
        }
    }

    fn timed<T>(&self, limit: Option<Duration>, f: impl FnOnce() -> T) -> T {
        let st = self.state();
        st.deadline.set(limit.map(|l| Instant::now() + l));
        let r = f();
        st.deadline.set(None);
        r
    }

    // calls a slot that writes, over the state's write buffer, naming it for its errors
    fn call_writing(
        &self,
        slot: &'static str,
        args: &[JSValue],
        limit: Option<Duration>,
    ) -> Result<Owned, String> {
        let st = self.state();
        st.writing.set(true);
        st.slot.set(Some(slot));
        let r = self.timed(limit, || self.call_host(slot, args));
        st.writing.set(false);
        st.slot.set(None);
        r
    }

    // calls __host[name], which runs a slot that only reads, naming the slot for the error of a
    // write it makes
    fn call_reading(
        &self,
        name: &str,
        slot: &'static str,
        args: &[JSValue],
    ) -> Result<Owned, String> {
        let st = self.state();
        st.slot.set(Some(slot));
        let r = self.timed(Some(self.call_limit), || self.call_host(name, args));
        st.slot.set(None);
        r
    }

    pub fn principal(&self, user: Option<&str>) -> Owned {
        let ctx = self.ctx;
        unsafe {
            let p = JS_NewObject(ctx);
            let u = match user {
                Some(u) => new_string(ctx, u.as_bytes()),
                None => JS_NULL,
            };
            JS_SetPropertyStr(ctx, p, c"user".as_ptr(), u);
            Owned::new(ctx, p)
        }
    }

    // a JS array of strings
    fn strings_of(&self, arr: JSValue) -> Result<Vec<String>, String> {
        let ctx = self.ctx;
        unsafe {
            let lenv = Owned::new(ctx, JS_GetPropertyStr(ctx, arr, c"length".as_ptr()));
            let mut n = 0i64;
            if JS_ToInt64(ctx, &mut n, lenv.v) != 0 {
                return Err(self.exception());
            }
            let mut out = Vec::with_capacity(n.max(0) as usize);
            for i in 0..n {
                let item = Owned::new(ctx, JS_GetPropertyUint32(ctx, arr, i as u32));
                match name_arg(ctx, item.v) {
                    None => return Err(self.exception()),
                    Some((s, true)) => {
                        throw_type(ctx, &format!("a string beginning {} holds U+0000", lossy(&s)));
                        return Err(self.exception());
                    }
                    Some((s, false)) => out.push(String::from_utf8_lossy(&s).into_owned()),
                }
            }
            Ok(out)
        }
    }

    /// The decider over the state's write buffer, which holds what it wrote when it returns: None
    /// when it carried the mutation out, and the reason when it rejected it; Err when it threw.
    pub fn decide(&self, data: JSValue, principal: JSValue) -> Result<Option<String>, String> {
        let r = self.call_writing("decide", &[data, principal], Some(self.call_limit))?;

        // null carried the mutation out, and a reason, text to show, which a U+0000 in it ends,
        // rejected it
        if is_null(r.v) {
            return Ok(None);
        }
        if !is_string(r.v) {
            return Err("decide answered neither null nor a reason".into());
        }
        match name_arg(self.ctx, r.v) {
            Some((s, _)) => Ok(Some(String::from_utf8_lossy(&s).into_owned())),
            None => Err(self.exception()),
        }
    }

    /// runs the bundle's bootstrap, if it has one
    pub fn bootstrap(&self) -> Result<(), String> {
        self.call_writing("bootstrap", &[], None).map(|_| ())
    }

    /// every cron entry of the bundle's cron installs, as install, entry, and spec
    pub fn cron_entries(&self) -> Result<Vec<(String, String, String)>, String> {
        let r = self.call_reading("cronEntries", "cronEntries", &[])?;
        let ctx = self.ctx;
        let mut n = 0i64;
        unsafe {
            let lenv = Owned::new(ctx, JS_GetPropertyStr(ctx, r.v, c"length".as_ptr()));
            if JS_ToInt64(ctx, &mut n, lenv.v) != 0 {
                return Err(self.exception());
            }
        }
        let mut out = Vec::new();
        for i in 0..n {
            let e = Owned::new(ctx, unsafe { JS_GetPropertyUint32(ctx, r.v, i as u32) });
            let s = self.strings_of(e.v)?;
            let [a, b, c] = <[String; 3]>::try_from(s)
                .map_err(|s| format!("cron entry {i} is {s:?}, not [install, entry, spec]"))?;
            out.push((a, b, c));
        }
        Ok(out)
    }

    /// one tick of a cron entry, slot and now in Unix milliseconds, as its install's mutation
    pub fn tick(&self, install: &str, entry: &str, slot: i64, now: i64) -> Result<(), String> {
        let ctx = self.ctx;
        let args = [
            Owned::new(ctx, new_string(ctx, install.as_bytes())),
            Owned::new(ctx, new_string(ctx, entry.as_bytes())),
            Owned::new(ctx, JS_NewFloat64(slot as f64)),
            Owned::new(ctx, JS_NewFloat64(now as f64)),
        ];
        let raw: Vec<JSValue> = args.iter().map(|a| a.v).collect();
        self.call_writing("tick", &raw, Some(self.call_limit)).map(|_| ())
    }

    pub fn grant(&self, principal: JSValue) -> Result<Vec<String>, String> {
        let r = self.call_reading("grant", "grant", &[principal])?;
        self.strings_of(r.v)
    }

    /// lookup's answer for an identity given as msgpack, as msgpack, or None for null
    pub fn lookup(&self, ident: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let ctx = self.ctx;
        let node = mp::parse_whole(ident).map_err(|_| "invalid msgpack".to_string())?;
        let arg = Owned::new(ctx, mpjs::decode(ctx, &node)?);
        let r = self.call_reading("lookup", "lookup", &[arg.v])?;
        if is_null(r.v) || is_undefined(r.v) {
            return Ok(None);
        }
        let mut w = mp::Writer::new();
        mpjs::encode(ctx, r.v, &mut w, 0)?;
        Ok(Some(w.into_vec()))
    }

    /// What lookup answers for the principal's token: its generation, -1 for no account, and its
    /// password hash, if it has one.
    pub fn account(&self, principal: JSValue) -> Result<(i64, Option<String>), String> {
        let ctx = self.ctx;
        let r = self.call_reading("account", "lookup", &[principal])?;
        if is_null(r.v) {
            return Ok((-1, None));
        }

        // the generation, which host.js has checked is a non-negative safe integer, and the
        // hash, which it has checked is a string or null
        unsafe {
            let g = Owned::new(ctx, JS_GetPropertyStr(ctx, r.v, c"generation".as_ptr()));
            let mut generation = 0i64;
            if JS_ToInt64(ctx, &mut generation, g.v) != 0 {
                return Err(self.exception());
            }
            let h = Owned::new(ctx, JS_GetPropertyStr(ctx, r.v, c"passwordHash".as_ptr()));
            let hash = if is_string(h.v) {
                js_string(ctx, h.v).map(|s| String::from_utf8_lossy(&s).into_owned())
            } else {
                None
            };
            Ok((generation, hash))
        }
    }

    /// the registry the bundle carries
    pub fn schema(&self) -> Arc<Schema> {
        self.state().schema.clone()
    }

    /// runs f with the call's reads recorded, answering what it read
    pub fn recording<T>(&self, f: impl FnOnce(&Host) -> T) -> (T, Reads) {
        *self.state().track.borrow_mut() = Some(Reads::default());
        let r = f(self);
        let reads = self.state().track.borrow_mut().take().unwrap_or_default();
        (r, reads)
    }

    /// The JS value of a prepared mutation's data, or why it fails its type.
    pub fn prepared_data(&self, node: &mp::Node<'_>, ty: u32) -> Result<Owned, String> {
        let st = self.state();
        match walk::prepared_to_js(self.ctx, &st.schema, node, ty) {
            Ok(v) => Ok(Owned::new(self.ctx, v)),
            Err(e) => {
                if unsafe { JS_HasException(self.ctx) } != 0 {
                    unsafe { JS_FreeValue(self.ctx, JS_GetException(self.ctx)) };
                }
                Err(e)
            }
        }
    }

    /// tests only: the keys a scan steps through before it seeks
    pub fn set_scan_budget(&self, budget: usize) {
        self.state().scan_budget.set(budget);
    }

    /// Tests only: a scan request given as JSON, through the native behind every transaction's
    /// scan, answered with its batch as JSON or with the message of what it threw.
    pub fn scan_json(&self, req: &str) -> Result<String, String> {
        let ctx = self.ctx;
        let mut b = req.as_bytes().to_vec();
        b.push(0);
        unsafe {
            let r =
                JS_ParseJSON(ctx, b.as_ptr() as *const _, req.len(), c"<scan request>".as_ptr());
            if is_exception(r) {
                return Err(self.exception());
            }
            let r = Owned::new(ctx, r);
            let global = Owned::new(ctx, JS_GetGlobalObject(ctx));
            let f = Owned::new(ctx, JS_GetPropertyStr(ctx, global.v, c"__pl_scan".as_ptr()));
            let out = JS_Call(ctx, f.v, JS_UNDEFINED, 1, &r.v);
            if is_exception(out) {
                let exc = Owned::new(ctx, JS_GetException(ctx));
                return Err(js_string(ctx, exc.v)
                    .map(|s| String::from_utf8_lossy(&s).into_owned())
                    .unwrap_or_default());
            }
            let out = Owned::new(ctx, out);
            let text = Owned::new(ctx, JS_JSONStringify(ctx, out.v, JS_UNDEFINED, JS_UNDEFINED));
            js_string(ctx, text.v)
                .map(|s| String::from_utf8_lossy(&s).into_owned())
                .ok_or_else(|| "the scan's answer would not convert to text".into())
        }
    }

    /// Tests only: stores a string value under key, converted under a type as a decider's write
    /// would be, past the write gate.
    pub fn put_raw(&self, key: &str, ty: &str, value: &str) -> Result<(), String> {
        let st = self.state();
        let t = st
            .schema
            .lookup(ty.as_bytes())
            .ok_or_else(|| format!("no registry entry for type {ty}"))?;
        let v = Owned::new(self.ctx, new_string(self.ctx, value.as_bytes()));
        let mut out = Vec::new();
        walk::js_to_mpack(st.env.get().unwrap(), &st.schema, v.v, t, false, &mut out)?;
        st.store.set(key.as_bytes(), &out)
    }

    /// the thread the host runs on calls this once, so the runtime measures its stack from there
    pub fn bind_thread(&self) {
        unsafe { JS_UpdateStackTop(self.rt) }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        unsafe {
            JS_FreeValue(self.ctx, self.source_map);
            JS_FreeValue(self.ctx, self.map_stack);
            JS_FreeValue(self.ctx, self.host);
            JS_FreeContext(self.ctx);
            JS_FreeRuntime(self.rt);
            drop(Box::from_raw(self.state));
        }
    }
}
