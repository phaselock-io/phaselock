//! Token keys.  Tokens are EdDSA JWTs over Ed25519 keys.  A private key lives only in the memory
//! of the process that signs with it: the first signature after startup mints one, and so does
//! the first signature once the current key has been signing for KEY_ROTATION, so every restart
//! is a rotation and an idle server mints nothing.  A key's public half is committed to the token
//! key table before anything it signed leaves the process, and verification accepts any stored
//! key, found by the token's kid, so a token outlives the process that signed it.
//!
//! A key stops signing when its successor is minted, or when its process ends, which is no later
//! than the next process's start.  It is swept once every token it could have signed has
//! expired, the token lifetime past that, plus KEY_GRACE, so that a clock stepped back between a
//! key's last signature and its successor's minting cannot strand a live token.  Keeping a public
//! key longer costs nothing, since it can forge nothing.  The sweep runs whenever a key is minted.

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use ed25519_dalek::{SigningKey, VerifyingKey};

pub const KEY_ROTATION_MS: i64 = 24 * 3600 * 1000;
pub const KEY_GRACE_MS: i64 = 24 * 3600 * 1000;
pub const TOKEN_LIFETIME_MS: i64 = 30 * 24 * 3600 * 1000;

/// one stored key: its id, its public half, and when it was minted, in Unix milliseconds
#[derive(Clone)]
pub struct TokenKey {
    pub kid: String,
    pub public: VerifyingKey,
    pub minted: i64,
}

struct Stored {
    by_kid: HashMap<String, TokenKey>,
    // oldest first
    sorted: Vec<TokenKey>,
    // the ids of the keys minted before this process started
    past: HashSet<String>,
}

/// Every stored key, and the key this process signs with.
pub struct Keyring {
    /// held by a signature, so that two never mint at once
    pub signing: tokio::sync::Mutex<Option<(TokenKey, SigningKey)>>,
    stored: RwLock<Stored>,
    start: i64,
}

impl Keyring {
    pub fn new(stored: Vec<TokenKey>, start: i64) -> Keyring {
        let mut s = Stored { by_kid: HashMap::new(), sorted: Vec::new(), past: HashSet::new() };
        for k in stored {
            s.past.insert(k.kid.clone());
            s.by_kid.insert(k.kid.clone(), k.clone());
            s.sorted.push(k);
        }
        s.sorted.sort_by(|a, b| a.minted.cmp(&b.minted).then_with(|| a.kid.cmp(&b.kid)));
        Keyring { signing: tokio::sync::Mutex::new(None), stored: RwLock::new(s), start }
    }

    /// the stored key a token names
    pub fn key(&self, kid: &str) -> Option<TokenKey> {
        self.stored.read().unwrap().by_kid.get(kid).cloned()
    }

    /// the ids of the keys whose every token has expired by now, when a key minted at minted
    /// succeeds the newest
    pub fn swept(&self, minted: i64, now: i64) -> Vec<String> {
        let s = self.stored.read().unwrap();
        let mut out = Vec::new();
        for (i, k) in s.sorted.iter().enumerate() {
            // the key stopped signing when its successor was minted, or, for a past process's
            // key, by this process's start
            let mut retired = s.sorted.get(i + 1).map_or(minted, |n| n.minted);
            if s.past.contains(&k.kid) && self.start < retired {
                retired = self.start;
            }
            if retired + TOKEN_LIFETIME_MS + KEY_GRACE_MS < now {
                out.push(k.kid.clone());
            }
        }
        out
    }

    /// takes a minted key and drops the keys its sweep named, once both are durable
    pub fn add(&self, k: TokenKey, sweep: &[String]) {
        let mut s = self.stored.write().unwrap();
        s.by_kid.insert(k.kid.clone(), k.clone());
        s.sorted.push(k);
        for kid in sweep {
            s.by_kid.remove(kid);
            s.past.remove(kid);
        }
        let Stored { by_kid, sorted, .. } = &mut *s;
        sorted.retain(|k| by_kid.contains_key(&k.kid));
        sorted.sort_by(|a, b| a.minted.cmp(&b.minted).then_with(|| a.kid.cmp(&b.kid)));
    }
}
