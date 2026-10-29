//! The core: the writer thread that owns QuickJS and the SQLite writer connection and runs every
//! request in group commits, the reader thread with its own connection, and the mutation check
//! that runs on the caller's task.  The async layer talks to the writer through a request queue
//! and hears back through one results channel; it talks to the reader through a job channel with
//! a reply per job.
//!
//! The core keeps one registration per principal: what the grantor allows it, and for a user,
//! what lookup answers for its token, each with what it read.  The writer brings each up to date
//! when it uses it, running it again only when a write before it in the batch touched what it
//! read, so every check in a mutation's turn sees the state the mutation does.  After each batch,
//! a grant or account the batch touched is run again for a registration with connections, and
//! otherwise forgotten until it is next used; then each connection whose grant changed gets a view
//! result, and an account result names each user whose generation changed or that the core
//! forgot, all ahead of the batch's commit.  A registration with no connections is dropped once
//! it has gone unused for the TTL.

mod prepare;
mod reader;
mod writer;

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use bytes::Bytes;
use tokio::sync::mpsc;

pub use prepare::{HashRefusal, PrepareError, Prepared, prepare};
pub use reader::Reader;

use crate::walk::Schema;

/// the length of a mutation's id, a label the client mints
pub const ID_LEN: usize = 16;

/// The writer bounces a call at most this many times; past it, a proven mutation whose
/// credentials changed again is rejected.
pub const MAX_BOUNCES: i32 = 3;

/// One edit as the wire sees it: data is the edit's msgpack array, its envelope and its payload's
/// items, and position the position of its mutation, which the mutation's other edits share.
#[derive(Clone, Debug)]
pub struct Item {
    pub slice: String,
    pub position: u64,
    pub data: Bytes,
}

/// A mutation's proof as checked: whether it carries one, and if so whether it passed against
/// hash, the password hash lookup answered for the sender's token, None for none.
#[derive(Clone, Debug, Default)]
pub struct Verdict {
    pub state: Proof,
    pub hash: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Proof {
    #[default]
    None,
    Passed,
    Failed,
}

/// A request to the writer.  A user of None is anonymous, and any other user's token must carry
/// the generation lookup answers for its account.
pub enum Req {
    /// mutations `prepare` prepared, with one verdict per mutation or none, and the number of
    /// times the call has bounced
    Submit {
        reqid: u64,
        user: Option<String>,
        generation: i64,
        body: Vec<u8>,
        verdicts: Vec<Verdict>,
        attempt: i32,
    },
    Register {
        reqid: u64,
        conn: u64,
        user: Option<String>,
        generation: i64,
    },
    Unregister {
        conn: u64,
    },
    Lookup {
        reqid: u64,
        ident: Vec<u8>,
    },
    /// what lookup answers for a user's token as of the request's turn
    Account {
        reqid: u64,
        user: String,
    },
    /// gives every cron entry without a mark the minute, and answers every entry's mark
    Arm {
        reqid: u64,
        minute: i64,
    },
    /// decides a slot of a cron entry
    Tick {
        reqid: u64,
        entry: usize,
        slot: i64,
    },
    /// stores a token key and deletes the keys sweep names, in one commit
    Key {
        reqid: u64,
        kid: String,
        public: Vec<u8>,
        minted: i64,
        sweep: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Kind {
    #[default]
    Shutdown,
    /// items: every edit of one group commit, in order
    Commit,
    /// buf: msgpack array of per-mutation outcomes
    Outcome,
    /// conn: an initial or changed grant
    View,
    /// buf: msgpack of lookup's return, empty for null
    Lookup,
    /// marks: every cron entry's mark, in entry order
    Arm,
    /// status 500 with errmsg when the tick's hook failed
    Tick,
    /// a token key and its sweep are durable
    Key,
    /// user: a user's account changed; or reqid: an Account request's answer
    Account,
}

/// One result of the writer.  status is 0, 401 for a stale token, or 500 with errmsg.
#[derive(Clone, Debug, Default)]
pub struct Res {
    pub kind: Kind,
    pub status: u16,
    pub reqid: u64,
    pub conn: u64,
    /// the last committed position when this result was made
    pub position: u64,
    pub items: Vec<Item>,
    pub buf: Vec<u8>,
    /// what the grantor allows, sorted and unique
    pub selectors: Vec<String>,
    pub errmsg: String,
    /// an outcome that stopped at a proven mutation whose credentials changed after its proof
    /// was checked: buf holds the outcomes of the mutations before it, and hash what lookup
    /// answers now
    pub bounce: bool,
    pub hash: Option<String>,
    /// an account: the generation lookup answers for user's token, -1 for no account, and in a
    /// change, whether the core has forgotten it
    pub user: String,
    pub generation: i64,
    pub forgotten: bool,
    pub marks: Vec<i64>,
}

/// one entry of a cron install, as the bundle names it
#[derive(Clone, Debug)]
pub struct CronEntry {
    pub install: String,
    pub name: String,
    pub spec: String,
}

pub struct Config {
    pub dir: String,
    pub bundle: String,
    pub env: Vec<String>,
    pub cache_mib: i64,
    pub ttl_ms: i64,
}

struct Queue {
    reqs: VecDeque<Req>,
    stop: bool,
    // tests only: the loop takes no batch while held, so requests queue to land in one
    held: bool,
}

struct Shared {
    q: Mutex<Queue>,
    cv: Condvar,
}

/// The core, as the async layer holds it.
pub struct Core {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    results: mpsc::UnboundedSender<Res>,
    pub reader: Reader,
    pub schema: Arc<Schema>,
    pub epoch: String,
    pub cron: Vec<CronEntry>,
}

impl Core {
    /// Opens the core over the data directory: the writer thread, which evaluates the bundle and
    /// on an empty log runs its bootstrap, then the reader.  Results arrive on the receiver.
    pub fn open(c: Config) -> Result<(Core, mpsc::UnboundedReceiver<Res>), String> {
        std::fs::create_dir_all(&c.dir).map_err(|e| format!("mkdir {}: {e}", c.dir))?;
        let epoch = load_epoch(&c.dir)?;
        let path = format!("{}/pldb.sqlite", c.dir);
        let shared = Arc::new(Shared {
            q: Mutex::new(Queue { reqs: VecDeque::new(), stop: false, held: false }),
            cv: Condvar::new(),
        });
        let (tx, rx) = mpsc::unbounded_channel();

        // the writer thread opens what it owns, then answers whether it opened
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let w = writer::Opening {
            path: path.clone(),
            bundle: c.bundle,
            env: c.env,
            cache_mib: c.cache_mib,
            ttl_ms: c.ttl_ms,
            shared: shared.clone(),
            results: tx.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("pldb-writer".into())
            .stack_size(16 << 20)
            .spawn(move || writer::run(w, ready_tx))
            .map_err(|e| format!("spawning the writer: {e}"))?;
        let (schema, cron) = match ready_rx.recv() {
            Ok(Ok(opened)) => opened,
            Ok(Err(e)) => {
                let _ = thread.join();
                return Err(e);
            }
            Err(_) => {
                let _ = thread.join();
                return Err("the writer thread ended while opening".into());
            }
        };
        let reader = match Reader::open(&path, c.cache_mib, epoch.clone()) {
            Ok(r) => r,
            Err(e) => {
                shared.q.lock().unwrap().stop = true;
                shared.cv.notify_all();
                let _ = thread.join();
                return Err(e);
            }
        };
        let core = Core {
            shared,
            thread: Mutex::new(Some(thread)),
            results: tx,
            reader,
            schema,
            epoch,
            cron,
        };
        Ok((core, rx))
    }

    pub fn send(&self, r: Req) {
        let mut q = self.shared.q.lock().unwrap();
        q.reqs.push_back(r);
        self.shared.cv.notify_one();
    }

    /// tests only: while held, the core takes no batch, so the requests queued meanwhile land in
    /// one
    pub fn hold_batches(&self, hold: bool) {
        let mut q = self.shared.q.lock().unwrap();
        q.held = hold;
        self.shared.cv.notify_one();
    }

    /// tests only: how many requests are queued for the core's next batch
    pub fn queued(&self) -> usize {
        self.shared.q.lock().unwrap().reqs.len()
    }

    /// Stops the writer once it has run the requests queued, the batch in hand committed, then
    /// pushes the shutdown result.
    pub fn close(&self) {
        let Some(thread) = self.thread.lock().unwrap().take() else { return };
        {
            let mut q = self.shared.q.lock().unwrap();
            q.stop = true;
            q.held = false;
            self.shared.cv.notify_all();
        }
        let _ = thread.join();
        self.reader.close();
        let _ = self.results.send(Res { kind: Kind::Shutdown, ..Default::default() });
    }
}

/// The epoch names this log instance: 32 hex digits minted the first time a data directory is
/// opened and kept in <dir>/epoch.  Positions mean nothing across epochs, so a copy of a data
/// directory that is to diverge from the original must get a fresh one.
fn load_epoch(dir: &str) -> Result<String, String> {
    let path = format!("{dir}/epoch");
    if let Ok(b) = std::fs::read(&path) {
        if b.len() < 32 {
            return Err(format!("{path}: not an epoch"));
        }
        return Ok(String::from_utf8_lossy(&b[..32]).into_owned());
    }
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|e| format!("random bytes: {e}"))?;
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = format!("{dir}/epoch.tmp");
    std::fs::write(&tmp, &hex)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(hex)
}

/// the wall clock in Unix milliseconds
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// a time as Unix milliseconds
pub fn unix_ms(t: std::time::SystemTime) -> i64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// a time as Unix seconds, rounded down
pub fn unix_s(t: std::time::SystemTime) -> i64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => {
            let d = e.duration();
            -(d.as_secs() as i64) - if d.subsec_nanos() > 0 { 1 } else { 0 }
        }
    }
}
