//! phaselock-jni: the native host's binding for the Kotlin client, three functions of
//! `io.phaselock.client.Native` that move the bytes of phaselock-native's request protocol
//! (`phaselock_native::api`) between Java byte arrays and the host.

use jni_sys::{JNIEnv, jbyteArray, jclass, jlong};
use phaselock_native::api;
use phaselock_native::host::Host;

// the bytes of a Java byte array
unsafe fn read(env: *mut JNIEnv, arr: jbyteArray) -> Vec<u8> {
    unsafe {
        let f = &(**env).v1_1;
        let n = (f.GetArrayLength)(env, arr).max(0) as usize;
        let mut buf = vec![0u8; n];
        (f.GetByteArrayRegion)(env, arr, 0, n as i32, buf.as_mut_ptr().cast());
        buf
    }
}

// a new Java byte array holding bytes
unsafe fn write(env: *mut JNIEnv, bytes: &[u8]) -> jbyteArray {
    unsafe {
        let f = &(**env).v1_1;
        let arr = (f.NewByteArray)(env, bytes.len() as i32);
        if !arr.is_null() {
            (f.SetByteArrayRegion)(env, arr, 0, bytes.len() as i32, bytes.as_ptr().cast());
        }
        arr
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_phaselock_client_Native_open(
    env: *mut JNIEnv,
    _: jclass,
    bundle: jbyteArray,
    name: jbyteArray,
    limits: jbyteArray,
) -> jbyteArray {
    unsafe {
        let bundle = read(env, bundle);
        let name = String::from_utf8_lossy(&read(env, name)).into_owned();
        let limits = read(env, limits);
        let answer = api::open(&bundle, &name, &limits, |h| Box::into_raw(Box::new(h)) as jlong);
        write(env, &answer)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_phaselock_client_Native_call(
    env: *mut JNIEnv,
    _: jclass,
    host: jlong,
    request: jbyteArray,
) -> jbyteArray {
    unsafe {
        let h = &*(host as *const Host);
        let request = read(env, request);
        write(env, &api::respond(h, &request))
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_io_phaselock_client_Native_close(
    _: *mut JNIEnv,
    _: jclass,
    host: jlong,
) {
    if host != 0 {
        drop(unsafe { Box::from_raw(host as *mut Host) });
    }
}
