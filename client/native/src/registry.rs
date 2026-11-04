//! The Registry the Engine converts through, over the conversion kernel: a value of a type
//! identity between msgpack and JS, the operations of a raw edit or page, and the host's own
//! identities, which have no node.  `.json` is a plain value, `.mutation` an outbox row
//! (`[id, series, n, data]`, the data its wire bytes inline), and `.edits` a parked edit, which
//! reads as its envelope alone.  `.page` is never converted.  A walk under the mutations union
//! rejects fields its schema does not name; any other drops them.

use std::ffi::c_int;
use std::sync::Arc;

use phaselock_core::js::ffi::*;
use phaselock_core::js::{Owned, mpjs, new_string, throw_error, throw_type};
use phaselock_core::mp::{self, Node};
use phaselock_core::walk::{self, Schema, TokBuf, js_string};

use crate::edits;
use crate::host::{bytes_of, int_of, new_array, new_u8, set_prop, state};

// the skeleton's representations
pub const JS: i64 = 1;
pub const MSGPACK: i64 = 3;

/// a uuid's 16 bytes as its lower-case text, as the skeleton names an edit's id
fn uuid_string(b: &[u8]) -> String {
    let hex: String = b.iter().map(|c| format!("{c:02x}")).collect();
    if hex.len() != 32 {
        return hex;
    }
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// an edit's envelope as the skeleton's EditEnvelope
fn envelope_js(ctx: *mut JSContext, env: &edits::Envelope<'_>) -> JSValue {
    unsafe {
        let o = JS_NewObject(ctx);
        set_prop(ctx, o, c"position", JS_NewInt64(env.position));
        set_prop(ctx, o, c"slice", new_string(ctx, env.slice));
        set_prop(ctx, o, c"seq", JS_NewInt64(env.seq));
        set_prop(ctx, o, c"id", new_string(ctx, uuid_string(env.id).as_bytes()));
        set_prop(ctx, o, c"servertime", JS_NewDate(ctx, env.servertime_ms));
        set_prop(ctx, o, c"lifecycle", new_string(ctx, env.lifecycle.name().as_bytes()));
        o
    }
}

/// The skeleton's WireEdits of a msgpack array of raw edits: each its envelope and its raw bytes.
pub fn wire_edits(ctx: *mut JSContext, edits_array: &[u8]) -> Result<JSValue, String> {
    let (n, mut at) = mp::array_header(edits_array).map_err(|e| format!("edits: {e}"))?;
    let mut items = Vec::with_capacity(n.min(1024));
    for _ in 0..n {
        let used = mp::skip(&edits_array[at..]).map_err(|e| format!("edits: {e}"))?;
        let raw = &edits_array[at..at + used];
        at += used;
        let (env, _, _) = match edits::envelope(raw) {
            Ok(e) => e,
            Err(e) => {
                for v in items {
                    unsafe { JS_FreeValue(ctx, v) };
                }
                return Err(e);
            }
        };
        let o = envelope_js(ctx, &env);
        set_prop(ctx, o, c"raw", new_u8(ctx, raw));
        items.push(o);
    }
    Ok(new_array(ctx, items))
}

/// an outbox row as the skeleton's Mutation<Uint8Array>
fn mutation_js(ctx: *mut JSContext, bytes: &[u8]) -> Result<JSValue, String> {
    let bad = || "malformed outbox row".to_string();
    let (n, mut at) = mp::array_header(bytes).map_err(|_| bad())?;
    if n != 4 {
        return Err(bad());
    }
    let mut item = || -> Result<Node<'_>, String> {
        let (node, used) = mp::parse(&bytes[at..]).map_err(|_| bad())?;
        at += used;
        Ok(node)
    };
    let id = item()?;
    let series = item()?;
    let num = item()?;
    let data = &bytes[at..];
    let Some(id) = id.as_str() else { return Err(bad()) };
    unsafe {
        let o = JS_NewObject(ctx);
        set_prop(ctx, o, c"id", new_string(ctx, id));
        match (series.as_str(), num.as_i64()) {
            (Some(s), Some(k)) => {
                set_prop(ctx, o, c"series", new_string(ctx, s));
                set_prop(ctx, o, c"n", JS_NewInt64(k));
            }
            _ => {
                set_prop(ctx, o, c"series", JS_NULL);
                set_prop(ctx, o, c"n", JS_NULL);
            }
        }
        set_prop(ctx, o, c"data", new_u8(ctx, data));
        Ok(o)
    }
}

// an outbox row from the skeleton's Mutation<Uint8Array>; None with the exception pending
fn mutation_bytes(ctx: *mut JSContext, v: JSValue) -> Option<Vec<u8>> {
    let prop = |name: &std::ffi::CStr| {
        Owned::new(ctx, unsafe { JS_GetPropertyStr(ctx, v, name.as_ptr()) })
    };
    let id = prop(c"id");
    let series = prop(c"series");
    let n = prop(c"n");
    let data = prop(c"data");
    let mut w = mp::Writer::new();
    w.array(4);
    w.str(&js_string(ctx, id.v)?);
    if is_null(series.v) || is_undefined(series.v) || is_null(n.v) || is_undefined(n.v) {
        w.nil();
        w.nil();
    } else {
        w.str(&js_string(ctx, series.v)?);
        w.int(int_of(ctx, n.v)?);
    }
    w.raw(&bytes_of(ctx, data.v)?);
    Some(w.into_vec())
}

/// The JS value of bytes stored or delivered under a type.  Fails with why the bytes do not fit
/// the type; a walk that fails for the heap leaves its exception pending as well.
pub fn decode(
    ctx: *mut JSContext,
    sc: &Schema,
    ty: &[u8],
    bytes: &[u8],
) -> Result<JSValue, String> {
    match ty {
        b".json" => {
            let node = mp::parse_whole(bytes).map_err(|e| e.to_string())?;
            mpjs::decode(ctx, &node)
        }
        b".mutation" => mutation_js(ctx, bytes),
        b".edits" => Ok(envelope_js(ctx, &edits::envelope(bytes)?.0)),
        b".page" => Err("a snapshot page is never converted".into()),
        _ => {
            let t =
                sc.lookup(ty).ok_or_else(|| format!("no registry entry for type {}", lossy(ty)))?;
            let node = mp::parse_whole(bytes).map_err(|e| e.to_string())?;
            walk::to_js(ctx, sc, &node, t, Some(t) == sc.mutations())
        }
    }
}

/// A JS value as msgpack under a type, or why it does not fit the type.
pub fn encode(ctx: *mut JSContext, sc: &Schema, ty: &[u8], v: JSValue) -> Result<Vec<u8>, String> {
    match ty {
        b".json" => {
            let env = unsafe { state(ctx) }.env.get().ok_or("no js environment")?;
            let mut w = mp::Writer::new();
            mpjs::encode(env, v, &mut w, 0)?;
            Ok(w.into_vec())
        }
        b".mutation" => mutation_bytes(ctx, v).ok_or_else(|| "malformed outbox row".to_string()),
        b".edits" => Err(".edits converts from msgpack only".into()),
        b".page" => Err("a snapshot page is never converted".into()),
        _ => {
            let t =
                sc.lookup(ty).ok_or_else(|| format!("no registry entry for type {}", lossy(ty)))?;
            let env = unsafe { state(ctx) }.env.get().ok_or("no js environment")?;
            let mut out = Vec::new();
            walk::js_to_mpack(env, sc, v, t, Some(t) == sc.mutations(), &mut out)?;
            Ok(out)
        }
    }
}

pub fn lossy(b: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(b)
}

// throws why a conversion failed, unless the walk already left an exception
fn fail(ctx: *mut JSContext, msg: &str) -> JSValue {
    if unsafe { JS_HasException(ctx) } != 0 {
        return JS_EXCEPTION;
    }
    throw_error(ctx, msg)
}

/// the schema of a registry id
pub fn schema_of(ctx: *mut JSContext, v: JSValue) -> Option<Arc<Schema>> {
    let id = int_of(ctx, v)?;
    let schemas = unsafe { state(ctx) }.schemas.borrow();
    match schemas.get(id as usize) {
        Some(s) => Some(s.clone()),
        None => {
            throw_type(ctx, &format!("no registry {id}"));
            None
        }
    }
}

// pl.registry(schema): the id of the registry compiled from a generated Schema
pub unsafe extern "C" fn native_registry(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { std::slice::from_raw_parts(argv, 1) };
    let st = unsafe { state(ctx) };
    let Some(env) = st.env.get() else { return throw_error(ctx, "no js environment") };
    let mut tb = TokBuf::default();
    let compiled = walk::tokenize(env, a[0], &mut tb).and_then(|_| Schema::compile(&tb));
    match compiled {
        Err(e) => fail(ctx, &format!("schema: {e}")),
        Ok(sc) => {
            let mut schemas = st.schemas.borrow_mut();
            schemas.push(Arc::new(sc));
            JS_NewInt64(schemas.len() as i64 - 1)
        }
    }
}

// pl.convert(registry, type, value, from, to): the Registry's convert
pub unsafe extern "C" fn native_convert(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { std::slice::from_raw_parts(argv, 5) };
    let Some(sc) = schema_of(ctx, a[0]) else { return JS_EXCEPTION };
    let Some(ty) = js_string(ctx, a[1]) else { return JS_EXCEPTION };
    let (Some(from), Some(to)) = (int_of(ctx, a[3]), int_of(ctx, a[4])) else {
        return JS_EXCEPTION;
    };
    if from == to {
        return unsafe { JS_DupValue(a[2]) };
    }
    if ty == b".page" {
        return throw_error(ctx, "a snapshot page is never converted");
    }
    match (from, to) {
        (MSGPACK, JS) => {
            let Some(bytes) = bytes_of(ctx, a[2]) else { return JS_EXCEPTION };
            decode(ctx, &sc, &ty, &bytes).unwrap_or_else(|e| fail(ctx, &e))
        }
        (JS, MSGPACK) => match encode(ctx, &sc, &ty, a[2]) {
            Ok(b) => new_u8(ctx, &b),
            Err(e) => fail(ctx, &e),
        },
        _ => throw_error(ctx, &format!("no conversion of {} from {from} to {to}", lossy(&ty))),
    }
}

// pl.ops(bytes, edit): the operations of a raw edit or a page, each [key, value bytes or
// undefined]
pub unsafe extern "C" fn native_ops(
    ctx: *mut JSContext,
    _: JSValue,
    _: c_int,
    argv: *mut JSValue,
) -> JSValue {
    let a = unsafe { std::slice::from_raw_parts(argv, 2) };
    let Some(bytes) = bytes_of(ctx, a[0]) else { return JS_EXCEPTION };
    let edit = unsafe { JS_ToBool(ctx, a[1]) } == 1;
    match edits::ops(&bytes, edit) {
        Err(e) => throw_error(ctx, &e),
        Ok(ops) => {
            let items = ops
                .into_iter()
                .map(|(k, v)| {
                    let val = v.map(|v| new_u8(ctx, v)).unwrap_or(JS_UNDEFINED);
                    new_array(ctx, vec![new_string(ctx, k), val])
                })
                .collect();
            new_array(ctx, items)
        }
    }
}
