package main

// The HTTP layer: connections, mutations, snapshots, edit reads, and the dispatcher that fans the
// core's results out to connections.

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/robfig/cron/v3"
)

type Options struct {
	DataDir string
	Bundle  string
	DevAuth bool
	// password hashing: the workers, each holding one argon2id hash's memory while it runs
	// (default GOMAXPROCS), and each client's budget of hashes, a burst regained at a rate per
	// second (default 10, at 1 per second)
	HashWorkers int
	AuthBurst   int
	AuthRate    float64
	// the environment variables the bundle's bootstrap may read; any other reads as ""
	BootstrapEnv []string
	// the header a proxy in front of the server sets to the client's address, such as
	// CF-Connecting-IP; trusted from every request, so set only when nothing but the proxy can
	// reach the server
	ClientIPHeader string
	// the most mutations one POST /mutations may carry (default 128), and one without a session
	// (default 8)
	MaxMutations          int
	MaxAnonymousMutations int
	// the path every route is under, such as /phaselock, so an origin the database shares with an
	// app routes one prefix to it; "" puts the routes at the root
	PathPrefix string

	// tests only: the clock tokens and their keys are minted and checked by, time.Now when nil
	now func() time.Time
}

type Server struct {
	// the server's lifetime: every request runs under it, and Close ends it
	ctx    context.Context
	cancel context.CancelFunc

	core    *core
	keys    *keyring
	now     func() time.Time
	devAuth bool
	epoch   string
	hashes  *hashPool
	limit   *limiter
	// the header naming each request's client, if any
	clientIPHeader string
	// the most mutations a request may carry, and an anonymous one
	maxMutations, maxAnonymousMutations int
	// the path every route is under, "" for the root
	pathPrefix string

	mu       sync.Mutex
	pending  map[uint64]chan result
	conns    map[uint64]*conn
	nextReq  atomic.Uint64
	nextConn atomic.Uint64
	position atomic.Uint64
	done     chan struct{}

	// the bundle's cron entries, in the core's order, and the scheduler's end
	cron     []cronEntry
	cronDone chan struct{}

	// tests only: called once a login's password, or a request's proofs, have been checked,
	// before what they were checked against is read again
	proved func()
}

// conn is one connection.  Its view is what the grantor allows cut down to what it wants, and its
// token the hash of that set.  The dispatcher is the only goroutine that writes the view and sends
// on out; the handler is the only receiver.  Commit frames are pushed only once the handler has
// finished its cold catchup and flipped streaming, so a long replay buffers nothing; the hot
// catchup then covers the gap and the channel is deduped by position.
type conn struct {
	id        uint64
	wants     []string
	selectors []string // the view
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

// editsPage is the default and maximum number of edits one /edits response asks for.
const editsPage = 1000

// Open starts a server that lives until ctx ends or Close is called.  Its handler's requests
// should run under BaseContext, so that they end with it.
func Open(ctx context.Context, o Options) (*Server, error) {
	if err := checkClientIPHeader(o.ClientIPHeader); err != nil {
		return nil, err
	}
	if err := checkPathPrefix(o.PathPrefix); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		return nil, err
	}
	c, err := openCore(o.DataDir, o.Bundle, o.BootstrapEnv)
	if err != nil {
		return nil, err
	}

	// the token keys, every one minted before this process started
	now := o.now
	if now == nil {
		now = time.Now
	}
	stored, err := c.keys()
	if err != nil {
		c.close()
		return nil, err
	}

	// the cron entries, every spec of which must parse
	entries := c.cronEntries()
	scheds := make([]cron.Schedule, len(entries))
	for i, e := range entries {
		sched, notice, err := parseCron(e.spec)
		if err != nil {
			c.close()
			return nil, fmt.Errorf("cron entry %s of %s: %q: %w", e.name, e.install, e.spec, err)
		}
		if notice != "" {
			log.Printf("cron entry %s of %s: %s", e.name, e.install, notice)
		}
		scheds[i] = sched
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
	maxMutations, maxAnonymous := o.MaxMutations, o.MaxAnonymousMutations
	if maxMutations <= 0 {
		maxMutations = 128
	}
	if maxAnonymous <= 0 {
		maxAnonymous = 8
	}
	ctx, cancel := context.WithCancel(ctx)
	s := &Server{
		ctx:                   ctx,
		cancel:                cancel,
		hashes:                newHashPool(ctx, workers, 2*workers),
		limit:                 newLimiter(rate, burst),
		core:                  c,
		keys:                  newKeyring(stored, now()),
		now:                   now,
		devAuth:               o.DevAuth,
		clientIPHeader:        o.ClientIPHeader,
		pathPrefix:            o.PathPrefix,
		maxMutations:          maxMutations,
		maxAnonymousMutations: min(maxAnonymous, maxMutations),
		epoch:                 c.epoch(),
		pending:               map[uint64]chan result{},
		conns:                 map[uint64]*conn{},
		done:                  make(chan struct{}),
		cron:                  entries,
		cronDone:              make(chan struct{}),
	}
	go s.dispatch()

	// arm every new entry at the current minute, then tick every entry from its mark
	if len(entries) == 0 {
		close(s.cronDone)
		return s, nil
	}
	r := s.arm(time.Now().Truncate(time.Minute))
	if r.status != 0 {
		s.Close()
		return nil, fmt.Errorf("arming cron: %s", r.errmsg)
	}
	marks := make([]time.Time, len(r.marks))
	for i, m := range r.marks {
		marks[i] = time.Unix(m, 0).UTC()
	}
	sched := &cronScheduler{scheds: scheds, marks: marks, fire: s.fireCron, now: time.Now}
	go func() {
		defer close(s.cronDone)
		sched.run(s.ctx)
	}()
	return s, nil
}

// arm gives every cron entry without a mark the mark minute, and answers every entry's mark.
func (s *Server) arm(minute time.Time) result {
	return s.request(func(reqid uint64) { s.core.cronArm(reqid, minute) })
}

// tick decides one slot of cron entry i.
func (s *Server) tick(i int, slot time.Time) result {
	return s.request(func(reqid uint64) { s.core.cronTick(reqid, i, slot) })
}

// fireCron is the scheduler's fire: a tick, whose hook's failure is a bug in the bundle, logged.
func (s *Server) fireCron(i int, slot time.Time) {
	r := s.tick(i, slot)
	if r.status == http.StatusInternalServerError {
		e := s.cron[i]
		log.Printf("cron entry %s of %s at %s: %s", e.name, e.install, slot.Format(time.RFC3339), r.errmsg)
	}
}

// Close ends the server: its context, then the cron scheduler and the hash workers once their
// work in hand finishes, then the core, which commits the batch in hand.  Call it once no handler
// is running, after the HTTP server has shut down, since a handler would otherwise reach a closed
// core.
func (s *Server) Close() {
	s.cancel()
	<-s.cronDone
	s.hashes.wait()
	s.core.close()
	<-s.done
}

// BaseContext is the context an http.Server should run the handler's requests under, so that
// they end with the server.
func (s *Server) BaseContext(net.Listener) context.Context { return s.ctx }

// Handler serves every route under the server's path prefix, which it strips before routing.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/stream", s.handleStream)
	mux.HandleFunc("/mutations", s.handleMutations)
	mux.HandleFunc("/snapshot/", s.handleSnapshot)
	mux.HandleFunc("/edits/", s.handleEdits)
	mux.HandleFunc("/auth/token", s.handleAuth)
	if s.pathPrefix == "" {
		return mux
	}
	return http.StripPrefix(s.pathPrefix, mux)
}

// checkPathPrefix refuses a path prefix that is neither "" nor a path starting with a slash and
// ending without one
func checkPathPrefix(prefix string) error {
	if prefix != "" && (!strings.HasPrefix(prefix, "/") || strings.HasSuffix(prefix, "/")) {
		return fmt.Errorf("path prefix %q must start with a slash and not end with one, or be empty",
			prefix)
	}
	return nil
}

// dispatch /////////////////////////////////////////////////////////////////

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
		case rOutcome, rLookup, rArm, rTick, rKey:
			s.reply(r)
		case rView:
			s.mu.Lock()
			c := s.conns[r.conn]
			if c != nil && r.status == 0 {
				// the connection's view is the grant cut down to its wants
				view := intersect(r.selectors, c.wants)
				token := viewToken(view)
				changed := token != c.token
				c.selectors = view
				c.token = token
				if r.reqid != 0 {
					if !c.ephemeral {
						c.active = true
					}
				} else if c.active && changed {
					// a grant change that left this view as it was is no frame
					s.send(c, frame{pos: r.position, view: true,
						data: mpEncode([]any{"view", token, r.position, view})})
				}
			} else if c != nil && r.reqid == 0 && c.active {
				// the grantor failed when a commit re-ran it, so the connection ends
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
			mutations := groupPositions(r.items)
			s.mu.Lock()
			for _, c := range s.conns {
				if !c.active || !c.streaming {
					continue
				}
				for _, edits := range mutations {
					if f := editsFrame(edits, c.selectors); f != nil {
						// the mutation's own position: the connection's loop drops frames at or
						// below its cursor, and a commit may carry several mutations
						s.send(c, frame{pos: edits[0].position, data: f})
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

// groupPositions splits edits read in position order into each mutation's edits.
func groupPositions(items []item) [][]item {
	var groups [][]item
	for i, it := range items {
		if i == 0 || it.position != items[i-1].position {
			groups = append(groups, nil)
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], it)
	}
	return groups
}

// matches reports whether a selector covers a slice name or a narrower
// selector: a prefix selector ("*", "chat:*", "chat:acme,*") covers the names
// that begin with its text before the star, and an exact one, a slice's name,
// covers itself.
func matches(name, selector string) bool {
	if prefix, ok := strings.CutSuffix(selector, "*"); ok {
		return strings.HasPrefix(name, prefix)
	}
	return name == selector
}

// validSelector checks the wire form of a selector: a slice name, a prefix
// selector, or "*".  A name is its family, a non-empty run of A-Z a-z 0-9 _
// -, then, if its family has parameters, ':' and their values separated by
// ','.  Every value is non-empty; one before the last is a run of the
// family's characters, and the last may also hold . and ~, the characters a
// URL carries unencoded.  A prefix selector is a family and ':', or a
// family, ':', and whole leading values each followed by ',', then '*'.  The
// core checks a grantor's selectors, and the slice names a write or an
// expectation gives, by the same rules.
func validSelector(selector string) bool {
	if selector == "*" {
		return true
	}

	// a prefix selector's values are all leading ones, followed by their separator
	name, prefix := strings.CutSuffix(selector, "*")
	if prefix {
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
		if prefix || i < len(values)-1 {
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
// name or a parameter other than a slice name's last one may hold.
func segment(s string) bool {
	return s != "" && strings.IndexFunc(s, func(c rune) bool { return !segmentChar(c) }) < 0
}

// segmentChar reports whether c may appear in a family name or a parameter
// other than a slice name's last one.
func segmentChar(c rune) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		return true
	}
	return false
}

// editsFrame encodes ["edits", [edit...]] for the edits of one mutation that are in the view, or
// nil when none are.
func editsFrame(edits []item, selectors []string) []byte {
	var vis []item
	for _, it := range edits {
		if covers(selectors, it.slice) {
			vis = append(vis, it)
		}
	}
	if len(vis) == 0 {
		return nil
	}
	b := mpArrayHeader(nil, 2)
	b = mpAppendStr(b, "edits")
	b = mpArrayHeader(b, len(vis))
	for _, it := range vis {
		b = append(b, it.data...)
	}
	return b
}

// views ////////////////////////////////////////////////////////////////////

// intersect is a connection's view: every selector the grantor allows that a want covers, and every
// want that a granted selector covers, sorted and unique.  No wants means everything the grantor
// allows.
func intersect(granted, wants []string) []string {
	if len(wants) == 0 {
		wants = []string{"*"}
	}
	set := map[string]bool{}
	for _, m := range granted {
		for _, w := range wants {
			if matches(m, w) {
				set[m] = true
			} else if matches(w, m) {
				set[w] = true
			}
		}
	}
	view := make([]string, 0, len(set))
	for selector := range set {
		view = append(view, selector)
	}
	sort.Strings(view)
	return view
}

// viewToken hashes a view: FNV-1a 64 over its selectors in order, each with a
// terminating zero byte, as 16 hex digits.
func viewToken(view []string) string {
	h := fnv.New64a()
	for _, selector := range view {
		h.Write([]byte(selector))
		h.Write([]byte{0})
	}
	return fmt.Sprintf("%016x", h.Sum64())
}

// view registers the principal's grant and returns the connection's view and token.  The
// connection is subscribed to commits unless ephemeral.
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
	r.selectors = c.selectors
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
		if !validSelector(want) {
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
		if !write(mpEncode([]any{"view", view.token, view.position, view.selectors})) {
			return
		}
	}
	selectors := view.selectors
	// the connection delivers everything above the cursor: the client's checkpoint, or on a
	// bootstrap the view's position, which the client takes as the bound of what its snapshots
	// must cover
	cursor := view.position
	if since >= 0 {
		cursor = uint64(since)
	}

	// forwards queued view frames, updating the handler's selectors; returns false when the connection
	// is gone
	drainViews := func() bool {
		for {
			select {
			case f, ok := <-c.out:
				if !ok {
					return false
				}
				if f.view {
					s.mu.Lock()
					selectors = append([]string(nil), c.selectors...)
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
	// the last position the client has been told of, by an edits frame or a vouch
	told := cursor
	replay := func(from, to uint64) bool {
		items, err := s.core.readLog(from, to)
		if err != nil {
			write(mpEncode([]any{"end", "error", err.Error()}))
			return false
		}
		for _, edits := range groupPositions(items) {
			if f := editsFrame(edits, selectors); f != nil {
				if !write(f) {
					return false
				}
				told = edits[0].position
			}
		}
		if len(items) > 0 {
			cursor = max(cursor, items[len(items)-1].position)
		}
		return true
	}

	// cold catchup: unbuffered, as long as it takes
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
		// a window that ended past the last frame is vouched for, so a client whose view
		// matched nothing in it still sees the replay advance
		if cursor > told {
			if !write(mpEncode([]any{"vouch", cursor})) {
				return
			}
			told = cursor
		}
	}

	// switch to streaming, then a hot catchup through the dispatcher's
	// position as of the switch
	s.mu.Lock()
	c.streaming = true
	hot := s.position.Load()
	selectors = append([]string(nil), c.selectors...)
	s.mu.Unlock()
	if !replay(cursor+1, hot) {
		return
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

func (s *Server) handleMutations(w http.ResponseWriter, r *http.Request) {
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
	// the database's own time, from a whole request in hand to its answer, which the response
	// reports as Server-Timing so a client can tell it from the network's
	start := time.Now()
	client := s.clientOf(r)
	limit := s.maxMutations
	if p.anonymous {
		limit = s.maxAnonymousMutations
	}
	pc, err := s.core.prepare(s, r.Context(), client, body, limit)
	if errors.Is(err, errTooMany) {
		// the limit this request was held to, which the client splits its mutations under
		w.Header().Set("PhaseLock-Max-Mutations", strconv.Itoa(limit))
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	if errors.Is(err, errBusy) || errors.Is(err, errLimited) {
		hashFailed(w, err)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// each proof against the sender's credentials, within the client's budget
	var verdicts []verdict
	for _, proofs := range pc.proofs {
		if len(proofs) == 0 {
			continue
		}
		hash, err := s.passwordHashOf(p)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		verdicts, err = s.prove(r.Context(), client, hash, pc.proofs, true)
		if err != nil {
			hashFailed(w, err)
			return
		}
		if s.proved != nil {
			s.proved()
		}
		break
	}

	// the core answers for the mutations that passed the check; the rest were rejected here
	var outcomes []any
	if len(pc.offsets) > 0 {
		var res result
		outcomes, res = s.decide(r.Context(), p, pc, verdicts)
		if res.status != 0 {
			refuse(w, res)
			return
		}
	}
	merged := make([]any, 0, len(pc.reasons))
	for _, r := range pc.reasons {
		if r == "" {
			merged = append(merged, outcomes[0])
			outcomes = outcomes[1:]
		} else {
			merged = append(merged, []any{"reject", r})
		}
	}
	w.Header().Set("Content-Type", "application/msgpack")
	w.Header().Set("Server-Timing", fmt.Sprintf("db;dur=%.2f", float64(time.Since(start).Microseconds())/1000))
	w.Write(mpEncode(merged))
}

// decide submits a request's passing mutations and answers their outcomes, in order.  When the
// writer bounces the call at a proven mutation, because the sender's credentials changed after
// its proof was checked, every proof from that mutation on is checked again against what lookup
// answers now, and the rest of the call is submitted again, so the call's mutations are still
// decided in order.  A failure answers a result with a status, the outcomes of mutations already
// decided lost with it, as a lost reply's are.
func (s *Server) decide(ctx context.Context, p principal, pc *prepared, verdicts []verdict) ([]any, result) {
	var outcomes []any
	first := 0
	for attempt := 0; ; attempt++ {
		// the call from its first undecided mutation
		body := pc.body[pc.offsets[first]:]
		var vs []verdict
		if verdicts != nil {
			vs = verdicts[first:]
		}
		res := s.request(func(reqid uint64) { s.core.submit(reqid, p, body, vs, attempt) })
		if res.status != 0 {
			return nil, res
		}
		v, err := mpDecodeBytes(res.buf)
		if err != nil {
			return nil, result{status: http.StatusInternalServerError, errmsg: err.Error()}
		}
		outs := v.([]any)
		outcomes = append(outcomes, outs...)
		if !res.bounce {
			return outcomes, res
		}

		// the mutation after the outcomes bounced: check its proofs, and every later one, again
		first += len(outs)
		again, err := s.prove(ctx, "", res.hash, pc.proofs[first:], false)
		if err != nil {
			return nil, result{status: http.StatusServiceUnavailable, errmsg: err.Error()}
		}
		copy(verdicts[first:], again)
	}
}

// handleSnapshot serves a blob of the selector, cut at one position.  A snapshot response is
// either the blob inline or a text/plain pointer to it in a blob store: this server answers
// inline, and a deployment backed by a blob store answers with a pointer.  Either way the origin's
// response carries PhaseLock-Position and PhaseLock-Epoch, because a resumed download reads the
// blob with a Range from its resume offset, so it never sees the blob's own header and learns the
// cut's position and epoch only from the origin's response; and because a blob store owes only
// the bytes, never PhaseLock headers.  The pointer is a 200 with a body rather than a 3xx redirect
// because many HTTP clients follow redirects themselves and expose only the final response's
// headers, which would lose the origin's.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	selector := strings.TrimPrefix(r.URL.Path, "/snapshot/")
	if !validSelector(selector) {
		http.Error(w, "malformed selector", http.StatusBadRequest)
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
	if !covers(view.selectors, selector) {
		http.Error(w, "selector not visible", http.StatusForbidden)
		return
	}
	blob, position, err := s.core.snapshot(selector)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("PhaseLock-Position", fmt.Sprint(position))
	w.Header().Set("PhaseLock-Epoch", s.epoch)
	w.Write(blob)
}

// covers reports whether the view's selectors grant the whole selector.
func covers(selectors []string, selector string) bool {
	for _, r := range selectors {
		if matches(selector, r) {
			return true
		}
	}
	return false
}

// handleEdits serves a selector's edits with after < position < before, for a client tailing a
// snapshot, one edits frame per position.  The selector is the path after /edits/: a slice, a
// prefix selector, or "*"; the view must cover all of it.  Either bound may be omitted: no after
// is the start of the log, no before is the head.  A page holds max edits and the rest of the last
// one's position, since it never splits a mutation's edits, or fewer when the range runs out.  The
// PhaseLock-Scanned header is the client's next bound, to be used as-is: the last position
// delivered when the page was full, the far bound when the range is exhausted, and the last
// position delivered (or after itself) when the far bound is the head, so that clients at the
// head ask for the same page.
func (s *Server) handleEdits(w http.ResponseWriter, r *http.Request) {
	p, err := s.principalOf(r)
	if err != nil {
		s.unauthorized(w, err)
		return
	}
	selector := strings.TrimPrefix(r.URL.Path, "/edits/")
	if !validSelector(selector) {
		http.Error(w, "malformed selector", http.StatusBadRequest)
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
	limit := editsPage
	if m := q.Get("max"); m != "" {
		n, err := strconv.Atoi(m)
		if err != nil || n < 1 {
			http.Error(w, "max must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = min(n, editsPage)
	}
	c, view := s.view(p, nil, true)
	if view.status != 0 {
		refuse(w, view)
		return
	}
	s.drop(c)
	if !covers(view.selectors, selector) {
		http.Error(w, "selector not visible", http.StatusForbidden)
		return
	}
	items, err := s.core.readEdits(selector, after, before, reverse, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	mutations := groupPositions(items)
	scanned := before
	if reverse {
		scanned = after
	} else if toHead {
		scanned = after
	}
	if len(items) >= limit || (toHead && !reverse && len(items) > 0) {
		scanned = items[len(items)-1].position
	}
	w.Header().Set("Content-Type", "application/msgpack")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("PhaseLock-Scanned", strconv.FormatUint(scanned, 10))
	for _, edits := range mutations {
		w.Write(editsFrame(edits, []string{"*"}))
	}
}

var errNoBundle = errors.New("a bundle path is required")
