//! Password hashing: argon2id runs on a fixed pool of workers behind a bounded queue, so its
//! memory stays at the pool's size times one hash's, and a per-client token bucket in front of the
//! pool keeps one client from filling the queue.  Hashes are PHC strings, which carry the
//! parameters they were made with.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

// the argon2id parameters new hashes are made with
const ARGON_TIME: u32 = 2;
const ARGON_MEMORY: u32 = 19 * 1024;
const ARGON_THREADS: u32 = 1;
const ARGON_KEY_LEN: usize = 32;

// PHC strings use the standard alphabet with no padding
const PHC64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD_NO_PAD;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashError {
    /// the queue is full
    Busy,
    /// the client's budget is spent
    Limited,
    /// the pool has stopped
    Closed,
}

impl HashError {
    pub fn message(self) -> &'static str {
        match self {
            HashError::Busy => "password hashing is busy; try again",
            HashError::Limited => "too many password attempts; slow down",
            HashError::Closed => "the server is shutting down",
        }
    }
}

fn argon(pw: &[u8], salt: &[u8], t: u32, m: u32, p: u32, len: usize) -> Option<Vec<u8>> {
    let params = Params::new(m, t, p, Some(len)).ok()?;
    let mut out = vec![0u8; len];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(pw, salt, &mut out)
        .ok()?;
    Some(out)
}

pub fn hash_password(pw: &str) -> String {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("random bytes");
    let key = argon(pw.as_bytes(), &salt, ARGON_TIME, ARGON_MEMORY, ARGON_THREADS, ARGON_KEY_LEN)
        .expect("argon2id at fixed parameters");
    format!(
        "$argon2id$v=19$m={ARGON_MEMORY},t={ARGON_TIME},p={ARGON_THREADS}${}${}",
        PHC64.encode(salt),
        PHC64.encode(key)
    )
}

/// spends what verifying a password at the current parameters spends, and answers false: what a
/// login naming no account gets, so its timing does not tell it from a wrong password
pub fn dummy_verify(pw: &str) -> bool {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("random bytes");
    argon(pw.as_bytes(), &salt, ARGON_TIME, ARGON_MEMORY, ARGON_THREADS, ARGON_KEY_LEN);
    false
}

pub fn verify_password(hash: &str, pw: &str) -> bool {
    let parts: Vec<&str> = hash.split('$').collect();
    if parts.len() != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
        return false;
    }
    let mut m = None;
    let mut t = None;
    let mut p = None;
    let fields: Vec<&str> = parts[3].split(',').collect();
    if fields.len() != 3 {
        return false;
    }
    for (f, want) in fields.iter().zip(["m=", "t=", "p="]) {
        let Some(v) = f.strip_prefix(want).and_then(|v| v.parse::<u32>().ok()) else {
            return false;
        };
        match want {
            "m=" => m = Some(v),
            "t=" => t = Some(v),
            _ => p = Some(v),
        }
    }
    let (Ok(salt), Ok(want)) = (PHC64.decode(parts[4]), PHC64.decode(parts[5])) else {
        return false;
    };
    if want.is_empty() {
        return false;
    }
    let Some(key) = argon(pw.as_bytes(), &salt, t.unwrap(), m.unwrap(), p.unwrap(), want.len())
    else {
        return false;
    };
    subtle::ConstantTimeEq::ct_eq(key.as_slice(), want.as_slice()).into()
}

/// waits until a flag is set
pub async fn until(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

/// A pool of hash workers: workers run at once, and a job waits for one in a queue of bounded
/// length, leaving the queue when a worker takes it.  A job whose client has left before a worker
/// reaches it is skipped, since its future is dropped.  When the pool stops, the workers finish
/// the jobs in hand and take no more.
pub struct HashPool {
    workers: Arc<Semaphore>,
    queue: Arc<Semaphore>,
    stopped: watch::Sender<bool>,
}

impl HashPool {
    pub fn new(workers: usize, queue: usize) -> HashPool {
        HashPool {
            workers: Arc::new(Semaphore::new(workers)),
            queue: Arc::new(Semaphore::new(queue)),
            stopped: watch::channel(false).0,
        }
    }

    // runs a job holding its place in the queue on a worker once one is free
    async fn run<T: Send + 'static>(
        &self,
        place: OwnedSemaphorePermit,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, HashError> {
        let mut stopped = self.stopped.subscribe();
        tokio::select! {
            w = self.workers.clone().acquire_owned() => {
                let w = w.map_err(|_| HashError::Closed)?;
                drop(place);
                let r = tokio::task::spawn_blocking(move || {
                    let r = f();
                    drop(w);
                    r
                });
                r.await.map_err(|_| HashError::Closed)
            }
            _ = until(&mut stopped) => Err(HashError::Closed),
        }
    }

    /// runs f on a worker and waits for it: Busy when the queue is full
    pub async fn try_run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, HashError> {
        if *self.stopped.borrow() {
            return Err(HashError::Closed);
        }
        let Ok(place) = self.queue.clone().try_acquire_owned() else { return Err(HashError::Busy) };
        self.run(place, f).await
    }

    /// runs f on a worker and waits for it, as try_run does, but waits for room in the queue
    pub async fn queue_run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, HashError> {
        if *self.stopped.borrow() {
            return Err(HashError::Closed);
        }
        let mut stopped = self.stopped.subscribe();
        let place = tokio::select! {
            s = self.queue.clone().acquire_owned() => s.map_err(|_| HashError::Closed)?,
            _ = until(&mut stopped) => return Err(HashError::Closed),
        };
        self.run(place, f).await
    }

    /// stops taking jobs, then waits until the jobs in hand finish
    pub async fn stop(&self, workers: usize) {
        self.stopped.send_replace(true);
        let _ = self.workers.acquire_many(workers as u32).await;
    }
}

/// A token bucket per client: each holds up to burst tokens and regains rate per second, and an
/// attempt spends one.  A bucket that has refilled is forgotten.
pub struct Limiter {
    rate: f64,
    burst: f64,
    inner: Mutex<LimiterState>,
}

struct LimiterState {
    clients: HashMap<String, (f64, Instant)>,
    last_sweep: Instant,
}

impl Limiter {
    pub fn new(rate: f64, burst: usize) -> Limiter {
        Limiter {
            rate,
            burst: burst as f64,
            inner: Mutex::new(LimiterState { clients: HashMap::new(), last_sweep: Instant::now() }),
        }
    }

    /// spends one of the client's tokens, or reports that none is left
    pub fn allow(&self, client: &str) -> bool {
        self.allow_at(client, Instant::now())
    }

    fn allow_at(&self, client: &str, now: Instant) -> bool {
        let mut st = self.inner.lock().unwrap();

        // forget the buckets that have refilled, at most once a minute
        if now.duration_since(st.last_sweep) >= Duration::from_secs(60) {
            st.last_sweep = now;
            let (rate, burst) = (self.rate, self.burst);
            st.clients.retain(|_, (tokens, at)| {
                *tokens + now.duration_since(*at).as_secs_f64() * rate < burst
            });
        }
        let (rate, burst) = (self.rate, self.burst);
        let b = st.clients.entry(client.to_string()).or_insert((burst, now));
        b.0 = burst.min(b.0 + now.duration_since(b.1).as_secs_f64() * rate);
        b.1 = now;
        if b.0 < 1.0 {
            return false;
        }
        b.0 -= 1.0;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;

    // a job that holds its worker until released, reporting when it starts
    fn holding() -> (impl FnOnce() + Send + 'static, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let run = move || {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv();
        };
        (run, started, release)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_bounds_its_queue() {
        let p = Arc::new(HashPool::new(1, 1));
        let (run, started, release) = holding();

        // the worker takes the first job and the queue holds the second; the third is refused
        let first = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();
        let second = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(|| ()).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(p.try_run(|| ()).await, Err(HashError::Busy));

        // once the worker is free both queued jobs finish
        release.send(()).unwrap();
        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_skips_the_jobs_of_clients_that_left() {
        let p = Arc::new(HashPool::new(1, 4));
        let (run, started, release) = holding();
        let busy = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();

        // a job queued behind the busy worker whose client then leaves
        let ran = Arc::new(AtomicBool::new(false));
        let waiting = tokio::spawn({
            let (p, ran) = (p.clone(), ran.clone());
            async move { p.try_run(move || ran.store(true, Ordering::SeqCst)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());

        // the worker skips its job
        release.send(()).unwrap();
        busy.await.unwrap().unwrap();
        p.try_run(|| ()).await.unwrap();
        assert!(!ran.load(Ordering::SeqCst), "the job of a client that left was run");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_stops() {
        let p = Arc::new(HashPool::new(1, 4));
        let (run, started, release) = holding();
        let running = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();

        // a queued job, and then shutdown
        let ran = Arc::new(AtomicBool::new(false));
        let queued = tokio::spawn({
            let (p, ran) = (p.clone(), ran.clone());
            async move { p.try_run(move || ran.store(true, Ordering::SeqCst)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let stopping = tokio::spawn({
            let p = p.clone();
            async move { p.stop(1).await }
        });

        // the queued job's client is answered at once, and its job never runs
        assert_eq!(queued.await.unwrap(), Err(HashError::Closed));

        // the hash in progress finishes, and then the workers are gone
        release.send(()).unwrap();
        running.await.unwrap().unwrap();
        stopping.await.unwrap();
        assert!(!ran.load(Ordering::SeqCst), "a queued job ran after shutdown");
        assert_eq!(p.try_run(|| ()).await, Err(HashError::Closed));
    }

    #[test]
    fn the_limiter() {
        let mut now = Instant::now();
        let l = Limiter::new(2.0, 3);

        // a burst, then refusal
        for i in 0..3 {
            assert!(l.allow_at("a", now), "attempt {i} of the burst refused");
        }
        assert!(!l.allow_at("a", now), "an attempt past the burst allowed");

        // clients have their own buckets
        assert!(l.allow_at("b", now));

        // tokens come back at the rate, up to the burst
        now += Duration::from_millis(500);
        assert!(l.allow_at("a", now) && !l.allow_at("a", now));
        now += Duration::from_secs(3600);
        for i in 0..3 {
            assert!(l.allow_at("a", now), "after a long rest, attempt {i} refused");
        }
        assert!(!l.allow_at("a", now), "a long rest gave back more than the burst");

        // a bucket that has refilled is forgotten
        now += Duration::from_secs(3600);
        l.allow_at("c", now);
        assert!(
            !l.inner.lock().unwrap().clients.contains_key("b"),
            "an idle client's bucket was kept"
        );
    }
}
