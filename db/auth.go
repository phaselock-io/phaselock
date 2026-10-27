package main

// Tokens and passwords.  Tokens are EdDSA JWTs signed with the token keys
// (keys.go); passwords are argon2id hashes in a PHC string, which carries
// the parameters they were made with.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

const tokenLifetime = 30 * 24 * time.Hour

// the argon2id parameters new hashes are made with
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

// PHC strings use the standard alphabet with no padding
var phc64 = base64.RawStdEncoding

type claims struct {
	Sub string `json:"sub"`
	Gen int64  `json:"gen"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
	Jti string `json:"jti"`
}

var b64 = base64.RawURLEncoding

// header is a token's JOSE header
type header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

// mint signs a token for an account at its generation, answering it and its expiry
func (s *Server) mint(user string, gen int64) (string, int64, error) {
	s.keys.signMu.Lock()
	defer s.keys.signMu.Unlock()
	now := s.now()
	k, private, err := s.signer(now)
	if err != nil {
		return "", 0, err
	}
	jti := make([]byte, 8)
	rand.Read(jti)
	c := claims{Sub: user, Gen: gen, Iat: now.Unix(), Exp: now.Add(tokenLifetime).Unix(), Jti: fmt.Sprintf("%x", jti)}
	h, _ := json.Marshal(header{Alg: "EdDSA", Typ: "JWT", Kid: k.kid})
	payload, _ := json.Marshal(c)
	signing := b64.EncodeToString(h) + "." + b64.EncodeToString(payload)
	sig := ed25519.Sign(private, []byte(signing))
	return signing + "." + b64.EncodeToString(sig), c.Exp, nil
}

func (s *Server) verify(token string) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}

	// the key the header names, which signs only EdDSA
	raw, err := b64.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("malformed token")
	}
	var h header
	if err := json.Unmarshal(raw, &h); err != nil {
		return nil, errors.New("malformed token")
	}
	if h.Alg != "EdDSA" {
		return nil, errors.New("unsupported token algorithm")
	}
	k := s.keys.key(h.Kid)
	if k == nil {
		return nil, errors.New("unknown token key")
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(k.pub, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, errors.New("bad signature")
	}

	// the claims, until they expire
	payload, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("malformed token")
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, errors.New("malformed token")
	}
	if c.Exp < s.now().Unix() {
		return nil, errors.New("token expired")
	}
	return &c, nil
}

// principalOf resolves the Authorization header; no header is anonymous.  A token whose generation
// is not the one the core last published for its user is refused here, without a trip to the
// writer, which checks every other token.
func (s *Server) principalOf(r *http.Request) (principal, error) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return principal{anonymous: true, gen: -1}, nil
	}
	token, ok := strings.CutPrefix(h, "Bearer ")
	if !ok {
		return principal{}, errors.New("expected a bearer token")
	}
	c, err := s.verify(token)
	if err != nil {
		return principal{}, err
	}
	s.mu.Lock()
	gen, known := s.generations[c.Sub]
	s.mu.Unlock()
	if known && gen != c.Gen {
		return principal{}, errRevoked
	}
	return principal{user: c.Sub, gen: c.Gen, exp: c.Exp}, nil
}

var errRevoked = errors.New("token revoked")

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory,
		argonTime, argonThreads, phc64.EncodeToString(salt), phc64.EncodeToString(key))
}

// dummyVerify spends what verifying a password at the current parameters spends, and answers
// false: what a login naming no account gets, so its timing does not tell it from a wrong
// password
func dummyVerify(pw string) bool {
	salt := make([]byte, 16)
	rand.Read(salt)
	argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return false
}

func verifyPassword(hash, pw string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	var memory, times uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &times, &threads); err != nil {
		return false
	}
	salt, err := phc64.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := phc64.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false
	}
	key := argon2.IDKey([]byte(pw), salt, times, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(key, want) == 1
}

/*
clientOf names the client a request comes from, for its hashing budget: its address from the

	client IP header, when the server names one and the request carries a valid one, or else the
	address it connected from.  An IPv6 client is named by its /64, since a single host is commonly
	given a whole /64 to draw addresses from.
*/
func (s *Server) clientOf(r *http.Request) string {
	if s.clientIPHeader != "" {
		if addr, err := netip.ParseAddr(strings.TrimSpace(r.Header.Get(s.clientIPHeader))); err == nil {
			return clientKey(addr)
		}
	}
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		return clientKey(ap.Addr())
	}
	return r.RemoteAddr
}

// clientKey is the budget key of an address: an IPv4 address itself, an IPv6 one its /64
func clientKey(addr netip.Addr) string {
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	return netip.PrefixFrom(addr.WithZone(""), 64).Masked().String()
}

// checkClientIPHeader refuses a client IP header that holds a list of addresses rather than one
func checkClientIPHeader(name string) error {
	if strings.EqualFold(name, "X-Forwarded-For") || strings.EqualFold(name, "Forwarded") {
		return fmt.Errorf("client IP header %s is unsupported: name a header holding one address, "+
			"such as CF-Connecting-IP", name)
	}
	return nil
}

// hashFailed answers a request whose password hashing did not run: the client's budget is spent,
// the pool is full, or the server is going away.
func hashFailed(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errLimited):
		http.Error(w, err.Error(), http.StatusTooManyRequests)
	default:
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	}
}

// the bundle's lookup result; passwordHash is nil for an account without one
type account struct {
	user         string
	generation   int64
	passwordHash *string
}

// whether two lookup answers hold the same credentials: no account in either, or the same user
// with the same password hash
func sameCredentials(a, b *account) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.user != b.user || (a.passwordHash == nil) != (b.passwordHash == nil) {
		return false
	}
	return a.passwordHash == nil || *a.passwordHash == *b.passwordHash
}

func (s *Server) lookup(ident map[string]any) (*account, error) {
	r := s.request(func(reqid uint64) { s.core.lookup(reqid, mpEncode(ident)) })
	if r.status != 0 {
		return nil, errors.New(r.errmsg)
	}
	if len(r.buf) == 0 {
		return nil, nil
	}
	v, err := mpDecodeBytes(r.buf)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("lookup returned a non-object")
	}
	a := &account{}
	a.user, _ = m["user"].(string)
	if h, ok := m["passwordHash"].(string); ok {
		a.passwordHash = &h
	}
	if g, ok := m["generation"]; ok && g != nil {
		a.generation = asInt64(g)
	}
	return a, nil
}

// passwordHashOf is the password hash lookup answers for a principal's token, which its
// MutationAuth proofs are checked against: nil for the anonymous principal and for none
func (s *Server) passwordHashOf(p principal) (*string, error) {
	if p.anonymous {
		return nil, nil
	}
	r := s.request(func(reqid uint64) { s.core.account(reqid, p.user) })
	if r.status != 0 {
		return nil, errors.New(r.errmsg)
	}
	return r.hash, nil
}

// prove checks each mutation's proofs, the passwords prepare set aside, against hash, and answers
// each mutation's verdict: none for a mutation without proofs, and failed for one when there is
// no hash.  A first check spends the client's budget, as a login does; a check after a bounce does
// not (recheck).
func (s *Server) prove(ctx context.Context, client string, hash *string, proofs [][]string,
	first bool) ([]verdict, error) {
	verdicts := make([]verdict, len(proofs))
	for i, passwords := range proofs {
		if len(passwords) == 0 {
			continue
		}
		verdicts[i] = verdict{state: proofPassed, hash: hash}
		for _, password := range passwords {
			ok := false
			if hash != nil {
				h := *hash
				check := func() bool { return verifyPassword(h, password) }
				var err error
				if first {
					ok, err = s.verifyFor(ctx, client, check)
				} else {
					ok, err = s.recheck(ctx, check)
				}
				if err != nil {
					return nil, err
				}
			}
			if !ok {
				verdicts[i].state = proofFailed
				break
			}
		}
	}
	return verdicts, nil
}

func asInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case uint64:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}

func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := readBody(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	v, err := mpDecodeBytes(body)
	req, ok := v.(map[string]any)
	if err != nil || !ok {
		http.Error(w, "body must be a msgpack map", http.StatusBadRequest)
		return
	}
	kind, _ := req["kind"].(string)
	var user string
	var gen int64
	switch kind {
	case "dev":
		if !s.devAuth {
			http.Error(w, "dev auth is disabled", http.StatusForbidden)
			return
		}
		// password sign-in without the password: the account and its generation come from lookup
		identity, _ := req["identity"].(string)
		a, err := s.lookup(map[string]any{"kind": "password", "identity": identity})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if a == nil {
			http.Error(w, "no such account", http.StatusUnauthorized)
			return
		}
		user, gen = a.user, a.generation
	case "password":
		identity, _ := req["identity"].(string)
		password, _ := req["password"].(string)
		ident := map[string]any{"kind": "password", "identity": identity}
		a, err := s.lookup(ident)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var ok bool
		for attempt := 0; ; attempt++ {
			// an unknown account gets a dummy verification, so it answers no faster than a wrong
			// password and spends the same budget
			check := func() bool { return dummyVerify(password) }
			if a != nil && a.passwordHash != nil {
				hash := *a.passwordHash
				check = func() bool { return verifyPassword(hash, password) }
			}
			if attempt == 0 {
				ok, err = s.verifyFor(r.Context(), s.clientOf(r), check)
			} else {
				ok, err = s.recheck(r.Context(), check)
			}
			if err != nil {
				hashFailed(w, err)
				return
			}
			if s.proved != nil {
				s.proved()
			}

			// the login is decided against the credentials lookup answers now, so a password
			// checked against credentials that changed meanwhile is checked again
			now, err := s.lookup(ident)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if sameCredentials(a, now) {
				a = now
				break
			}
			if attempt == maxBounces {
				log.Printf("pldb: lookup answered different credentials for %q on each of %d reads",
					identity, maxBounces+2)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			a = now
		}
		if !ok {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		user, gen = a.user, a.generation
	case "refresh":
		p, err := s.principalOf(r)
		if err != nil || p.anonymous {
			http.Error(w, "refresh needs a bearer token", http.StatusUnauthorized)
			return
		}
		a, err := s.lookup(map[string]any{"kind": "refresh", "user": p.user})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// a token speaks only for an existing account at its current generation
		if a == nil || a.generation != p.gen {
			http.Error(w, "token revoked", http.StatusUnauthorized)
			return
		}
		user, gen = p.user, p.gen
	default:
		http.Error(w, "unknown kind", http.StatusBadRequest)
		return
	}
	token, exp, err := s.mint(user, gen)
	if err != nil {
		signFailed(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/msgpack")
	w.Write(mpEncode(map[string]any{"token": token, "user": user, "exp": exp}))
}
