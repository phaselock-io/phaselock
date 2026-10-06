package main

// The HTTP layer: streams, commands, list, snapshots, and the dispatcher
// that fans the core's results out to connections.

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Options struct {
	DataDir string
	Bundle  string
	DevAuth bool
	Secret  []byte // generated and stored in DataDir when nil
	// password hashing: the workers, each holding one argon2id hash's memory while it runs
	// (default GOMAXPROCS), and each client's budget of hashes, a burst regained at a rate per
	// second (default 10, at 1 per second)
	HashWorkers int
	AuthBurst   int
	AuthRate    float64
	// the environment variables the bundle's bootstrap may read; any other reads as ""
	BootstrapEnv []string
}

type Server struct {
	// the server's lifetime: every request runs under it, and Close ends it
	ctx    context.Context
	cancel context.CancelFunc

	core    *core
	secret  []byte
	devAuth bool
	epoch   string
	hashes  *hashPool
	limit   *limiter

	mu       sync.Mutex
	pending  map[uint64]chan result
	conns    map[uint64]*conn
	nextReq  atomic.Uint64
	nextConn atomic.Uint64
	position atomic.Uint64
	done     chan struct{}
}

// conn is one stream connection.  Its view is what maySee allows cut down
// to what it wants, and its token the hash of that set.  The dispatcher is
// the only goroutine that writes the view and sends on out; the handler is
// the only receiver.  Commit frames are pushed only once the handler has
// finished its cold catchup and flipped streaming, so a long replay buffers
// nothing; the hot catchup then covers the gap and the channel is deduped
// by position.
type conn struct {
	id        uint64
	wants     []string
	prefixes  []string // the view
	token     string   // the hash of the view
	active    bool
	ephemeral bool
	streaming bool
	out       chan frame
}

// frame is one queued wire frame with the log position it carries.
type frame struct {
	pos  uint64
	view bool
	end  bool // the connection's last frame
	data []byte
}

const (
	heartbeat = 15 * time.Second
	maxBody   = 16 << 20
	coldBatch = 1000
)

// eventsPage is the default and maximum size of one /events response.
const eventsPage = 1000

// Open starts a server that lives until ctx ends or Close is called.  Its handler's requests
// should run under BaseContext, so that they end with it.
func Open(ctx context.Context, o Options) (*Server, error) {
	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		return nil, err
	}
	secret := o.Secret
	if secret == nil {
		var err error
		secret, err = loadSecret(filepath.Join(o.DataDir, "secret"))
		if err != nil {
			return nil, err
		}
	}
	c, err := openCore(o.DataDir, o.Bundle, o.BootstrapEnv)
	if err != nil {
		return nil, err
	}
	workers := o.HashWorkers
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	burst, rate := o.AuthBurst, o.AuthRate
	if burst <= 0 {
		burst = 10
	}
	if rate <= 0 {
		rate = 1
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Server{
		ctx:     ctx,
		cancel:  cancel,
		hashes:  newHashPool(ctx, workers, 2*workers),
		limit:   newLimiter(rate, burst),
		core:    c,
		secret:  secret,
		devAuth: o.DevAuth,
		epoch:   c.epoch(),
		pending: map[uint64]chan result{},
		conns:   map[uint64]*conn{},
		done:    make(chan struct{}),
	}
	go s.dispatch()
	return s, nil
}

func loadSecret(path string) ([]byte, error) {
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b, nil
	}
	b := make([]byte, 32)
	rand.Read(b)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, err
	}
	return b, nil
}

// Close ends the server: its context, then the hash workers once their hashes in hand finish,
// then the core, which commits the batch in hand.  Call it once no handler is running, after
// the HTTP server has shut down, since a handler would otherwise reach a closed core.
func (s *Server) Close() {
	s.cancel()
	s.hashes.wait()
	s.core.close()
	<-s.done
}

// BaseContext is the context an http.Server should run the handler's requests under, so that
// they end with the server.
func (s *Server) BaseContext(net.Listener) context.Context { return s.ctx }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", s.handleStream)
	mux.HandleFunc("/commands", s.handleCommands)
	mux.HandleFunc("/snapshot/", s.handleSnapshot)
	mux.HandleFunc("/events/", s.handleEvents)
	mux.HandleFunc("/auth/token", s.handleAuth)
	return mux
}

// dispatch /////////////////////////////////////////////////////////////////

// request sends one request to the core and waits for its reply.
// request sends one request to the core and waits for its reply, or for the server to end.
func (s *Server) request(send func(reqid uint64)) result {
	reqid := s.nextReq.Add(1)
	ch := make(chan result, 1)
	s.mu.Lock()
	s.pending[reqid] = ch
	s.mu.Unlock()
	send(reqid)
	select {
	case r := <-ch:
		return r
	case <-s.ctx.Done():
		return result{status: http.StatusServiceUnavailable, errmsg: errClosed.Error()}
	}
}

func (s *Server) dispatch() {
	defer close(s.done)
	for {
		r := s.core.pop()
		switch r.kind {
		case rShutdown:
			s.mu.Lock()
			for _, c := range s.conns {
				if c.active {
					close(c.out)
					c.active = false
				}
			}
			s.mu.Unlock()
			return
		case rOutcome, rLookup:
			s.reply(r)
		case rView:
			s.mu.Lock()
			c := s.conns[r.conn]
			if c != nil && r.status == 0 {
				// the connection's view is maySee cut down to its wants
				view := intersect(r.prefixes, c.wants)
				token := viewToken(view)
				changed := token != c.token
				c.prefixes = view
				c.token = token
				if r.reqid != 0 {
					if !c.ephemeral {
						c.active = true
					}
				} else if c.active && changed {
					// a maySee change that left this view as it was is no frame
					s.send(c, frame{pos: r.position, view: true,
						data: mpEncode([]any{"view", token, r.position, view})})
				}
			} else if c != nil && r.reqid == 0 && c.active {
				// maySee failed when a commit re-ran it, so the connection ends
				s.send(c, frame{pos: r.position, view: true, end: true,
					data: mpEncode([]any{"end", "error", r.errmsg})})
				c.active = false
			}
			s.mu.Unlock()
			if r.reqid != 0 {
				s.reply(r)
			}
		case rCommit:
			s.position.Store(r.position)
			atoms := groupAtoms(r.items)
			s.mu.Lock()
			for _, c := range s.conns {
				if !c.active || !c.streaming {
					continue
				}
				for _, atom := range atoms {
					if f := eventsFrame(atom, c.prefixes); f != nil {
						// the atom's own position: the stream loop drops frames at or
						// below its cursor, and a commit may carry several atoms
						s.send(c, frame{pos: atom[len(atom)-1].position, data: f})
					}
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *Server) reply(r result) {
	s.mu.Lock()
	ch := s.pending[r.reqid]
	delete(s.pending, r.reqid)
	s.mu.Unlock()
	if ch != nil {
		ch <- r
	}
}

// send queues a frame; a live connection that cannot keep up is closed.
func (s *Server) send(c *conn, f frame) {
	select {
	case c.out <- f:
	default:
		close(c.out)
		c.active = false
	}
}

// groupAtoms splits a commit's items into atoms by command id.
func groupAtoms(items []item) [][]item {
	var atoms [][]item
	for i, it := range items {
		if i == 0 || it.commandid != items[i-1].commandid {
			atoms = append(atoms, nil)
		}
		atoms[len(atoms)-1] = append(atoms[len(atoms)-1], it)
	}
	return atoms
}

// matches reports whether a wire ref covers a stream name or a narrower
// ref: a wildcard ("*", "chat:*", "chat:acme,*") covers the names that
// begin with its text before the star, and a name covers itself.
func matches(stream, ref string) bool {
	if prefix, wild := strings.CutSuffix(ref, "*"); wild {
		return strings.HasPrefix(stream, prefix)
	}
	return stream == ref
}

// validRef checks the wire form of a ref: a stream name, a wildcard, or
// "*".  A name is its family, a non-empty run of A-Z a-z 0-9 _ -, then, if
// its family has parameters, ':' and their values separated by ','.  Every
// value is non-empty; one before the last is a run of the family's
// characters, and the last may also hold . and ~, the characters a URL
// carries unencoded.  A wildcard is a family and ':', or a family, ':', and
// whole leading values each followed by ',', then '*'.  The core checks a
// name against its family's template.
func validRef(ref string) bool {
	if ref == "*" {
		return true
	}

	// a wildcard's values are all leading ones, followed by their separator
	name, wild := strings.CutSuffix(ref, "*")
	if wild {
		var sep bool
		if name, sep = strings.CutSuffix(name, ","); !sep {
			if name, sep = strings.CutSuffix(name, ":"); !sep || strings.Contains(name, ":") {
				return false
			}
		} else if !strings.Contains(name, ":") {
			return false
		}
	}

	// the family, then its values
	family, rest, params := strings.Cut(name, ":")
	if !segment(family) {
		return false
	}
	if !params {
		return true
	}
	values := strings.Split(rest, ",")
	for i, v := range values {
		if wild || i < len(values)-1 {
			if !segment(v) {
				return false
			}
		} else if v == "" || strings.IndexFunc(v, func(c rune) bool {
			return !segmentChar(c) && c != '.' && c != '~'
		}) >= 0 {
			return false
		}
	}
	return true
}

// segment reports whether s is a non-empty run of the characters a family
// name or a parameter other than a template's terminal one may hold.
func segment(s string) bool {
	return s != "" && strings.IndexFunc(s, func(c rune) bool { return !segmentChar(c) }) < 0
}

// segmentChar reports whether c may appear in a family name or a parameter
// other than a template's terminal one.
func segmentChar(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		return true
	}
	return false
}

// eventsFrame encodes ["events", [ev...]] for the events of an atom that
// are in the view, or nil when none are.
func eventsFrame(atom []item, prefixes []string) []byte {
	var vis []item
	for _, it := range atom {
		if covers(prefixes, it.stream) {
			vis = append(vis, it)
		}
	}
	if len(vis) == 0 {
		return nil
	}
	b := mpArrayHeader(nil, 2)
	b = mpAppendStr(b, "events")
	b = mpArrayHeader(b, len(vis))
	for _, it := range vis {
		b = append(b, it.data...)
	}
	return b
}

// views ////////////////////////////////////////////////////////////////////

// intersect is a connection's view: every ref maySee allows that a want
// covers, and every want that a maySee ref covers, sorted and unique.  No
// wants means everything maySee allows.
func intersect(maySee, wants []string) []string {
	if len(wants) == 0 {
		wants = []string{"*"}
	}
	set := map[string]bool{}
	for _, m := range maySee {
		for _, w := range wants {
			if matches(m, w) {
				set[m] = true
			} else if matches(w, m) {
				set[w] = true
			}
		}
	}
	view := make([]string, 0, len(set))
	for ref := range set {
		view = append(view, ref)
	}
	sort.Strings(view)
	return view
}

// viewToken hashes a view: FNV-1a 64 over its refs in order, each with a
// terminating zero byte, as 16 hex digits.
func viewToken(view []string) string {
	h := fnv.New64a()
	for _, ref := range view {
		h.Write([]byte(ref))
		h.Write([]byte{0})
	}
	return fmt.Sprintf("%016x", h.Sum64())
}

// view registers the principal's maySee and returns the connection's view
// and token.  The connection is subscribed to commits unless ephemeral.
func (s *Server) view(p principal, wants []string, ephemeral bool) (*conn, result) {
	c := &conn{
		id:        s.nextConn.Add(1),
		wants:     wants,
		ephemeral: ephemeral,
		out:       make(chan frame, 1024),
	}
	s.mu.Lock()
	s.conns[c.id] = c
	s.mu.Unlock()
	r := s.request(func(reqid uint64) { s.core.register(reqid, c.id, p) })
	if r.status != 0 {
		s.drop(c)
		return c, r
	}

	// the dispatcher computed the view before it replied
	s.mu.Lock()
	r.prefixes = c.prefixes
	r.token = c.token
	s.mu.Unlock()
	return c, r
}

func (s *Server) drop(c *conn) {
	s.mu.Lock()
	delete(s.conns, c.id)
	c.active = false
	s.mu.Unlock()
	s.core.unregister(c.id)
}

// refuse answers a request the core did not carry out: a stale token, the server shutting
// down, or a failure in the core.
func refuse(w http.ResponseWriter, r result) {
	switch r.status {
	case http.StatusUnauthorized:
		http.Error(w, "token rejected", http.StatusUnauthorized)
	case http.StatusServiceUnavailable:
		http.Error(w, r.errmsg, http.StatusServiceUnavailable)
	default:
		http.Error(w, r.errmsg, http.StatusInternalServerError)
	}
}

func (s *Server) unauthorized(w http.ResponseWriter, err error) {
	http.Error(w, err.Error(), http.StatusUnauthorized)
}

// handlers /////////////////////////////////////////////////////////////////

func readBody(r *http.Request) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, maxBody))
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	p, err := s.principalOf(r)
	if err != nil {
		s.unauthorized(w, err)
		return
	}
	since, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	if err != nil || since < -1 {
		http.Error(w, "since must be -1 or a position", http.StatusBadRequest)
		return
	}
	wants := r.URL.Query()["want"]
	if len(wants) == 0 {
		wants = []string{"*"}
	}
	for _, want := range wants {
		if !validRef(want) {
			http.Error(w, "malformed want", http.StatusBadRequest)
			return
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	c, view := s.view(p, wants, false)
	if view.status != 0 {
		refuse(w, view)
		return
	}
	defer s.drop(c)

	h := w.Header()
	h.Set("Content-Type", "application/msgpack")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	h.Set("PhaseLock-Protocol", "1")
	h.Set("PhaseLock-Epoch", s.epoch)
	h.Set("PhaseLock-Time", strconv.FormatInt(time.Now().UnixMilli(), 10))
	h.Set("PhaseLock-View", view.token)
	h.Set("PhaseLock-Position", strconv.FormatUint(view.position, 10))
	w.WriteHeader(http.StatusOK)

	write := func(b []byte) bool {
		if _, err := w.Write(b); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	// a client whose stored token is not the current one gets the view as
	// the first frame, ahead of history, so reconciliation is in order with
	// everything that follows
	if r.URL.Query().Get("view") != view.token {
		if !write(mpEncode([]any{"view", view.token, view.position, view.prefixes})) {
			return
		}
	}
	prefixes := view.prefixes
	cursor := uint64(0)
	if since >= 0 {
		cursor = uint64(since)
	}

	// forwards queued view frames, updating the handler's prefix list;
	// returns false when the connection is gone
	drainViews := func() bool {
		for {
			select {
			case f, ok := <-c.out:
				if !ok {
					return false
				}
				if f.view {
					s.mu.Lock()
					prefixes = append([]string(nil), c.prefixes...)
					s.mu.Unlock()
					if !write(f.data) || f.end {
						return false
					}
				}
			default:
				return true
			}
		}
	}
	replay := func(from, to uint64) bool {
		items, err := s.core.readLog(from, to)
		if err != nil {
			write(mpEncode([]any{"end", "error", err.Error()}))
			return false
		}
		for _, atom := range groupAtoms(items) {
			if f := eventsFrame(atom, prefixes); f != nil {
				if !write(f) {
					return false
				}
			}
		}
		if len(items) > 0 {
			cursor = max(cursor, items[len(items)-1].position)
		}
		return true
	}

	// cold catchup: unbuffered, as long as it takes
	if since >= 0 {
		for {
			if !drainViews() {
				return
			}
			before := cursor
			if !replay(cursor+1, cursor+coldBatch) {
				return
			}
			if cursor == before {
				break
			}
		}
	}

	// switch to streaming, then a hot catchup through the dispatcher's
	// position as of the switch
	s.mu.Lock()
	c.streaming = true
	hot := s.position.Load()
	prefixes = append([]string(nil), c.prefixes...)
	s.mu.Unlock()
	if since >= 0 {
		if !replay(cursor+1, hot) {
			return
		}
	}
	cursor = max(cursor, hot)
	if !write(mpEncode([]any{"live", cursor})) {
		return
	}

	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case f, ok := <-c.out:
			if !ok {
				write(mpEncode([]any{"end", "overflow", "connection could not keep up"}))
				return
			}
			if !f.view && f.pos <= cursor {
				continue
			}
			if !f.view {
				cursor = f.pos
			}
			if !write(f.data) || f.end {
				return
			}
		case <-ticker.C:
			if !write(mpEncode([]any{"vouch", s.position.Load()})) {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	p, err := s.principalOf(r)
	if err != nil {
		s.unauthorized(w, err)
		return
	}
	body, err := readBody(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	prepared, reasons, err := s.core.prepare(s, r.Context(), clientOf(r), body)
	if errors.Is(err, errBusy) || errors.Is(err, errLimited) {
		hashFailed(w, err)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// the core answers for the commands that passed the check; the rest were rejected here
	var outcomes []any
	passing := 0
	for _, r := range reasons {
		if r == "" {
			passing++
		}
	}
	if passing > 0 {
		res := s.request(func(reqid uint64) { s.core.submit(reqid, p, prepared) })
		if res.status != 0 {
			refuse(w, res)
			return
		}
		v, err := mpDecodeBytes(res.buf)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		outcomes = v.([]any)
	}
	merged := make([]any, 0, len(reasons))
	for _, r := range reasons {
		if r == "" {
			merged = append(merged, outcomes[0])
			outcomes = outcomes[1:]
		} else {
			merged = append(merged, []any{"reject", r})
		}
	}
	w.Header().Set("Content-Type", "application/msgpack")
	w.Write(mpEncode(merged))
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	ref := strings.TrimPrefix(r.URL.Path, "/snapshot/")
	if !validRef(ref) {
		http.Error(w, "malformed ref", http.StatusBadRequest)
		return
	}
	p, err := s.principalOf(r)
	if err != nil {
		s.unauthorized(w, err)
		return
	}
	c, view := s.view(p, nil, true)
	if view.status != 0 {
		refuse(w, view)
		return
	}
	s.drop(c)
	if !covers(view.prefixes, ref) {
		http.Error(w, "ref not visible", http.StatusForbidden)
		return
	}
	blob, position, err := s.core.snapshot(ref)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("PhaseLock-Position", fmt.Sprint(position))
	w.Write(blob)
}

// covers reports whether the view's refs grant the whole ref.
func covers(prefixes []string, ref string) bool {
	for _, prefix := range prefixes {
		if matches(ref, prefix) {
			return true
		}
	}
	return false
}

// handleEvents serves a ref's events with after < position < before, for
// a client tailing a snapshot.  The ref is the path after /events/: a
// stream, a wildcard, or "*"; the view must cover all of it.  Either bound may be omitted: no after is the start of
// the log, no before is the head.  The PhaseLock-Scanned header is the
// client's next bound, to be used as-is: the last position delivered when
// the page was full, the far bound when the range is exhausted, and the
// last position delivered (or after itself) when the far bound is the
// head, so that clients at the head ask for the same page.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	p, err := s.principalOf(r)
	if err != nil {
		s.unauthorized(w, err)
		return
	}
	ref := strings.TrimPrefix(r.URL.Path, "/events/")
	if !validRef(ref) {
		http.Error(w, "malformed ref", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	after, before, toHead := uint64(0), uint64(math.MaxInt64), true
	var err1, err2 error
	if v := q.Get("after"); v != "" {
		after, err1 = strconv.ParseUint(v, 10, 63)
	}
	if v := q.Get("before"); v != "" {
		before, err2 = strconv.ParseUint(v, 10, 63)
		toHead = false
	}
	if err1 != nil || err2 != nil {
		http.Error(w, "after and before must be positions", http.StatusBadRequest)
		return
	}
	reverse := q.Get("reverse") == "true"
	limit := eventsPage
	if m := q.Get("max"); m != "" {
		n, err := strconv.Atoi(m)
		if err != nil || n < 1 {
			http.Error(w, "max must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = min(n, eventsPage)
	}
	c, view := s.view(p, nil, true)
	if view.status != 0 {
		refuse(w, view)
		return
	}
	s.drop(c)
	if !covers(view.prefixes, ref) {
		http.Error(w, "ref not visible", http.StatusForbidden)
		return
	}
	items, err := s.core.readEvents(ref, after, before, reverse, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	scanned := before
	if reverse {
		scanned = after
	} else if toHead {
		scanned = after
	}
	if len(items) == limit || (toHead && !reverse && len(items) > 0) {
		scanned = items[len(items)-1].position
	}
	w.Header().Set("Content-Type", "application/msgpack")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("PhaseLock-Scanned", strconv.FormatUint(scanned, 10))
	for _, atom := range groupAtoms(items) {
		w.Write(eventsFrame(atom, []string{"*"}))
	}
}

var errNoBundle = errors.New("a bundle path is required")
