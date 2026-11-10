//! The request protocol every binding serves: three calls, every argument and answer msgpack
//! bytes, so no platform string ever crosses (JNI's modified UTF-8, for one, would change a key's
//! bytes) and a binding stays one function per lifetime step.
//!
//! - `open(bundle, name, limits)` loads the native bundle under `[stack, memory, callMillis]`,
//!   the JS stack and heap in bytes and each call's deadline, answering `["ok", host]`, the host
//!   being the binding's handle for it;
//! - `call(host, request)` runs one request, `[op, ...args]`, answering `["ok", delay, events]`,
//!   delay being the milliseconds until the next timer is due, or nil for none.  The request
//!   `["connHooks", hooks]` carries every connection hook the client has queued, each
//!   `[op, connection, ...args]`, so that the frames among them commit together, and the request
//!   `["queries", requests]` starts and closes queries, each `["query", id, engine, call]`,
//!   `["statusQuery", id, engine]`, or `["closeQuery", id]`, so that the queries started among
//!   them are answered together;
//! - `close(host)` frees the host.
//!
//! A request that fails answers `["error", message]`.  A call whose deadline passes while JS runs
//! ends the host: it answers `["ended", message]`, the message naming the limit and the
//! interrupted JS's backtrace, every store transaction is aborted, and every call after it
//! answers the same without running any JS.  A host is used only from the thread that opened it.

use phaselock_core::mp::{self, Node};

use std::time::Duration;

use crate::host::{Hook, Host, Limits, Push, QueryOp};

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

/// Opens a host, answering `["ok", handle]` with the handle `keep` makes of it, or
/// `["error", message]`.
pub fn open(bundle: &[u8], name: &str, limits: &[u8], keep: impl FnOnce(Host) -> i64) -> Vec<u8> {
    let mut w = mp::Writer::new();
    match self::limits(limits).and_then(|l| Host::open(bundle, name, l)) {
        Ok(h) => {
            w.array(2);
            w.str(b"ok");
            w.int(keep(h));
        }
        Err(e) => {
            w.array(2);
            w.str(b"error");
            w.str(e.as_bytes());
        }
    }
    w.into_vec()
}

/// Runs one request, answering as the protocol does.
pub fn respond(h: &Host, request: &[u8]) -> Vec<u8> {
    let r = call(h, request);
    answer(r, h.ended().is_some())
}

/// Runs one request against the host under the call deadline, answering its events.
pub fn call(h: &Host, request: &[u8]) -> Result<Vec<u8>> {
    h.timed(|| dispatch(h, request))
}

// one request, to the host method that serves it
fn dispatch(h: &Host, request: &[u8]) -> Result<Vec<u8>> {
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
        b"queries" => {
            // every request read before any is made, so a malformed one fails the batch whole
            let list = a.get(0)?.array().ok_or("queries: argument 0 is no array")?;
            h.queries(&list.iter().map(query_op).collect::<Result<Vec<_>>>()?)
        }
        b"connHooks" => {
            // every hook read before any is delivered, so a malformed one fails the request whole
            let list = a.get(0)?.array().ok_or("connHooks: argument 0 is no array")?;
            h.conn_hooks(&list.iter().map(hook).collect::<Result<Vec<_>>>()?)
        }
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

// one request of a queries batch, [op, id, ...args]
fn query_op<'a>(request: &'a Node<'a>) -> Result<QueryOp<'a>> {
    let items = request.array().ok_or("queries: a request is not an array")?;
    let op = items.first().and_then(Node::as_str).ok_or("queries: a request has no op")?;
    let a = Args { op, items };
    Ok(match op {
        b"query" => QueryOp::Query { id: a.int(0)?, engine: a.int(1)?, call: a.bin(2)? },
        b"statusQuery" => QueryOp::Status { id: a.int(0)?, engine: a.int(1)? },
        b"closeQuery" => QueryOp::Close { id: a.int(0)? },
        _ => return Err(format!("queries: unknown request {}", a.name())),
    })
}

// one hook of a connHooks request, [op, connection, ...args]
fn hook<'a>(request: &'a Node<'a>) -> Result<(i64, Hook<'a>)> {
    let items = request.array().ok_or("connHooks: a hook is not an array")?;
    let op = items.first().and_then(Node::as_str).ok_or("connHooks: a hook has no op")?;
    let a = Args { op, items };
    let hook = match op {
        b"connOpen" => Hook::Open { epoch: a.str(1)?, head: a.int(2)? },
        b"connView" => {
            Hook::View { token: a.str(1)?, position: a.int(2)?, selectors: a.strings(3)? }
        }
        b"connEdits" => Hook::Edits(a.bin(1)?),
        b"connLive" => Hook::Live(a.int(1)?),
        b"connVouch" => Hook::Vouch(a.int(1)?),
        b"connEnd" => Hook::End { code: a.int(1)?, reason: a.str(2)?, fatal: a.opt_str(3)? },
        _ => return Err(format!("connHooks: unknown hook {}", a.name())),
    };
    Ok((a.int(0)?, hook))
}

// the limits open takes, [stack, memory, callMillis]
fn limits(bytes: &[u8]) -> Result<Limits> {
    let node = mp::parse_whole(bytes).map_err(|e| format!("limits: {e}"))?;
    let items = node.array().ok_or("limits: not an array")?;
    let int = |i: usize| -> Result<u64> {
        items.get(i).and_then(Node::as_u64).ok_or_else(|| format!("limits: item {i} is no count"))
    };
    Ok(Limits {
        stack: int(0)? as usize,
        memory: int(1)? as usize,
        call: Duration::from_millis(int(2)?),
    })
}

// an answer: ok and the events a call returned, the error, or why the host ended
fn answer(r: Result<Vec<u8>>, ended: bool) -> Vec<u8> {
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
            w.str(if ended { b"ended" } else { b"error" });
            w.str(e.as_bytes());
        }
    }
    w.into_vec()
}
