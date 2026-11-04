//! The native host: one QuickJS runtime running host.js and the model's native bundle, and every
//! engine the bundle builds in it, each over an LMDB store or the skeleton's in-memory one.
//!
//! The host is sans-IO.  The client drives it from one thread with calls (the client's half of
//! every contract: frames, backfill deliveries, mutation outcomes, the app's mutations and
//! queries), and each call answers with the events the JS side raised meanwhile (connect,
//! backfill, send, query results, ...) and how long until the next timer is due, after which the
//! client calls `pump`.  JS reaches Rust through the natives on `__pl`, and Rust reaches JS through
//! the methods of `__host`; the client holds numbers only, ids in tables on the JS side.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, c_int, c_void};
use std::sync::Arc;
use std::time::{Duration, Instant};

use phaselock_core::js::ffi::*;
use phaselock_core::js::{Owned, cstring, mpjs, new_string, throw_error, throw_type};
use phaselock_core::mp;
use phaselock_core::walk::{JsEnv, Schema, js_string};

use crate::lmdb;
use crate::registry;
use crate::store;

/// the JS half of the host, which runs before the bundle
const HOST_JS: &str = include_str!("../host.js");

pub type Result<T> = std::result::Result<T, String>;

/// The state the natives reach through the context's opaque pointer.  Every field that changes
/// while JS runs is a cell, borrowed only inside one native.
pub struct State {
    pub env: Cell<Option<JsEnv>>,
    /// the Uint8Array constructor, for the byte arrays the natives answer
    pub u8_ctor: Cell<JSValue>,
    /// the bundle's DEV: a stored value that fails to decode throws rather than reading absent
    pub dev: Cell<bool>,
    /// the events raised since the call from the client began, each encoded
    events: RefCell<Vec<Vec<u8>>>,
    /// each timer's deadline, by id
    timers: RefCell<HashMap<i64, Instant>>,
    /// every schema a registry was built over, by id
    pub schemas: RefCell<Vec<Arc<Schema>>>,
    /// each LMDB store, by id
    pub stores: RefCell<HashMap<i64, lmdb::Env>>,
    /// each open transaction, by id: its store's registry and the transaction
    pub txns: RefCell<HashMap<i64, (Arc<Schema>, lmdb::Txn)>>,
    pub next_txn: Cell<i64>,
    /// when the call from the client that is running must end, past which JS is interrupted
    deadline: Cell<Option<Instant>>,
    /// whether the interrupt has fired, and the first exception taken after it, as its text
    interrupted: Cell<bool>,
    trace: RefCell<Option<String>>,
    /// why the host ended, once a call ran past its deadline; every call after it fails with this
    ended: RefCell<Option<String>>,
}

pub unsafe fn state<'a>(ctx: *mut JSContext) -> &'a State {
    unsafe { &*(JS_GetContextOpaque(ctx) as *const State) }
}

/// How far the JS may run: the stack it may take below the frame that calls into it, the heap of
/// the runtime, and how long one call from the client may run before its JS is interrupted.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub stack: usize,
    pub memory: usize,
    pub call: Duration,
}

impl Default for Limits {
    /// QuickJS's own stack limit, which suits a thread of a platform's default size, a heap of
    /// 1 GiB, and calls of up to a minute
    fn default() -> Limits {
        Limits { stack: 1 << 20, memory: 1 << 30, call: Duration::from_secs(60) }
    }
}

/// The runtime with host.js and the bundle loaded.
pub struct Host {
    rt: *mut JSRuntime,
    ctx: *mut JSContext,
    host: JSValue,
    state: *mut State,
    call_limit: Duration,
}

// QuickJS's interrupt check: whether the call running has passed its deadline
unsafe extern "C" fn interrupt(_rt: *mut JSRuntime, opaque: *mut c_void) -> c_int {
    let st = unsafe { &*(opaque as *const State) };
    let passed = st.deadline.get().is_some_and(|d| Instant::now() > d);
    if passed {
        st.interrupted.set(true);
    }
    passed as c_int
}

// values ///////////////////////////////////////////////////////////////////////

/// a new Uint8Array holding a copy of bytes
pub fn new_u8(ctx: *mut JSContext, bytes: &[u8]) -> JSValue {
    unsafe {
        let buf = JS_NewArrayBufferCopy(ctx, bytes.as_ptr(), bytes.len());
        if is_exception(buf) {
            return buf;
        }
        let ctor = state(ctx).u8_ctor.get();
        let arr = JS_CallConstructor(ctx, ctor, 1, &buf);
        JS_FreeValue(ctx, buf);
        arr
    }
}

/// the bytes of a Uint8Array or an ArrayBuffer, or None with a TypeError pending
pub fn bytes_of(ctx: *mut JSContext, v: JSValue) -> Option<Vec<u8>> {
    with_bytes(ctx, v, <[u8]>::to_vec)
}

/// f over the bytes of a Uint8Array or an ArrayBuffer, read in place, or None with a TypeError
/// pending
pub fn with_bytes<R>(ctx: *mut JSContext, v: JSValue, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
    unsafe {
        let mut size = 0usize;
        let p = JS_GetArrayBuffer(ctx, &mut size, v);
        if !p.is_null() {
            return Some(f(std::slice::from_raw_parts(p, size)));
        }
        JS_FreeValue(ctx, JS_GetException(ctx));
        let (mut off, mut len, mut per) = (0usize, 0usize, 0usize);
        let buf = JS_GetTypedArrayBuffer(ctx, v, &mut off, &mut len, &mut per);
        if is_exception(buf) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            throw_type(ctx, "expected bytes");
            return None;
        }
        let p = JS_GetArrayBuffer(ctx, &mut size, buf);
        JS_FreeValue(ctx, buf);
        if p.is_null() {
            return None;
        }
        Some(f(std::slice::from_raw_parts(p.add(off), len)))
    }
}

/// a JS number's integer, or None with the exception pending
pub fn int_of(ctx: *mut JSContext, v: JSValue) -> Option<i64> {
    let mut d = 0f64;
    if unsafe { JS_ToFloat64(ctx, &mut d, v) } != 0 {
        return None;
    }
    Some(d as i64)
}

/// a new array of the values, each taken
pub fn new_array(ctx: *mut JSContext, items: Vec<JSValue>) -> JSValue {
    unsafe {
        let arr = JS_NewArray(ctx);
        for (i, v) in items.into_iter().enumerate() {
            JS_DefinePropertyValueUint32(ctx, arr, i as u32, v, JS_PROP_C_W_E);
        }
        arr
    }
}

/// sets obj's property name to v, taking v
pub fn set_prop(ctx: *mut JSContext, obj: JSValue, name: &CStr, v: JSValue) {
    unsafe { JS_SetPropertyStr(ctx, obj, name.as_ptr(), v) };
}

fn opt_str(ctx: *mut JSContext, s: Option<&str>) -> JSValue {
    match s {
        Some(s) => new_string(ctx, s.as_bytes()),
        None => JS_NULL,
    }
}

// the natives ////////////////////////////////////////////////////////////////

unsafe fn args<'a>(argv: *mut JSValue, n: usize) -> &'a [JSValue] {
    unsafe { std::slice::from_raw_parts(argv, n) }
}

// pl.emit(event): an event for the client, a plain array
unsafe extern "C" fn native_emit(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let mut w = mp::Writer::new();
    if let Err(e) = mpjs::encode(ctx, a[0], &mut w, 0) {
        return throw_type(ctx, &format!("an event: {e}"));
    }
    unsafe { state(ctx) }.events.borrow_mut().push(w.into_vec());
    JS_UNDEFINED
}

// pl.log(text)
unsafe extern "C" fn native_log(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let Some(text) = js_string(ctx, a[0]) else { return JS_EXCEPTION };
    let mut w = mp::Writer::new();
    w.array(2);
    w.str(b"log");
    w.str(&text);
    unsafe { state(ctx) }.events.borrow_mut().push(w.into_vec());
    JS_UNDEFINED
}

// pl.timer(id, ms): a timer due ms from now
unsafe extern "C" fn native_timer(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };
    let (Some(id), Some(ms)) = (int_of(ctx, a[0]), int_of(ctx, a[1])) else { return JS_EXCEPTION };
    let due = Instant::now() + Duration::from_millis(ms.max(0) as u64);
    unsafe { state(ctx) }.timers.borrow_mut().insert(id, due);
    JS_UNDEFINED
}

// pl.clearTimer(id)
unsafe extern "C" fn native_clear_timer(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let Some(id) = int_of(ctx, a[0]) else { return JS_EXCEPTION };
    unsafe { state(ctx) }.timers.borrow_mut().remove(&id);
    JS_UNDEFINED
}

// pl.random(n): an ArrayBuffer of n random bytes
unsafe extern "C" fn native_random(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let Some(n) = int_of(ctx, a[0]) else { return JS_EXCEPTION };
    let mut buf = vec![0u8; n.clamp(0, 65536) as usize];
    if let Err(e) = getrandom::fill(&mut buf) {
        return throw_error(ctx, &format!("randomness: {e}"));
    }
    unsafe { JS_NewArrayBufferCopy(ctx, buf.as_ptr(), buf.len()) }
}

// pl.encode(value): a plain value as msgpack, an ArrayBuffer
unsafe extern "C" fn native_encode(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let mut w = mp::Writer::new();
    if let Err(e) = mpjs::encode(ctx, a[0], &mut w, 0) {
        return throw_type(ctx, &e);
    }
    unsafe { JS_NewArrayBufferCopy(ctx, w.buf.as_ptr(), w.buf.len()) }
}

// pl.equal(a, b): whether two ArrayBuffers or Uint8Arrays hold the same bytes
unsafe extern "C" fn native_equal(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };
    match with_bytes(ctx, a[0], |x| with_bytes(ctx, a[1], |y| x == y)).flatten() {
        Some(same) => JS_NewBool(same),
        None => JS_EXCEPTION,
    }
}

type Native = (&'static CStr, JSCFunction, c_int);

const NATIVES: &[Native] = &[
    (c"emit", native_emit, 1),
    (c"log", native_log, 1),
    (c"timer", native_timer, 2),
    (c"clearTimer", native_clear_timer, 1),
    (c"random", native_random, 1),
    (c"encode", native_encode, 1),
    (c"equal", native_equal, 2),
    (c"registry", registry::native_registry, 1),
    (c"convert", registry::native_convert, 5),
    (c"ops", registry::native_ops, 2),
    (c"begin", store::native_begin, 3),
    (c"commit", store::native_commit, 1),
    (c"abort", store::native_abort, 1),
    (c"get", store::native_get, 4),
    (c"set", store::native_set, 5),
    (c"del", store::native_del, 2),
    (c"delPrefix", store::native_del_prefix, 2),
    (c"scan", store::native_scan, 2),
    (c"applyEdits", store::native_apply_edits, 2),
    (c"applyParked", store::native_apply_parked, 3),
    (c"applySnapshot", store::native_apply_snapshot, 3),
];

// the host ///////////////////////////////////////////////////////////////////

/// One of a connection's hooks, as the client hears it from the transport.  An edits frame carries
/// the msgpack array of its raw edits, and an end's fatal names a refused session, which ends the
/// engine.
pub enum Hook<'a> {
    Open { epoch: &'a str, head: i64 },
    View { token: &'a str, position: i64, selectors: Vec<String> },
    Edits(&'a [u8]),
    Live(i64),
    Vouch(i64),
    End { code: i64, reason: &'a str, fatal: Option<&'a str> },
}

/// One backfill delivery from the client, which the Engine parks.
pub enum Push<'a> {
    Length(i64),
    Header { position: i64, seqs: &'a [u8], visible: i64 },
    Page { page: &'a [u8], skip: i64, checksum: &'a str },
    PagesDone,
    Edits { edits: &'a [u8], scanned: i64 },
    EditsDone,
}

impl Host {
    /// Opens the runtime under its limits: host.js, then the bundle, a script that installs the
    /// model's engines as `globalThis.__engines`.  Errors name the script that failed.  The stack
    /// limit counts down from each call into JS, so the thread that drives the host needs that
    /// much stack free beneath its own frames, and room for the natives JS calls.
    pub fn open(bundle: &[u8], name: &str, limits: Limits) -> Result<Host> {
        unsafe {
            let rt = JS_NewRuntime();
            JS_SetMaxStackSize(rt, limits.stack);
            JS_SetMemoryLimit(rt, limits.memory);
            let ctx = JS_NewContext(rt);
            let st = Box::into_raw(Box::new(State {
                env: Cell::new(None),
                u8_ctor: Cell::new(JS_UNDEFINED),
                dev: Cell::new(false),
                events: RefCell::new(Vec::new()),
                timers: RefCell::new(HashMap::new()),
                schemas: RefCell::new(Vec::new()),
                stores: RefCell::new(HashMap::new()),
                txns: RefCell::new(HashMap::new()),
                next_txn: Cell::new(1),
                deadline: Cell::new(None),
                interrupted: Cell::new(false),
                trace: RefCell::new(None),
                ended: RefCell::new(None),
            }));
            JS_SetContextOpaque(ctx, st as *mut c_void);
            JS_SetInterruptHandler(rt, Some(interrupt), st as *mut c_void);
            let mut h = Host { rt, ctx, host: JS_UNDEFINED, state: st, call_limit: limits.call };

            // the natives, on __pl
            let global = Owned::new(ctx, JS_GetGlobalObject(ctx));
            let pl = JS_NewObject(ctx);
            for &(name, f, n) in NATIVES {
                let fv = JS_NewCFunction2(ctx, f, name.as_ptr(), n, JS_CFUNC_GENERIC, 0);
                JS_SetPropertyStr(ctx, pl, name.as_ptr(), fv);
            }
            JS_SetPropertyStr(ctx, global.v, c"__pl".as_ptr(), pl);
            let ctor = JS_GetPropertyStr(ctx, global.v, c"Uint8Array".as_ptr());
            h.state().u8_ctor.set(ctor);
            let Some(env) = JsEnv::new(ctx) else {
                return Err(format!("js environment: {}", h.exception()));
            };
            h.state().env.set(Some(env));

            // host.js, then the bundle, under one call's deadline
            h.timed(|| {
                h.eval(HOST_JS.as_bytes(), "host.js").map_err(|e| format!("host.js: {e}"))?;
                h.eval(bundle, name).map_err(|e| format!("bundle: {e}"))
            })?;
            h.host = JS_GetPropertyStr(ctx, global.v, c"__host".as_ptr());
            let engines = Owned::new(ctx, JS_GetPropertyStr(ctx, global.v, c"__engines".as_ptr()));
            if !is_object(engines.v) {
                return Err("the bundle installed no engines (globalThis.__engines)".into());
            }

            // the bundle's mode, as the skeleton reads it
            let dev = Owned::new(ctx, h.eval_value(b"process.env.NODE_ENV !== 'production'")?);
            h.state().dev.set(JS_ToBool(ctx, dev.v) == 1);
            Ok(h)
        }
    }

    fn state(&self) -> &State {
        unsafe { &*self.state }
    }

    /* Runs f as one call from the client, under the call deadline.  JS still running when it passes
    is interrupted, which no JS can catch, so whatever the JS was doing stops halfway: the host
    ends.  Every store transaction still open is aborted, the call fails with why, naming the
    limit and the interrupted JS's backtrace, and so does every call after it, which runs no JS. */
    pub fn timed<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let st = self.state();
        if let Some(why) = self.ended() {
            return Err(why);
        }

        // the call, under its deadline
        st.deadline.set(Some(Instant::now() + self.call_limit));
        let r = f();
        st.deadline.set(None);
        if !st.interrupted.get() {
            return r;
        }

        // the call was interrupted, which ends the host
        st.txns.borrow_mut().clear();
        let trace =
            st.trace.borrow_mut().take().unwrap_or_else(|| "InternalError: interrupted".into());
        let why = format!("the call ran past its limit of {:?}: {trace}", self.call_limit);
        *st.ended.borrow_mut() = Some(why.clone());
        Err(why)
    }

    /// why the host ended, once a call ran past its deadline
    pub fn ended(&self) -> Option<String> {
        self.state().ended.borrow().clone()
    }

    fn eval_value(&self, text: &[u8]) -> Result<JSValue> {
        let mut b = text.to_vec();
        b.push(0);
        let r =
            unsafe { JS_Eval(self.ctx, b.as_ptr() as *const _, text.len(), c"<host>".as_ptr(), 0) };
        if is_exception(r) {
            return Err(self.exception());
        }
        Ok(r)
    }

    fn eval(&self, text: &[u8], name: &str) -> Result<()> {
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

    /// The pending exception, as its message and stack.  The first taken after the interrupt
    /// fired is the interrupt's own, whose text the host keeps as the backtrace of why it ended.
    fn exception(&self) -> String {
        let text = self.exception_text();
        let st = self.state();
        if st.interrupted.get() && st.trace.borrow().is_none() {
            *st.trace.borrow_mut() = Some(text.clone());
        }
        text
    }

    fn exception_text(&self) -> String {
        let ctx = self.ctx;
        unsafe {
            let e = Owned::new(ctx, JS_GetException(ctx));
            let text =
                |v: JSValue| js_string(ctx, v).map(|b| String::from_utf8_lossy(&b).into_owned());
            let msg = text(e.v).unwrap_or_else(|| "an exception".into());
            if !is_object(e.v) {
                return msg;
            }
            let stack = Owned::new(ctx, JS_GetPropertyStr(ctx, e.v, c"stack".as_ptr()));
            match text(stack.v) {
                Some(s) if !is_undefined(stack.v) && !s.is_empty() => format!("{msg}\n{s}"),
                _ => msg,
            }
        }
    }

    // calls __host[name] with args, each taken
    fn call(&self, name: &CStr, args: Vec<JSValue>) -> Result<()> {
        let ctx = self.ctx;
        unsafe {
            JS_UpdateStackTop(self.rt);
            let f = Owned::new(ctx, JS_GetPropertyStr(ctx, self.host, name.as_ptr()));
            let r = JS_Call(ctx, f.v, self.host, args.len() as c_int, args.as_ptr());
            for a in args {
                JS_FreeValue(ctx, a);
            }
            if is_exception(r) {
                return Err(format!("{}: {}", name.to_string_lossy(), self.exception()));
            }
            JS_FreeValue(ctx, r);
        }
        Ok(())
    }

    /* Runs what the call left runnable: every promise job, and every timer due, each followed by
    the jobs it queues, until neither remains; then answers the events raised since the last
    answer and how long until the next timer is due. */
    fn settle(&self) -> Result<Vec<u8>> {
        loop {
            self.run_jobs();

            // an interrupted call runs nothing more
            if self.state().interrupted.get() {
                break;
            }
            let now = Instant::now();
            let due: Vec<i64> = {
                let timers = self.state().timers.borrow();
                let mut due: Vec<(Instant, i64)> =
                    timers.iter().filter(|(_, d)| **d <= now).map(|(id, d)| (*d, *id)).collect();
                due.sort();
                due.into_iter().map(|(_, id)| id).collect()
            };
            if due.is_empty() {
                break;
            }
            for id in due {
                self.state().timers.borrow_mut().remove(&id);
                self.call(c"fire", vec![JS_NewInt64(id)])?;
                self.run_jobs();
                if self.state().interrupted.get() {
                    break;
                }
            }
        }

        // the events, behind the delay until the next timer
        let st = self.state();
        let next = st.timers.borrow().values().min().copied();
        let mut w = mp::Writer::new();
        w.array(2);
        match next {
            Some(d) => w.int(d.saturating_duration_since(Instant::now()).as_millis() as i64),
            None => w.nil(),
        }
        let events = std::mem::take(&mut *st.events.borrow_mut());
        w.array(events.len());
        for e in events {
            w.raw(&e);
        }
        Ok(w.into_vec())
    }

    // every pending promise job, until the interrupt fires; one that throws is logged, since no
    // caller awaits it
    fn run_jobs(&self) {
        unsafe {
            while !self.state().interrupted.get() && JS_IsJobPending(self.rt) != 0 {
                let mut jctx = std::ptr::null_mut();
                if JS_ExecutePendingJob(self.rt, &mut jctx) < 0 {
                    self.log(&format!("a promise job threw: {}", self.exception()));
                }
            }
        }
    }

    // a log event for the client
    fn log(&self, text: &str) {
        let mut w = mp::Writer::new();
        w.array(2);
        w.str(b"log");
        w.str(text.as_bytes());
        self.state().events.borrow_mut().push(w.into_vec());
    }

    // one call into __host, then whatever it left runnable
    fn deliver(&self, name: &CStr, args: Vec<JSValue>) -> Result<Vec<u8>> {
        let r = self.call(name, args);
        let out = self.settle()?;
        r.map(|_| out)
    }

    /// Runs every timer due and the work it leaves.
    pub fn pump(&self) -> Result<Vec<u8>> {
        unsafe { JS_UpdateStackTop(self.rt) };
        self.settle()
    }

    /// Builds the bundle's engine `name` under id, syncing as the session handle or as anonymous,
    /// over an LMDB store in the directory store, or the skeleton's in-memory store without one.
    pub fn create_engine(
        &self,
        id: i64,
        name: &str,
        session: Option<i64>,
        store: Option<&str>,
    ) -> Result<Vec<u8>> {
        let ctx = self.ctx;
        let store_arg = match store {
            None => JS_NULL,
            Some(dir) => {
                let env = lmdb::Env::open(dir)?;
                self.state().stores.borrow_mut().insert(id, env);
                JS_NewInt64(id)
            }
        };
        let session = session.map(JS_NewInt64).unwrap_or(JS_NULL);
        self.deliver(
            c"createEngine",
            vec![JS_NewInt64(id), new_string(ctx, name.as_bytes()), session, store_arg],
        )
    }

    /// Ends an engine, its connection, and its backfills, and closes its store.
    pub fn close_engine(&self, id: i64) -> Result<Vec<u8>> {
        let out = self.deliver(c"closeEngine", vec![JS_NewInt64(id)]);
        self.state().stores.borrow_mut().remove(&id);
        out
    }

    pub fn reconnect_now(&self, id: i64) -> Result<Vec<u8>> {
        self.deliver(c"reconnectNow", vec![JS_NewInt64(id)])
    }

    /// a mutation for the engine's outbox, as msgpack under its mutations union
    pub fn send_mutation(&self, id: i64, mutation: &[u8]) -> Result<Vec<u8>> {
        self.deliver(c"sendMutation", vec![JS_NewInt64(id), new_u8(self.ctx, mutation)])
    }

    /// an @online mutation, whose outcome comes back under call
    pub fn send_online_mutation(&self, id: i64, call: i64, mutation: &[u8]) -> Result<Vec<u8>> {
        let args = vec![JS_NewInt64(id), JS_NewInt64(call), new_u8(self.ctx, mutation)];
        self.deliver(c"sendOnlineMutation", args)
    }

    /// a declared query of the engine, its call as msgpack under the queries' wire type
    pub fn query(&self, id: i64, engine: i64, call: &[u8]) -> Result<Vec<u8>> {
        self.deliver(c"query", vec![JS_NewInt64(id), JS_NewInt64(engine), new_u8(self.ctx, call)])
    }

    /// the engine's status, as a plain msgpack map of its parts
    pub fn status_query(&self, id: i64, engine: i64) -> Result<Vec<u8>> {
        self.deliver(c"statusQuery", vec![JS_NewInt64(id), JS_NewInt64(engine)])
    }

    pub fn close_query(&self, id: i64) -> Result<Vec<u8>> {
        self.deliver(c"closeQuery", vec![JS_NewInt64(id)])
    }

    /// Delivers connections' hooks, each by connection, in order and then settles once, so the
    /// Engine takes every frame among them in one store transaction.  A hook that fails is logged
    /// as an event and the rest are still delivered, as each would be in a call of its own.
    pub fn conn_hooks(&self, hooks: &[(i64, Hook<'_>)]) -> Result<Vec<u8>> {
        // each hook, which only queues it for the Engine's advancer
        for (conn, hook) in hooks {
            if let Err(e) = self.conn_hook(*conn, hook) {
                self.log(&format!("a connection hook failed: {e}"));
            }
        }

        // then the advancer, once for them all
        self.settle()
    }

    // one hook's call into __host, the work it leaves unsettled
    fn conn_hook(&self, conn: i64, hook: &Hook<'_>) -> Result<()> {
        let ctx = self.ctx;
        let id = JS_NewInt64(conn);
        match hook {
            Hook::Open { epoch, head } => {
                let args = vec![id, new_string(ctx, epoch.as_bytes()), JS_NewInt64(*head)];
                self.call(c"connOpen", args)
            }
            Hook::View { token, position, selectors } => {
                let sel = new_array(
                    ctx,
                    selectors.iter().map(|s| new_string(ctx, s.as_bytes())).collect(),
                );
                let args = vec![id, new_string(ctx, token.as_bytes()), JS_NewInt64(*position), sel];
                self.call(c"connView", args)
            }
            Hook::Edits(edits) => {
                let arr = registry::wire_edits(ctx, edits)?;
                self.call(c"connEdits", vec![id, arr])
            }
            Hook::Live(position) => self.call(c"connLive", vec![id, JS_NewInt64(*position)]),
            Hook::Vouch(position) => self.call(c"connVouch", vec![id, JS_NewInt64(*position)]),
            Hook::End { code, reason, fatal } => {
                let args = vec![
                    id,
                    JS_NewInt64(*code),
                    new_string(ctx, reason.as_bytes()),
                    opt_str(ctx, *fatal),
                ];
                self.call(c"connEnd", args)
            }
        }
    }

    /// one delivery of a backfill, settled under push once the Engine commits it
    pub fn push(&self, backfill: i64, push: i64, item: Push<'_>) -> Result<Vec<u8>> {
        let ctx = self.ctx;
        let obj = unsafe { JS_NewObject(ctx) };
        match item {
            Push::Length(n) => set_prop(ctx, obj, c"length", JS_NewInt64(n)),
            Push::Header { position, seqs, visible } => {
                let node = mp::parse_whole(seqs).map_err(|e| format!("header seqs: {e}"))?;
                let seqs = mpjs::decode(ctx, &node)?;
                let h = unsafe { JS_NewObject(ctx) };
                set_prop(ctx, h, c"position", JS_NewInt64(position));
                set_prop(ctx, h, c"seqs", seqs);
                set_prop(ctx, h, c"visible", JS_NewInt64(visible));
                set_prop(ctx, obj, c"header", h);
            }
            Push::Page { page, skip, checksum } => {
                set_prop(ctx, obj, c"page", new_u8(ctx, page));
                set_prop(ctx, obj, c"skip", JS_NewInt64(skip));
                set_prop(ctx, obj, c"checksum", new_string(ctx, checksum.as_bytes()));
            }
            Push::PagesDone => set_prop(ctx, obj, c"pagesDone", JS_TRUE),
            Push::Edits { edits, scanned } => {
                set_prop(ctx, obj, c"edits", registry::wire_edits(ctx, edits)?);
                set_prop(ctx, obj, c"scanned", JS_NewInt64(scanned));
            }
            Push::EditsDone => set_prop(ctx, obj, c"editsDone", JS_TRUE),
        }
        self.deliver(c"push", vec![JS_NewInt64(backfill), JS_NewInt64(push), obj])
    }

    /// how a backfill call ended: an outcome, done or stale, or an error
    pub fn backfill_settled(
        &self,
        backfill: i64,
        outcome: Option<&str>,
        error: Option<&str>,
    ) -> Result<Vec<u8>> {
        let ctx = self.ctx;
        let args = vec![JS_NewInt64(backfill), opt_str(ctx, outcome), opt_str(ctx, error)];
        self.deliver(c"backfillSettled", args)
    }

    /// how a send ended: the outcomes as /mutations answers them, a msgpack array, or an error
    pub fn send_settled(
        &self,
        send: i64,
        outcomes: Option<&[u8]>,
        error: Option<&str>,
    ) -> Result<Vec<u8>> {
        let ctx = self.ctx;
        let outcomes = match outcomes {
            None => JS_NULL,
            Some(b) => {
                let node = mp::parse_whole(b).map_err(|e| format!("outcomes: {e}"))?;
                mpjs::decode(ctx, &node)?
            }
        };
        self.deliver(c"sendSettled", vec![JS_NewInt64(send), outcomes, opt_str(ctx, error)])
    }
}

impl Host {
    /// tests only: opens an LMDB store under id, as an engine's store opens, for natives to use
    #[doc(hidden)]
    pub fn open_store(&self, id: i64, dir: &str) -> Result<()> {
        let env = lmdb::Env::open(dir)?;
        self.state().stores.borrow_mut().insert(id, env);
        Ok(())
    }

    /// tests only: how many store transactions are open
    #[doc(hidden)]
    pub fn open_transactions(&self) -> usize {
        self.state().txns.borrow().len()
    }

    /// tests only: the JSON of what an expression evaluates to, any jobs it queued run first
    #[doc(hidden)]
    pub fn eval_json(&self, expr: &str) -> Result<String> {
        unsafe { JS_UpdateStackTop(self.rt) };
        let v =
            Owned::new(self.ctx, self.eval_value(format!("JSON.stringify({expr})").as_bytes())?);
        self.run_jobs();
        js_string(self.ctx, v.v)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .ok_or_else(|| self.exception())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        unsafe {
            // every transaction and store before the runtime, since none holds a JS value
            let st = Box::from_raw(self.state);
            st.txns.borrow_mut().clear();
            st.stores.borrow_mut().clear();
            JS_FreeValue(self.ctx, st.u8_ctor.get());
            JS_FreeValue(self.ctx, self.host);
            drop(st);
            JS_FreeContext(self.ctx);
            JS_FreeRuntime(self.rt);
        }
    }
}
