//! The C API of upstream QuickJS that the host uses, declared by hand from quickjs.h, and the
//! header's inline functions written out over the 64-bit JSValue: a 64-bit payload and a 64-bit
//! tag, passed by value as two integer words.

#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::os::raw::{c_char, c_double, c_int, c_void};

pub enum JSRuntime {}
pub enum JSContext {}

pub type JSAtom = u32;
pub type JSClassID = u32;
pub type JS_BOOL = c_int;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct JSValue {
    pub u: u64,
    pub tag: i64,
}

#[repr(C)]
pub struct JSPropertyEnum {
    pub is_enumerable: JS_BOOL,
    pub atom: JSAtom,
}

pub type JSCFunction =
    unsafe extern "C" fn(*mut JSContext, JSValue, c_int, *mut JSValue) -> JSValue;
pub type JSInterruptHandler = unsafe extern "C" fn(*mut JSRuntime, *mut c_void) -> c_int;

pub const JS_TAG_FIRST: i32 = -9;
pub const JS_TAG_BIG_INT: i32 = -9;
pub const JS_TAG_SYMBOL: i32 = -8;
pub const JS_TAG_STRING: i32 = -7;
pub const JS_TAG_STRING_ROPE: i32 = -6;
pub const JS_TAG_OBJECT: i32 = -1;
pub const JS_TAG_INT: i32 = 0;
pub const JS_TAG_BOOL: i32 = 1;
pub const JS_TAG_NULL: i32 = 2;
pub const JS_TAG_UNDEFINED: i32 = 3;
pub const JS_TAG_UNINITIALIZED: i32 = 4;
pub const JS_TAG_EXCEPTION: i32 = 6;
pub const JS_TAG_SHORT_BIG_INT: i32 = 7;
pub const JS_TAG_FLOAT64: i32 = 8;

pub const JS_PROP_CONFIGURABLE: c_int = 1 << 0;
pub const JS_PROP_WRITABLE: c_int = 1 << 1;
pub const JS_PROP_ENUMERABLE: c_int = 1 << 2;
pub const JS_PROP_C_W_E: c_int = JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE | JS_PROP_ENUMERABLE;
pub const JS_PROP_THROW: c_int = 1 << 14;

pub const JS_GPN_STRING_MASK: c_int = 1 << 0;
pub const JS_GPN_ENUM_ONLY: c_int = 1 << 4;

pub const JS_EVAL_TYPE_GLOBAL: c_int = 0;
pub const JS_CFUNC_GENERIC: c_int = 0;
pub const JS_ATOM_NULL: JSAtom = 0;

unsafe extern "C" {
    pub fn JS_NewRuntime() -> *mut JSRuntime;
    pub fn JS_FreeRuntime(rt: *mut JSRuntime);
    pub fn JS_SetMemoryLimit(rt: *mut JSRuntime, limit: usize);
    pub fn JS_SetMaxStackSize(rt: *mut JSRuntime, stack_size: usize);
    pub fn JS_UpdateStackTop(rt: *mut JSRuntime);
    pub fn JS_SetInterruptHandler(
        rt: *mut JSRuntime,
        cb: Option<JSInterruptHandler>,
        opaque: *mut c_void,
    );
    pub fn JS_NewContext(rt: *mut JSRuntime) -> *mut JSContext;
    pub fn JS_FreeContext(ctx: *mut JSContext);
    pub fn JS_SetContextOpaque(ctx: *mut JSContext, opaque: *mut c_void);
    pub fn JS_GetContextOpaque(ctx: *mut JSContext) -> *mut c_void;

    pub fn __JS_FreeValue(ctx: *mut JSContext, v: JSValue);

    pub fn JS_GetGlobalObject(ctx: *mut JSContext) -> JSValue;
    pub fn JS_NewObject(ctx: *mut JSContext) -> JSValue;
    pub fn JS_NewArray(ctx: *mut JSContext) -> JSValue;
    pub fn JS_NewStringLen(ctx: *mut JSContext, s: *const c_char, len: usize) -> JSValue;
    pub fn JS_NewDate(ctx: *mut JSContext, epoch_ms: c_double) -> JSValue;
    pub fn JS_NewError(ctx: *mut JSContext) -> JSValue;
    pub fn JS_NewArrayBufferCopy(ctx: *mut JSContext, buf: *const u8, len: usize) -> JSValue;
    pub fn JS_GetArrayBuffer(ctx: *mut JSContext, psize: *mut usize, obj: JSValue) -> *mut u8;
    pub fn JS_NewCFunction2(
        ctx: *mut JSContext,
        func: JSCFunction,
        name: *const c_char,
        length: c_int,
        cproto: c_int,
        magic: c_int,
    ) -> JSValue;

    pub fn JS_GetPropertyStr(ctx: *mut JSContext, obj: JSValue, prop: *const c_char) -> JSValue;
    pub fn JS_GetPropertyUint32(ctx: *mut JSContext, obj: JSValue, idx: u32) -> JSValue;
    pub fn JS_GetPropertyInternal(
        ctx: *mut JSContext,
        obj: JSValue,
        prop: JSAtom,
        receiver: JSValue,
        throw_ref_error: JS_BOOL,
    ) -> JSValue;
    pub fn JS_SetPropertyStr(
        ctx: *mut JSContext,
        obj: JSValue,
        prop: *const c_char,
        val: JSValue,
    ) -> c_int;
    pub fn JS_DefinePropertyValue(
        ctx: *mut JSContext,
        obj: JSValue,
        prop: JSAtom,
        val: JSValue,
        flags: c_int,
    ) -> c_int;
    pub fn JS_DefinePropertyValueUint32(
        ctx: *mut JSContext,
        obj: JSValue,
        idx: u32,
        val: JSValue,
        flags: c_int,
    ) -> c_int;
    pub fn JS_HasProperty(ctx: *mut JSContext, obj: JSValue, prop: JSAtom) -> c_int;
    pub fn JS_GetOwnPropertyNames(
        ctx: *mut JSContext,
        ptab: *mut *mut JSPropertyEnum,
        plen: *mut u32,
        obj: JSValue,
        flags: c_int,
    ) -> c_int;
    pub fn JS_FreePropertyEnum(ctx: *mut JSContext, tab: *mut JSPropertyEnum, len: u32);

    pub fn JS_NewAtomLen(ctx: *mut JSContext, s: *const c_char, len: usize) -> JSAtom;
    pub fn JS_FreeAtom(ctx: *mut JSContext, atom: JSAtom);
    pub fn JS_AtomToCStringLen(
        ctx: *mut JSContext,
        plen: *mut usize,
        atom: JSAtom,
    ) -> *const c_char;

    pub fn JS_Call(
        ctx: *mut JSContext,
        func: JSValue,
        this: JSValue,
        argc: c_int,
        argv: *const JSValue,
    ) -> JSValue;
    pub fn JS_Eval(
        ctx: *mut JSContext,
        input: *const c_char,
        len: usize,
        filename: *const c_char,
        flags: c_int,
    ) -> JSValue;
    pub fn JS_ParseJSON(
        ctx: *mut JSContext,
        buf: *const c_char,
        len: usize,
        filename: *const c_char,
    ) -> JSValue;

    pub fn JS_JSONStringify(
        ctx: *mut JSContext,
        obj: JSValue,
        replacer: JSValue,
        space: JSValue,
    ) -> JSValue;
    pub fn JS_Throw(ctx: *mut JSContext, obj: JSValue) -> JSValue;
    pub fn JS_GetException(ctx: *mut JSContext) -> JSValue;
    pub fn JS_HasException(ctx: *mut JSContext) -> JS_BOOL;
    pub fn JS_IsError(ctx: *mut JSContext, v: JSValue) -> JS_BOOL;
    pub fn JS_ThrowTypeError(ctx: *mut JSContext, fmt: *const c_char, ...) -> JSValue;
    pub fn JS_ThrowRangeError(ctx: *mut JSContext, fmt: *const c_char, ...) -> JSValue;
    pub fn JS_ThrowInternalError(ctx: *mut JSContext, fmt: *const c_char, ...) -> JSValue;

    pub fn JS_ToCStringLen2(
        ctx: *mut JSContext,
        plen: *mut usize,
        v: JSValue,
        cesu8: JS_BOOL,
    ) -> *const c_char;
    pub fn JS_FreeCString(ctx: *mut JSContext, s: *const c_char);
    pub fn JS_ToBool(ctx: *mut JSContext, v: JSValue) -> c_int;
    pub fn JS_ToInt32(ctx: *mut JSContext, pres: *mut i32, v: JSValue) -> c_int;
    pub fn JS_ToInt64(ctx: *mut JSContext, pres: *mut i64, v: JSValue) -> c_int;
    pub fn JS_ToInt64Ext(ctx: *mut JSContext, pres: *mut i64, v: JSValue) -> c_int;
    pub fn JS_ToFloat64(ctx: *mut JSContext, pres: *mut f64, v: JSValue) -> c_int;
    pub fn JS_IsFunction(ctx: *mut JSContext, v: JSValue) -> JS_BOOL;
    pub fn JS_IsArray(ctx: *mut JSContext, v: JSValue) -> c_int;
    pub fn JS_GetClassID(v: JSValue) -> JSClassID;
}

// the header's inline functions and macros

pub const fn mkval(tag: i32, val: i32) -> JSValue {
    JSValue { u: val as u32 as u64, tag: tag as i64 }
}

pub const JS_NULL: JSValue = mkval(JS_TAG_NULL, 0);
pub const JS_UNDEFINED: JSValue = mkval(JS_TAG_UNDEFINED, 0);
pub const JS_FALSE: JSValue = mkval(JS_TAG_BOOL, 0);
pub const JS_TRUE: JSValue = mkval(JS_TAG_BOOL, 1);
pub const JS_EXCEPTION: JSValue = mkval(JS_TAG_EXCEPTION, 0);

#[inline]
pub fn tag(v: JSValue) -> i32 {
    v.tag as i32
}

#[inline]
pub fn has_ref_count(v: JSValue) -> bool {
    (tag(v) as u32) >= (JS_TAG_FIRST as u32)
}

/// Releases a reference: the header's JS_FreeValue, whose count sits in the 32 bits before the
/// value's pointer.
#[inline]
pub unsafe fn JS_FreeValue(ctx: *mut JSContext, v: JSValue) {
    if has_ref_count(v) {
        unsafe {
            let rc = (v.u as *mut i32).sub(1);
            *rc -= 1;
            if *rc <= 0 {
                __JS_FreeValue(ctx, v);
            }
        }
    }
}

#[inline]
pub unsafe fn JS_DupValue(v: JSValue) -> JSValue {
    if has_ref_count(v) {
        unsafe {
            let rc = (v.u as *mut i32).sub(1);
            *rc += 1;
        }
    }
    v
}

#[inline]
pub fn JS_NewBool(b: bool) -> JSValue {
    mkval(JS_TAG_BOOL, b as i32)
}

#[inline]
pub fn JS_NewInt32(i: i32) -> JSValue {
    mkval(JS_TAG_INT, i)
}

#[inline]
pub fn new_float64_raw(d: f64) -> JSValue {
    JSValue { u: d.to_bits(), tag: JS_TAG_FLOAT64 as i64 }
}

#[inline]
pub fn JS_NewInt64(i: i64) -> JSValue {
    if i == i as i32 as i64 { JS_NewInt32(i as i32) } else { new_float64_raw(i as f64) }
}

#[inline]
pub fn JS_NewFloat64(d: f64) -> JSValue {
    if d >= i32::MIN as f64 && d <= i32::MAX as f64 {
        let i = d as i32;
        if (i as f64).to_bits() == d.to_bits() {
            return JS_NewInt32(i);
        }
    }
    new_float64_raw(d)
}

#[inline]
pub fn float64_of(v: JSValue) -> f64 {
    f64::from_bits(v.u)
}

#[inline]
pub fn int_of(v: JSValue) -> i32 {
    v.u as i32
}

#[inline]
pub fn is_exception(v: JSValue) -> bool {
    tag(v) == JS_TAG_EXCEPTION
}
#[inline]
pub fn is_null(v: JSValue) -> bool {
    tag(v) == JS_TAG_NULL
}
#[inline]
pub fn is_undefined(v: JSValue) -> bool {
    tag(v) == JS_TAG_UNDEFINED
}
#[inline]
pub fn is_bool(v: JSValue) -> bool {
    tag(v) == JS_TAG_BOOL
}
#[inline]
pub fn is_string(v: JSValue) -> bool {
    tag(v) == JS_TAG_STRING || tag(v) == JS_TAG_STRING_ROPE
}
#[inline]
pub fn is_object(v: JSValue) -> bool {
    tag(v) == JS_TAG_OBJECT
}
#[inline]
pub fn is_uninitialized(v: JSValue) -> bool {
    tag(v) == JS_TAG_UNINITIALIZED
}

#[inline]
pub unsafe fn JS_GetProperty(ctx: *mut JSContext, obj: JSValue, prop: JSAtom) -> JSValue {
    unsafe { JS_GetPropertyInternal(ctx, obj, prop, obj, 0) }
}
