package main

// The HTTP layer: connections, mutations, snapshots, edit reads, and the dispatcher that fans the
// core's results out to connections.

import (
	"bytes"
	"cmp"
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
	// the page cache of each of the store's SQLite connections, the writer's and the reader's, in
	// MiB (default 64)
	SqliteCacheSize int
	// the most commits and view changes a /stream connection may have queued and unsent before it
	// is dropped (default 2048)
	MaxStreamBacklog int
	// how long a principal's grant and account are kept once it has no connection and has gone
	// unused (default a minute)
	PrincipalTTL time.Duration

	// tests only: the clock tokens and their keys are minted and checked by, time.Now when nil
	now func() time.Time
	// tests only: the interval between a connection's heartbeat vouches, heartbeat when zero
	heartbeat time.Duration
	// tests only: called by the dispatcher with a commit's position before it pushes the commit's
	// frames, by a connection once its cold catchup is done, before it switches to streaming, and
	// by a streaming connection woken by its backlog, before it takes the backlog
	beforePush      func(position uint64)
	beforeStreaming func()
	beforeForward   func()
	// tests only: called by /snapshot and /edits once the principal is registered, before the read
	beforeRead func()
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
	// the most frames a streaming connection's backlog may hold
	maxStreamBacklog int

	mu       sync.Mutex
	pending  map[uint64]chan result
	conns    map[uint64]*conn
	nextReq  atomic.Uint64
	nextConn atomic.Uint64
	// the last commit's position, published under mu once the commit's frames are queued, which
	// broadcasts published; and whether the dispatcher has stopped, which broadcasts it too
	position  atomic.Uint64
	published *sync.Cond
	stopped   bool
	done      chan struct{}
	/* Each user's generation as the core last published it, for the users it keeps an account
	   for, and each user's connections whose tokens a change of the generation revokes, by user.
	   Both under mu. */
	generations map[string]int64
	byUser      map[string]map[*conn]struct{}
	// the interval between a connection's heartbeat vouches
	heartbeat time.Duration

	// the bundle's cron entries, in the core's order, and the scheduler's end
	cron     []cronEntry
	cronDone chan struct{}

	// tests only: called once a login's password, or a request's proofs, have been checked,
	// before what they were checked against is read again
	proved func()
	// tests only: see Options
	beforePush      func(position uint64)
	beforeStreaming func()
	beforeForward   func()
	beforeRead      func()
}

// conn is one connection.  Its view is what the grantor allows cut down to what it wants, and its
// token the hash of that set.  The dispatcher is the only goroutine that writes the view and
// queues frames on the backlog; the handler is the only one that takes them, and both do so under
// the server's lock.  Commit frames are queued only once the handler has finished its cold catchup
// and flipped streaming, so a long replay buffers nothing; the hot catchup then covers the gap and
// the backlog is deduped by position.  The backlog grows as frames are queued, up to the server's
// limit, and the handler takes it whole, so an idle connection holds none.
type conn struct {
	id        uint64
	wants     []string
	selectors []string // the view
	token     string   // the hash of the view
	active    bool
	ephemeral bool
	streaming bool
	backlog   []frame
	// whether the backlog reached its limit, or the server shut down; either ends the connection
	// once the handler has written what was queued before it
	overflowed, shutdown bool
	// signaled, without blocking, when a frame is queued or the connection ends
	wake chan struct{}
	// its principal's user, and its token's generation and expiry in Unix seconds; a connection
	// whose token no longer speaks for its account is revoked
	user    string
	gen     int64
	exp     int64
	revoked bool
	// what the grantor's failure answers the connection with, "" while it grants
	failure string
}

// frame is one queued frame: a commit whose edits the connection's view covers some of, or a
// change of the view.
type frame struct {
	commit *commit
	view   *viewChange
}

// commit is one commit's edits, each mutation's in a run of their own, in position order.  It is
// shared by every connection it is queued to, and read only: each handler writes the edits its
// view covers as it takes the commit from its backlog.
type commit struct {
	mutations [][]item
}

// viewChange is a view frame, which carries the view and, as its position, the one the dispatcher
// had published before the batch that changed it; the handler encodes it as it writes it (see
// viewFrame).  A grantor that failed queues the encoded end frame in its place.
type viewChange struct {
	pos       uint64
	token     string
	selectors []string
	end       []byte
}

// viewFrame encodes a view frame at a position.  A view frame's position is the last position the
// connection sent under the previous view: everything the connection sends after the frame is
// filtered by the new view, and the new view's edits at or below the position are the client's
// backfills' to deliver, through it.  The handler writes the later of its own cursor and the
// position the dispatcher had published before the batch that changed the view.  Its cursor alone
// would be wrong live: it moves only with the frames the connection is sent, so it lags commits
// the old view could not see, and a backfill's tail ending there would skip the new view's edits
// in them, a gap a fresh snapshot cut past them hides and an older cached one does not.  In a
// replay the cursor is right on its own, since the replay moves it through every position it
// reads, seen or not.
func viewFrame(token string, cursor uint64, selectors []string) []byte {
	return mpEncode([]any{"view", token, cursor, selectors})
}

// The codes of the end frames the database sends.  They are its own, in the 600s, which HTTP
// leaves unused, so a client reports them beside the HTTP statuses of the ends it sees outside the
// stream without confusing the two.
const (
	endGrantorFailed = 600 // the grantor failed when a commit re-ran it
	endOverflow      = 601 // the connection's backlog overflowed
	endReadFailed    = 602 // a history read failed
	endRevoked       = 603 // the token was revoked, or is about to expire
)

const (
	heartbeat = 15 * time.Second
	// how long before its token expires a connection ends, so that its client reconnects with the
	// token refreshed
	expiryLead = time.Minute
	maxBody    = 16 << 20
	coldBatch  = 1000
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

	// the page cache's size, which SQLite takes in KiB as a C int
	cacheMiB := o.SqliteCacheSize
	if cacheMiB <= 0 {
		cacheMiB = 64
	}
	if cacheMiB > math.MaxInt32/1024 {
		return nil, fmt.Errorf("sqlite cache size %d MiB is over the most SQLite takes, %d MiB",
			cacheMiB, math.MaxInt32/1024)
	}

	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		return nil, err
	}
	ttl := o.PrincipalTTL
	if ttl <= 0 {
		ttl = time.Minute
	}
	c, err := openCore(o.DataDir, o.Bundle, o.BootstrapEnv, cacheMiB, ttl)
	if err != nil {
		return nil, err
	}

	// the log's head, the position the dispatcher has published until its first commit
	head, err := c.head()
	if err != nil {
		c.close()
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
	maxStreamBacklog := o.MaxStreamBacklog
	if maxStreamBacklog <= 0 {
		maxStreamBacklog = 2048
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
		maxStreamBacklog:      maxStreamBacklog,
		epoch:                 c.epoch(),
		pending:               map[uint64]chan result{},
		conns:                 map[uint64]*conn{},
		generations:           map[string]int64{},
		byUser:                map[string]map[*conn]struct{}{},
		done:                  make(chan struct{}),
		heartbeat:             cmp.Or(o.heartbeat, heartbeat),
		cron:                  entries,
		cronDone:              make(chan struct{}),
		beforePush:            o.beforePush,
		beforeStreaming:       o.beforeStreaming,
		beforeForward:         o.beforeForward,
		beforeRead:            o.beforeRead,
	}
	s.published = sync.NewCond(&s.mu)
	s.position.Store(head)
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
					c.active = false
					c.shutdown = true
					wake(c)
				}
			}
			s.stopped = true
			s.published.Broadcast()
			s.mu.Unlock()
			return
		case rOutcome, rLookup, rArm, rTick, rKey:
			s.reply(r)
		case rAccount:
			if r.reqid != 0 {
				s.reply(r)
			} else {
				s.account(r)
			}
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
				c.failure = ""
				if r.reqid != 0 {
					// a connection the batch that registered it revoked never starts
					if !c.ephemeral && !c.revoked {
						c.active = true
					}
				} else if c.active && changed {
					// a grant change that left this view as it was is no frame; one that did comes
					// ahead of its batch's edits, at the position published before the batch
					s.queue(c, frame{view: &viewChange{pos: s.position.Load(), token: token,
						selectors: view}})
				}
			} else if c != nil {
				// the grantor failed, so the connection is answered with the failure, and one it
				// failed under when a commit re-ran it ends
				c.failure = r.errmsg
				if r.reqid == 0 && c.active {
					end := mpEncode([]any{"end", endGrantorFailed, r.errmsg})
					s.queue(c, frame{view: &viewChange{end: end}})
					c.active = false
				}
			}
			s.mu.Unlock()
			if r.reqid != 0 {
				s.reply(r)
			}
		case rCommit:
			if s.beforePush != nil {
				s.beforePush(r.position)
			}
			// the commit, queued once to every streaming connection whose view covers any of it
			var cm *commit
			s.mu.Lock()
			for _, c := range s.conns {
				if !c.active || !c.streaming || !coversAny(c.selectors, r.items) {
					continue
				}
				if cm == nil {
					cm = &commit{mutations: groupPositions(r.items)}
				}
				s.queue(c, frame{commit: cm})
			}

			/* Publish the position once every streaming connection holds the commit's frames, and
			   under the lock: a connection that forwards its queue after reading the position has
			   then written every frame at or below it, and one that switches to streaming gets
			   each commit from exactly one of its hot catchup and its queue. */
			s.position.Store(r.position)
			s.published.Broadcast()
			s.mu.Unlock()
		}
	}
}

// account takes the core's change to a user's account, ahead of the edits of the batch that made
// it: Go's copy of the generation, which refuses a stale token at once, and the end of every
// connection whose token no longer speaks for the account.
func (s *Server) account(r result) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.forgotten {
		delete(s.generations, r.user)
		return
	}
	s.generations[r.user] = r.generation
	for c := range s.byUser[r.user] {
		if c.gen == r.generation || c.revoked {
			continue
		}
		c.revoked = true
		s.queue(c, frame{view: &viewChange{end: mpEncode([]any{"end", endRevoked, "token revoked"})}})
		c.active = false
	}
}

// settled waits until the dispatcher has published a position, by which every change to a grant
// or an account up to it has reached the connections; false when the server stops first.
func (s *Server) settled(position uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.position.Load() < position && !s.stopped {
		s.published.Wait()
	}
	return s.position.Load() >= position
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

// queue adds a frame to a connection's backlog, under the server's lock, and wakes its handler.  A
// live connection that cannot keep up, whose backlog is at the limit, ends instead, and a
// connection that has ended takes no more frames.
func (s *Server) queue(c *conn, f frame) {
	if !c.active {
		return
	}
	if len(c.backlog) >= s.maxStreamBacklog {
		c.overflowed = true
		c.active = false
	} else {
		c.backlog = append(c.backlog, f)
	}
	wake(c)
}

func wake(c *conn) {
	select {
	case c.wake <- struct{}{}:
	default:
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
	var b bytes.Buffer
	if sent, _ := writeEditsFrame(&b, edits, selectors); !sent {
		return nil
	}
	return b.Bytes()
}

// writeEditsFrame writes the edits frame of one mutation's edits that are in the view, each edit's
// bytes as they are, and nothing when none are; it answers whether it wrote a frame.
func writeEditsFrame(w io.Writer, edits []item, selectors []string) (bool, error) {
	n := 0
	for _, it := range edits {
		if covers(selectors, it.slice) {
			n++
		}
	}
	if n == 0 {
		return false, nil
	}
	head := mpArrayHeader(nil, 2)
	head = mpAppendStr(head, "edits")
	head = mpArrayHeader(head, n)
	if _, err := w.Write(head); err != nil {
		return false, err
	}
	for _, it := range edits {
		if !covers(selectors, it.slice) {
			continue
		}
		if _, err := w.Write(it.data); err != nil {
			return false, err
		}
	}
	return true, nil
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
		wake:      make(chan struct{}, 1),
		user:      p.user,
		gen:       p.gen,
		exp:       p.exp,
	}
	s.mu.Lock()
	s.conns[c.id] = c
	if !p.anonymous && p.gen >= 0 {
		if s.byUser[p.user] == nil {
			s.byUser[p.user] = map[*conn]struct{}{}
		}
		s.byUser[p.user][c] = struct{}{}
	}
	s.mu.Unlock()
	r := s.request(func(reqid uint64) { s.core.register(reqid, c.id, p) })
	if r.status != 0 {
		s.drop(c)
		return c, r
	}

	// the dispatcher computed the view before it replied, and revoked a connection whose batch
	// revoked its token
	s.mu.Lock()
	r.selectors = c.selectors
	r.token = c.token
	revoked := c.revoked
	s.mu.Unlock()
	if revoked {
		s.drop(c)
		return c, result{status: http.StatusUnauthorized}
	}
	return c, r
}

func (s *Server) drop(c *conn) {
	s.mu.Lock()
	delete(s.conns, c.id)
	if conns := s.byUser[c.user]; conns != nil {
		delete(conns, c)
		if len(conns) == 0 {
			delete(s.byUser, c.user)
		}
	}
	c.active = false
	s.mu.Unlock()
	s.core.unregister(c.id)
}

// visible answers whether an ephemeral connection's view still covers a selector once the
// dispatcher has published position, the last its read saw, by which every change to its
// principal's grant or account up to it has reached the connection; otherwise it answers the
// client with why not.
func (s *Server) visible(w http.ResponseWriter, c *conn, selector string, position uint64) bool {
	if !s.settled(position) {
		http.Error(w, errClosed.Error(), http.StatusServiceUnavailable)
		return false
	}
	s.mu.Lock()
	revoked, failure, selectors := c.revoked, c.failure, c.selectors
	s.mu.Unlock()
	switch {
	case revoked:
		http.Error(w, errRevoked.Error(), http.StatusUnauthorized)
	case failure != "":
		http.Error(w, failure, http.StatusInternalServerError)
	case !covers(selectors, selector):
		http.Error(w, "selector not visible", http.StatusForbidden)
	default:
		return true
	}
	return false
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
	selectors := view.selectors
	// the connection delivers everything above the cursor: the client's checkpoint, or on a
	// bootstrap the view's position, which the client takes as the bound of what its snapshots
	// must cover
	cursor := view.position
	if since >= 0 {
		cursor = uint64(since)
	}

	// a client whose stored token is not the current one gets the view as the first frame, ahead
	// of history, at the cursor: the replay that follows is filtered by it
	if r.URL.Query().Get("view") != view.token {
		if !write(viewFrame(view.token, cursor, view.selectors)) {
			return
		}
	}

	// the token's expiry, shortly before which the connection ends
	var expired <-chan time.Time
	if p.exp != 0 {
		timer := time.NewTimer(time.Unix(p.exp, 0).Add(-expiryLead).Sub(s.now()))
		defer timer.Stop()
		expired = timer.C
	}
	endExpired := mpEncode([]any{"end", endRevoked, "token expiring"})

	// writes a queued view frame at the cursor, or an end frame a failed grantor or a revocation
	// queues
	writeView := func(v *viewChange) bool {
		if v.end != nil {
			write(v.end)
			return false
		}
		return write(viewFrame(v.token, max(v.pos, cursor), v.selectors))
	}

	// takes the backlog whole, under the server's lock, with whether the connection has ended, by
	// overflowing its backlog or with the server
	takeLocked := func() (queued []frame, overflowed, ended bool) {
		queued, c.backlog = c.backlog, nil
		return queued, c.overflowed, c.overflowed || c.shutdown
	}
	take := func() ([]frame, bool, bool) {
		s.mu.Lock()
		defer s.mu.Unlock()
		return takeLocked()
	}

	/* forward writes frames taken from the backlog, then the end of a connection that has ended.
	   A view frame sets the selectors the commits queued after it are filtered by, which are the
	   ones the dispatcher checked them against, and a commit's edits frames advance the cursor.
	   Returns false when the connection is done. */
	forward := func(queued []frame, overflowed, ended bool) bool {
		for _, f := range queued {
			if f.view != nil {
				if !writeView(f.view) {
					return false
				}
				selectors = f.view.selectors
				continue
			}
			for _, edits := range f.commit.mutations {
				// the mutation's own position: a commit may carry several mutations, and the hot
				// catchup sent those at or below the cursor
				if edits[0].position <= cursor {
					continue
				}
				sent, err := writeEditsFrame(w, edits, selectors)
				if err != nil {
					return false
				}
				if sent {
					cursor = edits[0].position
				}
			}
		}
		flusher.Flush()
		if overflowed {
			write(mpEncode([]any{"end", endOverflow, "connection could not keep up"}))
		}
		return !ended
	}
	// the last position the client has been told of, by an edits frame or a vouch
	told := cursor
	replay := func(from, to uint64) bool {
		items, err := s.core.readLog(from, to)
		if err != nil {
			write(mpEncode([]any{"end", endReadFailed, err.Error()}))
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

	// cold catchup: unbuffered, as long as it takes, with the view frames queued meanwhile, the only
	// frames queued before the switch to streaming
	for {
		select {
		case <-expired:
			write(endExpired)
			return
		default:
		}
		if !forward(take()) {
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

	// switch to streaming, then a hot catchup through the dispatcher's position as of the switch
	if s.beforeStreaming != nil {
		s.beforeStreaming()
	}
	s.mu.Lock()
	c.streaming = true
	hot := s.position.Load()
	selectors = append([]string(nil), c.selectors...)
	// the backlog holds only view frames until the switch, since the dispatcher queues commits to
	// streaming connections alone, and it queues only under the lock
	views, overflowed, ended := takeLocked()
	s.mu.Unlock()

	// the view frames queued before the switch, whose selectors the hot catchup replays under, go
	// ahead of it
	if !forward(views, overflowed, ended) {
		return
	}

	// the hot catchup
	if !replay(cursor+1, hot) {
		return
	}
	cursor = max(cursor, hot)
	if !write(mpEncode([]any{"live", cursor})) {
		return
	}

	ticker := time.NewTicker(s.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-c.wake:
			if s.beforeForward != nil {
				s.beforeForward()
			}
			if !forward(take()) {
				return
			}
		case <-ticker.C:
			/* The vouch names the cursor, so it never runs ahead of an edits frame still queued.
			   Every commit the dispatcher has published is already in the backlog, so forwarding
			   the backlog as it stands brings the cursor up to the published position, and a
			   submitter whose mutation touched no slice it can see gets its position on this
			   heartbeat. */
			published := s.position.Load()
			if !forward(take()) {
				return
			}
			cursor = max(cursor, published)
			if !write(mpEncode([]any{"vouch", cursor})) {
				return
			}
		case <-expired:
			write(endExpired)
			return
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
		if s.proved != nil {
			s.proved()
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
	defer s.drop(c)
	if !covers(view.selectors, selector) {
		http.Error(w, "selector not visible", http.StatusForbidden)
		return
	}

	// the cut, then the grant as of it, so that a revocation that lands before the cut hides it
	if s.beforeRead != nil {
		s.beforeRead()
	}
	blob, position, err := s.core.snapshot(selector)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !s.visible(w, c, selector, position) {
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

// coversAny reports whether the selectors cover the slice of any of the edits.
func coversAny(selectors []string, edits []item) bool {
	for _, it := range edits {
		if covers(selectors, it.slice) {
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
	defer s.drop(c)
	if !covers(view.selectors, selector) {
		http.Error(w, "selector not visible", http.StatusForbidden)
		return
	}

	// the edits, then the grant as of the head read after them, which bounds every edit read
	if s.beforeRead != nil {
		s.beforeRead()
	}
	items, err := s.core.readEdits(selector, after, before, reverse, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	head, err := s.core.head()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !s.visible(w, c, selector, head) {
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
