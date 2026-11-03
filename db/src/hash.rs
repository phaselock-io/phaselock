//! Password hashing: argon2id, behind the Hasher interface the server hashes and verifies
//! through, and a per-client token bucket in front of it that keeps one client from filling its
//! queue.  Hashes are PHC strings, which carry the parameters they were made with, so a hash made
//! at other parameters still verifies.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;

use crate::pool::{Pool, PoolError};

// the argon2id parameters new hashes are made with: RFC 9106's second recommended option, 64 MiB
// over 3 passes in 4 lanes, which this build computes one after another
const ARGON_TIME: u32 = 3;
const ARGON_MEMORY: u32 = 64 * 1024;
const ARGON_LANES: u32 = 4;
const ARGON_KEY_LEN: usize = 32;

// PHC strings use the standard alphabet with no padding
const PHC64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD_NO_PAD;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashError {
    /// the hasher's queue is full
    Busy,
    /// the client's budget is spent
    Limited,
    /// the hasher has stopped
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

impl From<PoolError> for HashError {
    fn from(e: PoolError) -> HashError {
        match e {
            PoolError::Busy => HashError::Busy,
            PoolError::Closed => HashError::Closed,
        }
    }
}

/// a hasher's answer
pub type Answer<'a, T> = Pin<Box<dyn Future<Output = Result<T, HashError>> + Send + 'a>>;

/// how a request waits for its turn at the hasher
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    /// refused with Busy when the hasher's queue is full
    Refuse,
    /// waiting for room in the queue: for a check whose call may already have decided mutations,
    /// and for bootstrap's hashes, which no client waits on
    Queue,
}

/** What the server hashes and verifies passwords through.  Each call is async: a hasher may
answer from a pool of threads or from a service across a socket, and the request waits without
holding a thread either way.  A call whose future is dropped is abandoned.

The server hashes on its own pool, Local, unless the embedding hands it another.  The interface
exists for a shared hosted tier, where many small databases run on one machine: each database
hands its hashes to one hasher the machine shares, outside its process, so the database's memory
stays small and the memory of hashing is paid once per machine instead of once per database.  A
standalone server has no use for another hasher. */
pub trait Hasher: Send + Sync {
    /// a PHC string of the password, at the hasher's parameters
    fn hash(&self, password: String, wait: Wait) -> Answer<'_, String>;

    /// Whether the password is the one stored hashes.  With no stored hash, spends what a
    /// verification spends and answers false, so a login naming no account answers no faster
    /// than a wrong password.
    fn verify(&self, stored: Option<String>, password: String, wait: Wait) -> Answer<'_, bool>;

    /// stops taking calls, and waits until the calls in hand finish
    fn stop(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// The hasher of a standalone server: argon2id on a fixed pool of workers behind a bounded
/// queue, so its memory stays at the pool's size times one hash's.
pub struct Local {
    pool: Pool,
}

impl Local {
    pub fn new(workers: usize, queue: usize) -> Local {
        Local { pool: Pool::new("pldb-hash", workers, queue) }
    }
}

impl Hasher for Local {
    fn hash(&self, password: String, wait: Wait) -> Answer<'_, String> {
        Box::pin(async move {
            let hash = move || hash_password(&password);
            Ok(match wait {
                Wait::Refuse => self.pool.try_run(hash).await?,
                Wait::Queue => self.pool.queue_run(hash).await?,
            })
        })
    }

    fn verify(&self, stored: Option<String>, password: String, wait: Wait) -> Answer<'_, bool> {
        Box::pin(async move {
            let check = move || match stored {
                Some(h) => verify_password(&h, &password),
                None => dummy_verify(&password),
            };
            Ok(match wait {
                Wait::Refuse => self.pool.try_run(check).await?,
                Wait::Queue => self.pool.queue_run(check).await?,
            })
        })
    }

    fn stop(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(self.pool.stop())
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
    let key = argon(pw.as_bytes(), &salt, ARGON_TIME, ARGON_MEMORY, ARGON_LANES, ARGON_KEY_LEN)
        .expect("argon2id at fixed parameters");
    format!(
        "$argon2id$v=19$m={ARGON_MEMORY},t={ARGON_TIME},p={ARGON_LANES}${}${}",
        PHC64.encode(salt),
        PHC64.encode(key)
    )
}

/// spends what verifying a password at the current parameters spends, and answers false: what a
/// login naming no account gets, so its timing does not tell it from a wrong password
pub fn dummy_verify(pw: &str) -> bool {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).expect("random bytes");
    argon(pw.as_bytes(), &salt, ARGON_TIME, ARGON_MEMORY, ARGON_LANES, ARGON_KEY_LEN);
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

    #[test]
    fn a_hash_verifies_and_carries_its_parameters() {
        let h = hash_password("hunter2");
        assert!(h.starts_with("$argon2id$v=19$m=65536,t=3,p=4$"), "{h}");
        assert!(verify_password(&h, "hunter2"));
        assert!(!verify_password(&h, "hunter3"));
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
