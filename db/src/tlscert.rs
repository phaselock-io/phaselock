//! Serving TLS from a certificate and key on disk, which the operator rotates by replacing the
//! files.  A handshake, at most once per CERT_CHECK_INTERVAL, stats the files, following
//! symlinks, and reloads the pair when either changed, so a rotation reaches every new connection
//! and an open one keeps the certificate it shook hands with.  A pair that does not load, such as
//! one caught halfway through a rotation, leaves the last certificate that loaded in place until a
//! later check loads the pair.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

// how often a handshake may look at the files for a rotation
const CERT_CHECK_INTERVAL: Duration = Duration::from_secs(1);

// the files of a certificate pair as a check found them: each one's size and modification time
type Stamp = [(u64, u128); 2];

struct State {
    cert: Arc<CertifiedKey>,
    loaded: Stamp,          // the files as the certificate in hand was loaded from them
    failed: Option<String>, // why the files last failed to load, logged once while it lasts
    checked: Instant,
}

#[derive(Debug)]
pub struct CertFiles {
    cert_file: String,
    key_file: String,
    state: Mutex<State>,
}

impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("State")
    }
}

fn stat(files: [&str; 2]) -> Result<Stamp, String> {
    let mut s = [(0, 0); 2];
    for (i, f) in files.iter().enumerate() {
        let m = std::fs::metadata(f).map_err(|e| format!("stat {f}: {e}"))?;
        let mtime = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos());
        s[i] = (m.len(), mtime);
    }
    Ok(s)
}

fn load(cert_file: &str, key_file: &str) -> Result<Arc<CertifiedKey>, String> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(cert_file)
        .map_err(|e| format!("tls: {cert_file}: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("tls: {cert_file}: {e}"))?;
    if certs.is_empty() {
        return Err(format!("tls: failed to find any PEM data in certificate input {cert_file}"));
    }
    let key =
        PrivateKeyDer::from_pem_file(key_file).map_err(|e| format!("tls: {key_file}: {e}"))?;
    let signer = rustls::crypto::ring::sign::any_supported_type(&key)
        .map_err(|e| format!("tls: {key_file}: {e}"))?;
    let ck = CertifiedKey::new(certs, signer);
    ck.keys_match().map_err(|e| format!("tls: private key does not match public key: {e}"))?;
    Ok(Arc::new(ck))
}

impl CertFiles {
    /// Loads the pair, failing when it does not load, so a wrong path or a mismatched pair fails
    /// at startup rather than at the first handshake.
    pub fn load(cert_file: &str, key_file: &str) -> Result<Arc<CertFiles>, String> {
        let loaded = stat([cert_file, key_file])?;
        let cert = load(cert_file, key_file)?;
        Ok(Arc::new(CertFiles {
            cert_file: cert_file.into(),
            key_file: key_file.into(),
            state: Mutex::new(State { cert, loaded, failed: None, checked: Instant::now() }),
        }))
    }

    /// the current certificate, reloading the pair first when a check is due and finds the files
    /// changed
    pub fn get(&self) -> Arc<CertifiedKey> {
        let mut st = self.state.lock().unwrap();

        // is a check due?
        let now = Instant::now();
        if now.duration_since(st.checked) < CERT_CHECK_INTERVAL {
            return st.cert.clone();
        }
        st.checked = now;

        // have the files changed since the certificate in hand was loaded?
        let stamp = stat([&self.cert_file, &self.key_file]);
        if let Ok(s) = &stamp
            && *s == st.loaded
        {
            st.failed = None;
            return st.cert.clone();
        }
        let err = match &stamp {
            Ok(s) => match load(&self.cert_file, &self.key_file) {
                Ok(c) => {
                    st.cert = c;
                    st.loaded = *s;
                    st.failed = None;
                    eprintln!("tls: loaded a new certificate from {}", self.cert_file);
                    return st.cert.clone();
                }
                Err(e) => e,
            },
            Err(e) => e.clone(),
        };

        // the files are missing or do not load, so the certificate in hand stays
        if let Some(e) = newly_failed(&mut st, err) {
            eprintln!("tls: keeping the current certificate: {e}");
        }
        st.cert.clone()
    }
}

// a failure to log, None when it is the one already logged, which it stays until the files load
// or return to the certificate in hand
fn newly_failed(st: &mut State, err: String) -> Option<String> {
    if st.failed.as_ref() == Some(&err) {
        return None;
    }
    st.failed = Some(err.clone());
    Some(err)
}

impl ResolvesServerCert for CertFiles {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // a self-signed certificate with the serial given, as PEM files of the certificate and its
    // key, and the certificate's DER
    fn write_pair(dir: &Path, serial: u64) -> (String, String, Vec<u8>) {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.serial_number = Some(rcgen::SerialNumber::from(serial));
        let cert = params.self_signed(&key).unwrap();
        std::fs::create_dir_all(dir).unwrap();
        let (c, k) = (dir.join("cert.pem"), dir.join("key.pem"));
        std::fs::write(&c, cert.pem()).unwrap();
        std::fs::write(&k, key.serialize_pem()).unwrap();
        (c.display().to_string(), k.display().to_string(), cert.der().to_vec())
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pldb-tls-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    // the leaf certificate a handshake would present now
    fn served(c: &CertFiles) -> Vec<u8> {
        c.get().cert[0].to_vec()
    }

    // the next handshake checks the files, as one would a second later
    fn due(c: &CertFiles) {
        let mut st = c.state.lock().unwrap();
        st.checked = Instant::now().checked_sub(2 * CERT_CHECK_INTERVAL).unwrap_or(st.checked);
    }

    // writes a file's contents into another file in place, then moves its modification time
    // forward so a check sees the change even within the filesystem's timestamp granularity
    fn replace(from: &str, to: &str) {
        std::fs::write(to, std::fs::read(from).unwrap()).unwrap();
        let future = std::time::SystemTime::now() + Duration::from_secs(60);
        std::fs::File::options().write(true).open(to).unwrap().set_modified(future).unwrap();
    }

    #[test]
    fn rotation() {
        let dir = temp("rotation");
        let (cert, key, one) = write_pair(&dir.join("live"), 1);
        let c = CertFiles::load(&cert, &key).unwrap();
        assert_eq!(served(&c), one);

        // a rotation reaches the next handshake once a check is due, and not before
        let (cert2, key2, two) = write_pair(&dir.join("two"), 2);
        replace(&cert2, &cert);
        replace(&key2, &key);
        assert_eq!(served(&c), one, "before a check is due");
        due(&c);
        assert_eq!(served(&c), two, "after the rotation");

        // a rotation caught halfway, a new certificate beside the old key, keeps the certificate
        // in hand, and the next check after the key lands loads the pair
        let (cert3, key3, three) = write_pair(&dir.join("three"), 3);
        replace(&cert3, &cert);
        due(&c);
        assert_eq!(served(&c), two, "halfway through a rotation");
        replace(&key3, &key);
        due(&c);
        assert_eq!(served(&c), three, "after the rotation completed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // a rotation by swapping symlinks, as certbot and Kubernetes rotate, is followed to the new
    // files
    #[test]
    fn rotation_by_symlink() {
        let dir = temp("symlink");
        let (_, _, one) = write_pair(&dir.join("one"), 1);
        let (cert2, key2, two) = write_pair(&dir.join("two"), 2);
        let link = dir.join("current");

        // the second pair's files differ from the first's in their stamp, as files written apart
        // in time do, beyond the filesystem's timestamp granularity
        replace(&cert2, &cert2);
        replace(&key2, &key2);
        std::os::unix::fs::symlink("one", &link).unwrap();
        let c = CertFiles::load(
            &link.join("cert.pem").display().to_string(),
            &link.join("key.pem").display().to_string(),
        )
        .unwrap();
        assert_eq!(served(&c), one);

        // swap the link atomically, as a rename over it
        let next = dir.join("next");
        std::os::unix::fs::symlink("two", &next).unwrap();
        std::fs::rename(&next, &link).unwrap();
        due(&c);
        assert_eq!(served(&c), two, "after the swap");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failure_is_logged_once_while_it_lasts() {
        let dir = temp("failure");
        let (cert, key, one) = write_pair(&dir.join("live"), 1);
        let c = CertFiles::load(&cert, &key).unwrap();

        // missing files fail every check, but only the first one logs
        std::fs::remove_file(&cert).unwrap();
        due(&c);
        assert_eq!(served(&c), one, "the certificate in hand stays");
        let failed = c.state.lock().unwrap().failed.clone();
        assert!(failed.as_deref().is_some_and(|f| f.contains("stat")), "{failed:?}");
        assert_eq!(newly_failed(&mut c.state.lock().unwrap(), failed.clone().unwrap()), None);

        // another failure logs, and a load clears the one in hand
        assert!(newly_failed(&mut c.state.lock().unwrap(), "another".into()).is_some());
        let (_, _, two) = write_pair(&dir.join("live"), 2);
        due(&c);
        assert_eq!(served(&c), two, "the files that load again");
        assert_eq!(c.state.lock().unwrap().failed, None, "a load clears the failure");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_fail_at_startup() {
        let dir = temp("startup");
        let (cert, _, _) = write_pair(&dir.join("one"), 1);
        let (_, other_key, _) = write_pair(&dir.join("two"), 2);
        assert!(
            CertFiles::load(&dir.join("missing.pem").display().to_string(), &other_key).is_err()
        );
        assert!(CertFiles::load(&cert, &other_key).is_err(), "a mismatched pair loaded");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
