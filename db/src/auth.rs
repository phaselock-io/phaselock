//! Tokens and passwords.  Tokens are EdDSA JWTs signed with the token keys (keys.rs); passwords
//! are argon2id hashes (hash.rs).

use std::net::{IpAddr, Ipv6Addr, SocketAddr};

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use ed25519_dalek::{Signer, SigningKey, Verifier};
use phaselock_core::mp::{self, Node, Val};
use serde::{Deserialize, Serialize};

use crate::core::{MAX_BOUNCES, Proof, Req, Verdict, unix_ms, unix_s};
use crate::hash::{HashError, Wait};
use crate::keys::{KEY_ROTATION_MS, TOKEN_LIFETIME_MS, TokenKey};
use crate::server::{ERR_REVOKED, Principal, Request, Resp, Server, hash_failed, http_error};

pub use crate::hash::hash_password;

// base64url without padding, decoding as leniently as the JOSE readers it talks to
const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Claims {
    sub: String,
    #[serde(rename = "gen")]
    generation: i64,
    iat: i64,
    exp: i64,
    jti: String,
}

/// a token's JOSE header
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

/// the bundle's lookup answer; password_hash is None for an account without one
#[derive(Clone, PartialEq, Eq)]
struct Account {
    user: String,
    generation: i64,
    password_hash: Option<String>,
}

/// Names the client a request comes from, for its hashing budget: its address from the client
/// IP header, when the server names one and the request carries a valid one, or else the address
/// it connected from.  An IPv6 client is named by its /64, since a single host is commonly given
/// a whole /64 to draw addresses from.
pub fn client_of(header_name: &str, header_value: &str, remote: &str) -> String {
    if !header_name.is_empty()
        && let Ok(addr) = header_value.trim().parse::<IpAddr>()
    {
        return client_key(addr);
    }
    match remote.parse::<SocketAddr>() {
        Ok(a) => client_key(a.ip()),
        Err(_) => remote.to_string(),
    }
}

// the budget key of an address: an IPv4 address itself, an IPv6 one its /64
fn client_key(addr: IpAddr) -> String {
    match addr {
        IpAddr::V4(a) => a.to_string(),
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = a.segments();
                format!("{}/64", Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

impl Server {
    pub fn client_of(&self, r: &Request) -> String {
        let value =
            if self.client_ip_header.is_empty() { "" } else { r.header(&self.client_ip_header) };
        client_of(&self.client_ip_header, value, &r.remote)
    }

    /// Signs a token for an account at its generation, answering it and its expiry.
    pub async fn mint(&self, user: &str, generation: i64) -> Result<(String, i64), String> {
        let mut signing = self.keys.signing.lock().await;
        let now = (self.clock)();
        let now_ms = unix_ms(now);

        // the key to sign with, minting one when this process has none or the current one has
        // been signing for a day
        let current = signing.as_ref().filter(|(k, _)| now_ms - k.minted < KEY_ROTATION_MS);
        let (key, private) = match current {
            Some((k, p)) => (k.clone(), p.clone()),
            None => {
                // a fresh key, and the keys it retires for good
                let mut seed = [0u8; 32];
                getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
                let private = SigningKey::from_bytes(&seed);
                let mut id = [0u8; 16];
                getrandom::fill(&mut id).map_err(|e| e.to_string())?;
                let kid: String = id.iter().map(|b| format!("{b:02x}")).collect();
                let k = TokenKey { kid, public: private.verifying_key(), minted: now_ms };
                let sweep = self.keys.swept(k.minted, now_ms);

                // committed before anything it signs leaves the process
                let (kid, public, minted, sw) =
                    (k.kid.clone(), k.public.to_bytes().to_vec(), k.minted, sweep.clone());
                let r =
                    self.request(|reqid| Req::Key { reqid, kid, public, minted, sweep: sw }).await;
                if r.status != 0 {
                    return Err(format!("storing a token key: {}", r.errmsg));
                }
                self.keys.add(k.clone(), &sweep);
                *signing = Some((k.clone(), private.clone()));
                (k, private)
            }
        };

        let mut jti = [0u8; 8];
        getrandom::fill(&mut jti).map_err(|e| e.to_string())?;
        let iat = unix_s(now);
        let c = Claims {
            sub: user.to_string(),
            generation,
            iat,
            exp: unix_s(now + std::time::Duration::from_millis(TOKEN_LIFETIME_MS as u64)),
            jti: jti.iter().map(|b| format!("{b:02x}")).collect(),
        };
        let h = Header { alg: "EdDSA".into(), typ: "JWT".into(), kid: key.kid.clone() };
        let signing_input = format!(
            "{}.{}",
            B64.encode(serde_json::to_vec(&h).unwrap()),
            B64.encode(serde_json::to_vec(&c).unwrap())
        );
        let sig = private.sign(signing_input.as_bytes());
        Ok((format!("{signing_input}.{}", B64.encode(sig.to_bytes())), c.exp))
    }

    fn verify(&self, token: &str) -> Result<Claims, String> {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3 {
            return Err("malformed token".into());
        }

        // the key the header names, which signs only EdDSA
        let raw = B64.decode(parts[0]).map_err(|_| "malformed token")?;
        let h: Header = serde_json::from_slice(&raw).map_err(|_| "malformed token")?;
        if h.alg != "EdDSA" {
            return Err("unsupported token algorithm".into());
        }
        let k = self.keys.key(&h.kid).ok_or("unknown token key")?;
        let sig =
            B64.decode(parts[2]).ok().and_then(|s| ed25519_dalek::Signature::from_slice(&s).ok());
        let signed = format!("{}.{}", parts[0], parts[1]);
        if !sig.is_some_and(|s| k.public.verify(signed.as_bytes(), &s).is_ok()) {
            return Err("bad signature".into());
        }

        // the claims, until they expire
        let payload = B64.decode(parts[1]).map_err(|_| "malformed token")?;
        let c: Claims = serde_json::from_slice(&payload).map_err(|_| "malformed token")?;
        if c.exp < unix_s((self.clock)()) {
            return Err("token expired".into());
        }

        // the server mints only the non-negative generations lookup answers
        if c.generation < 0 {
            return Err("malformed token".into());
        }
        Ok(c)
    }

    /// Resolves the Authorization header; no header is anonymous.  A token whose generation is
    /// not the one the core last published for its user is refused here, without a trip to the
    /// writer, which checks every other token.
    pub fn principal_of(&self, r: &Request) -> Result<Principal, String> {
        let h = r.header("authorization");
        if h.is_empty() {
            return Ok(Principal::anonymous());
        }
        let Some(token) = h.strip_prefix("Bearer ") else {
            return Err("expected a bearer token".into());
        };
        let c = self.verify(token)?;
        if self.generation(&c.sub).is_some_and(|g| g != c.generation) {
            return Err(ERR_REVOKED.into());
        }
        Ok(Principal { anonymous: false, user: c.sub, generation: c.generation, exp: c.exp })
    }

    /// hashes a password for a client, within its budget
    pub async fn hash_for(&self, client: &str, pw: String) -> Result<String, HashError> {
        if !self.limit.allow(client) {
            return Err(HashError::Limited);
        }
        self.hasher.hash(pw, Wait::Refuse).await
    }

    // checks a password for a client, within its budget
    async fn verify_for(
        &self,
        client: &str,
        stored: Option<String>,
        pw: String,
    ) -> Result<bool, HashError> {
        if !self.limit.allow(client) {
            return Err(HashError::Limited);
        }
        self.hasher.verify(stored, pw, Wait::Refuse).await
    }

    // checks a password again after the credentials it was checked against changed: outside any
    // client's budget, since the change was not the check's doing, and waiting for room at the
    // hasher, since its call may already have decided mutations
    async fn recheck(&self, stored: Option<String>, pw: String) -> Result<bool, HashError> {
        self.hasher.verify(stored, pw, Wait::Queue).await
    }

    /// the password hash lookup answers for a principal's token, which its MutationAuth proofs
    /// are checked against: None for the anonymous principal and for none
    pub async fn password_hash_of(&self, p: &Principal) -> Result<Option<String>, String> {
        if p.anonymous {
            return Ok(None);
        }
        let user = p.user.clone();
        let r = self.request(|reqid| Req::Account { reqid, user }).await;
        if r.status != 0 {
            return Err(r.errmsg);
        }
        Ok(r.hash)
    }

    /// Checks each mutation's proofs, the passwords prepare set aside, against hash, and answers
    /// each mutation's verdict: none for a mutation without proofs, and failed for one when there
    /// is no hash.  A first check spends the client's budget, as a login does; a check after a
    /// bounce does not.
    pub async fn prove(
        &self,
        client: &str,
        hash: Option<String>,
        proofs: &[Vec<String>],
        first: bool,
    ) -> Result<Vec<Verdict>, HashError> {
        let mut verdicts = vec![Verdict::default(); proofs.len()];
        for (i, passwords) in proofs.iter().enumerate() {
            if passwords.is_empty() {
                continue;
            }
            verdicts[i] = Verdict { state: Proof::Passed, hash: hash.clone() };
            for password in passwords {
                let mut ok = false;
                if let Some(h) = &hash {
                    let (h, pw) = (Some(h.clone()), password.clone());
                    ok = if first {
                        self.verify_for(client, h, pw).await?
                    } else {
                        self.recheck(h, pw).await?
                    };
                }
                if !ok {
                    verdicts[i].state = Proof::Failed;
                    break;
                }
            }
        }
        Ok(verdicts)
    }

    async fn lookup(&self, ident: &Val<'_>) -> Result<Option<Account>, String> {
        let ident = mp::encode(ident);
        let r = self.request(|reqid| Req::Lookup { reqid, ident }).await;
        if r.status != 0 {
            return Err(r.errmsg);
        }
        if r.buf.is_empty() {
            return Ok(None);
        }
        let node = mp::parse_whole(&r.buf).map_err(|e| e.to_string())?;
        if node.map().is_none() {
            return Err("lookup returned a non-object".into());
        }
        let text = |k: &str| {
            node.get(k).and_then(|v| v.as_str()).map(|s| String::from_utf8_lossy(s).into_owned())
        };
        let generation = match node.get("generation") {
            Some(Node::F32(f)) => *f as i64,
            Some(Node::F64(f)) => *f as i64,
            Some(n) => n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)).unwrap_or(0),
            None => 0,
        };
        Ok(Some(Account {
            user: text("user").unwrap_or_default(),
            generation,
            password_hash: text("passwordHash"),
        }))
    }

    pub async fn handle_auth(self: std::sync::Arc<Self>, mut r: Request) -> Resp {
        if r.method != http::Method::POST {
            return http_error(405, "POST only");
        }
        let body = match r.body().await {
            Ok(b) => b,
            Err(e) => return http_error(400, &e),
        };
        let Ok(req) = mp::parse(&body).map(|(n, _)| n) else {
            return http_error(400, "body must be a msgpack map");
        };
        if req.map().is_none() {
            return http_error(400, "body must be a msgpack map");
        }
        let text = |k: &str| {
            req.get(k)
                .and_then(|v| v.as_str())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .unwrap_or_default()
        };
        let (user, generation) = match text("kind").as_str() {
            "dev" => {
                if !self.dev_auth {
                    return http_error(403, "dev auth is disabled");
                }

                // password sign-in without the password: the account and its generation come
                // from lookup
                let identity = text("identity");
                let ident = Val::Map(vec![
                    ("identity", Val::Str(&identity)),
                    ("kind", Val::Str("password")),
                ]);
                match self.lookup(&ident).await {
                    Err(e) => return http_error(500, &e),
                    Ok(None) => return http_error(401, "no such account"),
                    Ok(Some(a)) => (a.user, a.generation),
                }
            }
            "password" => {
                let identity = text("identity");
                let password = text("password");
                let ident = Val::Map(vec![
                    ("identity", Val::Str(&identity)),
                    ("kind", Val::Str("password")),
                ]);
                let mut a = match self.lookup(&ident).await {
                    Ok(a) => a,
                    Err(e) => return http_error(500, &e),
                };
                let mut ok;
                let mut attempt = 0;
                loop {
                    // an unknown account gets a dummy verification, so it answers no faster than
                    // a wrong password and spends the same budget
                    let pw = password.clone();
                    let hash = a.as_ref().and_then(|a| a.password_hash.clone());
                    let r = if attempt == 0 {
                        self.verify_for(&self.client_of(&r), hash, pw).await
                    } else {
                        self.recheck(hash, pw).await
                    };
                    ok = match r {
                        Ok(ok) => ok,
                        Err(e) => return hash_failed(e),
                    };
                    self.proved().await;

                    // the login is decided against the credentials lookup answers now, so a
                    // password checked against credentials that changed meanwhile is checked
                    // again
                    let now = match self.lookup(&ident).await {
                        Ok(a) => a,
                        Err(e) => return http_error(500, &e),
                    };
                    if same_credentials(&a, &now) {
                        a = now;
                        break;
                    }
                    if attempt == MAX_BOUNCES {
                        eprintln!(
                            "pldb: lookup answered different credentials for {identity:?} on each of {} reads",
                            MAX_BOUNCES + 2
                        );
                        return http_error(500, "internal error");
                    }
                    a = now;
                    attempt += 1;
                }
                if !ok {
                    return http_error(401, "invalid credentials");
                }
                let a = a.unwrap();
                (a.user, a.generation)
            }
            "refresh" => {
                let p = match self.principal_of(&r) {
                    Ok(p) if !p.anonymous => p,
                    _ => return http_error(401, "refresh needs a bearer token"),
                };
                let ident =
                    Val::Map(vec![("kind", Val::Str("refresh")), ("user", Val::Str(&p.user))]);
                match self.lookup(&ident).await {
                    Err(e) => return http_error(500, &e),
                    // a token speaks only for an existing account at its current generation
                    Ok(a) if a.as_ref().is_none_or(|a| a.generation != p.generation) => {
                        return http_error(401, "token revoked");
                    }
                    Ok(_) => (p.user, p.generation),
                }
            }
            _ => return http_error(400, "unknown kind"),
        };
        let (token, exp) = match self.mint(&user, generation).await {
            Ok(t) => t,
            // only a closing server fails to store a key
            Err(e) => return http_error(503, &e),
        };
        let reply = Val::Map(vec![
            ("exp", Val::Int(exp)),
            ("token", Val::Str(&token)),
            ("user", Val::Str(&user)),
        ]);
        let mut resp =
            http::Response::new(crate::server::Body::Full(Some(mp::encode(&reply).into())));
        resp.headers_mut()
            .insert("content-type", http::HeaderValue::from_static("application/msgpack"));
        resp
    }
}

// whether two lookup answers hold the same credentials: no account in either, or the same user
// with the same password hash
fn same_credentials(a: &Option<Account>, b: &Option<Account>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.user == b.user && a.password_hash == b.password_hash,
        _ => false,
    }
}
