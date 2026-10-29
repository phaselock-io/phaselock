//! Tests only: the points a test holds the server at.  Each hook is an async function the server
//! awaits at its point when one is set, so a test can hold the server there until it has done
//! what it needs; every hook is unset unless a test sets it, at any time.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

type Fut = Pin<Box<dyn Future<Output = ()> + Send>>;

/// a hook the server awaits
pub type Hook = Arc<dyn Fn() -> Fut + Send + Sync>;

/// a hook the server awaits with a position
pub type PositionHook = Arc<dyn Fn(u64) -> Fut + Send + Sync>;

/// a hook of an async function
pub fn hook<F, R>(f: F) -> Hook
where
    F: Fn() -> R + Send + Sync + 'static,
    R: Future<Output = ()> + Send + 'static,
{
    Arc::new(move || Box::pin(f()))
}

/// a position hook of an async function
pub fn position_hook<F, R>(f: F) -> PositionHook
where
    F: Fn(u64) -> R + Send + Sync + 'static,
    R: Future<Output = ()> + Send + 'static,
{
    Arc::new(move |p| Box::pin(f(p)))
}

/// one hook's place, set or not
pub struct Slot<H>(Mutex<Option<H>>);

impl<H> Default for Slot<H> {
    fn default() -> Self {
        Slot(Mutex::new(None))
    }
}

impl<H: Clone> Slot<H> {
    pub fn set(&self, h: H) {
        *self.0.lock().unwrap() = Some(h);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }

    /// the hook, when one is set
    pub fn get(&self) -> Option<H> {
        self.0.lock().unwrap().clone()
    }
}

#[derive(Default)]
pub struct Hooks {
    /// awaited by the dispatcher with a commit's position, before it queues the commit's frames
    pub before_push: Slot<PositionHook>,
    /// awaited by a connection once its cold catchup is done, before it switches to streaming
    pub before_streaming: Slot<Hook>,
    /// awaited by a streaming connection woken by its backlog, before it takes the backlog
    pub before_forward: Slot<Hook>,
    /// awaited by /snapshot and /edits once the principal is registered, before the read
    pub before_read: Slot<Hook>,
    /// awaited once a login's password, or a request's proofs, have been checked, before what
    /// they were checked against is read again
    pub proved: Slot<Hook>,
    /// awaited by a connection once its first frame is handed to the HTTP layer, before it writes
    /// another
    pub after_first_frame: Slot<Hook>,
}

impl Hooks {
    /// unsets every hook
    pub fn clear_all(&self) {
        self.before_push.clear();
        self.before_streaming.clear();
        self.before_forward.clear();
        self.before_read.clear();
        self.proved.clear();
        self.after_first_frame.clear();
    }
}
