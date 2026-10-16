package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	data := flag.String("data", "./data", "data directory")
	bundle := flag.String("bundle", "", "path to the bundle JS file")
	listen := flag.String("listen", "127.0.0.1:8080", "listen address")
	devAuth := flag.Bool("dev-auth", false, "sign in as any existing account with no credential at /auth/token")
	clientIPHeader := flag.String("client-ip-header", "", "the header a proxy sets to the client's address, "+
		"such as CF-Connecting-IP; set only when nothing but the proxy can reach the listen address")
	maxCommands := flag.Int("max-commands", 128, "the most commands one request may carry")
	maxAnonymousCommands := flag.Int("max-anonymous-commands", 8,
		"the most commands one request without a session may carry")
	pathPrefix := flag.String("path-prefix", "/phaselock", "the path every route is under, so an "+
		"origin shared with an app routes one prefix to the database; \"\" for the root")
	tlsCert := flag.String("tls-cert", "", "serve HTTPS with the certificate in this PEM file, "+
		"reloaded when the file changes; requires --tls-key")
	tlsKey := flag.String("tls-key", "", "the private key of --tls-cert, in a PEM file")
	var bootstrapEnv []string
	flag.Func("bootstrap-env", "an environment variable the bundle's bootstrap may read (repeatable)", func(name string) error {
		bootstrapEnv = append(bootstrapEnv, name)
		return nil
	})
	flag.Parse()
	if *bundle == "" {
		fmt.Fprintln(os.Stderr, errNoBundle)
		os.Exit(2)
	}
	if (*tlsCert == "") != (*tlsKey == "") {
		fmt.Fprintln(os.Stderr, "phaselockdb: --tls-cert and --tls-key go together")
		os.Exit(2)
	}

	// a certificate pair loads before anything opens, so a wrong path or a mismatched pair fails
	// at once
	var certs *certFiles
	if *tlsCert != "" {
		var err error
		if certs, err = loadCertFiles(*tlsCert, *tlsKey); err != nil {
			log.Fatal(err)
		}
	}

	// one context for the process, ended by a signal
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv, err := Open(ctx, Options{DataDir: *data, Bundle: *bundle, DevAuth: *devAuth, BootstrapEnv: bootstrapEnv,
		ClientIPHeader: *clientIPHeader, MaxCommands: *maxCommands, MaxAnonymousCommands: *maxAnonymousCommands,
		PathPrefix: *pathPrefix})
	if err != nil {
		log.Fatal(err)
	}
	web := &http.Server{Addr: *listen, Handler: srv.Handler(), BaseContext: srv.BaseContext}
	served := make(chan error, 1)

	// serve HTTPS with the certificate pair, rotated by replacing its files, or else HTTP
	scheme := "http"
	if certs != nil {
		web.TLSConfig = &tls.Config{GetCertificate: certs.get}
		scheme = "https"
		go func() { served <- web.ListenAndServeTLS("", "") }()
	} else {
		go func() { served <- web.ListenAndServe() }()
	}
	log.Printf("phaselockdb listening on %s://%s%s (epoch %s)", scheme, *listen, *pathPrefix, srv.epoch)

	// serve until the signal, or until serving fails
	select {
	case <-ctx.Done():
	case err := <-served:
		srv.Close()
		log.Fatal(err)
	}

	/* Shut down in order: every request is already ending with the context, so Shutdown waits
	   only for handlers to return, a cgo call in progress included; then the server closes its
	   hash workers and the core, which commits the batch in hand. */
	web.Shutdown(context.Background())
	srv.Close()
}
