package main

import (
	"context"
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

	// one context for the process, ended by a signal
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv, err := Open(ctx, Options{DataDir: *data, Bundle: *bundle, DevAuth: *devAuth, BootstrapEnv: bootstrapEnv,
		ClientIPHeader: *clientIPHeader})
	if err != nil {
		log.Fatal(err)
	}
	web := &http.Server{Addr: *listen, Handler: srv.Handler(), BaseContext: srv.BaseContext}
	served := make(chan error, 1)
	go func() { served <- web.ListenAndServe() }()
	log.Printf("pldb listening on %s (epoch %s)", *listen, srv.epoch)

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
