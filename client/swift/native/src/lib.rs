//! phaselock-swift: the native host's binding for the Swift client, a C ABI of three functions
//! (include/phaselock.h) that move the bytes of phaselock-native's request protocol
//! (`phaselock_native::api`) between the caller's buffers and the host.  Every answer is a buffer
//! the caller frees with `pl_free`.

use std::slice;

use phaselock_native::api;
use phaselock_native::host::Host;

/// An answer's bytes, owned by Rust until `pl_free` takes them back.
#[repr(C)]
pub struct PlBytes {
    pub ptr: *mut u8,
    pub len: usize,
}

// bytes the caller passed, which may be empty with a null pointer
unsafe fn borrow<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { slice::from_raw_parts(ptr, len) } }
}

// an answer handed to the caller
fn give(bytes: Vec<u8>) -> PlBytes {
    let mut b = bytes.into_boxed_slice();
    let out = PlBytes { ptr: b.as_mut_ptr(), len: b.len() };
    std::mem::forget(b);
    out
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_open(
    bundle: *const u8,
    bundle_len: usize,
    name: *const u8,
    name_len: usize,
    limits: *const u8,
    limits_len: usize,
) -> PlBytes {
    unsafe {
        let name = String::from_utf8_lossy(borrow(name, name_len)).into_owned();
        give(api::open(borrow(bundle, bundle_len), &name, borrow(limits, limits_len), |h| {
            Box::into_raw(Box::new(h)) as i64
        }))
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_call(host: i64, request: *const u8, request_len: usize) -> PlBytes {
    unsafe {
        let h = &*(host as *const Host);
        give(api::respond(h, borrow(request, request_len)))
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_close(host: i64) {
    if host != 0 {
        drop(unsafe { Box::from_raw(host as *mut Host) });
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pl_free(bytes: PlBytes) {
    if !bytes.ptr.is_null() {
        drop(unsafe { Box::from_raw(slice::from_raw_parts_mut(bytes.ptr, bytes.len)) });
    }
}
