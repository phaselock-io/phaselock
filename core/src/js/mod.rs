//! QuickJS: its C API (ffi.rs), untyped msgpack <-> JS (mpjs.rs), and the helpers every host
//! handles values and throws errors with.

pub mod ffi;
pub mod mpjs;

use std::ffi::{CString, c_int};

use self::ffi::*;
use crate::walk::js_string;

/// A JS value this code owns a reference to, released when it drops.
pub struct Owned {
    ctx: *mut JSContext,
    pub v: JSValue,
}

impl Owned {
    pub fn new(ctx: *mut JSContext, v: JSValue) -> Owned {
        Owned { ctx, v }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe { JS_FreeValue(self.ctx, self.v) }
    }
}

/// a JS value's text, as the string it converts to; None with the exception pending
pub fn text_of(ctx: *mut JSContext, v: JSValue) -> Option<Vec<u8>> {
    js_string(ctx, v)
}

/// a C string of s, each U+0000 in it written as `\0`
pub fn cstring(s: &str) -> CString {
    CString::new(s.replace('\0', "\\0")).unwrap()
}

pub fn throw_type(ctx: *mut JSContext, msg: &str) -> JSValue {
    let m = cstring(msg);
    unsafe { JS_ThrowTypeError(ctx, c"%s".as_ptr(), m.as_ptr()) }
}

pub fn throw_range(ctx: *mut JSContext, msg: &str) -> JSValue {
    let m = cstring(msg);
    unsafe { JS_ThrowRangeError(ctx, c"%s".as_ptr(), m.as_ptr()) }
}

pub fn throw_internal(ctx: *mut JSContext, msg: &str) -> JSValue {
    let m = cstring(msg);
    unsafe { JS_ThrowInternalError(ctx, c"%s".as_ptr(), m.as_ptr()) }
}

/// throws a plain Error, as the skeleton's own checks do
pub fn throw_error(ctx: *mut JSContext, msg: &str) -> JSValue {
    unsafe {
        let e = JS_NewError(ctx);
        JS_SetPropertyStr(
            ctx,
            e,
            c"message".as_ptr(),
            JS_NewStringLen(ctx, msg.as_ptr() as *const _, msg.len()),
        );
        JS_Throw(ctx, e)
    }
}

/// whether obj has the property name, as `name in obj` answers; -1 with an exception
pub fn has_prop(ctx: *mut JSContext, obj: JSValue, name: &str) -> c_int {
    unsafe {
        let atom = JS_NewAtomLen(ctx, name.as_ptr() as *const _, name.len());
        let has = JS_HasProperty(ctx, obj, atom);
        JS_FreeAtom(ctx, atom);
        has
    }
}

pub fn new_string(ctx: *mut JSContext, s: &[u8]) -> JSValue {
    unsafe { JS_NewStringLen(ctx, s.as_ptr() as *const _, s.len()) }
}
