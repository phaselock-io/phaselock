package main

// Serving TLS from a certificate and key on disk, which the operator rotates by replacing the
// files.

import (
	"crypto/tls"
	"log"
	"os"
	"sync"
	"time"
)

// how often a handshake may look at the files for a rotation
const certCheckInterval = time.Second

// the files of a certificate pair as a check found them: each one's size and modification time
type certStamp [2]struct{ size, mod int64 }

// certFiles serves the certificate a pair of files holds, as a tls.Config's GetCertificate.  A
// handshake, at most once per certCheckInterval, stats the files, following symlinks, and reloads
// the pair when either changed, so a rotation reaches every new connection and an open one keeps
// the certificate it shook hands with.  A pair that does not load, such as one caught halfway
// through a rotation, leaves the last certificate that loaded in place until a later check loads
// the pair.
type certFiles struct {
	certFile, keyFile string

	mu      sync.Mutex
	cert    *tls.Certificate
	loaded  certStamp // the files as the certificate in hand was loaded from them
	failed  certStamp // the files as the last load that failed found them, logged once
	checked time.Time
}

// loadCertFiles loads the pair, failing when it does not load, so a wrong path or a mismatched
// pair fails at startup rather than at the first handshake
func loadCertFiles(certFile, keyFile string) (*certFiles, error) {
	c := &certFiles{certFile: certFile, keyFile: keyFile}
	stamp, err := c.stat()
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	c.cert, c.loaded, c.checked = &cert, stamp, time.Now()
	return c, nil
}

func (c *certFiles) stat() (certStamp, error) {
	var stamp certStamp
	for i, name := range []string{c.certFile, c.keyFile} {
		fi, err := os.Stat(name)
		if err != nil {
			return stamp, err
		}
		stamp[i].size, stamp[i].mod = fi.Size(), fi.ModTime().UnixNano()
	}
	return stamp, nil
}

// get answers the current certificate, reloading the pair first when a check is due and finds
// the files changed
func (c *certFiles) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// is a check due?
	now := time.Now()
	if now.Sub(c.checked) < certCheckInterval {
		return c.cert, nil
	}
	c.checked = now

	// have the files changed since the certificate in hand was loaded?
	stamp, err := c.stat()
	if err == nil && stamp == c.loaded {
		return c.cert, nil
	}
	if err == nil {
		var cert tls.Certificate
		cert, err = tls.LoadX509KeyPair(c.certFile, c.keyFile)
		if err == nil {
			c.cert, c.loaded = &cert, stamp
			log.Printf("tls: loaded a new certificate from %s", c.certFile)
			return c.cert, nil
		}
	}

	// the files are missing or do not load, so the certificate in hand stays; each state of the
	// files is logged once
	if stamp != c.failed {
		c.failed = stamp
		log.Printf("tls: keeping the current certificate: %v", err)
	}
	return c.cert, nil
}
