//! Msgpack <-> plain JS values, for untyped traffic such as the database's `lookup`.  Values are
//! the JSON projection: maps with string keys, arrays, strings, integers, floats, booleans, nil.
//! bin decodes to an ArrayBuffer, and an ArrayBuffer encodes to bin.

use super::ffi::*;
use crate::mp::{self, Node};
use crate::walk::js_string;

pub fn decode(ctx: *mut JSContext, node: &Node<'_>) -> Result<JSValue, String> {
    unsafe {
        Ok(match node {
            Node::Nil => JS_NULL,
            Node::Bool(b) => JS_NewBool(*b),
            Node::Int(i) => JS_NewInt64(*i),
            Node::Uint(u) => {
                if *u > i64::MAX as u64 {
                    JS_NewFloat64(*u as f64)
                } else {
                    JS_NewInt64(*u as i64)
                }
            }
            Node::F32(f) => JS_NewFloat64(*f as f64),
            Node::F64(f) => JS_NewFloat64(*f),
            Node::Str(s) => JS_NewStringLen(ctx, s.as_ptr() as *const _, s.len()),
            Node::Bin(b) => JS_NewArrayBufferCopy(ctx, b.as_ptr(), b.len()),
            Node::Array(items) => {
                let arr = JS_NewArray(ctx);
                for (i, item) in items.iter().enumerate() {
                    match decode(ctx, item) {
                        Ok(v) => {
                            JS_DefinePropertyValueUint32(ctx, arr, i as u32, v, JS_PROP_C_W_E);
                        }
                        Err(e) => {
                            JS_FreeValue(ctx, arr);
                            return Err(e);
                        }
                    }
                }
                arr
            }
            Node::Map(entries) => {
                let obj = JS_NewObject(ctx);
                for (k, v) in entries {
                    let Some(k) = k.as_str() else {
                        JS_FreeValue(ctx, obj);
                        return Err("msgpack map key is not a string".into());
                    };
                    let v = match decode(ctx, v) {
                        Ok(v) => v,
                        Err(e) => {
                            JS_FreeValue(ctx, obj);
                            return Err(e);
                        }
                    };
                    let atom = JS_NewAtomLen(ctx, k.as_ptr() as *const _, k.len());
                    JS_DefinePropertyValue(ctx, obj, atom, v, JS_PROP_C_W_E);
                    JS_FreeAtom(ctx, atom);
                }
                obj
            }
            Node::Ext(..) => return Err("unsupported msgpack type".into()),
        })
    }
}

pub fn encode(
    ctx: *mut JSContext,
    v: JSValue,
    w: &mut mp::Writer,
    depth: usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("value nested too deeply".into());
    }
    unsafe {
        match tag(v) {
            JS_TAG_NULL | JS_TAG_UNDEFINED => w.nil(),
            JS_TAG_BOOL => w.bool(int_of(v) != 0),
            JS_TAG_INT => w.int(int_of(v) as i64),
            JS_TAG_FLOAT64 => {
                let d = float64_of(v);
                if d.is_finite() && d == d.floor() && d.abs() < 9007199254740992.0 {
                    w.int(d as i64);
                } else {
                    w.double(d);
                }
            }
            JS_TAG_STRING | JS_TAG_STRING_ROPE => {
                let s = js_string(ctx, v).ok_or("reading a string")?;
                w.str(&s);
            }
            JS_TAG_OBJECT => {
                if JS_IsArray(ctx, v) == 1 {
                    let lenv = JS_GetPropertyStr(ctx, v, c"length".as_ptr());
                    let mut n = 0i64;
                    let rc = JS_ToInt64(ctx, &mut n, lenv);
                    JS_FreeValue(ctx, lenv);
                    if rc != 0 {
                        return Err("reading an array's length".into());
                    }
                    w.array(n as usize);
                    for i in 0..n {
                        let item = JS_GetPropertyUint32(ctx, v, i as u32);
                        if is_exception(item) {
                            return Err("reading an array element".into());
                        }
                        let r = encode(ctx, item, w, depth + 1);
                        JS_FreeValue(ctx, item);
                        r?;
                    }
                    return Ok(());
                }
                let mut size = 0usize;
                let bytes = JS_GetArrayBuffer(ctx, &mut size, v);
                if !bytes.is_null() {
                    w.bin(std::slice::from_raw_parts(bytes, size));
                    return Ok(());
                }
                JS_FreeValue(ctx, JS_GetException(ctx)); // not an ArrayBuffer
                encode_object(ctx, v, w, depth)?;
            }
            _ => return Err("value not encodable".into()),
        }
    }
    Ok(())
}

unsafe fn encode_object(
    ctx: *mut JSContext,
    v: JSValue,
    w: &mut mp::Writer,
    depth: usize,
) -> Result<(), String> {
    unsafe {
        let mut tab: *mut JSPropertyEnum = std::ptr::null_mut();
        let mut n = 0u32;
        if JS_GetOwnPropertyNames(ctx, &mut tab, &mut n, v, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)
            != 0
        {
            return Err("listing object keys".into());
        }

        // undefined values are skipped, so the entries are read before the map's count is known
        let mut vals = Vec::with_capacity(n as usize);
        let mut out = Ok(());
        for i in 0..n as usize {
            let atom = (*tab.add(i)).atom;
            let val = JS_GetProperty(ctx, v, atom);
            if is_exception(val) {
                out = Err("reading an object property".to_string());
                break;
            }
            vals.push((atom, val));
        }
        if out.is_ok() {
            w.map(vals.iter().filter(|(_, val)| !is_undefined(*val)).count());
            for &(atom, val) in &vals {
                if is_undefined(val) {
                    continue;
                }
                let mut klen = 0usize;
                let k = JS_AtomToCStringLen(ctx, &mut klen, atom);
                if k.is_null() {
                    out = Err("reading an object key".into());
                    break;
                }
                w.str(std::slice::from_raw_parts(k as *const u8, klen));
                JS_FreeCString(ctx, k);
                out = encode(ctx, val, w, depth + 1);
                if out.is_err() {
                    break;
                }
            }
        }
        for (_, val) in vals {
            JS_FreeValue(ctx, val);
        }
        JS_FreePropertyEnum(ctx, tab, n);
        out
    }
}
