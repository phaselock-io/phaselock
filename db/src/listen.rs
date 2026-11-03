//! Serving a listener: each connection it accepts is served by hyper, HTTP/1.1 or, over TLS,
//! HTTP/2, until the server's lifetime ends.

use std::sync::Arc;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::GracefulShutdown;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use crate::server::Server;

/// how long the end of the server's lifetime waits for its connections to finish
const DRAIN: Duration = Duration::from_secs(10);

/// Serves the listener's connections until the server's lifetime ends, which ends every request
/// at once, then waits up to DRAIN for the connections to finish.
pub async fn serve(srv: Arc<Server>, listener: TcpListener, tls: Option<TlsAcceptor>) {
    let graceful = GracefulShutdown::new();
    let mut done = srv.done.subscribe();
    loop {
        let (stream, remote) = tokio::select! {
            a = listener.accept() => match a {
                Ok(a) => a,
                Err(_) => continue,
            },
            _ = crate::pool::until(&mut done) => break,
        };
        let _ = stream.set_nodelay(true);
        let s = srv.clone();
        let remote = remote.to_string();
        let svc = service_fn(move |req| {
            let s = s.clone();
            let remote = remote.clone();
            async move { Ok::<_, std::convert::Infallible>(s.serve(req, remote).await) }
        });
        match &tls {
            None => {
                let conn = auto::Builder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(TokioIo::new(stream), svc)
                    .into_owned();
                tokio::spawn(graceful.watch(conn));
            }
            Some(acceptor) => {
                let acceptor = acceptor.clone();
                let watcher = graceful.watcher();
                tokio::spawn(async move {
                    let Ok(stream) = acceptor.accept(stream).await else { return };
                    let conn = auto::Builder::new(TokioExecutor::new())
                        .serve_connection_with_upgrades(TokioIo::new(stream), svc)
                        .into_owned();
                    let _ = watcher.watch(conn).await;
                });
            }
        }
    }
    drop(listener);
    let _ = tokio::time::timeout(DRAIN, graceful.shutdown()).await;
}
