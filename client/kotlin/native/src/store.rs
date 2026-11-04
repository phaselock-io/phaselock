//! The store natives: the skeleton's WTxn over an LMDB transaction, as InMemStore keeps its
//! contract.  Values are stored as msgpack and converted under the type each call names, with the
//! store's registry; edits and snapshot pages apply as bytes, and a read decodes them with the
//! reader's type.  A transaction is an id on the JS side, open between `begin` and `commit` or
//! `abort` inside one store call of the Engine's.

use std::collections::HashSet;
use std::ffi::{CStr, c_int};

use phaselock_core::js::ffi::*;
use phaselock_core::js::{Owned, new_string, throw_error, throw_range, throw_type};
use phaselock_core::scan::{self, Pattern, Visit};
use phaselock_core::walk::js_string;

use crate::edits::{self, Lifecycle};
use crate::host::{bytes_of, int_of, new_array, new_u8, set_prop, state};
use crate::lmdb::Txn;
use crate::registry::{self, JS, MSGPACK, lossy, schema_of};

/// the keys a walk steps through before it seeks: an LMDB seek costs little more than a step
const SCAN_STEP_BUDGET: usize = 4;

unsafe fn args<'a>(argv: *mut JSValue, n: usize) -> &'a [JSValue] {
    unsafe { std::slice::from_raw_parts(argv, n) }
}

// the transaction a call names, or a thrown TypeError
macro_rules! txn {
    ($ctx:expr, $v:expr, $txns:ident, $sc:ident, $t:ident) => {
        let Some(id) = int_of($ctx, $v) else { return JS_EXCEPTION };
        let st = unsafe { state($ctx) };
        let mut $txns = st.txns.borrow_mut();
        let Some(($sc, $t)) = $txns.get_mut(&id) else {
            return throw_type($ctx, &format!("no transaction {id}"));
        };
    };
}

// a string argument, or the exception pending
fn text(ctx: *mut JSContext, v: JSValue) -> Option<Vec<u8>> {
    js_string(ctx, v)
}

// a write that failed in LMDB, as the error the transaction throws
fn store_error(ctx: *mut JSContext, e: String) -> JSValue {
    throw_error(ctx, &e)
}

// an array of the keys, as strings
fn key_array(ctx: *mut JSContext, keys: Vec<Vec<u8>>) -> JSValue {
    new_array(ctx, keys.iter().map(|k| new_string(ctx, k)).collect())
}

// the keys an apply changed, each once, in the order they first changed
#[derive(Default)]
struct Changed {
    seen: HashSet<Vec<u8>>,
    order: Vec<Vec<u8>>,
}

impl Changed {
    fn add(&mut self, key: &[u8]) {
        if self.seen.insert(key.to_vec()) {
            self.order.push(key.to_vec());
        }
    }
}

// pl.begin(store, registry, writable): a transaction's id
pub unsafe extern "C" fn native_begin(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 3) };
    let Some(store) = int_of(ctx, a[0]) else { return JS_EXCEPTION };
    let Some(sc) = schema_of(ctx, a[1]) else { return JS_EXCEPTION };
    let write = unsafe { JS_ToBool(ctx, a[2]) } == 1;
    let st = unsafe { state(ctx) };
    let mut stores = st.stores.borrow_mut();
    let Some(env) = stores.get_mut(&store) else {
        return throw_type(ctx, &format!("no store {store}"));
    };
    match env.begin(write) {
        Err(e) => store_error(ctx, e),
        Ok(txn) => {
            let id = st.next_txn.get();
            st.next_txn.set(id + 1);
            st.txns.borrow_mut().insert(id, (sc, txn));
            JS_NewInt64(id)
        }
    }
}

// pl.commit(txn)
pub unsafe extern "C" fn native_commit(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let Some(id) = int_of(ctx, a[0]) else { return JS_EXCEPTION };
    let taken = unsafe { state(ctx) }.txns.borrow_mut().remove(&id);
    let Some((_, txn)) = taken else { return throw_type(ctx, &format!("no transaction {id}")) };
    match txn.commit() {
        Ok(()) => JS_UNDEFINED,
        Err(e) => store_error(ctx, e),
    }
}

// pl.abort(txn): drops the transaction, which aborts it
pub unsafe extern "C" fn native_abort(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 1) };
    let Some(id) = int_of(ctx, a[0]) else { return JS_EXCEPTION };
    let taken = unsafe { state(ctx) }.txns.borrow_mut().remove(&id);
    drop(taken);
    JS_UNDEFINED
}

/* A stored value in a representation: msgpack as a copy of its bytes, or JS decoded with the
reader's type.  A value that fails to decode throws, naming its key, in dev mode, and reads
absent in production. */
fn out(
    ctx: *mut JSContext,
    sc: &phaselock_core::walk::Schema,
    key: &[u8],
    ty: &[u8],
    rep: i64,
    bytes: &[u8],
) -> JSValue {
    if rep == MSGPACK {
        return new_u8(ctx, bytes);
    }
    if rep != JS {
        return throw_type(ctx, &format!("no representation {rep}"));
    }
    match registry::decode(ctx, sc, ty, bytes) {
        Ok(v) => v,
        Err(e) => {
            if !unsafe { state(ctx) }.dev.get() {
                if unsafe { JS_HasException(ctx) } != 0 {
                    unsafe { JS_FreeValue(ctx, JS_GetException(ctx)) };
                }
                return JS_UNDEFINED;
            }
            if unsafe { JS_HasException(ctx) } != 0 {
                return JS_EXCEPTION;
            }
            throw_error(ctx, &format!("{}: {e}", lossy(key)))
        }
    }
}

// pl.get(txn, key, type, rep)
pub unsafe extern "C" fn native_get(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 4) };
    let (Some(key), Some(ty), Some(rep)) = (text(ctx, a[1]), text(ctx, a[2]), int_of(ctx, a[3]))
    else {
        return JS_EXCEPTION;
    };
    txn!(ctx, a[0], txns, sc, t);
    match t.get(&key) {
        Err(e) => store_error(ctx, e),
        Ok(None) => JS_UNDEFINED,
        Ok(Some(bytes)) => {
            let bytes = bytes.to_vec();
            let sc = sc.clone();
            drop(txns);
            out(ctx, &sc, &key, &ty, rep, &bytes)
        }
    }
}

// pl.set(txn, key, type, rep, value)
pub unsafe extern "C" fn native_set(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 5) };
    let (Some(key), Some(ty), Some(rep)) = (text(ctx, a[1]), text(ctx, a[2]), int_of(ctx, a[3]))
    else {
        return JS_EXCEPTION;
    };
    let bytes = if rep == MSGPACK {
        let Some(b) = bytes_of(ctx, a[4]) else { return JS_EXCEPTION };
        b
    } else {
        let sc = {
            txn!(ctx, a[0], txns, sc, t);
            let _ = t;
            sc.clone()
        };
        match registry::encode(ctx, &sc, &ty, a[4]) {
            Ok(b) => b,
            Err(e) => {
                if unsafe { JS_HasException(ctx) } != 0 {
                    return JS_EXCEPTION;
                }
                return throw_type(ctx, &format!("{}: {e}", lossy(&key)));
            }
        }
    };
    txn!(ctx, a[0], txns, sc, t);
    let _ = sc;
    match t.put(&key, &bytes) {
        Ok(()) => JS_UNDEFINED,
        Err(e) => store_error(ctx, format!("{}: {e}", lossy(&key))),
    }
}

// pl.del(txn, key)
pub unsafe extern "C" fn native_del(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };
    let Some(key) = text(ctx, a[1]) else { return JS_EXCEPTION };
    txn!(ctx, a[0], txns, sc, t);
    let _ = sc;
    match t.del(&key) {
        Ok(_) => JS_UNDEFINED,
        Err(e) => store_error(ctx, e),
    }
}

// every key under prefix deleted, answering them
fn del_prefix(t: &mut Txn, prefix: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let keys = t.keys_under(prefix)?;
    for k in &keys {
        t.del(k)?;
    }
    Ok(keys)
}

// pl.delPrefix(txn, prefix): the keys deleted
pub unsafe extern "C" fn native_del_prefix(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };
    let Some(prefix) = text(ctx, a[1]) else { return JS_EXCEPTION };
    txn!(ctx, a[0], txns, sc, t);
    let _ = sc;
    match del_prefix(t, &prefix) {
        Ok(keys) => {
            drop(txns);
            key_array(ctx, keys)
        }
        Err(e) => store_error(ctx, e),
    }
}

// a property of obj, owned
fn prop(ctx: *mut JSContext, obj: JSValue, name: &CStr) -> Owned {
    Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, obj, name.as_ptr()) })
}

/* pl.scan(txn, req): one batch of the walk of the keys a pattern picks out, from just past
req.after, as the skeleton's StoreScan.  A full batch's next is its last key; whether more
follow is the next batch's answer. */
pub unsafe extern "C" fn native_scan(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };
    let req = a[1];

    // the request: its pattern, its limit, where it resumes, its direction, and its values
    let pattern = prop(ctx, req, c"pattern");
    let Ok(p) = Pattern::from_js(ctx, pattern.v) else { return JS_EXCEPTION };
    let limit = prop(ctx, req, c"limit");
    let Some(limit) = int_of(ctx, limit.v) else { return JS_EXCEPTION };
    if limit < 1 {
        return throw_range(ctx, "a scan's limit is at least 1");
    }
    let after = prop(ctx, req, c"after");
    let after = if is_undefined(after.v) || is_null(after.v) {
        None
    } else {
        let Some(s) = text(ctx, after.v) else { return JS_EXCEPTION };
        Some(s)
    };
    let reverse = prop(ctx, req, c"reverse");
    let reverse = unsafe { JS_ToBool(ctx, reverse.v) } == 1;
    let values = prop(ctx, req, c"values");
    let values = if unsafe { JS_ToBool(ctx, values.v) } == 0 {
        None
    } else {
        let ty = prop(ctx, values.v, c"type");
        let rep = prop(ctx, values.v, c"rep");
        let (Some(ty), Some(rep)) = (text(ctx, ty.v), int_of(ctx, rep.v)) else {
            return JS_EXCEPTION;
        };
        let name = prop(ctx, pattern.v, c"name");
        if is_null(name.v) {
            return throw_error(ctx, "a scan of every local key reads keys only");
        }
        Some((ty, rep))
    };

    // walk up to a batch's worth of keys, and no further
    let mut batch: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    let sc;
    {
        txn!(ctx, a[0], txns, schema, t);
        sc = schema.clone();
        let mut cur = match t.cursor(values.is_some()) {
            Ok(c) => c,
            Err(e) => return store_error(ctx, e),
        };
        let walked =
            scan::walk(&mut cur, &p, reverse, after.as_deref(), SCAN_STEP_BUDGET, |k, v| {
                batch.push((k.to_vec(), v.to_vec()));
                if batch.len() as i64 >= limit { Visit::Stop } else { Visit::Next }
            });
        if let Err(e) = walked {
            return store_error(ctx, e);
        }
    }

    // the batch, its values converted out; a value that fails to decode is left out
    let next =
        if batch.len() as i64 == limit { batch.last().map(|(k, _)| k.clone()) } else { None };
    let mut entries = Vec::with_capacity(batch.len());
    for (k, v) in &batch {
        let value = match &values {
            None => JS_UNDEFINED,
            Some((ty, rep)) => {
                let v = out(ctx, &sc, k, ty, *rep, v);
                if is_exception(v) {
                    for e in entries {
                        unsafe { JS_FreeValue(ctx, e) };
                    }
                    return JS_EXCEPTION;
                }
                if is_undefined(v) {
                    continue;
                }
                v
            }
        };
        entries.push(new_array(ctx, vec![new_string(ctx, k), value]));
    }
    let o = unsafe { JS_NewObject(ctx) };
    set_prop(ctx, o, c"entries", new_array(ctx, entries));
    let next = match next {
        Some(k) => new_string(ctx, &k),
        None => JS_NULL,
    };
    set_prop(ctx, o, c"next", next);
    o
}

// an edit as an error names it, by its lifecycle
fn edit_name(life: Lifecycle) -> String {
    match life {
        Lifecycle::Normal => "an edit".into(),
        l => format!("a {}", l.name()),
    }
}

/* One edit: a birth or a death clears the slice's keys first, then the operations apply in
order, of which a death has none, and each names a key under the edit's slice. */
fn apply_edit(
    t: &mut Txn,
    slice: &[u8],
    life: Lifecycle,
    raw: &[u8],
    changed: &mut Changed,
) -> Result<(), String> {
    if life != Lifecycle::Normal {
        let prefix = [slice, b"!"].concat();
        for k in del_prefix(t, &prefix)? {
            changed.add(&k);
        }
    }
    for (key, value) in edits::ops(raw, true)? {
        if life == Lifecycle::Death || edits::slice_of(key) != slice {
            return Err(format!("{} of {} writes {:?}", edit_name(life), lossy(slice), lossy(key)));
        }
        match value {
            Some(v) => t.put(key, v)?,
            None => {
                t.del(key)?;
            }
        }
        changed.add(key);
    }
    Ok(())
}

// pl.applyEdits(txn, edits): live edits, in order; answers the keys they changed
pub unsafe extern "C" fn native_apply_edits(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 2) };

    // each edit's slice, lifecycle, and raw bytes, read before the transaction is borrowed
    let len = prop(ctx, a[1], c"length");
    let Some(n) = int_of(ctx, len.v) else { return JS_EXCEPTION };
    let mut list = Vec::with_capacity(n.max(0) as usize);
    for i in 0..n.max(0) {
        let e = Owned::new(ctx, unsafe { JS_GetPropertyUint32(ctx, a[1], i as u32) });
        let slice = prop(ctx, e.v, c"slice");
        let life = prop(ctx, e.v, c"lifecycle");
        let raw = prop(ctx, e.v, c"raw");
        let (Some(slice), Some(life), Some(raw)) =
            (text(ctx, slice.v), text(ctx, life.v), bytes_of(ctx, raw.v))
        else {
            return JS_EXCEPTION;
        };
        let life = match &life[..] {
            b"normal" => Lifecycle::Normal,
            b"birth" => Lifecycle::Birth,
            b"death" => Lifecycle::Death,
            other => return throw_type(ctx, &format!("unknown lifecycle {}", lossy(other))),
        };
        list.push((slice, life, raw));
    }

    let mut changed = Changed::default();
    {
        txn!(ctx, a[0], txns, sc, t);
        let _ = sc;
        for (slice, life, raw) in &list {
            if let Err(e) = apply_edit(t, slice, *life, raw, &mut changed) {
                return throw_error(ctx, &e);
            }
        }
    }
    key_array(ctx, changed.order)
}

// pl.applyParked(txn, slice, fromSeq): the slice's parked edits from the seq on, in seq order
pub unsafe extern "C" fn native_apply_parked(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 3) };
    let (Some(slice), Some(from_seq)) = (text(ctx, a[1]), int_of(ctx, a[2])) else {
        return JS_EXCEPTION;
    };
    let mut changed = Changed::default();
    {
        txn!(ctx, a[0], txns, sc, t);
        let _ = sc;
        let applied = (|| -> Result<(), String> {
            let from = edits::parked_edit_key(&slice, from_seq);
            let prefix = [&b"!park-edit:"[..], &slice, b"!"].concat();
            for key in t.keys_under(&prefix)? {
                if key < from {
                    continue;
                }
                let raw = t.get(&key)?.ok_or("a parked edit vanished")?.to_vec();
                let life = edits::envelope(&raw)?.0.lifecycle;
                apply_edit(t, &slice, life, &raw, &mut changed)?;
            }
            Ok(())
        })();
        if let Err(e) = applied {
            return throw_error(ctx, &e);
        }
    }
    key_array(ctx, changed.order)
}

// pl.applySnapshot(txn, selector, skip): a backfill's parked pages, in order, every key under the
// selector but those of the slices in skip
pub unsafe extern "C" fn native_apply_snapshot(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { args(argv, 3) };
    let Some(selector) = text(ctx, a[1]) else { return JS_EXCEPTION };
    let len = prop(ctx, a[2], c"length");
    let Some(n) = int_of(ctx, len.v) else { return JS_EXCEPTION };
    let mut skipped = HashSet::new();
    for i in 0..n.max(0) {
        let s = Owned::new(ctx, unsafe { JS_GetPropertyUint32(ctx, a[2], i as u32) });
        let Some(s) = text(ctx, s.v) else { return JS_EXCEPTION };
        skipped.insert(s);
    }

    let mut changed = Changed::default();
    {
        txn!(ctx, a[0], txns, sc, t);
        let _ = sc;
        let applied = (|| -> Result<(), String> {
            let prefix = edits::selector_prefix(&selector);
            let pages = [&b"!park-snap:"[..], &selector, b"!"].concat();
            for page in t.keys_under(&pages)? {
                let bytes = t.get(&page)?.ok_or("a parked page vanished")?.to_vec();
                for (key, value) in edits::ops(&bytes, false)? {
                    if !key.starts_with(&prefix) {
                        return Err(format!(
                            "the snapshot of {} holds {:?}",
                            lossy(&selector),
                            lossy(key)
                        ));
                    }
                    if skipped.contains(edits::slice_of(key)) {
                        continue;
                    }
                    match value {
                        Some(v) => t.put(key, v)?,
                        None => {
                            t.del(key)?;
                        }
                    }
                    changed.add(key);
                }
            }
            Ok(())
        })();
        if let Err(e) = applied {
            return throw_error(ctx, &e);
        }
    }
    key_array(ctx, changed.order)
}
