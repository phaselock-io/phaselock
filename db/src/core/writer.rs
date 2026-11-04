//! The writer thread: it owns QuickJS and the SQLite writer connection, takes every request
//! queued as one group commit, keeps the registrations, and commits each mutation's write buffer
//! as its edits.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use bytes::Bytes;
use phaselock_core::js::Owned;
use phaselock_core::mp::{self, Node};
use phaselock_core::names;
use phaselock_core::walk::Schema;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::readsets::{Cached, Call, ReadIndex, ReadSet};
use super::{
    CronEntry, ID_LEN, Item, Kind, MAX_BOUNCES, Proof, Req, Res, Shared, Submit, Verdict, now_ms,
};
use crate::buffer::Touched;
use crate::js::{self, Host};
use crate::store::Store;

/// the most slices one mutation's expectations may name
pub const EXPECT_MAX: usize = 1024;

/// where an edit stands in its slice's life, as its envelope carries it: a normal edit applies
/// its writes, a birth clears the slice first, and a death clears it and writes nothing
#[derive(Clone, Copy, PartialEq, Eq)]
enum Life {
    Normal = 0,
    Birth = 1,
    Death = 2,
}

pub(super) struct Opening {
    pub path: String,
    pub bundle: String,
    pub env: Vec<String>,
    pub cache_mib: i64,
    pub ttl_ms: i64,
    pub call_limit: std::time::Duration,
    pub hash: js::HashFn,
    pub check: bool,
    pub shared: Arc<Shared>,
    pub results: mpsc::UnboundedSender<Res>,
}

type Opened = Result<(Arc<Schema>, Vec<CronEntry>), String>;

/* One principal's registration, shared by every connection with the principal and kept for the
TTL once the last one closes: what the grantor allows it and, for a user, what lookup answers
for its token, each current while its flag is set.  Each keeps what the connections or the
server were last told of it, so a change made in a batch reaches them once, at the batch's
end. */
#[derive(Default)]
struct Reg {
    canon: String,
    user: Option<String>,

    // the grant
    granted: bool,
    selectors: Vec<String>,
    hash: String,            // of selectors, so a change to the set is one comparison
    failure: Option<String>, // what its connections are answered with when the grantor failed
    greads: ReadSet,
    sent: String, // the hash its connections were last sent, and whether it was a failure
    sent_failure: bool,

    // the account
    looked: bool,
    generation: i64, // -1 for no account
    password_hash: Option<String>,
    lookup_failure: Option<String>, // what a proof is rejected with when lookup failed
    areads: ReadSet,
    told: bool, // whether the server holds a generation for the user, and which
    told_generation: i64,

    conns: Vec<u64>,
    used: i64,    // when it was last used or left by its last connection, in Unix ms
    visited: u64, // the last batch whose settle visits it
}

/// one group commit as it runs: the edits it commits, and the registrations it answers once it
/// ends
struct Batch {
    id: u64,
    servertime: i64,
    commit: Vec<Item>,
    // (registration, index of its reply among the batch's answers)
    replies: Vec<(usize, usize)>,
    // the answers, pushed once the batch commits
    after: Vec<Res>,
}

impl Batch {
    fn new(id: u64) -> Batch {
        Batch {
            id,
            servertime: now_ms(),
            commit: Vec::new(),
            replies: Vec::new(),
            after: Vec::new(),
        }
    }
}

struct Writer {
    host: Host,
    store: Rc<Store>,
    shared: Arc<Shared>,
    results: mpsc::UnboundedSender<Res>,
    position: u64,
    batches: u64,

    // the registrations by id, None for a free one: an id is its registration's while it lives
    regs: Vec<Option<Reg>>,
    free: Vec<usize>,
    // {principal, in canonical form: its registration}
    by_principal: HashMap<String, usize>,
    // {connection: its principal's registration}
    by_conn: HashMap<u64, usize>,
    // what the registrations' cached calls read
    index: ReadIndex,
    // the registrations the batch's settle visits, each one once: those a write dirtied and those
    // whose call ran
    visits: Vec<usize>,
    // the calls a write touched, reused write to write
    hits: Vec<Call>,
    // tests only: whether every batch ends by checking the registrations against their maps,
    // dying when they disagree
    check: bool,
    ttl_ms: i64,
    cron: Vec<CronEntry>,
    cron_keys: Vec<String>, // each entry's series key, $cron:<install>,<entry>
}

// a call's read-set while the call is clean, for the index's lookups
fn clean(regs: &[Option<Reg>], c: Call) -> Option<&ReadSet> {
    let g = regs[c.reg].as_ref()?;
    let r = match c.what {
        Cached::Grant => &g.greads,
        Cached::Account => &g.areads,
    };
    (!r.dirty).then_some(r)
}

fn die(what: &str, e: String) -> ! {
    eprintln!("pldb: fatal: {what}: {e}");
    std::process::abort()
}

fn canon(user: Option<&str>) -> String {
    match user {
        Some(u) => format!("u:{u}"),
        None => "anon".into(),
    }
}

fn view_hash(selectors: &[String]) -> String {
    let mut sorted = selectors.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut h: u64 = 14695981039346656037;
    for s in &sorted {
        for &c in s.as_bytes().iter().chain(std::iter::once(&0u8)) {
            h ^= c as u64;
            h = h.wrapping_mul(1099511628211);
        }
    }
    format!("{h:016x}")
}

/// a mutation id written as a uuid, for the server's log
fn format_id(id: &[u8]) -> String {
    let mut s = String::new();
    for (i, b) in id.iter().enumerate() {
        if [4, 6, 8, 10].contains(&i) {
            s.push('-');
        }
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn write_reason(w: &mut mp::Writer, kind: &str, reason: &str) {
    w.array(2);
    w.str(kind.as_bytes());
    w.str(reason.as_bytes());
}

// write an ok outcome: the mutation was decided at or before position
fn write_ok(w: &mut mp::Writer, position: u64) {
    w.array(2);
    w.str(b"ok");
    w.uint(position);
}

/// whether a view, the grantor's selectors in wire form, covers a slice
fn view_covers(view: &[String], slice: &[u8]) -> bool {
    view.iter().any(|sel| {
        if names::is_prefix_selector(sel) {
            slice.starts_with(&sel.as_bytes()[..sel.len() - 1])
        } else {
            sel.as_bytes() == slice
        }
    })
}

enum ProofCheck {
    Holds,
    Decided,
    Bounced(Option<String>),
}

pub(super) fn run(o: Opening, ready: std::sync::mpsc::Sender<Opened>) {
    let mut w = match open(o) {
        Ok(w) => w,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok((w.host.schema(), w.cron.clone())));
    w.host.bind_thread();
    w.run_loop();
}

/// opens the writer's store and host, and runs bootstrap on an empty log
fn open(o: Opening) -> Result<Writer, String> {
    let store = Rc::new(Store::open(&o.path, true, o.cache_mib)?);
    let position = store.max_position()?;
    let host = Host::open(
        &o.bundle,
        js::Options {
            store: store.clone(),
            env_names: o.env.clone(),
            hasher: o.hash,
            call_limit: o.call_limit,
        },
    )?;
    host.bind_thread();
    let mut w = Writer {
        host,
        store,
        shared: o.shared.clone(),
        results: o.results.clone(),
        position,
        batches: 0,
        regs: Vec::new(),
        free: Vec::new(),
        by_principal: HashMap::new(),
        by_conn: HashMap::new(),
        index: ReadIndex::default(),
        visits: Vec::new(),
        hits: Vec::new(),
        check: o.check,
        ttl_ms: o.ttl_ms,
        cron: Vec::new(),
        cron_keys: Vec::new(),
    };
    if w.position == 0 {
        w.bootstrap()?;
    }
    w.load_cron()?;
    Ok(w)
}

impl Writer {
    fn run_loop(&mut self) {
        loop {
            let reqs: Vec<Req> = {
                let mut q = self.shared.q.lock().unwrap();
                while (q.reqs.is_empty() || q.held) && !q.stop {
                    q = self.shared.cv.wait(q).unwrap();
                }
                if q.stop && q.reqs.is_empty() {
                    break;
                }
                q.reqs.drain(..).collect()
            };
            self.run_batch(reqs);
        }
    }

    /// What a client is told of a failure that is a bug, as opposed to a rejection: the whole
    /// error when the bundle is a dev build, and "internal error" otherwise.  The whole error goes
    /// to the log either way, under the mutation it failed when it failed one.
    fn bug_reason(&self, id: Option<&[u8]>, msg: String) -> String {
        match id {
            Some(id) => eprintln!("pldb: mutation {}: {msg}", format_id(id)),
            None => eprintln!("pldb: {msg}"),
        }
        if self.host.dev { msg } else { "internal error".into() }
    }

    // registrations //////////////////////////////////////////////////////////

    fn reg(&self, i: usize) -> &Reg {
        self.regs[i].as_ref().expect("a live registration")
    }

    fn reg_mut(&mut self, i: usize) -> &mut Reg {
        self.regs[i].as_mut().expect("a live registration")
    }

    // lists the registration for the batch's settle, once
    fn visit(&mut self, b: &Batch, i: usize) {
        if self.reg(i).visited == b.id {
            return;
        }
        self.reg_mut(i).visited = b.id;
        self.visits.push(i);
    }

    // a call's read-set, and its registration's flag that the call holds an answer
    fn read_set(&mut self, c: Call) -> &mut ReadSet {
        let g = self.reg_mut(c.reg);
        match c.what {
            Cached::Grant => &mut g.greads,
            Cached::Account => &mut g.areads,
        }
    }

    // replaces a call's read-set in the index, the one it held dropped
    fn relink(&mut self, c: Call, next: ReadSet) {
        let old = std::mem::replace(self.read_set(c), next);
        self.index.unlink(c, &old);
        let next = std::mem::take(self.read_set(c));
        self.index.link(c, &next);
        *self.read_set(c) = next;
    }

    // dirties each call in hits, listing its registration for the batch's settle
    fn dirty(&mut self, b: &Batch, hits: &mut Vec<Call>) {
        for c in hits.drain(..) {
            let r = self.read_set(c);
            if r.dirty {
                continue;
            }
            r.dirty = true;
            self.visit(b, c.reg);
        }
    }

    // dirties every call a written key touched
    fn written(&mut self, b: &Batch, key: &[u8]) {
        let mut hits = std::mem::take(&mut self.hits);
        let regs = &self.regs;
        self.index.written(key, |c| clean(regs, c), &mut hits);
        self.dirty(b, &mut hits);
        self.hits = hits;
    }

    // dirties every call a cleared slice, its prefix "<slice>!", touched
    fn cleared(&mut self, b: &Batch, prefix: &[u8]) {
        let mut hits = std::mem::take(&mut self.hits);
        let regs = &self.regs;
        self.index.cleared(prefix, |c| clean(regs, c), &mut hits);
        self.dirty(b, &mut hits);
        self.hits = hits;
    }

    /* Runs the grantor for the registration, replacing its selectors and read-set.  A grantor
    that throws or returns a malformed selector is a bug, and the registration fails closed: it
    grants nothing, and every connection of it is answered with the failure. */
    fn grant_run(&mut self, b: &Batch, i: usize) {
        let p = self.host.principal(self.reg(i).user.as_deref());
        let (r, reads) = self.host.recording(|h| h.grant(p.v));
        drop(p);
        self.relink(Call { reg: i, what: Cached::Grant }, ReadSet::of(reads));
        self.visit(b, i);

        // every selector in wire form, or the first failure
        let (selectors, msg) = match r {
            Err(e) => (Vec::new(), Some(format!("grant failed: {e}"))),
            Ok(raw) => {
                let mut out = Vec::with_capacity(raw.len());
                let mut msg = None;
                for s in raw {
                    match names::normalize_bundle_selector(&s) {
                        Some(n) => out.push(n),
                        None => {
                            msg = Some(format!("grant returned a malformed selector: {s}"));
                            break;
                        }
                    }
                }
                (out, msg)
            }
        };
        let failure = msg.map(|m| self.bug_reason(None, m));
        let g = self.reg_mut(i);
        g.selectors = if failure.is_some() { Vec::new() } else { selectors };
        g.failure = failure;
        g.hash = view_hash(&g.selectors);
        g.granted = true;
    }

    fn grant_forget(&mut self, i: usize) {
        self.relink(Call { reg: i, what: Cached::Grant }, ReadSet::default());
        let g = self.reg_mut(i);
        g.granted = false;
        g.selectors.clear();
        g.failure = None;
    }

    /* Runs lookup for the user's token, replacing the account and its read-set.  A lookup that
    throws is a bug, and the account fails closed: it is no account, so the user's tokens are
    refused. */
    fn account_run(&mut self, b: &Batch, i: usize) {
        let p = self.host.principal(self.reg(i).user.as_deref());
        let (r, reads) = self.host.recording(|h| h.account(p.v));
        drop(p);
        self.relink(Call { reg: i, what: Cached::Account }, ReadSet::of(reads));
        self.visit(b, i);
        let (generation, hash, failure) = match r {
            Ok((g, h)) => (g, h, None),
            Err(e) => (-1, None, Some(self.bug_reason(None, format!("lookup failed: {e}")))),
        };
        let g = self.reg_mut(i);
        g.generation = generation;
        g.password_hash = hash;
        g.lookup_failure = failure;
        g.looked = true;
    }

    fn account_forget(&mut self, i: usize) {
        self.relink(Call { reg: i, what: Cached::Account }, ReadSet::default());
        let g = self.reg_mut(i);
        g.looked = false;
        g.password_hash = None;
        g.lookup_failure = None;
    }

    // the principal's registration, made when it has none, used now
    fn reg_of(&mut self, b: &Batch, user: Option<&str>) -> usize {
        let c = canon(user);
        let i = match self.by_principal.get(&c) {
            Some(&i) => i,
            None => {
                let g =
                    Reg { canon: c.clone(), user: user.map(String::from), ..Default::default() };
                let i = match self.free.pop() {
                    Some(i) => i,
                    None => {
                        self.regs.push(None);
                        self.regs.len() - 1
                    }
                };
                self.regs[i] = Some(g);
                self.by_principal.insert(c, i);
                i
            }
        };
        self.reg_mut(i).used = b.servertime;
        i
    }

    // the principal's registration, its grant current as of this point in the batch
    fn reg_grant(&mut self, b: &Batch, user: Option<&str>) -> usize {
        let i = self.reg_of(b, user);
        let g = self.reg(i);
        if !g.granted || g.greads.dirty {
            self.grant_run(b, i);
        }
        i
    }

    // the user's registration, its account current as of this point in the batch
    fn reg_account(&mut self, b: &Batch, user: &str) -> usize {
        let i = self.reg_of(b, Some(user));
        let g = self.reg(i);
        if !g.looked || g.areads.dirty {
            self.account_run(b, i);
        }
        i
    }

    // the stale-token check: whether the token speaks for its user's account at its generation
    fn generation_ok(&mut self, b: &Batch, user: Option<&str>, generation: i64) -> bool {
        match user {
            Some(u) => {
                let i = self.reg_account(b, u);
                self.reg(i).generation == generation
            }
            None => true,
        }
    }

    // a view result's answer: what the grantor allows, sorted and unique, or its failure
    fn view_fill(r: &mut Res, g: &Reg) {
        if let Some(f) = &g.failure {
            r.status = 500;
            r.errmsg = f.clone();
            return;
        }
        let mut s = g.selectors.clone();
        s.sort();
        s.dedup();
        r.selectors = s;
    }

    fn handle_register(
        &mut self,
        b: &mut Batch,
        reqid: u64,
        conn: u64,
        user: Option<String>,
        generation: i64,
    ) {
        if !self.generation_ok(b, user.as_deref(), generation) {
            b.after.push(Res { kind: Kind::View, status: 401, conn, reqid, ..Default::default() });
            return;
        }
        let i = self.reg_grant(b, user.as_deref());
        self.reg_mut(i).conns.push(conn);
        self.by_conn.insert(conn, i);

        // the reply goes out with the batch's other answers, its view filled at the batch's end
        b.replies.push((i, b.after.len()));
        b.after.push(Res { kind: Kind::View, conn, reqid, ..Default::default() });
    }

    // the TTL of a registration its last connection leaves runs from now
    fn handle_unregister(&mut self, b: &Batch, conn: u64) {
        let Some(i) = self.by_conn.remove(&conn) else { return };
        let g = self.reg_mut(i);
        if let Some(at) = g.conns.iter().position(|&c| c == conn) {
            g.conns.swap_remove(at);
        }
        if g.conns.is_empty() {
            g.used = b.servertime;
        }
    }

    // what lookup answers for the user's token as of the request's turn
    fn handle_account(&mut self, b: &mut Batch, reqid: u64, user: String) {
        let i = self.reg_account(b, &user);
        let g = self.reg(i);
        let mut r = Res { kind: Kind::Account, reqid, ..Default::default() };
        match &g.lookup_failure {
            Some(f) => {
                r.status = 500;
                r.errmsg = f.clone();
            }
            None => {
                r.user = user;
                r.generation = g.generation;
                r.hash = g.password_hash.clone();
            }
        }
        b.after.push(r);
    }

    // an account result telling the server the user's generation, or to forget it
    fn account_result(g: &Reg, forgotten: bool) -> Res {
        Res {
            kind: Kind::Account,
            user: g.user.clone().unwrap_or_default(),
            generation: g.generation,
            forgotten,
            ..Default::default()
        }
    }

    /* Brings every registration the batch visits to the batch's end: each one a write dirtied,
    and each one whose call ran, since no other one's grant or account changed.  A grant or
    account a write dirtied is run again for a registration with connections, which hear of a
    change ahead of the batch's edits, and is otherwise forgotten until it is next used.  Then
    each connection whose grant changed since it was last sent one gets a view result, but the
    ones registered in the batch, whose replies answer them; and the server gets an account
    result for each user whose generation changed since it was last told one, or that the core
    forgot. */
    fn settle(&mut self, b: &Batch, accounts: &mut Vec<Res>, views: &mut Vec<Res>) {
        let mut visits = std::mem::take(&mut self.visits);
        for &i in &visits {
            // the grant
            let g = self.reg(i);
            if g.granted && g.greads.dirty {
                if !g.conns.is_empty() {
                    self.grant_run(b, i);
                } else {
                    self.grant_forget(i);
                }
            }

            // the connections, when it changed
            let position = self.position;
            let g = self.reg_mut(i);
            let failed = g.failure.is_some();
            if g.granted && (g.hash != g.sent || failed != g.sent_failure) {
                /* the whole set goes out on every change, and a failure; the server cuts a set
                down to each connection's wants and decides whether that view changed */
                for &c in &g.conns {
                    if b.replies.iter().any(|&(_, at)| b.after[at].conn == c) {
                        continue;
                    }
                    let mut r = Res { kind: Kind::View, conn: c, position, ..Default::default() };
                    Self::view_fill(&mut r, g);
                    views.push(r);
                }
                g.sent = g.hash.clone();
                g.sent_failure = failed;
            }

            // the account
            if g.user.is_none() {
                continue;
            }
            if g.looked && g.areads.dirty {
                if !g.conns.is_empty() {
                    self.account_run(b, i);
                } else {
                    self.account_forget(i);
                }
            }

            // the server's generation, when it is no longer the core's
            let g = self.reg_mut(i);
            if g.looked && (!g.told || g.told_generation != g.generation) {
                accounts.push(Self::account_result(g, false));
                g.told = true;
                g.told_generation = g.generation;
            } else if !g.looked && g.told {
                accounts.push(Self::account_result(g, true));
                g.told = false;
            }
        }
        visits.clear();
        self.visits = visits;
    }

    // drops every registration without connections that has gone unused for the TTL
    fn expire(&mut self, now: i64, accounts: &mut Vec<Res>) {
        for i in 0..self.regs.len() {
            let Some(g) = &self.regs[i] else { continue };
            if !g.conns.is_empty() || now - g.used < self.ttl_ms {
                continue;
            }
            if g.told {
                accounts.push(Self::account_result(g, true));
            }
            self.relink(Call { reg: i, what: Cached::Grant }, ReadSet::default());
            self.relink(Call { reg: i, what: Cached::Account }, ReadSet::default());
            let g = self.regs[i].take().expect("a live registration");
            self.by_principal.remove(&g.canon);
            self.free.push(i);
        }
    }

    /* Tests only: whether the registrations, their maps, and the read-set index agree as a batch
    leaves them, and where they do not: each live registration is its principal's and each of
    its connections', the index holds exactly what the calls holding an answer read, and settle
    left no call dirty. */
    fn check_registrations(&self) -> Result<(), String> {
        let ensure = |ok: bool, what: &dyn Fn() -> String| if ok { Ok(()) } else { Err(what()) };
        let mut index = ReadIndex::default();
        let (mut live, mut conns) = (0, 0);
        for (i, g) in self.regs.iter().enumerate() {
            let Some(g) = g else { continue };
            live += 1;
            conns += g.conns.len();
            let c = &g.canon;
            ensure(self.by_principal.get(c) == Some(&i), &|| format!("{c} is not mapped to {i}"))?;
            for k in &g.conns {
                ensure(self.by_conn.get(k) == Some(&i), &|| format!("connection {k} of {c}"))?;
            }
            ensure(!g.greads.dirty && !g.areads.dirty, &|| format!("{c} left dirty"))?;
            let unread = |r: &ReadSet| r.keys.is_empty() && r.spans.is_empty();
            ensure(g.granted || unread(&g.greads), &|| format!("{c}'s forgotten grant read"))?;
            ensure(g.looked || unread(&g.areads), &|| format!("{c}'s forgotten account read"))?;
            index.link(Call { reg: i, what: Cached::Grant }, &g.greads);
            index.link(Call { reg: i, what: Cached::Account }, &g.areads);
        }
        ensure(self.by_principal.len() == live, &|| {
            "a principal mapped to no registration".into()
        })?;
        ensure(self.by_conn.len() == conns, &|| "a connection mapped to no registration".into())?;
        ensure(index == self.index, &|| "the index differs from the registrations' reads".into())?;
        ensure(self.visits.is_empty(), &|| "visits left for the next batch".into())
    }

    // the write path ///////////////////////////////////////////////////////////

    /* The OCC check: every expected slice's seq must be exactly what the client names (0 for
    never born).  An expectation answers a slice's seq, so the sender may name only slices its
    grant covers when the mutation's turn comes; naming another rejects the mutation, whether or
    not the slice exists.  Writes the reject, or a conflict outcome listing each mismatched
    slice's actual seq, and answers whether either is written. */
    fn check_expect(
        &mut self,
        b: &Batch,
        w: &mut mp::Writer,
        expect: Option<&Node<'_>>,
        user: Option<&str>,
    ) -> bool {
        let Some(expect) = expect.and_then(|e| e.map()) else { return false };
        if expect.is_empty() {
            return false;
        }

        // what the sender may see; a grantor that fails grants nothing
        let i = self.reg_grant(b, user);
        let g = self.reg(i);
        if let Some(f) = &g.failure {
            write_reason(w, "reject", f);
            return true;
        }

        // every expected slice inside it
        for (k, _) in expect {
            let name = k.as_str().unwrap_or(b"");
            if !view_covers(&g.selectors, name) {
                let reason = format!(
                    "expect: {} is not a slice the sender may see",
                    String::from_utf8_lossy(name)
                );
                write_reason(w, "reject", &reason);
                return true;
            }
        }

        // the slices whose seq differs from what the client named, with their seq
        let mut conflicts = Vec::new();
        for (k, v) in expect {
            let name = k.as_str().unwrap_or(b"");
            let (seq, _) = self.store.slice_state(name).unwrap_or_else(|e| die("slice_state", e));
            if Some(seq) != v.as_u64() {
                conflicts.push((name, seq));
            }
        }
        if conflicts.is_empty() {
            return false;
        }
        w.array(2);
        w.str(b"conflict");
        w.map(conflicts.len());
        for (name, seq) in conflicts {
            w.str(name);
            w.uint(seq);
        }
        true
    }

    /* Commits one slice's part of a mutation as its edit, at the mutation's position, which its
    first edit takes.  The lifecycle follows from the buffer and the slice's row: a slice the
    buffer deleted is born again when the buffer wrote to it after, and otherwise dies, if it
    was live; a slice the buffer only wrote is edited when it is live, and born when it is
    unborn or deleted.  An unborn or deleted slice that gains no key is no edit. */
    fn commit_slice(&mut self, b: &mut Batch, id: &[u8], t: &Touched<'_>, position: &mut u64) {
        // the slice, where it stands, and whether the buffer sets any of its keys
        let name = String::from_utf8_lossy(t.name).into_owned();
        let (seq, live) = self.store.slice_state(t.name).unwrap_or_else(|e| die("slice_state", e));
        let sets = t.entries.iter().any(|(_, v)| v.is_some());

        // its lifecycle, or no edit
        let life = match t.del {
            Some(_) if sets => Life::Birth,
            Some(_) => Life::Death,
            None if live => Life::Normal,
            None => Life::Birth,
        };
        if !live && (life == Life::Death || !sets) {
            return;
        }
        if *position == 0 {
            self.position += 1;
            *position = self.position;
        }
        let pos = *position;

        // the slice's row: a birth revives it, a death ends it, and an erasure drops its edits
        // before this one
        let st = Rc::clone(&self.store);
        if life == Life::Birth {
            st.slice_birth(&name, pos).unwrap_or_else(|e| die("slice_birth", e));
        }
        if life == Life::Death {
            st.slice_death(&name, pos).unwrap_or_else(|e| die("slice_death", e));
        }
        if t.del == Some(true) {
            st.slice_erase(&name, pos).unwrap_or_else(|e| die("slice_erase", e));
        }

        // the store: a live slice's birth or death clears it first, then the edit's operations
        // apply
        if live && life != Life::Normal {
            let mut prefix = t.name.to_vec();
            prefix.push(b'!');
            st.del_prefix(&prefix).unwrap_or_else(|e| die("del_prefix", e));
            self.cleared(b, &prefix);
        }
        if life != Life::Death {
            for &(k, v) in &t.entries {
                match v {
                    None if life == Life::Birth => continue,
                    Some(v) => st.set(k, v),
                    None => st.del(k),
                }
                .unwrap_or_else(|e| die("apply", e));
                self.written(b, k);
            }
        }

        // the edit, appended to the log at the slice's next seq and queued for the connections
        let edit = encode_edit(pos, &name, seq + 1, id, b.servertime, life, &t.entries);
        let next = st.slice_next_seq(&name, edit.len(), pos).unwrap_or_else(|e| die("next_seq", e));
        if next != seq + 1 {
            die("slice", format!("{name}: seq {next} after {seq}"));
        }
        st.append(pos, &name, next, life as u8, &edit).unwrap_or_else(|e| die("append", e));
        b.commit.push(Item { slice: name, position: pos, data: Bytes::from(edit) });
    }

    /// Commits the write buffer as the mutation's edits, one per slice it touched, in name order,
    /// all at one position, and empties the buffer.  A mutation that edits nothing takes no
    /// position.
    fn commit_edits(&mut self, b: &mut Batch, id: &[u8]) {
        let wb = std::mem::take(&mut *self.host.state().wb.borrow_mut());
        let mut position = 0;
        for t in wb.touched() {
            self.commit_slice(b, id, &t, &mut position);
        }
    }

    fn clear_buffer(&self) {
        self.host.state().wb.borrow_mut().clear();
    }

    /// Decides one mutation: expect, then the decider over the write buffer, whose writes become
    /// the mutation's edits when it carries the mutation out.  A reject, a conflict, or a throw
    /// discards the buffer, leaving nothing in the log or the store.
    #[allow(clippy::too_many_arguments)]
    fn decide(
        &mut self,
        b: &mut Batch,
        w: &mut mp::Writer,
        id: &[u8],
        data: &Owned,
        expect: Option<&Node<'_>>,
        user: Option<&str>,
        principal: &Owned,
    ) {
        // the client's expectations of its slices
        if self.check_expect(b, w, expect, user) {
            return;
        }

        // the decider, writing into the buffer
        let reason = match self.host.decide(data.v, principal.v) {
            Ok(r) => r,
            Err(e) => Some(self.bug_reason(Some(id), format!("decide error: {e}"))),
        };
        if let Some(reason) = reason {
            self.clear_buffer();
            write_reason(w, "reject", &reason);
            return;
        }

        // the edits, answered ok at the head after them
        self.commit_edits(b, id);
        write_ok(w, self.position);
    }

    /* A proven mutation's proof, against what lookup answers for its sender now, which is what
    the decider would read: Holds when it passed against the same hash; Decided with a rejection
    written when it failed against the same hash, or lookup failed; and Bounced with the hash
    lookup answers when the hash changed after the proof was checked, so that the proof is
    checked again against it.  A call that has bounced MAX_BOUNCES times is rejected instead,
    since its sender's credentials keep changing under it. */
    fn check_proof(
        &mut self,
        b: &Batch,
        w: &mut mp::Writer,
        v: &Verdict,
        attempt: i32,
        user: Option<&str>,
    ) -> ProofCheck {
        // the hash, none for the anonymous principal
        let mut now = None;
        if let Some(u) = user {
            let i = self.reg_account(b, u);
            let g = self.reg(i);
            if let Some(f) = &g.lookup_failure {
                write_reason(w, "reject", f);
                return ProofCheck::Decided;
            }
            now = g.password_hash.clone();
        }

        // has the hash changed since the proof was checked?
        let same = now == v.hash;
        if !same && attempt < MAX_BOUNCES {
            return ProofCheck::Bounced(now);
        }
        if !same {
            let reason = format!(
                "the sender's credentials changed {} times while its proof was checked",
                MAX_BOUNCES + 1
            );
            write_reason(w, "reject", &reason);
            return ProofCheck::Decided;
        }

        // with the credentials unchanged, a failed verdict stands
        if v.state == Proof::Failed {
            write_reason(w, "reject", "invalid credentials");
            return ProofCheck::Decided;
        }
        ProofCheck::Holds
    }

    /* One mutation, its outcome written into w.  A mutation in a series passes the dedup check
    first, against the group's open transaction, so it sees every decision ahead of it in its
    group: a number at or below the series' mark was decided already, and anything else runs,
    an unknown series included, since series rows are kept forever.  A proven mutation's proof
    is checked next, before its expectations, so a failed proof never learns a slice's seq.
    Every decision moves the mark, whatever it decided.  Answers Some with what lookup answers
    when the mutation bounced instead, which decides nothing and writes no outcome. */
    #[allow(clippy::too_many_arguments)]
    fn run_mutation(
        &mut self,
        b: &mut Batch,
        w: &mut mp::Writer,
        series: Option<(&str, u64)>,
        id: &[u8],
        data: &Owned,
        expect: Option<&Node<'_>>,
        user: Option<&str>,
        principal: &Owned,
        verdict: Option<&Verdict>,
        attempt: i32,
    ) -> Option<Option<String>> {
        // the dedup check
        if let Some((key, n)) = series {
            let hwm = self.store.series_hwm(key).unwrap_or_else(|e| die("series_hwm", e));
            if hwm.is_some_and(|h| n <= h) {
                write_ok(w, self.position);
                return None;
            }
        }

        // the proof, then the mutation
        let proof = match verdict {
            Some(v) if v.state != Proof::None => self.check_proof(b, w, v, attempt, user),
            _ => ProofCheck::Holds,
        };
        match proof {
            ProofCheck::Bounced(h) => return Some(h),
            ProofCheck::Holds => self.decide(b, w, id, data, expect, user, principal),
            ProofCheck::Decided => {}
        }

        // the decision moves the mark
        if let Some((key, n)) = series {
            self.store.series_mark(key, n, b.servertime).unwrap_or_else(|e| die("series_mark", e));
        }
        None
    }

    fn handle_submit(&mut self, b: &mut Batch, s: Submit) {
        let Submit { reqid, user, generation, body, verdicts, attempt } = s;
        let mut r = Res { kind: Kind::Outcome, reqid, ..Default::default() };
        if !self.generation_ok(b, user.as_deref(), generation) {
            r.status = 401;
            b.after.push(r);
            return;
        }
        let principal = self.host.principal(user.as_deref());
        let mutations = self.host.schema().mutations();

        /* walk the prepared [key, n, id, data, expect?] values, each already checked, with a
        series' key or nil in place of the series, until one bounces */
        let mut outcomes = mp::Writer::new();
        let mut count = 0usize;
        let mut consumed = 0;
        let mut k = 0;
        while consumed < body.len() && !r.bounce {
            let (c, used) = mp::parse(&body[consumed..])
                .unwrap_or_else(|e| die("prepared body", e.to_string()));
            consumed += used;
            let items = c.array().unwrap_or_else(|| die("prepared body", "not an array".into()));

            // the series' key and the mutation's number, or none for an unnumbered mutation
            let series = items[0].as_str().map(|key| {
                (std::str::from_utf8(key).unwrap_or(""), items[1].as_u64().unwrap_or(0))
            });
            let id = match &items[2] {
                Node::Bin(b) => *b,
                _ => die("prepared body", "no id".into()),
            };
            let expect = items.get(4);

            // the data as a JS value, and the expectations
            let data = mutations
                .ok_or_else(|| "this database takes no mutations".to_string())
                .and_then(|t| self.host.prepared_data(&items[3], t));
            match data {
                Err(why) => write_reason(&mut outcomes, "reject", &why),
                Ok(data) => {
                    let v = verdicts.get(k);
                    if let Some(hash) = self.run_mutation(
                        b,
                        &mut outcomes,
                        series,
                        id,
                        &data,
                        expect,
                        user.as_deref(),
                        &principal,
                        v,
                        attempt,
                    ) {
                        r.bounce = true;
                        r.hash = hash;
                        k += 1;
                        continue;
                    }
                }
            }
            count += 1;
            k += 1;
        }
        let mut w = mp::Writer::new();
        w.array(count);
        w.raw(&outcomes.buf);
        r.buf = w.into_vec();
        b.after.push(r);
    }

    fn handle_lookup(&mut self, b: &mut Batch, reqid: u64, ident: Vec<u8>) {
        let mut r = Res { kind: Kind::Lookup, reqid, ..Default::default() };
        match self.host.lookup(&ident) {
            Err(e) => {
                r.status = 500;
                r.errmsg = self.bug_reason(None, format!("lookup failed: {e}"));
            }
            Ok(buf) => r.buf = buf.unwrap_or_default(),
        }
        b.after.push(r);
    }

    /// Gives every cron entry without a mark the request's minute, so that it first fires at its
    /// first slot after that, and answers every entry's mark.
    fn handle_arm(&mut self, b: &mut Batch, reqid: u64, minute: i64) {
        let mut marks = Vec::with_capacity(self.cron_keys.len());
        for key in &self.cron_keys {
            let mark = match self.store.series_hwm(key).unwrap_or_else(|e| die("series_hwm", e)) {
                Some(m) => m,
                None => {
                    self.store
                        .series_mark(key, minute as u64, b.servertime)
                        .unwrap_or_else(|e| die("series_mark", e));
                    minute as u64
                }
            };
            marks.push(mark as i64);
        }
        b.after.push(Res { kind: Kind::Arm, reqid, marks, ..Default::default() });
    }

    /* One tick of a cron entry, past intake.  A slot at or below the entry's mark was decided
    already; any other runs the entry's hook as its install's mutation, with the batch's server
    time as the tick's now, over the write buffer, and commits what it wrote as one mutation's
    edits under a label of its own.  The decision moves the mark, a hook's failure included. */
    fn handle_tick(&mut self, b: &mut Batch, reqid: u64, entry: usize, slot: i64) {
        let mut r = Res { kind: Kind::Tick, reqid, ..Default::default() };
        let key = self.cron_keys[entry].clone();
        let e = self.cron[entry].clone();

        // the dedup check
        let mark = self.store.series_hwm(&key).unwrap_or_else(|e| die("series_hwm", e));
        if mark.is_some_and(|m| slot as u64 <= m) {
            b.after.push(r);
            return;
        }

        // the hook, writing into the buffer, and its edits, or the failure that discards them
        let mut id = [0u8; ID_LEN];
        getrandom::fill(&mut id).unwrap_or_else(|e| die("random bytes", e.to_string()));
        match self.host.tick(&e.install, &e.name, slot * 1000, b.servertime) {
            Err(err) => {
                self.clear_buffer();
                r.status = 500;
                r.errmsg =
                    self.bug_reason(Some(&id), format!("cron {},{}: {err}", e.install, e.name));
            }
            Ok(()) => self.commit_edits(b, &id),
        }

        // the decision moves the mark
        self.store
            .series_mark(&key, slot as u64, b.servertime)
            .unwrap_or_else(|e| die("series_mark", e));
        b.after.push(r);
    }

    // adds a token key and deletes the keys it sweeps, answered once the batch commits
    fn handle_key(
        &mut self,
        b: &mut Batch,
        reqid: u64,
        kid: String,
        public: Vec<u8>,
        minted: i64,
        sweep: Vec<String>,
    ) {
        self.store.key_add(&kid, &public, minted).unwrap_or_else(|e| die("key_add", e));
        for k in sweep {
            self.store.key_del(&k).unwrap_or_else(|e| die("key_del", e));
        }
        b.after.push(Res { kind: Kind::Key, reqid, ..Default::default() });
    }

    fn run_batch(&mut self, reqs: Vec<Req>) {
        self.batches += 1;
        let mut b = Batch::new(self.batches);
        self.store.exec("BEGIN IMMEDIATE").unwrap_or_else(|e| die("begin", e));

        // each request in its turn, its answer queued behind the batch's commit
        for q in reqs {
            match q {
                Req::Submit(s) => self.handle_submit(&mut b, s),
                Req::Register { reqid, conn, user, generation } => {
                    self.handle_register(&mut b, reqid, conn, user, generation)
                }
                Req::Unregister { conn } => self.handle_unregister(&b, conn),
                Req::Lookup { reqid, ident } => self.handle_lookup(&mut b, reqid, ident),
                Req::Account { reqid, user } => self.handle_account(&mut b, reqid, user),
                Req::Arm { reqid, minute } => self.handle_arm(&mut b, reqid, minute),
                Req::Tick { reqid, entry, slot } => self.handle_tick(&mut b, reqid, entry, slot),
                Req::Key { reqid, kid, public, minted, sweep } => {
                    self.handle_key(&mut b, reqid, kid, public, minted, sweep)
                }
            }
        }

        // the registrations as the batch leaves them
        let (mut accounts, mut views) = (Vec::new(), Vec::new());
        self.settle(&b, &mut accounts, &mut views);

        // each registration's reply, with its view as the batch leaves it
        for &(i, at) in &b.replies {
            Self::view_fill(&mut b.after[at], self.reg(i));
        }

        // then the registrations gone unused, and the commit
        self.expire(b.servertime, &mut accounts);
        if self.check
            && let Err(e) = self.check_registrations()
        {
            die("the registrations", e);
        }
        self.store.exec("COMMIT").unwrap_or_else(|e| die("commit", e));

        // the changes to accounts and views, ahead of the edits they apply to
        for r in accounts.into_iter().chain(views) {
            let _ = self.results.send(r);
        }
        if !b.commit.is_empty() {
            let items = std::mem::take(&mut b.commit);
            let _ = self.results.send(Res {
                kind: Kind::Commit,
                position: self.position,
                items,
                ..Default::default()
            });
        }
        for mut r in b.after {
            r.position = self.position;
            let _ = self.results.send(r);
        }
    }

    // open ///////////////////////////////////////////////////////////////////

    /// On an empty log, the bundle's bootstrap seeds it: what it writes commits as one mutation's
    /// edits, before anything is served.  A bootstrap that throws, writing to a key under no slice
    /// name among the reasons, fails the open.
    fn bootstrap(&mut self) -> Result<(), String> {
        if let Err(e) = self.host.bootstrap() {
            self.clear_buffer();
            return Err(format!("bootstrap: {e}"));
        }
        if self.host.state().wb.borrow().is_empty() {
            return Ok(());
        }

        // the mutation's id, a label like any client's
        let mut id = [0u8; ID_LEN];
        getrandom::fill(&mut id).map_err(|e| format!("random bytes: {e}"))?;

        // one transaction, as a group commit would run it; nothing is subscribed yet, so the
        // commit's items go nowhere
        let mut b = Batch::new(0);
        self.store.exec("BEGIN IMMEDIATE").unwrap_or_else(|e| die("begin", e));
        self.commit_edits(&mut b, &id);
        self.store.exec("COMMIT").unwrap_or_else(|e| die("commit", e));
        Ok(())
    }

    /// Reads the bundle's cron entries, each with the series key that holds its mark.  An
    /// install's name is a JS identifier without $, which the bundle's plugin set checks, and an
    /// entry's name must be fit for the key too.
    fn load_cron(&mut self) -> Result<(), String> {
        let entries = self.host.cron_entries().map_err(|e| format!("cron entries: {e}"))?;
        for (install, entry, _) in &entries {
            let ok = !entry.is_empty()
                && entry.len() <= 64
                && entry.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
            if !ok {
                return Err(format!(
                    "cron entry {entry} of {install}: not 1 to 64 of [A-Za-z0-9_-]"
                ));
            }
        }
        for (install, name, spec) in entries {
            self.cron_keys.push(format!("$cron:{install},{name}"));
            self.cron.push(CronEntry { install, name, spec });
        }
        Ok(())
    }
}

/// An edit's wire encoding: one msgpack array, the envelope, then the payload's items flat, each
/// operation a one-byte opcode and its items: 0, key, value sets a key, and 1, key deletes one.
/// A birth carries the slice's sets alone, since it clears the slice first, and a death carries
/// no operations.
fn encode_edit(
    position: u64,
    slice: &str,
    seq: u64,
    id: &[u8],
    servertime: i64,
    life: Life,
    entries: &[(&[u8], Option<&[u8]>)],
) -> Vec<u8> {
    // the payload's items: three per set, and two per deletion of a normal edit
    let mut nitems = 0;
    if life != Life::Death {
        for (_, v) in entries {
            if v.is_some() {
                nitems += 3;
            } else if life == Life::Normal {
                nitems += 2;
            }
        }
    }

    // the envelope
    let mut w = mp::Writer::new();
    w.array(1 + nitems);
    w.array(6);
    w.uint(position);
    w.str(slice.as_bytes());
    w.uint(seq);
    w.bin(id);
    w.timestamp(servertime / 1000, (servertime % 1000) as u32 * 1_000_000);
    w.uint(life as u64);

    // the operations, each value inline as the buffer holds it
    if life != Life::Death {
        for (k, v) in entries {
            match v {
                Some(v) => {
                    w.uint(0);
                    w.str(k);
                    w.raw(v);
                }
                None if life == Life::Normal => {
                    w.uint(1);
                    w.str(k);
                }
                None => {}
            }
        }
    }
    w.into_vec()
}

/// a mutation's series as its key in the series table: the hex SHA-256 of its bytes, so that
/// nothing the database stores lets its reader send under a live series
pub fn series_key(series: &[u8]) -> String {
    Sha256::digest(series).iter().map(|b| format!("{b:02x}")).collect()
}
