package main

// Tokens and passwords.  Tokens are HS256 JWTs signed with the database
// secret; passwords are argon2id hashes in a PHC string, which carries
// the parameters they were made with.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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

func (s *Server) mint(user string, gen int64) (string, int64) {
	now := time.Now()
	jti := make([]byte, 8)
	rand.Read(jti)
	c := claims{Sub: user, Gen: gen, Iat: now.Unix(), Exp: now.Add(tokenLifetime).Unix(), Jti: fmt.Sprintf("%x", jti)}
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(c)
	signing := header + "." + b64.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(signing))
	return signing + "." + b64.EncodeToString(mac.Sum(nil)), c.Exp
}

func (s *Server) verify(token string) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("malformed token")
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errors.New("bad signature")
	}
	payload, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("malformed token")
	}
	var c claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, errors.New("malformed token")
	}
	if c.Exp < time.Now().Unix() {
		return nil, errors.New("token expired")
	}
	return &c, nil
}

// principalOf resolves the Authorization header; no header is anonymous.
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
	return principal{user: c.Sub, gen: c.Gen}, nil
}

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

// the bundle's lookup result
type account struct {
	user       string
	generation int64
	secret     string
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
	a.secret, _ = m["secret"].(string)
	if g, ok := m["generation"]; ok && g != nil {
		a.generation = asInt64(g)
	}
	return a, nil
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
		a, err := s.lookup(map[string]any{"kind": "password", "identity": identity})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// an unknown account gets a dummy verification, so it answers no faster than a wrong
		// password and spends the same budget
		check := func() bool { return dummyVerify(password) }
		if a != nil && a.secret != "" {
			check = func() bool { return verifyPassword(a.secret, password) }
		}
		ok, err := s.verifyFor(r.Context(), s.clientOf(r), check)
		if err != nil {
			hashFailed(w, err)
			return
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
	token, exp := s.mint(user, gen)
	w.Header().Set("Content-Type", "application/msgpack")
	w.Write(mpEncode(map[string]any{"token": token, "user": user, "exp": exp}))
}
