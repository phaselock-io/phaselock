package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// a self-signed certificate with the serial given, as PEM files of the certificate and its key
func writePair(t *testing.T, dir string, serial int64) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}

// a TLS listener serving the pair's certificate, and a dial that answers the serial it presents
func serveCerts(t *testing.T, c *certFiles) func() int64 {
	t.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{GetCertificate: c.get})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				conn.(*tls.Conn).Handshake()
				conn.Close()
			}()
		}
	}()
	return func() int64 {
		t.Helper()
		conn, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{InsecureSkipVerify: true})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		return conn.ConnectionState().PeerCertificates[0].SerialNumber.Int64()
	}
}

// the next handshake checks the files, as one would a second later
func due(c *certFiles) {
	c.mu.Lock()
	c.checked = time.Time{}
	c.mu.Unlock()
}

// writes a file's contents into another file in place, then moves its modification time forward
// so a check sees the change even within the filesystem's timestamp granularity
func replace(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	if err := os.Chtimes(to, future, future); err != nil {
		t.Fatal(err)
	}
}

func TestCertRotation(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := writePair(t, filepath.Join(dir, "live"), 1)
	c, err := loadCertFiles(certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	serial := serveCerts(t, c)
	if got := serial(); got != 1 {
		t.Fatalf("first handshake: serial %d", got)
	}

	// a rotation reaches the next handshake once a check is due, and not before
	cert2, key2 := writePair(t, filepath.Join(dir, "two"), 2)
	replace(t, cert2, certFile)
	replace(t, key2, keyFile)
	if got := serial(); got != 1 {
		t.Fatalf("before a check is due: serial %d", got)
	}
	due(c)
	if got := serial(); got != 2 {
		t.Fatalf("after the rotation: serial %d", got)
	}

	// a rotation caught halfway, a new certificate beside the old key, keeps the certificate in
	// hand, and the next check after the key lands loads the pair
	cert3, key3 := writePair(t, filepath.Join(dir, "three"), 3)
	replace(t, cert3, certFile)
	due(c)
	if got := serial(); got != 2 {
		t.Fatalf("halfway through a rotation: serial %d", got)
	}
	replace(t, key3, keyFile)
	due(c)
	if got := serial(); got != 3 {
		t.Fatalf("after the rotation completed: serial %d", got)
	}
}

// a rotation by swapping symlinks, as certbot and Kubernetes rotate, is followed to the new files
func TestCertRotationBySymlink(t *testing.T) {
	dir := t.TempDir()
	writePair(t, filepath.Join(dir, "one"), 1)
	writePair(t, filepath.Join(dir, "two"), 2)
	link := filepath.Join(dir, "current")
	if err := os.Symlink("one", link); err != nil {
		t.Fatal(err)
	}
	c, err := loadCertFiles(filepath.Join(link, "cert.pem"), filepath.Join(link, "key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	serial := serveCerts(t, c)
	if got := serial(); got != 1 {
		t.Fatalf("first handshake: serial %d", got)
	}

	// swap the link atomically, as a rename over it
	next := filepath.Join(dir, "next")
	if err := os.Symlink("two", next); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(next, link); err != nil {
		t.Fatal(err)
	}
	due(c)
	if got := serial(); got != 2 {
		t.Fatalf("after the swap: serial %d", got)
	}
}

func TestCertFilesFailAtStartup(t *testing.T) {
	dir := t.TempDir()
	certFile, _ := writePair(t, filepath.Join(dir, "one"), 1)
	_, otherKey := writePair(t, filepath.Join(dir, "two"), 2)
	if _, err := loadCertFiles(filepath.Join(dir, "missing.pem"), otherKey); err == nil {
		t.Fatal("a missing certificate loaded")
	}
	if _, err := loadCertFiles(certFile, otherKey); err == nil {
		t.Fatal("a mismatched pair loaded")
	}
}
