//! phaselockdb: PhaseLock's v0 database, the binary: its flags, TLS, and signals over the
//! library (lib.rs).

use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;

use phaselockdb::server::{self, Options, Server};
use phaselockdb::{cron, listen, tlscert};

/// The command line, in any of the forms -name value, --name value, -name=value, and
/// --name=value, a boolean flag alone or with =true or =false.
struct Flags {
    data: String,
    bundle: String,
    listen: String,
    dev_auth: bool,
    client_ip_header: String,
    max_mutations: i64,
    max_anonymous_mutations: i64,
    path_prefix: String,
    tls_cert: String,
    tls_key: String,
    sqlite_cache_size: i64,
    max_stream_backlog: i64,
    principal_ttl: Duration,
    bootstrap_env: Vec<String>,
}

const USAGE: &str = "usage: phaselockdb --bundle <file> [flags]

  --data <dir>                      data directory (default ./data)
  --bundle <file>                   path to the bundle JS file
  --listen <addr>                   listen address (default 127.0.0.1:8080)
  --dev-auth                        sign in as any existing account with no credential at /auth/token
  --client-ip-header <name>         the header a proxy sets to the client's address, such as
                                    CF-Connecting-IP; set only when nothing but the proxy can reach
                                    the listen address
  --max-mutations <n>               the most mutations one request may carry (default 128)
  --max-anonymous-mutations <n>     the most mutations one request without a session may carry
                                    (default 8)
  --path-prefix <path>              the path every route is under (default /phaselock); \"\" for
                                    the root
  --tls-cert <file>                 serve HTTPS with the certificate in this PEM file, reloaded
                                    when the file changes; requires --tls-key
  --tls-key <file>                  the private key of --tls-cert, in a PEM file
  --sqlite-cache-size <MiB>         the page cache of each SQLite connection (default 64)
  --max-stream-backlog <n>          the most commits and view changes a /stream connection may
                                    have queued and unsent before it is dropped (default 2048)
  --principal-ttl <duration>        how long a principal's grant and account are kept once it has
                                    no connection and has gone unused (default 1m0s)
  --bootstrap-env <name>            an environment variable the bundle's bootstrap may read
                                    (repeatable)";

fn parse_flags(args: &[String]) -> Result<Flags, String> {
    let mut f = Flags {
        data: "./data".into(),
        bundle: String::new(),
        listen: "127.0.0.1:8080".into(),
        dev_auth: false,
        client_ip_header: String::new(),
        max_mutations: 128,
        max_anonymous_mutations: 8,
        path_prefix: "/phaselock".into(),
        tls_cert: String::new(),
        tls_key: String::new(),
        sqlite_cache_size: 64,
        max_stream_backlog: 2048,
        principal_ttl: Duration::from_secs(60),
        bootstrap_env: Vec::new(),
    };
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        let Some(name) = a.strip_prefix("--").or_else(|| a.strip_prefix('-')) else {
            // the flags end at the first argument that is not one
            break;
        };
        if name.is_empty() {
            break;
        }
        let (name, inline) = match name.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (name, None),
        };
        let bad = |v: &str| format!("invalid value {v:?} for flag -{name}");

        // a boolean flag
        if name == "dev-auth" {
            f.dev_auth = match inline.as_deref() {
                None | Some("true") | Some("1") => true,
                Some("false") | Some("0") => false,
                Some(v) => return Err(bad(v)),
            };
            continue;
        }

        // any other takes a value
        let v = match inline {
            Some(v) => v,
            None => {
                let Some(v) = args.get(i) else {
                    return Err(format!("flag needs an argument: -{name}"));
                };
                i += 1;
                v.clone()
            }
        };
        let int = |v: &str| v.parse::<i64>().map_err(|_| bad(v));
        let dur = |v: &str| cron::parse_duration(v).map_err(|_| bad(v));
        match name {
            "data" => f.data = v,
            "bundle" => f.bundle = v,
            "listen" => f.listen = v,
            "client-ip-header" => f.client_ip_header = v,
            "max-mutations" => f.max_mutations = int(&v)?,
            "max-anonymous-mutations" => f.max_anonymous_mutations = int(&v)?,
            "path-prefix" => f.path_prefix = v,
            "tls-cert" => f.tls_cert = v,
            "tls-key" => f.tls_key = v,
            "sqlite-cache-size" => f.sqlite_cache_size = int(&v)?,
            "max-stream-backlog" => f.max_stream_backlog = int(&v)?,
            "principal-ttl" => f.principal_ttl = dur(&v)?,
            "bootstrap-env" => f.bootstrap_env.push(v),
            _ => return Err(format!("flag provided but not defined: -{name}")),
        }
    }
    Ok(f)
}

fn fail(msg: impl std::fmt::Display, code: i32) -> ! {
    eprintln!("{msg}");
    std::process::exit(code)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help" || a == "-help") {
        println!("{USAGE}");
        return;
    }
    let f = parse_flags(&args).unwrap_or_else(|e| fail(format!("{e}\n{USAGE}"), 2));

    // the options a server refuses come first, then the bundle, then the certificate pair
    if let Err(e) = server::check_client_ip_header(&f.client_ip_header)
        .and_then(|()| server::check_path_prefix(&f.path_prefix))
        .and_then(|()| server::check_cache_size(f.sqlite_cache_size).map(|_| ()))
    {
        fail(format!("phaselockdb: {e}"), 1);
    }
    if f.bundle.is_empty() {
        fail("a bundle path is required", 2);
    }
    if f.tls_cert.is_empty() != f.tls_key.is_empty() {
        fail("phaselockdb: --tls-cert and --tls-key go together", 2);
    }
    let certs = (!f.tls_cert.is_empty()).then(|| {
        tlscert::CertFiles::load(&f.tls_cert, &f.tls_key)
            .unwrap_or_else(|e| fail(format!("phaselockdb: {e}"), 1))
    });

    let rt =
        tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = rt.block_on(run(f, certs));
    drop(rt);
    std::process::exit(code);
}

async fn run(f: Flags, certs: Option<Arc<tlscert::CertFiles>>) -> i32 {
    let o = Options {
        data_dir: f.data,
        bundle: f.bundle,
        dev_auth: f.dev_auth,
        hasher: None,
        hash_workers: 0,
        auth_burst: 0,
        auth_rate: 0.0,
        bootstrap_env: f.bootstrap_env,
        client_ip_header: f.client_ip_header,
        max_mutations: f.max_mutations.max(0) as usize,
        max_anonymous_mutations: f.max_anonymous_mutations.max(0) as usize,
        path_prefix: f.path_prefix.clone(),
        sqlite_cache_size: f.sqlite_cache_size,
        max_stream_backlog: f.max_stream_backlog.max(0) as usize,
        principal_ttl: f.principal_ttl,
        heartbeat: Duration::ZERO,
        call_limit: Duration::ZERO,
        check_registrations: false,
        clock: None,
    };
    let srv = match Server::open(o).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("phaselockdb: {e}");
            return 1;
        }
    };
    let listener = match TcpListener::bind(&f.listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("phaselockdb: listen {}: {e}", f.listen);
            srv.close().await;
            return 1;
        }
    };
    let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or(f.listen.clone());
    let tls = certs.map(|c| {
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("tls versions")
        .with_no_client_auth()
        .with_cert_resolver(c);
        cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        tokio_rustls::TlsAcceptor::from(Arc::new(cfg))
    });
    let scheme = if tls.is_some() { "https" } else { "http" };
    eprintln!("phaselockdb listening on {scheme}://{addr}{} (epoch {})", f.path_prefix, srv.epoch);

    // serve until a signal ends the server's lifetime
    let serving = tokio::spawn(listen::serve(srv.clone(), listener, tls));
    let mut term =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }

    /* Shut down in order: every request ends with the server's lifetime, so the connections wait
    only for handlers to return; then the server closes its hash workers and the core, which
    commits the batch in hand. */
    srv.cancel();
    let _ = serving.await;
    srv.close().await;
    0
}
