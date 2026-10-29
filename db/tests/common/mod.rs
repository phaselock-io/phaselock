//! The harness every feature test runs on.  A test's server runs in the test's own process,
//! serving a loopback port as the binary serves its listener, so the tests speak HTTP to it as
//! clients do and reach its internals, its core and its hooks, directly.

#![allow(dead_code)]

pub mod blob;
pub mod value;

use std::collections::BTreeMap;
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use phaselockdb::listen;
use phaselockdb::server::{Clock, Options, Server};

pub use blob::Blob;
pub use value::{V, decode, encode};

/// the replay's window, in positions
pub const COLD_BATCH: i64 = 1000;
pub const TOKEN_LIFETIME: Duration = Duration::from_secs(30 * 24 * 3600);
pub const KEY_GRACE: Duration = Duration::from_secs(24 * 3600);
/// how long before its token expires a connection ends
pub const EXPIRY_LEAD: Duration = Duration::from_secs(60);
pub const HEARTBEAT: Duration = Duration::from_secs(15);

// the codes of the end frames the database sends
pub const END_GRANTOR_FAILED: i64 = 600;
pub const END_OVERFLOW: i64 = 601;
pub const END_READ_FAILED: i64 = 602;
pub const END_REVOKED: i64 = 603;

// an edit's lifecycle, as its envelope carries it
pub const NORMAL: i64 = 0;
pub const BIRTH: i64 = 1;
pub const DEATH: i64 = 2;

/// how long a test waits for a frame before it fails
const FRAME_WAIT: Duration = Duration::from_secs(5);

/// a file of the test bundle's directory
pub fn testdata(name: &str) -> String {
    format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// The options a test's server opens with unless it changes them: a data directory of its own,
/// the dev test bundle, dev auth, an attempt budget no test of other features runs out of, and
/// the routes at the root.
pub fn options(dir: &Path) -> Options {
    Options {
        data_dir: dir.display().to_string(),
        bundle: testdata("bundle.js"),
        dev_auth: true,
        auth_burst: 1000,
        ..Default::default()
    }
}

// what a harness keeps until its last clone drops: the server, its listener's task, and a data
// directory the harness made
struct Life {
    srv: Arc<Server>,
    serving: Mutex<Option<JoinHandle<()>>>,
    stopped: AtomicBool,
    _dir: Option<tempfile::TempDir>,
}

impl Drop for Life {
    fn drop(&mut self) {
        // a test that did not stop its server, a failing one among them, ends it here
        if !self.stopped.load(Ordering::SeqCst) {
            self.srv.cancel();
            self.srv.core.close();
        }
    }
}

/// One server, as a test drives it; clones share it.
#[derive(Clone)]
pub struct Harness {
    pub srv: Arc<Server>,
    pub addr: SocketAddr,
    pub dir: PathBuf,
    life: Arc<Life>,
}

pub async fn start() -> Harness {
    start_with(|_| {}).await
}

/// a server over a data directory the test keeps, as one that restarts does
pub async fn start_in(dir: &Path) -> Harness {
    let dir = dir.to_path_buf();
    start_with(move |o| o.data_dir = dir.display().to_string()).await
}

/// a server with the test's changes to the options
pub async fn start_with(f: impl FnOnce(&mut Options)) -> Harness {
    try_start_with(f).await.unwrap_or_else(|e| panic!("open: {e}"))
}

/// a server with the test's changes to the options, or why it did not open
pub async fn try_start_with(f: impl FnOnce(&mut Options)) -> Result<Harness, String> {
    let tmp = tempfile::tempdir().expect("a data directory");
    let mut o = options(tmp.path());
    f(&mut o);
    let dir = PathBuf::from(&o.data_dir);
    let srv = Server::open(o).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
    let addr = listener.local_addr().unwrap();
    let serving = tokio::spawn(listen::serve(srv.clone(), listener, None));
    let life = Arc::new(Life {
        srv: srv.clone(),
        serving: Mutex::new(Some(serving)),
        stopped: AtomicBool::new(false),
        _dir: Some(tmp),
    });
    Ok(Harness { srv, addr, dir, life })
}

/// a response, its body whole
pub struct Response {
    pub status: u16,
    pub headers: http::HeaderMap,
    pub body: Vec<u8>,
}

impl Response {
    /// a header's value, "" when the response has none
    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// one request over a connection of its own, answered with the response's head and its body
async fn send(addr: SocketAddr, req: http::Request<Full<Bytes>>) -> http::Response<Incoming> {
    let stream = TcpStream::connect(addr).await.expect("connect");
    let (mut sender, conn) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.expect("handshake");
    tokio::spawn(conn);
    sender.send_request(req).await.expect("request")
}

fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> http::Request<Full<Bytes>> {
    let mut b = http::Request::builder().method(method).uri(path).header("host", addr.to_string());
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    if body.is_some() {
        b = b.header("content-type", "application/msgpack");
    }
    b.body(Full::new(Bytes::from(body.unwrap_or_default()))).expect("a request")
}

/// boxes a call for together
pub fn call<F: Future<Output = ()> + Send + 'static>(
    f: F,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(f)
}

impl Harness {
    /// Ends the server as the binary does: its lifetime, which ends every request under it, then
    /// the listener once its connections finish, then the hash pool and the core, which commits
    /// the batch in hand.
    pub async fn stop(&self) {
        if self.life.stopped.swap(true, Ordering::SeqCst) {
            return;
        }

        // a hook that holds a clone of the harness would keep the server alive past its end
        self.srv.hooks.clear_all();
        self.srv.cancel();
        let serving = self.life.serving.lock().unwrap().take();
        if let Some(s) = serving {
            let _ = s.await;
        }
        self.srv.close().await;
    }

    /// a request with a bearer token unless token is "", answered whole
    pub async fn req(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Vec<u8>>,
    ) -> Response {
        let auth = format!("Bearer {token}");
        let headers: Vec<(&str, &str)> =
            if token.is_empty() { Vec::new() } else { vec![("authorization", auth.as_str())] };
        self.req_with(method, path, &headers, body).await
    }

    /// a request with the headers given, answered whole
    pub async fn req_with(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Response {
        let resp = send(self.addr, request(self.addr, method, path, headers, body)).await;
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let body =
            resp.into_body().collect().await.map(|b| b.to_bytes().to_vec()).unwrap_or_default();
        Response { status, headers, body }
    }

    /// Signs in as an existing account with no credential, through dev auth; the test bundle's
    /// standing users, root (an admin) and p1, need no account in the log.
    pub async fn token(&self, identity: &str) -> String {
        let body = encode(&crate::obj! {"kind" => "dev", "identity" => identity});
        let r = self.req("POST", "/auth/token", "", Some(body)).await;
        assert_eq!(r.status, 200, "dev token for {identity}: {}", r.text());
        decode(&r.body)["token"].str().to_string()
    }

    pub async fn admin(&self) -> String {
        self.token("root").await
    }

    /// a password sign-in's status
    pub async fn login(&self, identity: &str, password: &str) -> u16 {
        self.req("POST", "/auth/token", "", Some(login_body(identity, password))).await.status
    }

    /// signs in with a password, which must succeed, answering the token
    pub async fn sign_in(&self, user: &str, password: &str) -> String {
        let r = self.req("POST", "/auth/token", "", Some(login_body(user, password))).await;
        assert_eq!(r.status, 200, "login as {user}: {}", r.text());
        decode(&r.body)["token"].str().to_string()
    }

    /// creates an account with a password, as anyone may, and signs in to it
    pub async fn sign_up(&self, user: &str, password: &str) -> String {
        let id = format!("signup-{user}");
        let m = crate::mutation!(&id, "create-account", "user" => user, "password" => password);
        self.accept("", m).await;
        self.sign_in(user, password).await
    }

    pub fn epoch(&self) -> &str {
        &self.srv.epoch
    }

    /// posts mutations, answering their outcomes; any status but 200 fails the test
    pub async fn mutations(&self, token: &str, muts: &[Mutation]) -> Vec<Outcome> {
        let (status, outs) = self.mutations_status(token, muts).await;
        assert_eq!(status, 200, "mutations: status {status}");
        outs
    }

    /// posts mutations, answering the status and, for a 200, their outcomes
    pub async fn mutations_status(&self, token: &str, muts: &[Mutation]) -> (u16, Vec<Outcome>) {
        let body: Vec<u8> = muts.iter().flat_map(|m| m.encode(None)).collect();
        self.mutations_raw_status(token, body).await
    }

    /// posts a body as it is, answering the status and, for a 200, the outcomes
    pub async fn mutations_raw_status(&self, token: &str, body: Vec<u8>) -> (u16, Vec<Outcome>) {
        let r = self.req("POST", "/mutations", token, Some(body)).await;
        if r.status != 200 {
            return (r.status, Vec::new());
        }
        (r.status, outcomes(&r.body))
    }

    /// posts one mutation with an expect map, answering its outcome
    pub async fn expecting(&self, token: &str, m: &Mutation, expect: V) -> Outcome {
        let r = self.req("POST", "/mutations", token, Some(m.encode(Some(&expect)))).await;
        assert_eq!(r.status, 200, "mutations: status {}", r.status);
        outcomes(&r.body).remove(0)
    }

    /// posts one mutation that must be accepted, answering its position
    pub async fn accept(&self, token: &str, m: Mutation) -> i64 {
        let o = self.mutations(token, std::slice::from_ref(&m)).await.remove(0);
        assert_eq!(o.kind, "ok", "expected ok for {}, got {o:?}", m.id);
        o.position
    }

    /// a connection since a position, wanting the selectors given or everything; the view frame
    /// a connection presenting no token gets first is set aside in its first
    pub async fn connect(&self, token: &str, since: i64, wants: &[&str]) -> Conn {
        self.connect_open(token, since, "", false, wants).await
    }

    /// a connection presenting a stored view token, its frames as they come
    pub async fn connect_view(&self, token: &str, since: i64, view: &str) -> Conn {
        self.connect_open(token, since, view, false, &[]).await
    }

    /// a connection whose reader reads nothing until it is resumed, its frames as they come
    pub async fn connect_paused(&self, token: &str, since: i64, wants: &[&str]) -> Conn {
        self.connect_open(token, since, "", true, wants).await
    }

    pub async fn connect_open(
        &self,
        token: &str,
        since: i64,
        view: &str,
        paused: bool,
        wants: &[&str],
    ) -> Conn {
        let mut q = format!("/stream?since={since}");
        if !view.is_empty() {
            q += &format!("&view={view}");
        }
        for w in wants {
            q += &format!("&want={w}");
        }
        let auth = format!("Bearer {token}");
        let headers: Vec<(&str, &str)> =
            if token.is_empty() { Vec::new() } else { vec![("authorization", auth.as_str())] };
        let resp = send(self.addr, request(self.addr, "GET", &q, &headers, None)).await;
        if resp.status() != 200 {
            let status = resp.status();
            let body = resp.into_body().collect().await.map(|b| b.to_bytes()).unwrap_or_default();
            panic!("connect: status {status}: {}", String::from_utf8_lossy(&body));
        }
        let headers = resp.headers().clone();

        // the reader: each msgpack value the body carries, then why it ended
        let (tx, rx) = mpsc::unbounded_channel();
        let (resume, resumed) = oneshot::channel::<()>();
        let reader = tokio::spawn(async move {
            if paused {
                let _ = resumed.await;
            }
            let mut body = resp.into_body();
            let mut buf = Vec::new();
            loop {
                match body.frame().await {
                    Some(Ok(f)) => {
                        let Ok(d) = f.into_data() else { continue };
                        buf.extend_from_slice(&d);
                        while let Some((v, used)) = value::decode_prefix(&buf) {
                            buf.drain(..used);
                            if tx.send(Ok(v)).is_err() {
                                return;
                            }
                        }
                    }
                    Some(Err(e)) => {
                        let _ = tx.send(Err(e.to_string()));
                        return;
                    }
                    None => {
                        let _ = tx.send(Err("the connection ended".into()));
                        return;
                    }
                }
            }
        });
        let mut c = Conn {
            rx,
            headers,
            first: None,
            pushed_back: None,
            resume: paused.then_some(resume),
            reader,
        };

        /* A connection presenting no token gets the view frame first; it is kept aside so tests
        see the frames a client with the current token sees, unless they asked for the frames as
        they come. */
        if view.is_empty() && !paused {
            let f = c.next().await;
            if f[0] == "view" {
                c.first = Some(f);
            } else {
                c.pushed_back = Some(f);
            }
        }
        c
    }

    /// a snapshot of the selector, parsed and checked against its headers
    pub async fn snapshot(&self, token: &str, selector: &str) -> Blob {
        let r = self.req("GET", &format!("/snapshot/{selector}"), token, None).await;
        assert_eq!(r.status, 200, "snapshot {selector}: {}", r.text());
        assert_eq!(
            r.header("content-length"),
            r.body.len().to_string(),
            "Content-Length for a {}-byte blob",
            r.body.len()
        );
        let b = blob::parse(&r.body);
        assert_eq!(r.header("phaselock-position"), b.position.to_string(), "the position header");
        assert_eq!(r.header("phaselock-epoch"), b.header["epoch"].str(), "the epoch header");

        // every slice with a key is in the slices map
        for k in &b.keys {
            let slice = &k[..k.find('!').unwrap()];
            assert!(b.slices.contains_key(slice), "key {k} of a slice missing from {:?}", b.slices);
        }
        b
    }

    /// The selector's edits with after < position < before, each bound left out when it is
    /// negative, newest first when reverse, at most max a page when max is not 0: the page's
    /// edits, its PhaseLock-Scanned, and its status, the edits empty for any status but 200.
    pub async fn edits_range(
        &self,
        token: &str,
        selector: &str,
        after: i64,
        before: i64,
        reverse: bool,
        max: usize,
    ) -> (Vec<Edit>, i64, u16) {
        let mut q = format!("/edits/{selector}?");
        if after >= 0 {
            q += &format!("&after={after}");
        }
        if before >= 0 {
            q += &format!("&before={before}");
        }
        if reverse {
            q += "&reverse=true";
        }
        if max > 0 {
            q += &format!("&max={max}");
        }
        let r = self.req("GET", &q, token, None).await;
        if r.status != 200 {
            return (Vec::new(), 0, r.status);
        }

        // the page's edits frames, back to back
        let mut evs = Vec::new();
        let mut rest = &r.body[..];
        while !rest.is_empty() {
            let (f, used) = value::decode_prefix(rest).expect("decode edits: a truncated frame");
            evs.extend(edits(&f));
            rest = &rest[used..];
        }
        let scanned = r.header("phaselock-scanned");
        let scanned = scanned.parse().unwrap_or_else(|_| panic!("scanned header: {scanned:?}"));
        (evs, scanned, r.status)
    }

    /// the messages a patron's slice holds, as an admin's snapshot reads them
    pub async fn messages(&self, patron: &str) -> Vec<String> {
        let b = self.snapshot(&self.admin().await, &format!("patron:{patron}")).await;
        match b.records.get(&format!("patron:{patron}!messages")) {
            Some(v) if !v.is_nil() => strs(v),
            _ => Vec::new(),
        }
    }

    /// Runs the calls with the core's batches held, each started once the one before it has
    /// queued its request, so their requests land in one batch, in order; answers once every
    /// call has returned.
    pub async fn together(&self, calls: Vec<Pin<Box<dyn Future<Output = ()> + Send>>>) {
        self.srv.core.hold_batches(true);
        let mut running = Vec::new();
        for (i, c) in calls.into_iter().enumerate() {
            running.push(tokio::spawn(c));
            let deadline = Instant::now() + FRAME_WAIT;
            while self.srv.core.queued() < i + 1 {
                if Instant::now() > deadline {
                    self.srv.core.hold_batches(false);
                    panic!("call {i} queued no request");
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        self.srv.core.hold_batches(false);
        for r in running {
            r.await.unwrap();
        }
    }
}

/// a password sign-in's body
pub fn login_body(identity: &str, password: &str) -> Vec<u8> {
    encode(&crate::obj! {"kind" => "password", "identity" => identity, "password" => password})
}

/// one outcome of a mutation
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub kind: String,
    pub position: i64,
    pub reason: String,
    /// a conflict's slices, each with its actual seq
    pub current: BTreeMap<String, i64>,
}

/// the outcomes of a /mutations response
pub fn outcomes(body: &[u8]) -> Vec<Outcome> {
    decode(body)
        .arr()
        .iter()
        .map(|o| {
            let mut out = Outcome { kind: o[0].str().to_string(), ..Default::default() };
            match out.kind.as_str() {
                "ok" => out.position = o[1].int(),
                "reject" => out.reason = o[1].str().to_string(),
                "conflict" => {
                    out.current = o[1].map().iter().map(|(k, v)| (k.clone(), v.int())).collect()
                }
                _ => {}
            }
            out
        })
        .collect()
}

/// a mutation to post: unnumbered unless in_series names its series and number
#[derive(Clone, Debug)]
pub struct Mutation {
    pub id: String,
    pub series: Option<(String, i64)>,
    pub data: V,
}

/// a mutation: its id, its type, and its data's other fields, `mutation!("c1", "add-book", "id"
/// => "b1", "title" => "Dune")`
#[macro_export]
macro_rules! mutation {
    ($id:expr, $typ:expr $(, $k:expr => $v:expr)* $(,)?) => {
        $crate::common::Mutation::new($id, $crate::obj!{"type" => $typ $(, $k => $v)*})
    };
}

impl Mutation {
    pub fn new(id: &str, data: V) -> Mutation {
        Mutation { id: id.to_string(), series: None, data }
    }

    /// the mutation as number n of a series
    pub fn in_series(mut self, series: &str, n: i64) -> Mutation {
        self.series = Some((series.to_string(), n));
        self
    }

    /// the mutation as the wire carries it, with an expect map when one is given
    pub fn encode(&self, expect: Option<&V>) -> Vec<u8> {
        let (series, n) = match &self.series {
            Some((s, n)) => (V::from(s.as_str()), V::Int(*n)),
            None => (V::Nil, V::Nil),
        };
        let mut v = vec![series, n, V::Bin(label(&self.id)), self.data.clone()];
        if let Some(e) = expect {
            v.push(e.clone());
        }
        encode(&V::Arr(v))
    }
}

/// a test's mutation id as the 16 bytes on the wire: its name, padded with zeros
pub fn label(id: &str) -> Vec<u8> {
    assert!(id.len() <= 16, "mutation id too long: {id}");
    let mut b = id.as_bytes().to_vec();
    b.resize(16, 0);
    b
}

/// An open /stream connection.  Dropping it closes the connection.
pub struct Conn {
    rx: mpsc::UnboundedReceiver<Result<V, String>>,
    pub headers: http::HeaderMap,
    /// the view frame a connection presenting no token got first
    pub first: Option<V>,
    pushed_back: Option<V>,
    resume: Option<oneshot::Sender<()>>,
    reader: JoinHandle<()>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Conn {
    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    /// starts a paused connection's reader
    pub fn resume(&mut self) {
        if let Some(r) = self.resume.take() {
            let _ = r.send(());
        }
    }

    /// the next frame, or why the connection ended, or None when none comes in time
    pub async fn try_next(&mut self, wait: Duration) -> Option<Result<V, String>> {
        if let Some(f) = self.pushed_back.take() {
            return Some(Ok(f));
        }
        tokio::time::timeout(wait, self.rx.recv()).await.ok().flatten()
    }

    /// the next frame; the connection's end or a wait past FRAME_WAIT fails the test
    pub async fn next(&mut self) -> V {
        match self.try_next(FRAME_WAIT).await {
            Some(Ok(f)) => f,
            Some(Err(e)) => panic!("connection ended: {e}"),
            None => panic!("timeout waiting for frame"),
        }
    }

    /// the next frame with the tag, past any vouches
    pub async fn next_tagged(&mut self, tag: &str) -> V {
        for _ in 0..50 {
            let f = self.next().await;
            if f[0] == tag {
                return f;
            }
            assert!(f[0] == "vouch", "expected {tag} frame, got {f:?}");
        }
        panic!("no {tag} frame after many vouches")
    }

    /// the once-per-connection live frame's position
    pub async fn live(&mut self) -> i64 {
        let f = self.next().await;
        assert!(f[0] == "live", "expected live frame, got {f:?}");
        f[1].int()
    }

    /// nothing but a vouch for a while
    pub async fn quiet(&mut self) {
        if let Some(r) = self.try_next(Duration::from_millis(200)).await {
            match r {
                Ok(f) => assert!(f[0] == "vouch", "expected silence, got {f:?}"),
                Err(e) => panic!("expected silence, the connection ended: {e}"),
            }
        }
    }

    /// whether the connection ends within wait, past any frames still to read
    pub async fn ends_within(&mut self, wait: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.try_next(left).await {
                Some(Ok(_)) => continue,
                Some(Err(_)) => return true,
                None => return false,
            }
        }
    }
}

/// one decoded edit: its envelope, and its payload's operations in order, with its sets by key
/// and its deletions
#[derive(Clone, Debug)]
pub struct Edit {
    pub position: i64,
    pub slice: String,
    pub seq: i64,
    /// the mutation id as it arrived
    pub id: Vec<u8>,
    /// the id as a test names it: its bytes without label's zeros
    pub mutation: String,
    pub servertime: SystemTime,
    pub lifecycle: i64,
    pub ops: Vec<EditOp>,
    pub sets: BTreeMap<String, V>,
    pub dels: Vec<String>,
}

/// one operation of an edit's payload: a set of key to value, or a deletion of key
#[derive(Clone, Debug)]
pub struct EditOp {
    pub del: bool,
    pub key: String,
    pub value: V,
}

impl Edit {
    /// an edit's wire array: the envelope, then the payload's items flat
    pub fn decode(v: &V) -> Edit {
        let a = v.arr();
        let env = &a[0];
        let id = env[3].bin().to_vec();
        let mut e = Edit {
            position: env[0].int(),
            slice: env[1].str().to_string(),
            seq: env[2].int(),
            mutation: String::from_utf8_lossy(&id).trim_end_matches('\0').to_string(),
            id,
            servertime: env[4].time(),
            lifecycle: env[5].int(),
            ops: Vec::new(),
            sets: BTreeMap::new(),
            dels: Vec::new(),
        };
        let mut i = 1;
        while i < a.len() {
            let key = a[i + 1].str().to_string();
            match a[i].int() {
                0 => {
                    e.ops.push(EditOp { del: false, key: key.clone(), value: a[i + 2].clone() });
                    e.sets.insert(key, a[i + 2].clone());
                    i += 3;
                }
                1 => {
                    e.ops.push(EditOp { del: true, key: key.clone(), value: V::Nil });
                    e.dels.push(key);
                    i += 2;
                }
                op => panic!("unknown opcode {op}"),
            }
        }
        e
    }

    /// a field of the value the edit sets at key, nil when it sets none
    pub fn field(&self, key: &str, name: &str) -> V {
        self.sets.get(key).map(|v| v[name].clone()).unwrap_or(V::Nil)
    }
}

/// the edits of an edits frame
pub fn edits(f: &V) -> Vec<Edit> {
    f[1].arr().iter().map(Edit::decode).collect()
}

/// an array of strings
pub fn strs(v: &V) -> Vec<String> {
    v.arr().iter().map(|s| s.str().to_string()).collect()
}

/// a settable clock
#[derive(Clone)]
pub struct TestClock(Arc<Mutex<SystemTime>>);

impl TestClock {
    pub fn new(t: SystemTime) -> TestClock {
        TestClock(Arc::new(Mutex::new(t)))
    }

    pub fn now(&self) -> SystemTime {
        *self.0.lock().unwrap()
    }

    pub fn set(&self, t: SystemTime) {
        *self.0.lock().unwrap() = t;
    }

    /// the clock as a server reads it
    pub fn clock(&self) -> Clock {
        let c = self.clone();
        Arc::new(move || c.now())
    }
}
