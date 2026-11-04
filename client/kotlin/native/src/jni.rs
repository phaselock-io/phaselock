//! The JNI surface: three functions of `io.phaselock.client.Native`, every argument and answer a
//! byte array of msgpack, so no Java string crosses JNI (whose modified UTF-8 would change a
//! key's bytes) and the surface stays one function per lifetime step.
//!
//! - `open(bundle, name)` loads the native bundle, answering `["ok", host]`;
//! - `call(host, request)` runs one request, `[op, ...args]`, answering `["ok", delay, events]`,
//!   delay being the milliseconds until the next timer is due, or nil for none;
//! - `close(host)` frees the host.
//!
//! A request that fails answers `["error", message]`.  A host is used only from the thread that
//! opened it.

use jni_sys::{JNIEnv, jbyteArray, jclass, jlong};
use phaselock_core::mp::{self, Node};

use crate::host::{Host, Push};

type Result<T> = std::result::Result<T, String>;

// the request's arguments, each read by type and position
struct Args<'a> {
    op: &'a [u8],
    items: &'a [Node<'a>],
}

impl<'a> Args<'a> {
    fn get(&self, i: usize) -> Result<&'a Node<'a>> {
        self.items.get(i + 1).ok_or_else(|| format!("{}: missing argument {i}", self.name()))
    }

    fn name(&self) -> String {
        String::from_utf8_lossy(self.op).into_owned()
    }

    fn int(&self, i: usize) -> Result<i64> {
        self.get(i)?.as_i64().ok_or_else(|| format!("{}: argument {i} is no integer", self.name()))
    }

    fn opt_int(&self, i: usize) -> Result<Option<i64>> {
        if self.get(i)?.is_nil() { Ok(None) } else { self.int(i).map(Some) }
    }

    fn str(&self, i: usize) -> Result<&'a str> {
        let s = self
            .get(i)?
            .as_str()
            .ok_or_else(|| format!("{}: argument {i} is no string", self.name()))?;
        std::str::from_utf8(s).map_err(|_| format!("{}: argument {i} is not UTF-8", self.name()))
    }

    fn opt_str(&self, i: usize) -> Result<Option<&'a str>> {
        if self.get(i)?.is_nil() { Ok(None) } else { self.str(i).map(Some) }
    }

    fn bin(&self, i: usize) -> Result<&'a [u8]> {
        match self.get(i)? {
            Node::Bin(b) => Ok(b),
            _ => Err(format!("{}: argument {i} is no bin", self.name())),
        }
    }

    fn opt_bin(&self, i: usize) -> Result<Option<&'a [u8]>> {
        if self.get(i)?.is_nil() { Ok(None) } else { self.bin(i).map(Some) }
    }

    fn strings(&self, i: usize) -> Result<Vec<String>> {
        let a = self
            .get(i)?
            .array()
            .ok_or_else(|| format!("{}: argument {i} is no array", self.name()))?;
        a.iter()
            .map(|s| {
                s.as_str()
                    .and_then(|s| std::str::from_utf8(s).ok())
                    .map(str::to_string)
                    .ok_or_else(|| format!("{}: argument {i} holds a non-string", self.name()))
            })
            .collect()
    }
}

/// Runs one request against the host, answering its events.
pub fn call(h: &Host, request: &[u8]) -> Result<Vec<u8>> {
    let node = mp::parse_whole(request).map_err(|e| format!("request: {e}"))?;
    let items = node.array().ok_or("request: not an array")?;
    let op = items.first().and_then(Node::as_str).ok_or("request: no op")?;
    let a = Args { op, items };
    match op {
        b"pump" => h.pump(),
        b"createEngine" => h.create_engine(a.int(0)?, a.str(1)?, a.opt_int(2)?, a.opt_str(3)?),
        b"closeEngine" => h.close_engine(a.int(0)?),
        b"reconnectNow" => h.reconnect_now(a.int(0)?),
        b"sendMutation" => h.send_mutation(a.int(0)?, a.bin(1)?),
        b"sendOnlineMutation" => h.send_online_mutation(a.int(0)?, a.int(1)?, a.bin(2)?),
        b"query" => h.query(a.int(0)?, a.int(1)?, a.bin(2)?),
        b"statusQuery" => h.status_query(a.int(0)?, a.int(1)?),
        b"closeQuery" => h.close_query(a.int(0)?),
        b"connOpen" => h.conn_open(a.int(0)?, a.str(1)?, a.int(2)?),
        b"connView" => h.conn_view(a.int(0)?, a.str(1)?, a.int(2)?, &a.strings(3)?),
        b"connEdits" => h.conn_edits(a.int(0)?, a.bin(1)?),
        b"connLive" => h.conn_live(a.int(0)?, a.int(1)?),
        b"connVouch" => h.conn_vouch(a.int(0)?, a.int(1)?),
        b"connEnd" => h.conn_end(a.int(0)?, a.int(1)?, a.str(2)?, a.opt_str(3)?),
        b"push" => {
            let item = match a.str(2)? {
                "length" => Push::Length(a.int(3)?),
                "header" => {
                    Push::Header { position: a.int(3)?, seqs: a.bin(4)?, visible: a.int(5)? }
                }
                "page" => Push::Page { page: a.bin(3)?, skip: a.int(4)?, checksum: a.str(5)? },
                "pagesDone" => Push::PagesDone,
                "edits" => Push::Edits { edits: a.bin(3)?, scanned: a.int(4)? },
                "editsDone" => Push::EditsDone,
                other => return Err(format!("push: unknown item {other}")),
            };
            h.push(a.int(0)?, a.int(1)?, item)
        }
        b"backfillSettled" => h.backfill_settled(a.int(0)?, a.opt_str(1)?, a.opt_str(2)?),
        b"sendSettled" => h.send_settled(a.int(0)?, a.opt_bin(1)?, a.opt_str(2)?),
        _ => Err(format!("unknown request {}", a.name())),
    }
}

// an answer: ok and the events a call returned, or the error
fn answer(r: Result<Vec<u8>>) -> Vec<u8> {
    let mut w = mp::Writer::new();
    match r {
        Ok(events) => {
            // the host answers [delay, events] under a one-byte header, whose two elements follow
            // "ok" as they are
            w.array(3);
            w.str(b"ok");
            w.raw(&events[1..]);
        }
        Err(e) => {
            w.array(2);
            w.str(b"error");
            w.str(e.as_bytes());
        }
    }
    w.into_vec()
}

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
) -> jbyteArray {
    unsafe {
        let bundle = read(env, bundle);
        let name = String::from_utf8_lossy(&read(env, name)).into_owned();
        let mut w = mp::Writer::new();
        match Host::open(&bundle, &name) {
            Ok(h) => {
                w.array(2);
                w.str(b"ok");
                w.int(Box::into_raw(Box::new(h)) as jlong);
            }
            Err(e) => {
                w.array(2);
                w.str(b"error");
                w.str(e.as_bytes());
            }
        }
        write(env, &w.buf)
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
        write(env, &answer(call(h, &request)))
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
