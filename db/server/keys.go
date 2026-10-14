package main

// Token keys.  Tokens are EdDSA JWTs over Ed25519 keys.  A private key lives only in the memory
// of the process that signs with it: the first signature after startup mints one, and so does
// the first signature once the current key has been signing for keyRotation, so every restart is
// a rotation and an idle server mints nothing.  A key's public half is committed to the token key
// table before anything it signed leaves the process, and verification accepts any stored key,
// found by the token's kid, so a token outlives the process that signed it.
//
// A key stops signing when its successor is minted, or when its process ends, which is no later
// than the next process's start.  It is swept once every token it could have signed has
// expired, the token lifetime past that, plus keyGrace, so that a clock stepped back between a
// key's last signature and its successor's minting cannot strand a live token.  Keeping a public
// key longer costs nothing, since it can forge nothing.  The sweep runs whenever a key is minted.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

const (
	keyRotation = 24 * time.Hour
	keyGrace    = 24 * time.Hour
)

// tokenKey is one stored key: its id, its public half, and when it was minted
type tokenKey struct {
	kid    string
	pub    ed25519.PublicKey
	minted time.Time
}

// keyring holds every stored key and the key this process signs with.
type keyring struct {
	// held by a signature, so that two never mint at once
	signMu  sync.Mutex
	current *tokenKey
	private ed25519.PrivateKey

	// the stored keys, by id and oldest first, and the ids of those minted before this process
	// started, at start
	mu     sync.RWMutex
	byKid  map[string]*tokenKey
	sorted []*tokenKey
	past   map[string]bool
	start  time.Time
}

func newKeyring(stored []tokenKey, start time.Time) *keyring {
	ring := &keyring{byKid: map[string]*tokenKey{}, past: map[string]bool{}, start: start}
	for i := range stored {
		k := &stored[i]
		ring.byKid[k.kid] = k
		ring.sorted = append(ring.sorted, k)
		ring.past[k.kid] = true
	}
	ring.order()
	return ring
}

// order sorts the stored keys oldest first, as the table lists them
func (ring *keyring) order() {
	sort.SliceStable(ring.sorted, func(i, j int) bool {
		a, b := ring.sorted[i], ring.sorted[j]
		if !a.minted.Equal(b.minted) {
			return a.minted.Before(b.minted)
		}
		return a.kid < b.kid
	})
}

// key is the stored key a token names, or nil
func (ring *keyring) key(kid string) *tokenKey {
	ring.mu.RLock()
	defer ring.mu.RUnlock()
	return ring.byKid[kid]
}

// swept is the ids of the keys whose every token has expired by now, when a key minted at minted
// succeeds the newest
func (ring *keyring) swept(minted, now time.Time) []string {
	ring.mu.RLock()
	defer ring.mu.RUnlock()
	var out []string
	for i, k := range ring.sorted {
		// the key stopped signing when its successor was minted, or, for a past process's key, by
		// this process's start
		retired := minted
		if i+1 < len(ring.sorted) {
			retired = ring.sorted[i+1].minted
		}
		if ring.past[k.kid] && ring.start.Before(retired) {
			retired = ring.start
		}
		if retired.Add(tokenLifetime + keyGrace).Before(now) {
			out = append(out, k.kid)
		}
	}
	return out
}

// signer answers the key to sign with now, minting one when this process has none or the current
// one has been signing for keyRotation.  A minted key and the sweep it makes are durable before it
// is answered.
func (s *Server) signer(now time.Time) (*tokenKey, ed25519.PrivateKey, error) {
	ring := s.keys
	if ring.current != nil && now.Sub(ring.current.minted) < keyRotation {
		return ring.current, ring.private, nil
	}

	// a fresh key, and the keys it retires for good
	pub, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	id := make([]byte, 16)
	rand.Read(id)
	k := &tokenKey{kid: hex.EncodeToString(id), pub: pub, minted: now}
	sweep := ring.swept(k.minted, now)

	// committed before anything it signs leaves the process
	r := s.request(func(reqid uint64) { s.core.addKey(reqid, *k, sweep) })
	if r.status != 0 {
		return nil, nil, fmt.Errorf("storing a token key: %s", r.errmsg)
	}
	ring.mu.Lock()
	ring.byKid[k.kid] = k
	ring.sorted = append(ring.sorted, k)
	for _, kid := range sweep {
		delete(ring.byKid, kid)
		delete(ring.past, kid)
	}
	kept := ring.sorted[:0]
	for _, old := range ring.sorted {
		if ring.byKid[old.kid] != nil {
			kept = append(kept, old)
		}
	}
	ring.sorted = kept
	ring.order()
	ring.mu.Unlock()
	ring.current, ring.private = k, private
	return k, private, nil
}

// signFailed answers a request whose token could not be signed, as only a closing server fails
// to store a key
func signFailed(w http.ResponseWriter, err error) {
	http.Error(w, err.Error(), http.StatusServiceUnavailable)
}
