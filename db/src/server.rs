//! The HTTP layer: connections, mutations, snapshots, edit reads, and the dispatcher that fans the
//! core's results out to connections.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::{Frame as BodyFrame, Incoming, SizeHint};
use tokio::sync::{Notify, mpsc, oneshot, watch};

use crate::core::unix_ms;
use crate::core::{self, Core, Item, Kind, PrepareError, Prepared, Req, Res, Submit, Verdict};
use crate::cron::{self, Scheduler};
use crate::hash::{HashError, Hasher, Limiter, Local, Wait};
use crate::hooks::Hooks;
use crate::js;
use crate::keys::Keyring;
use crate::mp::{self, Val};
use crate::names::{self, covers};
use crate::pool::{Pool, PoolError};

#[derive(Default)]
pub struct Options {
    pub data_dir: String,
    pub bundle: String,
    pub dev_auth: bool,
    /// password hashing: the hasher, the server's own pool of hash_workers when None, each worker
    /// holding one argon2id hash's memory while it runs; and each client's budget of hashes, a
    /// burst regained at a rate per second
    pub hasher: Option<Arc<dyn Hasher>>,
    pub hash_workers: usize,
    pub auth_burst: usize,
    pub auth_rate: f64,
    /// the environment variables the bundle's bootstrap may read; any other reads as ""
    pub bootstrap_env: Vec<String>,
    /// the header a proxy in front of the server sets to the client's address, such as
    /// CF-Connecting-IP; trusted from every request, so set only when nothing but the proxy can
    /// reach the server
    pub client_ip_header: String,
    /// the most mutations one POST /mutations may carry, and one without a session
    pub max_mutations: usize,
    pub max_anonymous_mutations: usize,
    /// the path every route is under, such as /phaselock; "" puts the routes at the root
    pub path_prefix: String,
    /// the page cache of each of the store's SQLite connections, in MiB
    pub sqlite_cache_size: i64,
    /// the most commits and view changes a /stream connection may have queued and unsent before
    /// it is dropped
    pub max_stream_backlog: usize,
    /// how long a principal's grant and account are kept once it has no connection and has gone
    /// unused
    pub principal_ttl: Duration,
    /// the interval between a connection's heartbeat vouches
    pub heartbeat: Duration,
    /// how long one call into the bundle may run before it is interrupted, 30 seconds when zero
    pub call_limit: Duration,
    /// the clock tokens and their keys are minted and checked by, the system's when None
    pub clock: Option<Clock>,
}

/// a clock: the wall-clock time now
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

// the codes of the end frames the database sends: its own, in the 600s, which HTTP leaves
// unused, so a client reports them beside the HTTP statuses of the ends it sees outside the
// stream without confusing the two
const END_GRANTOR_FAILED: i64 = 600; // the grantor failed when a commit re-ran it
const END_OVERFLOW: i64 = 601; // the connection's backlog overflowed
const END_READ_FAILED: i64 = 602; // a history read failed
const END_REVOKED: i64 = 603; // the token was revoked, or is about to expire

pub const HEARTBEAT: Duration = Duration::from_secs(15);
// how long before its token expires a connection ends, so that its client reconnects with the
// token refreshed
const EXPIRY_LEAD_MS: i64 = 60_000;
const MAX_BODY: usize = 16 << 20;
// the largest mutation body checked on the task that took it; a larger one is checked on the
// check pool, since its check runs long enough to hold up the tasks behind it
const CHECK_INLINE: usize = 16 << 10;
// the default number of hash workers is one per core, up to this many
const HASH_WORKERS_MAX: usize = 16;
/* The header on a refusal made before any mutation reached the writer, so a client may send the
request again whether or not its mutations are numbered.  A 429 never carries it: every 429 the
server answers is such a refusal. */
pub const SAFE_TO_RETRY: &str = "phaselock-safe-to-retry";
// the seconds a 503 or 429 asks the client to wait before it tries again
const RETRY_AFTER: &str = "1";
const COLD_BATCH: u64 = 1000;
/// the default and maximum number of edits one /edits response asks for
const EDITS_PAGE: usize = 1000;
// the frames a stream's writer may have handed the HTTP layer and the client not yet taken
const STREAM_CHUNKS: usize = 32;

pub const ERR_CLOSED: &str = "the server is shutting down";
pub const ERR_REVOKED: &str = "token revoked";

// bodies /////////////////////////////////////////////////////////////////////

/// A response body: whole, or streamed from a channel its writer feeds.
pub enum Body {
    Full(Option<Bytes>),
    Stream(mpsc::Receiver<Bytes>),
}

impl hyper::body::Body for Body {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<BodyFrame<Bytes>, Infallible>>> {
        match &mut *self {
            Body::Full(b) => Poll::Ready(b.take().map(|b| Ok(BodyFrame::data(b)))),
            Body::Stream(rx) => rx.poll_recv(cx).map(|b| b.map(|b| Ok(BodyFrame::data(b)))),
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self, Body::Full(None))
    }

    fn size_hint(&self) -> SizeHint {
        match self {
            Body::Full(Some(b)) => SizeHint::with_exact(b.len() as u64),
            Body::Full(None) => SizeHint::with_exact(0),
            Body::Stream(_) => SizeHint::default(),
        }
    }
}

pub type Resp = Response<Body>;

/// answers with a message as plain text, as an error the client shows
pub fn http_error(status: u16, msg: &str) -> Resp {
    let mut r = Response::new(Body::Full(Some(Bytes::from(format!("{msg}\n")))));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = r.headers_mut();
    h.insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    if status == 503 || status == 429 {
        h.insert("retry-after", HeaderValue::from_static(RETRY_AFTER));
    }
    r
}

/// answers a request the server sheds before any mutation of it reaches the writer
pub fn shed(msg: &str) -> Resp {
    let mut r = http_error(503, msg);
    r.headers_mut().insert(SAFE_TO_RETRY, HeaderValue::from_static("true"));
    r
}

fn reply_bytes(content_type: &'static str, body: Vec<u8>) -> Resp {
    let mut r = Response::new(Body::Full(Some(Bytes::from(body))));
    r.headers_mut().insert("content-type", HeaderValue::from_static(content_type));
    r
}

fn set(h: &mut HeaderMap, name: &'static str, v: impl AsRef<str>) {
    if let Ok(v) = HeaderValue::from_str(v.as_ref()) {
        h.insert(name, v);
    }
}

/// a request as the handlers read it: its method, path relative to the prefix, query, headers,
/// the address it came from, and its body
pub struct Request {
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: HeaderMap,
    pub remote: String,
    body: Option<Incoming>,
}

impl Request {
    pub fn q(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn q_all(&self, name: &str) -> Vec<String> {
        self.query.iter().filter(|(k, _)| k == name).map(|(_, v)| v.clone()).collect()
    }

    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    /// the body, its first MAX_BODY bytes
    pub async fn body(&mut self) -> Result<Vec<u8>, String> {
        let Some(mut b) = self.body.take() else { return Ok(Vec::new()) };
        let mut out = Vec::new();
        while let Some(f) = b.frame().await {
            let f = f.map_err(|e| e.to_string())?;
            if let Ok(d) = f.into_data() {
                let room = MAX_BODY - out.len();
                out.extend_from_slice(&d[..d.len().min(room)]);
                if out.len() == MAX_BODY {
                    break;
                }
            }
        }
        Ok(out)
    }
}

fn unhex(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// percent-decodes text, and a '+' as a space when plus is set, as a query's values are
pub fn unescape(s: &str, plus: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => match (unhex(b[i + 1]), unhex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h << 4 | l);
                    i += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            b'+' if plus => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// a query's pairs; a pair holding ';' is malformed and dropped
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty() && !p.contains(';'))
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (unescape(k, true), unescape(v, true))
        })
        .collect()
}

// connections ////////////////////////////////////////////////////////////////

/// A queued frame: a commit whose edits the connection's view covers some of, or a change of
/// the view.
#[derive(Clone)]
enum Frame {
    Commit(Arc<Commit>),
    View(Arc<ViewChange>),
}

/// One commit's edits, each mutation's in a run of their own, in position order.  It is shared by
/// every connection it is queued to, and read only: each writer writes the edits its view covers
/// as it takes the commit from its backlog.
struct Commit {
    mutations: Vec<Vec<Item>>,
}

/// A view frame, which carries the view and, as its position, the one the dispatcher had
/// published before the batch that changed it; the writer encodes it as it writes it.  A grantor
/// that failed, or a revocation, queues the encoded end frame in its place.
struct ViewChange {
    pos: u64,
    token: String,
    selectors: Vec<String>,
    end: Option<Bytes>,
}

/// One connection.  Its view is what the grantor allows cut down to what it wants, and its token
/// the hash of that set.  The dispatcher is the only task that writes the view and queues frames
/// on the backlog; the connection's writer is the only one that takes them, and both do so under
/// the server's lock.  Commit frames are queued only once the writer has finished its cold catchup
/// and flipped streaming, so a long replay buffers nothing; the hot catchup then covers the gap
/// and the backlog is deduped by position.  The backlog grows as frames are queued, up to the
/// server's limit, and the writer takes it whole, so an idle connection holds none.
struct Conn {
    wants: Vec<String>,
    selectors: Vec<String>, // the view
    token: String,          // the hash of the view
    active: bool,
    ephemeral: bool,
    streaming: bool,
    backlog: Vec<Frame>,
    // whether the backlog reached its limit, or the server shut down; either ends the connection
    // once its writer has written what was queued before it
    overflowed: bool,
    shutdown: bool,
    // signaled when a frame is queued or the connection ends
    wake: Arc<Notify>,
    // its principal's user, and its token's generation; a connection whose token no longer speaks
    // for its account is revoked
    user: String,
    generation: i64,
    revoked: bool,
    // what the grantor's failure answers the connection with, "" while it grants
    failure: String,
}

struct Shared {
    pending: HashMap<u64, oneshot::Sender<Res>>,
    conns: HashMap<u64, Conn>,
    /* each user's generation as the core last published it, for the users it keeps an account
    for, and each user's connections whose tokens a change of the generation revokes */
    generations: HashMap<String, i64>,
    by_user: HashMap<String, HashSet<u64>>,
    stopped: bool,
}

/// a principal: anonymous, or a user with its token's generation and expiry in Unix seconds; the
/// anonymous principal's generation is -1, since it has none
#[derive(Clone, Debug)]
pub struct Principal {
    pub anonymous: bool,
    pub user: String,
    pub generation: i64,
    pub exp: i64,
}

impl Principal {
    pub fn anonymous() -> Principal {
        Principal { anonymous: true, user: String::new(), generation: -1, exp: 0 }
    }

    pub fn user_opt(&self) -> Option<String> {
        (!self.anonymous).then(|| self.user.clone())
    }
}

/// what a registration answers: the view and its token, at the position it is the view at
struct ViewAnswer {
    selectors: Vec<String>,
    token: String,
    position: u64,
}

pub struct Server {
    pub core: Core,
    pub keys: Keyring,
    pub clock: Clock,
    pub dev_auth: bool,
    pub epoch: String,
    pub hasher: Arc<dyn Hasher>,
    // the hasher the server made, which it stops when it closes
    local_hasher: Option<Arc<Local>>,
    pub limit: Limiter,
    // the checks of large mutation bodies
    checks: Pool,
    pub client_ip_header: String,
    max_mutations: usize,
    max_anonymous_mutations: usize,
    pub path_prefix: String,
    max_stream_backlog: usize,
    heartbeat: Duration,
    mu: Mutex<Shared>,
    next_req: AtomicU64,
    next_conn: AtomicU64,
    /// the last commit's position, published under the lock once the commit's frames are queued
    position: AtomicU64,
    published: watch::Sender<(u64, bool)>,
    /// the server's lifetime: every request ends when it ends
    pub done: watch::Sender<bool>,
    /// tests only: the points a test holds the server at
    pub hooks: Hooks,
    dispatcher: Mutex<Option<tokio::task::JoinHandle<()>>>,
    cron_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// checks a path prefix: "" or a path starting with a slash and ending without one
pub fn check_path_prefix(prefix: &str) -> Result<(), String> {
    if !prefix.is_empty() && (!prefix.starts_with('/') || prefix.ends_with('/')) {
        return Err(format!(
            "path prefix {prefix:?} must start with a slash and not end with one, or be empty"
        ));
    }
    Ok(())
}

/// refuses a client IP header that holds a list of addresses rather than one
pub fn check_client_ip_header(name: &str) -> Result<(), String> {
    if name.eq_ignore_ascii_case("X-Forwarded-For") || name.eq_ignore_ascii_case("Forwarded") {
        return Err(format!(
            "client IP header {name} is unsupported: name a header holding one address, such as CF-Connecting-IP"
        ));
    }
    Ok(())
}

/// the page cache's size, which SQLite takes in KiB as a C int
pub fn check_cache_size(mib: i64) -> Result<i64, String> {
    let mib = if mib <= 0 { 64 } else { mib };
    let max = i32::MAX as i64 / 1024;
    if mib > max {
        return Err(format!(
            "sqlite cache size {mib} MiB is over the most SQLite takes, {max} MiB"
        ));
    }
    Ok(mib)
}

fn group_positions(items: &[Item]) -> Vec<Vec<Item>> {
    let mut groups: Vec<Vec<Item>> = Vec::new();
    for it in items {
        match groups.last_mut() {
            Some(g) if g[0].position == it.position => g.push(it.clone()),
            _ => groups.push(vec![it.clone()]),
        }
    }
    groups
}

fn covers_any(selectors: &[String], items: &[Item]) -> bool {
    items.iter().any(|it| covers(selectors, &it.slice))
}

/// A connection's view: every selector the grantor allows that a want covers, and every want that
/// a granted selector covers, sorted and unique.  No wants means everything the grantor allows.
fn intersect(granted: &[String], wants: &[String]) -> Vec<String> {
    let star = ["*".to_string()];
    let wants = if wants.is_empty() { &star[..] } else { wants };
    let mut set = Vec::new();
    for m in granted {
        for w in wants {
            if names::matches(m, w) {
                set.push(m.clone());
            } else if names::matches(w, m) {
                set.push(w.clone());
            }
        }
    }
    set.sort();
    set.dedup();
    set
}

/// a view's token: FNV-1a 64 over its selectors in order, each with a terminating zero byte, as
/// 16 hex digits
fn view_token(view: &[String]) -> String {
    let mut h: u64 = 14695981039346656037;
    for s in view {
        for &c in s.as_bytes().iter().chain(std::iter::once(&0u8)) {
            h ^= c as u64;
            h = h.wrapping_mul(1099511628211);
        }
    }
    format!("{h:016x}")
}

/// A view frame at a position.  A view frame's position is the last position the connection sent
/// under the previous view: everything the connection sends after the frame is filtered by the
/// new view, and the new view's edits at or below the position are the client's backfills' to
/// deliver, through it.  The writer writes the later of its own cursor and the position the
/// dispatcher had published before the batch that changed the view.  Its cursor alone would be
/// wrong live: it moves only with the frames the connection is sent, so it lags commits the old
/// view could not see, and a backfill's tail ending there would skip the new view's edits in them,
/// a gap a fresh snapshot cut past them hides and an older cached one does not.  In a replay the
/// cursor is right on its own, since the replay moves it through every position it reads, seen or
/// not.
fn view_frame(token: &str, cursor: u64, selectors: &[String]) -> Bytes {
    Bytes::from(mp::encode(&Val::Array(vec![
        Val::Str("view"),
        Val::Str(token),
        Val::Int(cursor as i64),
        Val::Strs(selectors),
    ])))
}

fn tagged(tag: &str, n: u64) -> Bytes {
    Bytes::from(mp::encode(&Val::Array(vec![Val::Str(tag), Val::Int(n as i64)])))
}

fn end_frame(code: i64, reason: &str) -> Bytes {
    Bytes::from(mp::encode(&Val::Array(vec![Val::Str("end"), Val::Int(code), Val::Str(reason)])))
}

/// the chunks of the edits frame of one mutation's edits that are in the view, each edit's bytes
/// as they are, or None when none are
fn edits_frame(edits: &[Item], selectors: &[String]) -> Option<Vec<Bytes>> {
    let n = edits.iter().filter(|it| covers(selectors, &it.slice)).count();
    if n == 0 {
        return None;
    }
    let mut head = mp::Writer::new();
    head.array(2);
    head.str(b"edits");
    head.array(n);
    let mut out = vec![Bytes::from(head.into_vec())];
    out.extend(edits.iter().filter(|it| covers(selectors, &it.slice)).map(|it| it.data.clone()));
    Some(out)
}

/// answers a request the core did not carry out: a stale token, the server shutting down, or a
/// failure in the core
fn refuse(r: &Res) -> Resp {
    match r.status {
        401 => http_error(401, "token rejected"),
        503 => http_error(503, &r.errmsg),
        _ => http_error(500, &r.errmsg),
    }
}

// a request's connection, dropped from the server when the request ends
struct ConnGuard {
    s: Arc<Server>,
    id: u64,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.s.drop_conn(self.id);
    }
}

impl Server {
    /// Opens a server that lives until close.
    pub async fn open(o: Options) -> Result<Arc<Server>, String> {
        check_client_ip_header(&o.client_ip_header)?;
        check_path_prefix(&o.path_prefix)?;
        let cache = check_cache_size(o.sqlite_cache_size)?;
        let ttl = if o.principal_ttl.is_zero() { Duration::from_secs(60) } else { o.principal_ttl };

        // the hasher, which bootstrap hashes through too, waiting on the writer thread
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let (hasher, local_hasher): (Arc<dyn Hasher>, _) = match o.hasher {
            Some(h) => (h, None),
            None => {
                let workers =
                    if o.hash_workers == 0 { cores.min(HASH_WORKERS_MAX) } else { o.hash_workers };
                let l = Arc::new(Local::new(workers, 2 * workers));
                (l.clone(), Some(l))
            }
        };
        let bootstrap_hash: js::HashFn = {
            let (h, rt) = (hasher.clone(), tokio::runtime::Handle::current());
            Box::new(move |pw| rt.block_on(h.hash(pw.to_string(), Wait::Queue)).ok())
        };

        let cfg = core::Config {
            dir: o.data_dir.clone(),
            bundle: o.bundle.clone(),
            env: o.bootstrap_env.clone(),
            cache_mib: cache,
            ttl_ms: ttl.as_millis() as i64,
            call_limit: if o.call_limit.is_zero() { js::CALL_LIMIT } else { o.call_limit },
            hash: bootstrap_hash,
        };
        let (c, results) = tokio::task::spawn_blocking(move || Core::open(cfg))
            .await
            .map_err(|e| e.to_string())??;

        // the log's head, the position the dispatcher has published until its first commit, and
        // the token keys, every one minted before this process started
        let head = c.reader.head().await.inspect_err(|_| c.close())?;
        let stored = c.reader.keys().await.inspect_err(|_| c.close())?;
        let clock = o.clock.unwrap_or_else(|| Arc::new(SystemTime::now));
        let mut keys = Vec::new();
        for k in stored {
            let Ok(public) = <[u8; 32]>::try_from(k.public.as_slice()) else { continue };
            let Ok(public) = ed25519_dalek::VerifyingKey::from_bytes(&public) else { continue };
            keys.push(crate::keys::TokenKey { kid: k.kid, public, minted: k.minted });
        }

        // the cron entries, every spec of which must parse
        let mut scheds = Vec::new();
        for e in &c.cron {
            match cron::parse(&e.spec) {
                Ok((sched, notice)) => {
                    if let Some(n) = notice {
                        eprintln!("cron entry {} of {}: {n}", e.name, e.install);
                    }
                    scheds.push(sched);
                }
                Err(err) => {
                    c.close();
                    return Err(format!(
                        "cron entry {} of {}: {:?}: {err}",
                        e.name, e.install, e.spec
                    ));
                }
            }
        }

        let burst = if o.auth_burst == 0 { 10 } else { o.auth_burst };
        let rate = if o.auth_rate <= 0.0 { 1.0 } else { o.auth_rate };
        let max_mutations = if o.max_mutations == 0 { 128 } else { o.max_mutations };
        let max_anonymous =
            if o.max_anonymous_mutations == 0 { 8 } else { o.max_anonymous_mutations };
        let start = unix_ms(clock());
        let s = Arc::new(Server {
            keys: Keyring::new(keys, start),
            clock,
            dev_auth: o.dev_auth,
            epoch: c.epoch.clone(),
            hasher,
            local_hasher,
            limit: Limiter::new(rate, burst),
            checks: Pool::new("pldb-check", cores, 2 * cores),
            client_ip_header: o.client_ip_header,
            max_mutations,
            max_anonymous_mutations: max_anonymous.min(max_mutations),
            path_prefix: o.path_prefix,
            max_stream_backlog: if o.max_stream_backlog == 0 { 2048 } else { o.max_stream_backlog },
            heartbeat: if o.heartbeat.is_zero() { HEARTBEAT } else { o.heartbeat },
            mu: Mutex::new(Shared {
                pending: HashMap::new(),
                conns: HashMap::new(),
                generations: HashMap::new(),
                by_user: HashMap::new(),
                stopped: false,
            }),
            next_req: AtomicU64::new(0),
            next_conn: AtomicU64::new(0),
            position: AtomicU64::new(head),
            published: watch::channel((head, false)).0,
            done: watch::channel(false).0,
            hooks: Hooks::default(),
            dispatcher: Mutex::new(None),
            cron_task: Mutex::new(None),
            core: c,
        });
        let d = tokio::spawn(s.clone().dispatch(results));
        *s.dispatcher.lock().unwrap() = Some(d);

        // arm every new entry at the current minute, then tick every entry from its mark
        if scheds.is_empty() {
            return Ok(s);
        }
        let now = crate::core::now_ms() / 1000;
        let r = s.arm(now - now.rem_euclid(60)).await;
        if r.status != 0 {
            s.close().await;
            return Err(format!("arming cron: {}", r.errmsg));
        }
        let sched = Scheduler { scheds, marks: r.marks.clone() };
        let srv = s.clone();
        let mut done = s.done.subscribe();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = sched.run(crate::core::now_ms, |i, slot| srv.clone().fire_cron(i, slot)) => {}
                _ = crate::pool::until(&mut done) => {}
            }
        });
        *s.cron_task.lock().unwrap() = Some(task);
        Ok(s)
    }

    /// decides one slot, in Unix seconds, of cron entry i
    pub async fn tick(&self, entry: usize, slot: i64) -> Res {
        self.request(|reqid| Req::Tick { reqid, entry, slot }).await
    }

    /// gives every cron entry without a mark the minute, in Unix seconds, and answers every
    /// entry's mark
    pub async fn arm(&self, minute: i64) -> Res {
        self.request(|reqid| Req::Arm { reqid, minute }).await
    }

    // the scheduler's fire: a tick, whose hook's failure is a bug in the bundle, logged
    async fn fire_cron(self: Arc<Self>, i: usize, slot: i64) {
        let r = self.tick(i, slot).await;
        if r.status == 500 {
            let e = &self.core.cron[i];
            eprintln!(
                "cron entry {} of {} at {}: {}",
                e.name,
                e.install,
                cron::rfc3339(slot),
                r.errmsg
            );
        }
    }

    /// Ends the server's lifetime, so every request ends; then, once its handlers have returned,
    /// close finishes the cron scheduler and the hash workers' work in hand, and closes the core,
    /// which commits the batch in hand.
    pub fn cancel(&self) {
        self.done.send_replace(true);
    }

    pub async fn close(&self) {
        self.cancel();
        let cron = self.cron_task.lock().unwrap().take();
        if let Some(t) = cron {
            let _ = t.await;
        }
        if let Some(h) = &self.local_hasher {
            h.stop().await;
        }
        self.checks.stop().await;
        let core = &self.core;
        tokio::task::block_in_place(|| core.close());
        let d = self.dispatcher.lock().unwrap().take();
        if let Some(d) = d {
            let _ = d.await;
        }
    }

    async fn closed(&self) {
        let mut d = self.done.subscribe();
        let _ = d.wait_for(|d| *d).await;
    }

    // dispatch ///////////////////////////////////////////////////////////////

    /// sends one request to the core and waits for its reply, or for the server to end
    pub async fn request(&self, send: impl FnOnce(u64) -> Req) -> Res {
        let reqid = self.next_req.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        self.mu.lock().unwrap().pending.insert(reqid, tx);
        self.core.send(send(reqid));
        tokio::select! {
            r = rx => r.unwrap_or_else(|_| Res { status: 503, errmsg: ERR_CLOSED.into(), ..Default::default() }),
            _ = self.closed() => {
                self.mu.lock().unwrap().pending.remove(&reqid);
                Res { status: 503, errmsg: ERR_CLOSED.into(), ..Default::default() }
            }
        }
    }

    fn reply(&self, r: Res) {
        let ch = self.mu.lock().unwrap().pending.remove(&r.reqid);
        if let Some(ch) = ch {
            let _ = ch.send(r);
        }
    }

    /// Queues a frame on a connection's backlog, under the server's lock, and wakes its writer.
    /// A live connection that cannot keep up, whose backlog is at the limit, ends instead, and a
    /// connection that has ended takes no more frames.
    fn queue(max: usize, c: &mut Conn, f: Frame) {
        if !c.active {
            return;
        }
        if c.backlog.len() >= max {
            c.overflowed = true;
            c.active = false;
        } else {
            c.backlog.push(f);
        }
        c.wake.notify_one();
    }

    async fn dispatch(self: Arc<Self>, mut results: mpsc::UnboundedReceiver<Res>) {
        while let Some(r) = results.recv().await {
            match r.kind {
                Kind::Shutdown => {
                    let mut sh = self.mu.lock().unwrap();
                    for c in sh.conns.values_mut() {
                        if c.active {
                            c.active = false;
                            c.shutdown = true;
                            c.wake.notify_one();
                        }
                    }
                    sh.stopped = true;
                    self.published.send_replace((self.position.load(Ordering::SeqCst), true));
                    return;
                }
                Kind::Outcome | Kind::Lookup | Kind::Arm | Kind::Tick | Kind::Key => self.reply(r),
                Kind::Account => {
                    if r.reqid != 0 {
                        self.reply(r);
                    } else {
                        self.account(&r);
                    }
                }
                Kind::View => {
                    {
                        let max = self.max_stream_backlog;
                        let pos = self.position.load(Ordering::SeqCst);
                        let mut sh = self.mu.lock().unwrap();
                        if let Some(c) = sh.conns.get_mut(&r.conn) {
                            if r.status == 0 {
                                // the connection's view is the grant cut down to its wants
                                let view = intersect(&r.selectors, &c.wants);
                                let token = view_token(&view);
                                let changed = token != c.token;
                                c.selectors = view.clone();
                                c.token = token.clone();
                                c.failure.clear();
                                if r.reqid != 0 {
                                    // a connection the batch that registered it revoked never
                                    // starts
                                    if !c.ephemeral && !c.revoked {
                                        c.active = true;
                                    }
                                } else if c.active && changed {
                                    // a grant change that left this view as it was is no frame;
                                    // one that did comes ahead of its batch's edits, at the
                                    // position published before the batch
                                    let v = ViewChange { pos, token, selectors: view, end: None };
                                    Self::queue(max, c, Frame::View(Arc::new(v)));
                                }
                            } else {
                                // the grantor failed, so the connection is answered with the
                                // failure, and one it failed under when a commit re-ran it ends
                                c.failure = r.errmsg.clone();
                                if r.reqid == 0 && c.active {
                                    let end = end_frame(END_GRANTOR_FAILED, &r.errmsg);
                                    let v = ViewChange {
                                        pos: 0,
                                        token: String::new(),
                                        selectors: Vec::new(),
                                        end: Some(end),
                                    };
                                    Self::queue(max, c, Frame::View(Arc::new(v)));
                                    c.active = false;
                                }
                            }
                        }
                    }
                    if r.reqid != 0 {
                        self.reply(r);
                    }
                }
                Kind::Commit => {
                    if let Some(h) = self.hooks.before_push.get() {
                        h(r.position).await;
                    }

                    // the commit, queued once to every streaming connection whose view covers any
                    // of it
                    let max = self.max_stream_backlog;
                    let mut cm: Option<Arc<Commit>> = None;
                    let mut sh = self.mu.lock().unwrap();
                    for c in sh.conns.values_mut() {
                        if !c.active || !c.streaming || !covers_any(&c.selectors, &r.items) {
                            continue;
                        }
                        let cm = cm.get_or_insert_with(|| {
                            Arc::new(Commit { mutations: group_positions(&r.items) })
                        });
                        Self::queue(max, c, Frame::Commit(cm.clone()));
                    }

                    /* Publish the position once every streaming connection holds the commit's
                    frames, and under the lock: a connection that forwards its queue after
                    reading the position has then written every frame at or below it, and one
                    that switches to streaming gets each commit from exactly one of its hot
                    catchup and its queue. */
                    self.position.store(r.position, Ordering::SeqCst);
                    self.published.send_replace((r.position, false));
                    drop(sh);
                }
            }
        }
    }

    /// Takes the core's change to a user's account, ahead of the edits of the batch that made
    /// it: the server's copy of the generation, which refuses a stale token at once, and the end
    /// of every connection whose token no longer speaks for the account.
    fn account(&self, r: &Res) {
        let max = self.max_stream_backlog;
        let mut sh = self.mu.lock().unwrap();
        if r.forgotten {
            sh.generations.remove(&r.user);
            return;
        }
        sh.generations.insert(r.user.clone(), r.generation);
        let ids: Vec<u64> =
            sh.by_user.get(&r.user).map(|s| s.iter().copied().collect()).unwrap_or_default();
        for id in ids {
            let Some(c) = sh.conns.get_mut(&id) else { continue };
            if c.generation == r.generation || c.revoked {
                continue;
            }
            c.revoked = true;
            let end = end_frame(END_REVOKED, "token revoked");
            let v =
                ViewChange { pos: 0, token: String::new(), selectors: Vec::new(), end: Some(end) };
            Self::queue(max, c, Frame::View(Arc::new(v)));
            c.active = false;
        }
    }

    /// the generation the core last published for a user, if it keeps an account for the user
    pub fn generation(&self, user: &str) -> Option<i64> {
        self.mu.lock().unwrap().generations.get(user).copied()
    }

    /// Waits until the dispatcher has published a position, by which every change to a grant or
    /// an account up to it has reached the connections; false when the server stops first.
    async fn settled(&self, position: u64) -> bool {
        let mut rx = self.published.subscribe();
        match rx.wait_for(|&(p, stopped)| p >= position || stopped).await {
            Ok(v) => v.0 >= position,
            Err(_) => false,
        }
    }

    // views //////////////////////////////////////////////////////////////////

    /// Registers the principal's grant and answers the connection and its view.  The connection
    /// is subscribed to commits unless ephemeral.
    async fn view(
        self: &Arc<Self>,
        p: &Principal,
        wants: Vec<String>,
        ephemeral: bool,
    ) -> (ConnGuard, Result<ViewAnswer, Res>) {
        let id = self.next_conn.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut sh = self.mu.lock().unwrap();
            sh.conns.insert(
                id,
                Conn {
                    wants,
                    selectors: Vec::new(),
                    token: String::new(),
                    active: false,
                    ephemeral,
                    streaming: false,
                    backlog: Vec::new(),
                    overflowed: false,
                    shutdown: false,
                    wake: Arc::new(Notify::new()),
                    user: p.user.clone(),
                    generation: p.generation,
                    revoked: false,
                    failure: String::new(),
                },
            );
            if !p.anonymous {
                sh.by_user.entry(p.user.clone()).or_default().insert(id);
            }
        }
        let guard = ConnGuard { s: self.clone(), id };
        let user = p.user_opt();
        let generation = p.generation;
        let r = self.request(|reqid| Req::Register { reqid, conn: id, user, generation }).await;
        if r.status != 0 {
            return (guard, Err(r));
        }

        // the dispatcher computed the view before it replied, and revoked a connection whose
        // batch revoked its token
        let sh = self.mu.lock().unwrap();
        let Some(c) = sh.conns.get(&id) else {
            return (
                guard,
                Err(Res { status: 503, errmsg: ERR_CLOSED.into(), ..Default::default() }),
            );
        };
        if c.revoked {
            return (guard, Err(Res { status: 401, ..Default::default() }));
        }
        let a = ViewAnswer {
            selectors: c.selectors.clone(),
            token: c.token.clone(),
            position: r.position,
        };
        drop(sh);
        (guard, Ok(a))
    }

    fn drop_conn(&self, id: u64) {
        {
            let mut sh = self.mu.lock().unwrap();
            if let Some(c) = sh.conns.remove(&id)
                && let Some(set) = sh.by_user.get_mut(&c.user)
            {
                set.remove(&id);
                if set.is_empty() {
                    sh.by_user.remove(&c.user);
                }
            }
        }
        self.core.send(Req::Unregister { conn: id });
    }

    /// tests only: how many connections the server holds
    pub fn conns(&self) -> usize {
        self.mu.lock().unwrap().conns.len()
    }

    /// Why an ephemeral connection's view no longer covers a selector once the dispatcher has
    /// published position, the last its read saw, by which every change to its principal's grant
    /// or account up to it has reached the connection: the answer that says so, None while the
    /// view covers it.
    async fn not_visible(&self, id: u64, selector: &str, position: u64) -> Option<Resp> {
        if !self.settled(position).await {
            return Some(http_error(503, ERR_CLOSED));
        }
        let sh = self.mu.lock().unwrap();
        let Some(c) = sh.conns.get(&id) else { return Some(http_error(503, ERR_CLOSED)) };
        if c.revoked {
            Some(http_error(401, ERR_REVOKED))
        } else if !c.failure.is_empty() {
            Some(http_error(500, &c.failure))
        } else if !covers(&c.selectors, selector) {
            Some(http_error(403, "selector not visible"))
        } else {
            None
        }
    }

    // handlers ///////////////////////////////////////////////////////////////

    /// Serves one request: every route is under the path prefix, which it strips before routing.
    pub async fn serve(self: Arc<Self>, req: http::Request<Incoming>, remote: String) -> Resp {
        let (parts, body) = req.into_parts();
        let raw_path = parts.uri.path().to_string();
        let mut r = Request {
            method: parts.method,
            path: unescape(&raw_path, false),
            query: parse_query(parts.uri.query().unwrap_or("")),
            headers: parts.headers,
            remote,
            body: Some(body),
        };
        let Some(path) = r.path.strip_prefix(&self.path_prefix) else {
            return http_error(404, "404 page not found");
        };
        r.path = path.to_string();
        match r.path.as_str() {
            "/stream" => self.handle_stream(r).await,
            "/mutations" => self.handle_mutations(r).await,
            "/auth/token" => self.handle_auth(r).await,
            p if p.starts_with("/snapshot/") => self.handle_snapshot(r).await,
            p if p.starts_with("/edits/") => self.handle_edits(r).await,
            _ => http_error(404, "404 page not found"),
        }
    }

    async fn handle_stream(self: Arc<Self>, r: Request) -> Resp {
        let p = match self.principal_of(&r) {
            Ok(p) => p,
            Err(e) => return http_error(401, &e),
        };
        let since = match r.q("since").unwrap_or("").parse::<i64>() {
            Ok(s) if s >= -1 => s,
            _ => return http_error(400, "since must be -1 or a position"),
        };
        let mut wants = r.q_all("want");
        if wants.is_empty() {
            wants = vec!["*".into()];
        }
        if !wants.iter().all(|w| names::valid_selector(w)) {
            return http_error(400, "malformed want");
        }

        let (guard, view) = self.view(&p, wants, false).await;
        let view = match view {
            Ok(v) => v,
            Err(res) => return refuse(&res),
        };

        let (tx, rx) = mpsc::channel(STREAM_CHUNKS);
        let mut resp = Response::new(Body::Stream(rx));
        let h = resp.headers_mut();
        set(h, "content-type", "application/msgpack");
        set(h, "cache-control", "no-store");
        set(h, "x-accel-buffering", "no");
        set(h, "phaselock-protocol", "1");
        set(h, "phaselock-epoch", &self.epoch);
        set(h, "phaselock-time", unix_ms(SystemTime::now()).to_string());
        set(h, "phaselock-view", &view.token);
        set(h, "phaselock-position", view.position.to_string());

        let presented = r.q("view").unwrap_or("").to_string();
        let out = Out { tx, first: self.hooks.after_first_frame.get() };
        tokio::spawn(self.stream(guard, p, since, view, presented, out));
        resp
    }

    async fn stream(
        self: Arc<Self>,
        guard: ConnGuard,
        p: Principal,
        since: i64,
        view: ViewAnswer,
        presented: String,
        out: Out,
    ) {
        let s = self.clone();
        let mut done = s.done.subscribe();
        let closed = out.tx.clone();
        tokio::select! {
            _ = s.stream_frames(guard.id, p, since, view, presented, out) => {}
            _ = crate::pool::until(&mut done) => {}
            _ = closed.closed() => {}
        }
        drop(guard);
    }

    async fn stream_frames(
        &self,
        id: u64,
        p: Principal,
        since: i64,
        view: ViewAnswer,
        presented: String,
        mut out: Out,
    ) {
        let mut selectors = view.selectors.clone();
        // the connection delivers everything above the cursor: the client's checkpoint, or on a
        // bootstrap the view's position, which the client takes as the bound of what its
        // snapshots must cover
        let mut cursor = if since >= 0 { since as u64 } else { view.position };

        // a client whose stored token is not the current one gets the view as the first frame,
        // ahead of history, at the cursor: the replay that follows is filtered by it
        if presented != view.token
            && !out.write(&[view_frame(&view.token, cursor, &view.selectors)]).await
        {
            return;
        }

        // the token's expiry, shortly before which the connection ends
        let expires = (p.exp != 0).then(|| {
            let left = p.exp * 1000 - EXPIRY_LEAD_MS - unix_ms((self.clock)());
            Instant::now() + Duration::from_millis(left.max(0) as u64)
        });
        let end_expired = end_frame(END_REVOKED, "token expiring");
        let wake = match self.mu.lock().unwrap().conns.get(&id) {
            Some(c) => c.wake.clone(),
            None => return,
        };

        // takes the backlog whole, under the server's lock, with whether the connection has
        // overflowed and whether it has ended, by overflowing its backlog or with the server
        let take_locked = |sh: &mut Shared| -> (Vec<Frame>, bool, bool) {
            match sh.conns.get_mut(&id) {
                Some(c) => {
                    (std::mem::take(&mut c.backlog), c.overflowed, c.overflowed || c.shutdown)
                }
                None => (Vec::new(), false, true),
            }
        };
        let take = || take_locked(&mut self.mu.lock().unwrap());

        // the last position the client has been told of, by an edits frame or a vouch
        let mut told = cursor;

        // cold catchup: unbuffered, as long as it takes, with the view frames queued meanwhile,
        // the only frames queued before the switch to streaming
        loop {
            if expires.is_some_and(|e| Instant::now() >= e) {
                out.write(std::slice::from_ref(&end_expired)).await;
                return;
            }
            let (q, of, ended) = take();
            if !self.forward(&mut out, q, of, ended, &mut selectors, &mut cursor).await {
                return;
            }
            let before = cursor;
            if !self
                .replay(
                    &mut out,
                    cursor + 1,
                    cursor + COLD_BATCH,
                    &selectors,
                    &mut cursor,
                    &mut told,
                )
                .await
            {
                return;
            }
            if cursor == before {
                break;
            }
            // a window that ended past the last frame is vouched for, so a client whose view
            // matched nothing in it still sees the replay advance
            if cursor > told {
                if !out.write(&[tagged("vouch", cursor)]).await {
                    return;
                }
                told = cursor;
            }
        }

        // switch to streaming, then a hot catchup through the dispatcher's position as of the
        // switch
        if let Some(h) = self.hooks.before_streaming.get() {
            h().await;
        }
        let (views, of, ended, hot) = {
            let mut sh = self.mu.lock().unwrap();
            let Some(c) = sh.conns.get_mut(&id) else { return };
            c.streaming = true;
            selectors = c.selectors.clone();
            let hot = self.position.load(Ordering::SeqCst);
            // the backlog holds only view frames until the switch, since the dispatcher queues
            // commits to streaming connections alone, and it queues only under the lock
            let (v, of, ended) = take_locked(&mut sh);
            (v, of, ended, hot)
        };

        // the view frames queued before the switch, whose selectors the hot catchup replays
        // under, go ahead of it
        if !self.forward(&mut out, views, of, ended, &mut selectors, &mut cursor).await {
            return;
        }

        // the hot catchup
        if !self.replay(&mut out, cursor + 1, hot, &selectors, &mut cursor, &mut told).await {
            return;
        }
        cursor = cursor.max(hot);
        if !out.write(&[tagged("live", cursor)]).await {
            return;
        }

        let mut ticker =
            tokio::time::interval_at(tokio::time::Instant::now() + self.heartbeat, self.heartbeat);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let expired = async {
            match expires {
                Some(e) => tokio::time::sleep_until(e.into()).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(expired);
        loop {
            tokio::select! {
                _ = wake.notified() => {
                    if let Some(h) = self.hooks.before_forward.get() {
                        h().await;
                    }
                    let (q, of, ended) = take();
                    if !self.forward(&mut out, q, of, ended, &mut selectors, &mut cursor).await {
                        return;
                    }
                }
                _ = ticker.tick() => {
                    /* The vouch names the cursor, so it never runs ahead of an edits frame still
                       queued.  Every commit the dispatcher has published is already in the
                       backlog, so forwarding the backlog as it stands brings the cursor up to the
                       published position, and a submitter whose mutation touched no slice it can
                       see gets its position on this heartbeat. */
                    let published = self.position.load(Ordering::SeqCst);
                    let (q, of, ended) = take();
                    if !self.forward(&mut out, q, of, ended, &mut selectors, &mut cursor).await {
                        return;
                    }
                    cursor = cursor.max(published);
                    if !out.write(&[tagged("vouch", cursor)]).await {
                        return;
                    }
                }
                _ = &mut expired => {
                    out.write(std::slice::from_ref(&end_expired)).await;
                    return;
                }
            }
        }
    }

    /* Writes frames taken from the backlog, then the end of a connection that has ended.  A view
    frame sets the selectors the commits queued after it are filtered by, which are the ones
    the dispatcher checked them against, and a commit's edits frames advance the cursor.
    Answers false when the connection is done. */
    async fn forward(
        &self,
        out: &mut Out,
        queued: Vec<Frame>,
        overflowed: bool,
        ended: bool,
        selectors: &mut Vec<String>,
        cursor: &mut u64,
    ) -> bool {
        for f in queued {
            match f {
                Frame::View(v) => {
                    // a view frame at the cursor, or an end frame a failed grantor or a
                    // revocation queues
                    if let Some(end) = &v.end {
                        out.write(std::slice::from_ref(end)).await;
                        return false;
                    }
                    if !out.write(&[view_frame(&v.token, v.pos.max(*cursor), &v.selectors)]).await {
                        return false;
                    }
                    *selectors = v.selectors.clone();
                }
                Frame::Commit(cm) => {
                    for edits in &cm.mutations {
                        // the mutation's own position: a commit may carry several mutations, and
                        // the hot catchup sent those at or below the cursor
                        if edits[0].position <= *cursor {
                            continue;
                        }
                        if let Some(chunks) = edits_frame(edits, selectors) {
                            if !out.write(&chunks).await {
                                return false;
                            }
                            *cursor = edits[0].position;
                        }
                    }
                }
            }
        }
        if overflowed {
            out.write(&[end_frame(END_OVERFLOW, "connection could not keep up")]).await;
        }
        !ended
    }

    async fn replay(
        &self,
        out: &mut Out,
        from: u64,
        to: u64,
        selectors: &[String],
        cursor: &mut u64,
        told: &mut u64,
    ) -> bool {
        let items = match self.core.reader.read_log(from, to).await {
            Ok(items) => items,
            Err(e) => {
                out.write(&[end_frame(END_READ_FAILED, &e)]).await;
                return false;
            }
        };
        for edits in group_positions(&items) {
            if let Some(chunks) = edits_frame(&edits, selectors) {
                if !out.write(&chunks).await {
                    return false;
                }
                *told = edits[0].position;
            }
        }
        if let Some(last) = items.last() {
            *cursor = (*cursor).max(last.position);
        }
        true
    }

    async fn handle_mutations(self: Arc<Self>, mut r: Request) -> Resp {
        if r.method != Method::POST {
            return http_error(405, "POST only");
        }
        let p = match self.principal_of(&r) {
            Ok(p) => p,
            Err(e) => return http_error(401, &e),
        };
        let body = match r.body().await {
            Ok(b) => b,
            Err(e) => return http_error(400, &e),
        };

        // the database's own time, from a whole request in hand to its answer, which the
        // response reports as Server-Timing so a client can tell it from the network's
        let start = Instant::now();
        let client = self.client_of(&r);
        let limit = if p.anonymous { self.max_anonymous_mutations } else { self.max_mutations };
        let schema = self.core.schema.clone();

        // the check: on this task for a small body, and on the check pool for a large one, which
        // sheds the request when the pool's queue is full
        let pc = if body.len() <= CHECK_INLINE {
            core::prepare(&schema, &body, limit)
        } else {
            match self.checks.try_run(move || core::prepare(&schema, &body, limit)).await {
                Ok(pc) => pc,
                Err(PoolError::Busy) => return shed("the database is busy checking mutations"),
                Err(PoolError::Closed) => return shed(ERR_CLOSED),
            }
        };
        let mut pc = match pc {
            Ok(pc) => pc,
            Err(PrepareError::TooMany) => {
                // the limit this request was held to, which the client splits its mutations under
                let mut resp = http_error(
                    413,
                    "the request carries more mutations than the database takes in one",
                );
                set(resp.headers_mut(), "phaselock-max-mutations", limit.to_string());
                return resp;
            }
            Err(PrepareError::Malformed(e)) => return http_error(400, &e),
        };

        // each NewPassword's hash, within the client's budget, written into its hole
        if !pc.passwords.is_empty() {
            let mut hashes = Vec::with_capacity(pc.passwords.len());
            for pw in std::mem::take(&mut pc.passwords) {
                match self.hash_for(&client, pw).await {
                    Ok(h) => hashes.push(h),
                    Err(e) => return hash_failed(e),
                }
            }
            pc.fill(&hashes);
        }

        // each proof against the sender's credentials, within the client's budget
        let mut verdicts = Vec::new();
        if pc.proofs.iter().any(|p| !p.is_empty()) {
            let hash = match self.password_hash_of(&p).await {
                Ok(h) => h,
                Err(e) => return http_error(500, &e),
            };
            verdicts = match self.prove(&client, hash, &pc.proofs, true).await {
                Ok(v) => v,
                Err(e) => return hash_failed(e),
            };
            self.proved().await;
        }

        // the core answers for the mutations that passed the check; the rest were rejected here
        let mut outcomes = Vec::new();
        if !pc.offsets.is_empty() {
            match self.decide(&p, &pc, verdicts).await {
                Ok(o) => outcomes = o,
                Err(res) => return refuse(&res),
            }
        }
        let mut w = mp::Writer::new();
        w.array(pc.reasons.len());
        let mut outs = outcomes.into_iter();
        for reason in &pc.reasons {
            match reason {
                None => w.raw(&outs.next().unwrap_or_default()),
                Some(r) => {
                    w.array(2);
                    w.str(b"reject");
                    w.str(r.as_bytes());
                }
            }
        }
        let mut resp = reply_bytes("application/msgpack", w.into_vec());
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        set(resp.headers_mut(), "server-timing", format!("db;dur={ms:.2}"));
        resp
    }

    /// Submits a request's passing mutations and answers their outcomes, each its own encoded
    /// value, in order.  When the writer bounces the call at a proven mutation, because the
    /// sender's credentials changed after its proof was checked, every proof from that mutation
    /// on is checked again against what lookup answers now, and the rest of the call is submitted
    /// again, so the call's mutations are still decided in order.  A failure answers a result
    /// with a status, the outcomes of mutations already decided lost with it, as a lost reply's
    /// are.
    async fn decide(
        &self,
        p: &Principal,
        pc: &Prepared,
        mut verdicts: Vec<Verdict>,
    ) -> Result<Vec<Vec<u8>>, Box<Res>> {
        let mut outcomes = Vec::new();
        let mut first = 0;
        let mut attempt = 0;
        loop {
            // the call from its first undecided mutation
            let body = pc.body[pc.offsets[first]..].to_vec();
            let vs = if verdicts.is_empty() { Vec::new() } else { verdicts[first..].to_vec() };
            let user = p.user_opt();
            let generation = p.generation;
            let res = self
                .request(|reqid| {
                    Req::Submit(Submit { reqid, user, generation, body, verdicts: vs, attempt })
                })
                .await;
            if res.status != 0 {
                return Err(Box::new(res));
            }
            let outs = split_array(&res.buf).ok_or_else(|| {
                Box::new(Res {
                    status: 500,
                    errmsg: "malformed outcomes".into(),
                    ..Default::default()
                })
            })?;
            let n = outs.len();
            outcomes.extend(outs);
            if !res.bounce {
                return Ok(outcomes);
            }

            // the mutation after the outcomes bounced: check its proofs, and every later one,
            // again
            first += n;
            let again = self
                .prove("", res.hash.clone(), &pc.proofs[first..], false)
                .await
                .map_err(|e| {
                    Box::new(Res { status: 503, errmsg: e.message().into(), ..Default::default() })
                })?;
            self.proved().await;
            for (i, v) in again.into_iter().enumerate() {
                verdicts[first + i] = v;
            }
            attempt += 1;
        }
    }

    // the hook a login or a request reaches once its passwords are checked
    pub(crate) async fn proved(&self) {
        if let Some(h) = self.hooks.proved.get() {
            h().await;
        }
    }

    /// Serves a blob of the selector, cut at one position.  A snapshot response is either the
    /// blob inline or a text/plain pointer to it in a blob store: this server answers inline.
    /// Either way the origin's response carries PhaseLock-Position and PhaseLock-Epoch, since a
    /// resumed download reads the blob with a Range from its resume offset and learns the cut's
    /// position and epoch only from the origin's response.
    async fn handle_snapshot(self: Arc<Self>, r: Request) -> Resp {
        let selector = r.path["/snapshot/".len()..].to_string();
        if !names::valid_selector(&selector) {
            return http_error(400, "malformed selector");
        }
        let p = match self.principal_of(&r) {
            Ok(p) => p,
            Err(e) => return http_error(401, &e),
        };
        let (guard, view) = self.view(&p, Vec::new(), true).await;
        let view = match view {
            Ok(v) => v,
            Err(res) => return refuse(&res),
        };
        if !covers(&view.selectors, &selector) {
            return http_error(403, "selector not visible");
        }

        // the cut, then the grant as of it, so that a revocation that lands before the cut hides
        // it
        self.before_read().await;
        let (blob, position) = match self.core.reader.snapshot(&selector).await {
            Ok(b) => b,
            Err(e) => return http_error(500, &e),
        };
        if let Some(resp) = self.not_visible(guard.id, &selector, position).await {
            return resp;
        }
        let mut resp = Response::new(Body::Full(Some(Bytes::from(blob))));
        let h = resp.headers_mut();
        set(h, "content-type", "application/octet-stream");
        set(h, "cache-control", "no-store");
        set(h, "phaselock-position", position.to_string());
        set(h, "phaselock-epoch", &self.epoch);
        resp
    }

    async fn before_read(&self) {
        if let Some(h) = self.hooks.before_read.get() {
            h().await;
        }
    }

    /// Serves a selector's edits with after < position < before, for a client tailing a
    /// snapshot, one edits frame per position.  Either bound may be omitted: no after is the
    /// start of the log, no before is the head.  A page holds max edits and the rest of the last
    /// one's position, since it never splits a mutation's edits, or fewer when the range runs
    /// out.  The PhaseLock-Scanned header is the client's next bound, to be used as-is: the last
    /// position delivered when the page was full, the far bound when the range is exhausted, and
    /// the last position delivered (or after itself) when the far bound is the head, so that
    /// clients at the head ask for the same page.
    async fn handle_edits(self: Arc<Self>, r: Request) -> Resp {
        let p = match self.principal_of(&r) {
            Ok(p) => p,
            Err(e) => return http_error(401, &e),
        };
        let selector = r.path["/edits/".len()..].to_string();
        if !names::valid_selector(&selector) {
            return http_error(400, "malformed selector");
        }
        let pos = |v: Option<&str>| -> Result<Option<u64>, ()> {
            match v {
                None | Some("") => Ok(None),
                Some(v) => {
                    v.parse::<u64>().ok().filter(|&n| n <= i64::MAX as u64).map(Some).ok_or(())
                }
            }
        };
        let (Ok(after), Ok(before)) = (pos(r.q("after")), pos(r.q("before"))) else {
            return http_error(400, "after and before must be positions");
        };
        let to_head = before.is_none();
        let after = after.unwrap_or(0);
        let before = before.unwrap_or(i64::MAX as u64);
        let reverse = r.q("reverse") == Some("true");
        let mut limit = EDITS_PAGE;
        if let Some(m) = r.q("max").filter(|m| !m.is_empty()) {
            match m.parse::<i64>() {
                Ok(n) if n >= 1 => limit = (n as usize).min(EDITS_PAGE),
                _ => return http_error(400, "max must be a positive integer"),
            }
        }
        let (guard, view) = self.view(&p, Vec::new(), true).await;
        let view = match view {
            Ok(v) => v,
            Err(res) => return refuse(&res),
        };
        if !covers(&view.selectors, &selector) {
            return http_error(403, "selector not visible");
        }

        // the edits, then the grant as of the head read after them, which bounds every edit read
        self.before_read().await;
        let items =
            match self.core.reader.read_edits(&selector, after, before, reverse, limit).await {
                Ok(i) => i,
                Err(e) => return http_error(500, &e),
            };
        let head = match self.core.reader.head().await {
            Ok(h) => h,
            Err(e) => return http_error(500, &e),
        };
        if let Some(resp) = self.not_visible(guard.id, &selector, head).await {
            return resp;
        }
        let mut scanned = if reverse || to_head { after } else { before };
        if items.len() >= limit || (to_head && !reverse && !items.is_empty()) {
            scanned = items.last().unwrap().position;
        }
        let mut body = Vec::new();
        let all = ["*".to_string()];
        for edits in group_positions(&items) {
            for c in edits_frame(&edits, &all).unwrap_or_default() {
                body.extend_from_slice(&c);
            }
        }
        let mut resp = reply_bytes("application/msgpack", body);
        let h = resp.headers_mut();
        set(h, "cache-control", "no-store");
        set(h, "phaselock-scanned", scanned.to_string());
        resp
    }
}

/// the encoded values of a msgpack array, each its own bytes
fn split_array(buf: &[u8]) -> Option<Vec<Vec<u8>>> {
    // the header: its length, and where the elements start
    let be = |b: &[u8]| b.iter().fold(0usize, |n, &c| n << 8 | c as usize);
    let (n, mut at) = match *buf.first()? {
        h @ 0x90..=0x9f => ((h & 0x0f) as usize, 1),
        0xdc => (be(buf.get(1..3)?), 3),
        0xdd => (be(buf.get(1..5)?), 5),
        _ => return None,
    };

    // each element, parsed once to find its end
    let mut out = Vec::with_capacity(n.min(buf.len()));
    for _ in 0..n {
        let (_, used) = mp::parse(buf.get(at..)?).ok()?;
        out.push(buf[at..at + used].to_vec());
        at += used;
    }
    Some(out)
}

/* Answers a request whose password hashing did not run: the client's budget is spent, the
hasher is full, or the server is going away.  Hashing runs before any mutation of a request
reaches the writer, so the request may be sent again; and no other refusal answers 429, so a
client may resend any request a 429 answers. */
pub fn hash_failed(e: HashError) -> Resp {
    match e {
        HashError::Limited => http_error(429, e.message()),
        _ => shed(e.message()),
    }
}

/// A stream's writer: frames go to the HTTP layer as chunks, and a test may hold the writer after
/// its first frame.
struct Out {
    tx: mpsc::Sender<Bytes>,
    // the hook awaited after the first frame, until it is written
    first: Option<crate::hooks::Hook>,
}

impl Out {
    /// writes one frame's chunks, answering false when the client has gone
    async fn write(&mut self, chunks: &[Bytes]) -> bool {
        // each chunk as it is, an edit's bytes shared with every connection it goes to
        for c in chunks {
            if self.tx.send(c.clone()).await.is_err() {
                return false;
            }
        }
        if let Some(h) = self.first.take() {
            h().await;
        }
        true
    }
}
