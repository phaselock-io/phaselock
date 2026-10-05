package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// test harness /////////////////////////////////////////////////////////////

type harness struct {
	t   *testing.T
	srv *Server
	web *httptest.Server
	dir string
}

func start(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	return startIn(t, dir)
}

func startIn(t *testing.T, dir string) *harness {
	t.Helper()
	return startWith(t, t.Context(), Options{DataDir: dir})
}

// startWith opens a server under ctx with the test defaults filled into o: the dev test bundle
// unless o names another, dev auth, a fixed secret, and an attempt budget no test of other
// features runs out of.
func startWith(t *testing.T, ctx context.Context, o Options) *harness {
	t.Helper()
	if o.DataDir == "" {
		o.DataDir = t.TempDir()
	}
	if o.Bundle == "" {
		o.Bundle = filepath.Join("testdata", "bundle.js")
	}
	o.DevAuth = true
	o.Secret = []byte("test-secret")
	if o.AuthBurst == 0 {
		o.AuthBurst = 1000
	}
	srv, err := Open(ctx, o)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	web := httptest.NewUnstartedServer(srv.Handler())
	web.Config.BaseContext = srv.BaseContext
	web.Start()
	h := &harness{t: t, srv: srv, web: web, dir: o.DataDir}
	t.Cleanup(h.stop)
	return h
}

// stop shuts down as main does: the server's context ends, which ends every request under it,
// then the web server waits for handlers to return, then the server closes.
func (h *harness) stop() {
	if h.srv != nil {
		h.srv.cancel()
	}
	if h.web != nil {
		h.web.Close()
		h.web = nil
	}
	if h.srv != nil {
		h.srv.Close()
		h.srv = nil
	}
}

func (h *harness) do(method, path, token string, body []byte) (int, http.Header, []byte) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.web.URL+path, bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/msgpack")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, out
}

// token mints a dev token for user with the given traits.
// token signs in as an existing account with no credential, through dev auth; the test bundle's
// standing users, root (an admin) and p1, need no account in the log.
func (h *harness) token(identity string) string {
	h.t.Helper()
	body := mpEncode(map[string]any{"kind": "dev", "identity": identity})
	status, _, out := h.do("POST", "/auth/token", "", body)
	if status != 200 {
		h.t.Fatalf("dev token: status %d: %s", status, out)
	}
	reply := mpDecodeOne(h.t, out).(map[string]any)
	return reply["token"].(string)
}

func (h *harness) admin() string { return h.token("root") }
func (h *harness) epoch() string { return h.srv.epoch }

type command struct {
	id   string
	data map[string]any
}

func cmd(id, typ string, kv ...any) command {
	data := map[string]any{"type": typ}
	for i := 0; i+1 < len(kv); i += 2 {
		data[kv[i].(string)] = kv[i+1]
	}
	return command{id: id, data: data}
}

// commands posts commands and returns the outcomes.
func (h *harness) commands(token string, cmds ...command) []outcome {
	h.t.Helper()
	status, outs := h.commandsStatus(token, cmds...)
	if status != 200 {
		h.t.Fatalf("commands: status %d", status)
	}
	return outs
}

func (h *harness) commandsStatus(token string, cmds ...command) (int, []outcome) {
	h.t.Helper()
	var body []byte
	for _, c := range cmds {
		body = append(body, mpEncode([]any{c.id, c.data})...)
	}
	status, _, out := h.do("POST", "/commands", token, body)
	if status != 200 {
		return status, nil
	}
	return status, decodeOutcomes(h.t, out)
}

func decodeOutcomes(t *testing.T, out []byte) []outcome {
	raw := mpDecodeOne(t, out).([]any)
	var outs []outcome
	for _, r := range raw {
		arr := r.([]any)
		o := outcome{kind: arr[0].(string)}
		switch o.kind {
		case "ack", "dup":
			o.position = asInt(arr[1])
		case "reject":
			o.reason = arr[1].(string)
		case "conflict":
			o.current = map[string]int64{}
			for k, v := range arr[1].(map[string]any) {
				o.current[k] = asInt(v)
			}
		}
		outs = append(outs, o)
	}
	return outs
}

type outcome struct {
	kind     string
	position int64
	reason   string
	current  map[string]int64
}

// expecting posts one command with an expect map and returns its outcome.
func (h *harness) expecting(token string, c command, expect map[string]any) outcome {
	h.t.Helper()
	body := mpEncode([]any{c.id, c.data, expect})
	status, _, out := h.do("POST", "/commands", token, body)
	if status != 200 {
		h.t.Fatalf("commands: status %d", status)
	}
	return decodeOutcomes(h.t, out)[0]
}

func (h *harness) ack(token string, c command) int64 {
	h.t.Helper()
	outs := h.commands(token, c)
	if outs[0].kind != "ack" {
		h.t.Fatalf("expected ack for %s, got %+v", c.id, outs[0])
	}
	return outs[0].position
}

// stream is an open /stream connection.
type stream struct {
	t      *testing.T
	resp   *http.Response
	frames chan any
	errs   chan error
	header http.Header
	// the view frame a connection without the current token gets first
	first []any
}

func (h *harness) stream(token string, since int64, wants ...string) *stream {
	h.t.Helper()
	return h.streamOpen(token, since, "", nil, wants...)
}

// streamView opens a stream presenting a stored view token.
func (h *harness) streamView(token string, since int64, view string) *stream {
	h.t.Helper()
	return h.streamOpen(token, since, view, nil)
}

// streamPaused opens a stream whose reader waits on start before reading.
func (h *harness) streamPaused(token string, since int64, start chan struct{}, wants ...string) *stream {
	h.t.Helper()
	return h.streamOpen(token, since, "", start, wants...)
}

func (h *harness) streamOpen(token string, since int64, view string, start chan struct{}, wants ...string) *stream {
	h.t.Helper()
	q := fmt.Sprintf("/stream?since=%d", since)
	if view != "" {
		q += "&view=" + view
	}
	for _, w := range wants {
		q += "&want=" + w
	}
	req, err := http.NewRequest("GET", h.web.URL+q, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		h.t.Fatalf("stream: status %d: %s", resp.StatusCode, body)
	}
	s := &stream{t: h.t, resp: resp, frames: make(chan any, 64), errs: make(chan error, 1), header: resp.Header}
	go func() {
		if start != nil {
			<-start
		}
		dec := newMpDecoder(resp.Body)
		for {
			v, err := dec.Decode()
			if err != nil {
				s.errs <- err
				return
			}
			s.frames <- v
		}
	}()
	h.t.Cleanup(s.close)
	// a stream opened without presenting a token gets the view frame first;
	// keep it aside so tests see the same frames as a client with the
	// current token, unless they asked for the raw stream
	if view == "" && start == nil {
		if f := s.next(); f[0] == "view" {
			s.first = f
		} else {
			s.frames <- f
		}
	}
	return s
}

func (s *stream) close() { s.resp.Body.Close() }

// next returns the next frame or fails; a frame read before the stream ended comes first.
func (s *stream) next() []any {
	s.t.Helper()
	select {
	case f := <-s.frames:
		return f.([]any)
	default:
	}
	select {
	case f := <-s.frames:
		return f.([]any)
	case err := <-s.errs:
		s.t.Fatalf("stream ended: %v", err)
	case <-time.After(5 * time.Second):
		s.t.Fatalf("timeout waiting for frame")
	}
	return nil
}

// nextTagged skips vouches until a frame with the tag arrives.
func (s *stream) nextTagged(tag string) []any {
	s.t.Helper()
	for i := 0; i < 50; i++ {
		f := s.next()
		if f[0].(string) == tag {
			return f
		}
		if f[0].(string) != "vouch" {
			s.t.Fatalf("expected %s frame, got %v", tag, f)
		}
	}
	s.t.Fatalf("no %s frame after many vouches", tag)
	return nil
}

// live expects the once-per-connection live frame and returns its position.
func (s *stream) live() int64 {
	s.t.Helper()
	f := s.next()
	if f[0] != "live" {
		s.t.Fatalf("expected live frame, got %v", f)
	}
	return asInt(f[1])
}

func (s *stream) quiet() {
	s.t.Helper()
	select {
	case f := <-s.frames:
		if f.([]any)[0].(string) != "vouch" {
			s.t.Fatalf("expected silence, got %v", f)
		}
	case <-time.After(200 * time.Millisecond):
	}
}

// event is one decoded [envelope, data] value.
type event struct {
	position   int64
	stream     string
	seq        int64
	commandid  string
	servertime time.Time
	data       map[string]any
}

func events(f []any) []event {
	var out []event
	for _, ev := range f[1].([]any) {
		pair := ev.([]any)
		env := pair[0].([]any)
		out = append(out, event{
			position:   asInt(env[0]),
			stream:     env[1].(string),
			seq:        asInt(env[2]),
			commandid:  env[3].(string),
			servertime: env[4].(time.Time),
			data:       pair[1].(map[string]any),
		})
	}
	return out
}

func asInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case uint64:
		return int64(n)
	case float64:
		return int64(n)
	}
	panic(fmt.Sprintf("not an integer: %T %v", v, v))
}

func mpDecodeOne(t *testing.T, b []byte) any {
	t.Helper()
	v, err := newMpDecoder(bytes.NewReader(b)).Decode()
	if err != nil {
		t.Fatalf("decode: %v (%x)", err, b)
	}
	return v
}

func strs(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}

// tests ////////////////////////////////////////////////////////////////////

func TestCommandsAckDupReject(t *testing.T) {
	h := start(t)
	admin := h.admin()

	outs := h.commands(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	if outs[0].kind != "ack" || outs[0].position < 1 {
		t.Fatalf("expected ack, got %+v", outs[0])
	}
	first := outs[0].position

	// resubmission is an idempotent ack with the original position
	outs = h.commands(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	if outs[0].kind != "dup" || outs[0].position != first {
		t.Fatalf("expected dup at %d, got %+v", first, outs[0])
	}

	// precommit rejection, structural rejection, and a later ack in one post
	outs = h.commands(admin,
		cmd("c2", "add-book", "id", "b1", "title", "Dune again"),
		cmd("c3", "add-book", "id", "b2"),
		cmd("c4", "add-book", "id", "b2", "title", "Emma"),
	)
	if outs[0].kind != "reject" || outs[0].reason != "book exists" {
		t.Fatalf("expected precommit reject, got %+v", outs[0])
	}
	if outs[1].kind != "reject" || !strings.Contains(outs[1].reason, "$.title: missing required field") {
		t.Fatalf("expected structural reject, got %+v", outs[1])
	}
	if outs[2].kind != "ack" || outs[2].position <= first {
		t.Fatalf("expected ack after rejects, got %+v", outs[2])
	}

	// anonymous is a principal; the bundle says it may not add books
	outs = h.commands("", cmd("c5", "add-book", "id", "b3", "title", "Nope"))
	if outs[0].kind != "reject" || outs[0].reason != "unauthorized" {
		t.Fatalf("expected unauthorized, got %+v", outs[0])
	}
}

func TestBootstrapAndLiveAtoms(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))

	s := h.stream(admin, -1)
	if s.header.Get("PhaseLock-Protocol") != "1" || len(s.header.Get("PhaseLock-Epoch")) != 32 {
		t.Fatalf("bad headers: %v", s.header)
	}
	if s.header.Get("PhaseLock-View") == "" || s.header.Get("PhaseLock-Time") == "" {
		t.Fatalf("missing view or time header: %v", s.header)
	}
	live := s.live()

	// a new patron: birth then the event, one atom, one frame
	pos := h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	f := s.nextTagged("events")
	evs := events(f)
	if len(evs) != 2 {
		t.Fatalf("expected birth + event, got %v", evs)
	}
	if evs[0].data["$sys"] != "birth" || evs[0].stream != "patron.p1" {
		t.Fatalf("expected birth on patron.p1, got %+v", evs[0])
	}
	if evs[1].data["type"] != "add-patron" || evs[1].stream != "patron.p1" {
		t.Fatalf("expected add-patron, got %+v", evs[1])
	}
	if evs[0].position != live+1 || evs[1].position != live+2 || evs[1].position != pos {
		t.Fatalf("positions: live=%d ack=%d evs=%+v", live, pos, evs)
	}
	if evs[0].seq != 1 || evs[1].seq != 2 {
		t.Fatalf("seq is dense per stream from the birth: %+v", evs)
	}
	for _, e := range evs {
		if e.commandid != "c2" {
			t.Fatalf("every event carries the command id: %+v", e)
		}
		if e.servertime.Before(time.Now().Add(-time.Minute)) || e.servertime.After(time.Now()) {
			t.Fatalf("servertime looks wrong: %+v", e)
		}
	}

	// a multi-stream atom arrives as one frame
	h.ack(admin, cmd("c3", "try-hold", "id", "h1", "book", "b1", "patron", "p1"))
	evs = events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].stream != "book" || evs[1].stream != "patron.p1" {
		t.Fatalf("expected book + patron events, got %+v", evs)
	}
	if evs[0].commandid != "c3" || evs[1].commandid != "c3" {
		t.Fatalf("shared command id: %+v", evs)
	}
	if evs[0].seq != 3 || evs[1].seq != 3 {
		t.Fatalf("seq per stream: book birth=1 add=2 hold=%d; patron birth=1 add=2 hold=%d", evs[0].seq, evs[1].seq)
	}
}

func TestLiveMultiAtomCommit(t *testing.T) {
	h := start(t)
	admin := h.admin()
	pos := h.ack(admin, cmd("c0", "add-book", "id", "b0", "title", "Zero"))
	s := h.stream(admin, -1)
	if s.header.Get("PhaseLock-Position") != fmt.Sprint(pos) {
		t.Fatalf("PhaseLock-Position %q, want %d", s.header.Get("PhaseLock-Position"), pos)
	}
	s.nextTagged("live")
	// one POST, two commands, one group commit: two atoms on the wire
	body := append(mpEncode([]any{"c1", map[string]any{"type": "add-patron", "id": "p1", "name": "Ann"}}),
		mpEncode([]any{"c2", map[string]any{"type": "add-patron", "id": "p2", "name": "Bob"}})...)
	if status, _, _ := h.do("POST", "/commands", admin, body); status != 200 {
		t.Fatalf("commands: status %d", status)
	}
	first := events(s.nextTagged("events"))
	second := events(s.nextTagged("events"))
	if first[0].stream != "patron.p1" || second[0].stream != "patron.p2" {
		t.Fatalf("expected both atoms live: %+v then %+v", first, second)
	}
}

func TestHistoryReplay(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	p2 := h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	p3 := h.ack(admin, cmd("c3", "rename-patron", "id", "p1", "name", "Anne"))

	// from genesis: book birth+add, patron birth+add, rename
	s := h.stream(admin, 0)
	var all []event
	for len(all) < 5 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	want := []string{"book", "book", "patron.p1", "patron.p1", "patron.p1"}
	wantSeq := []int64{1, 2, 1, 2, 3}
	for i, e := range all {
		if e.stream != want[i] || e.position != int64(i+1) || e.seq != wantSeq[i] {
			t.Fatalf("history[%d] = %+v, want stream %s pos %d seq %d", i, e, want[i], i+1, wantSeq[i])
		}
	}
	if s.live() != p3 {
		t.Fatalf("live frame should carry the position history ended at")
	}
	// then live
	h.ack(admin, cmd("c4", "rename-patron", "id", "p1", "name", "Annie"))
	evs := events(s.nextTagged("events"))
	if evs[0].data["name"] != "Annie" {
		t.Fatalf("expected live rename, got %+v", evs)
	}

	// resume after p2: only the rename atom, at p3
	s2 := h.stream(admin, p2)
	evs = events(s2.nextTagged("events"))
	if len(evs) != 1 || evs[0].position != p3 || evs[0].data["name"] != "Anne" {
		t.Fatalf("resume from %d: got %+v", p2, evs)
	}
	s2.nextTagged("events") // the live rename
	s2.live()
}

func TestViewAndWants(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.ack(admin, cmd("c3", "add-patron", "id", "p2", "name", "Bob"))

	// a patron sees the book shard and its own shard, from history
	ann := h.token("p1")
	s := h.stream(ann, 0)
	var all []event
	for len(all) < 4 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	for _, e := range all {
		if e.stream != "book" && e.stream != "patron.p1" {
			t.Fatalf("leaked event: %+v", e)
		}
	}
	s.live()
	// other patrons' events are invisible and produce no frame at all
	h.ack(admin, cmd("c4", "rename-patron", "id", "p2", "name", "Robert"))
	s.quiet()
	h.ack(admin, cmd("c5", "rename-patron", "id", "p1", "name", "Anne"))
	evs := events(s.nextTagged("events"))
	if evs[0].stream != "patron.p1" {
		t.Fatalf("expected own event, got %+v", evs)
	}

	// wants narrow the view: the frame carries maySee cut down to the wants,
	// and the token hashes that set, so it differs from the unrestricted one
	s2 := h.stream(ann, -1, "book")
	if s2.first == nil || strings.Join(strs(s2.first[3]), ",") != "book" {
		t.Fatalf("narrowed view frame: %v", s2.first)
	}
	if s2.header.Get("PhaseLock-View") == s.header.Get("PhaseLock-View") {
		t.Fatalf("token should reflect the wants")
	}
	s2.live()
	h.ack(admin, cmd("c6", "rename-patron", "id", "p1", "name", "Annie"))
	s2.quiet()
	h.ack(admin, cmd("c7", "add-book", "id", "b2", "title", "Emma"))
	evs = events(s2.nextTagged("events"))
	if evs[0].stream != "book" {
		t.Fatalf("expected book event, got %+v", evs)
	}

	// the narrower of a want and a grant is kept, and a want nothing grants
	// vanishes: patron.* against patron.p1 is patron.p1, author.* is nothing
	s4 := h.stream(ann, -1, "patron.*", "author.*")
	if s4.first == nil || strings.Join(strs(s4.first[3]), ",") != "patron.p1" {
		t.Fatalf("intersected view frame: %v", s4.first)
	}
	s4.live()
	s5 := h.stream(admin, -1, "patron.*")
	if s5.first == nil || strings.Join(strs(s5.first[3]), ",") != "patron.*" {
		t.Fatalf("admin view cut down to a family: %v", s5.first)
	}
	s5.live()

	// anonymous sees only the book shard
	s3 := h.stream("", -1)
	s3.live()
	h.ack(admin, cmd("c8", "rename-patron", "id", "p1", "name", "Ann"))
	s3.quiet()
}

func TestMaySeeInvalidation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.ack(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.ack(admin, cmd("c3", "create-account", "user", "p1", "password", "hunter2"))

	ann := h.token("p1")
	s := h.stream(ann, -1)
	s.live()
	token0 := s.header.Get("PhaseLock-View")
	// two connections of the same principal with narrower wants
	sb := h.stream(ann, -1, "book")
	sb.live()
	sp := h.stream(ann, -1, "patron.*")
	sp.live()

	// granting a view rewrites maySee's read-set key: a view frame arrives,
	// before any events of the same commit, carrying the whole set of refs
	grantPos := h.ack(admin, cmd("c4", "grant-view", "user", "p1", "prefix", "patron.p2/"))
	f := s.nextTagged("view")
	if f[1].(string) == token0 {
		t.Fatalf("token should change on grant")
	}
	// the frame names the commit position the view changed at
	if asInt(f[2]) != grantPos {
		t.Fatalf("view position %v, want %d", f[2], grantPos)
	}
	if got := strings.Join(strs(f[3]), ","); got != "book,patron.p1,patron.p2" {
		t.Fatalf("grant frame refs: %v", got)
	}
	token1 := f[1].(string)
	// the grant is inside one connection's wants and outside the other's: the
	// first gets its own view, the second's view is as it was, so no frame
	f = sp.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "patron.p1,patron.p2" {
		t.Fatalf("grant frame refs under wants: %v", got)
	}
	sb.quiet()

	// now p2's events flow
	h.ack(admin, cmd("c5", "rename-patron", "id", "p2", "name", "Robert"))
	evs := events(s.nextTagged("events"))
	if evs[0].stream != "patron.p2" {
		t.Fatalf("expected granted stream, got %+v", evs)
	}

	// a connection presenting a stale token gets the view frame first, with
	// the current refs; one presenting the current token goes straight to live
	s2 := h.streamView(ann, -1, token0)
	v := s2.nextTagged("view")
	if v[1].(string) != token1 || fmt.Sprint(asInt(v[2])) != s2.header.Get("PhaseLock-Position") {
		t.Fatalf("first view frame: %v (stream token %v)", v, token1)
	}
	if got := strings.Join(strs(v[3]), ","); got != "book,patron.p1,patron.p2" {
		t.Fatalf("first view refs: %v", got)
	}
	s2.resp.Body.Close()
	s3 := h.streamView(ann, -1, token1)
	if f := s3.next(); f[0] != "live" {
		t.Fatalf("current token: expected live first, got %v", f)
	}
	s3.resp.Body.Close()

	// revocation: a view frame, and the same commit's events are withheld
	h.ack(admin, cmd("c6", "revoke-view", "user", "p1", "prefix", "patron.p2/"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron.p1" {
		t.Fatalf("revoke frame refs: %v", got)
	}
	if f[1].(string) != token0 {
		t.Fatalf("token should return to the original after revoke")
	}
	h.ack(admin, cmd("c7", "rename-patron", "id", "p2", "name", "Bob"))
	s.quiet()

	// refs are never expanded: a family grant is one ref, and the client
	// learns the members from the blob
	h.ack(admin, cmd("c8", "add-patron", "id", "p3", "name", "Cy"))
	h.ack(admin, cmd("c9", "grant-view", "user", "p1", "prefix", "patron.*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron.*,patron.p1" {
		t.Fatalf("wildcard grant frame refs: %v", got)
	}
	tokenFamily := f[1].(string)
	// every change to the set is sent, even one that leaves coverage as it
	// was: patron.p2 is inside the held patron.*
	h.ack(admin, cmd("c9b", "grant-view", "user", "p1", "prefix", "patron.p2/"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron.*,patron.p1,patron.p2" || f[1].(string) == tokenFamily {
		t.Fatalf("grant inside a held family: %v", f)
	}
	h.ack(admin, cmd("c9c", "revoke-view", "user", "p1", "prefix", "patron.p2/"))
	f = s.nextTagged("view")
	if f[1].(string) != tokenFamily {
		t.Fatalf("revoke inside a held family: %v", f)
	}
	h.ack(admin, cmd("c10", "add-patron", "id", "p4", "name", "Di"))
	evs = events(s.nextTagged("events"))
	if evs[0].stream != "patron.p4" || evs[0].data["$sys"] != "birth" {
		t.Fatalf("births under a held wildcard arrive in-stream: %+v", evs)
	}
	h.ack(admin, cmd("c11", "revoke-view", "user", "p1", "prefix", "patron.*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron.p1" {
		t.Fatalf("wildcard revoke frame refs: %v", got)
	}
}

func TestBirthDeath(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.ack(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob"))

	// a bootstrap presents no token and gets the view frame first
	s := h.stream(admin, -1)
	if v := s.first; v == nil || strings.Join(strs(v[3]), ",") != "*" || asInt(v[2]) != 4 {
		t.Fatalf("first view frame: %v", v)
	}
	s.live()
	pos := h.ack(admin, cmd("c3", "remove-patron", "id", "p1"))
	evs := events(s.nextTagged("events"))
	if len(evs) != 1 || evs[0].data["$sys"] != "death" || evs[0].stream != "patron.p1" || evs[0].position != pos {
		t.Fatalf("expected death, got %+v", evs)
	}
	if evs[0].seq != 3 {
		t.Fatalf("death takes the next seq: %+v", evs)
	}

	// the dead stream is gone from the family's blob and its keys are gone
	if fam := h.snapshot(admin, "patron.*"); len(fam.streams) != 1 || fam.streams["patron.p2"] != 2 {
		t.Fatalf("streams after death: %v", fam.streams)
	}
	blob := h.snapshot(admin, "patron.p1")
	if len(blob.records) != 0 {
		t.Fatalf("dead stream still has state: %v", blob.records)
	}

	// rebirth under the same name
	h.ack(admin, cmd("c4", "add-patron", "id", "p1", "name", "Ann II"))
	evs = events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].data["$sys"] != "birth" || evs[1].data["name"] != "Ann II" {
		t.Fatalf("expected rebirth, got %+v", evs)
	}
	if evs[0].seq != 4 || evs[1].seq != 5 {
		t.Fatalf("seq continues across lives: %+v", evs)
	}
	blob = h.snapshot(admin, "patron.p1")
	if blob.records["patron.p1/patron"] == nil {
		t.Fatalf("reborn stream has no state: %v", blob.records)
	}
}

// snapshot blob parsing per the README ///////////////////////////////////

type blob struct {
	header   map[string]any
	streams  map[string]int64
	position int64
	records  map[string]any
	raw      map[string][]byte
	keys     []string
}

func (h *harness) snapshot(token, ref string) blob {
	h.t.Helper()
	status, hdr, out := h.do("GET", "/snapshot/"+ref, token, nil)
	if status != 200 {
		h.t.Fatalf("snapshot %s: status %d: %s", ref, status, out)
	}
	b := parseBlob(h.t, out)
	if fmt.Sprint(b.position) != hdr.Get("PhaseLock-Position") {
		h.t.Fatalf("position header %q != blob %d", hdr.Get("PhaseLock-Position"), b.position)
	}
	// every stream with a record is in the streams map
	for _, k := range b.keys {
		if _, ok := b.streams[k[:strings.Index(k, "/")]]; !ok {
			h.t.Fatalf("record %s for a stream missing from %v", k, b.streams)
		}
	}
	return b
}

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

func parseBlob(t *testing.T, b []byte) blob {
	t.Helper()
	if len(b) < 9 || string(b[:4]) != "PLSN" || b[4] != 1 {
		t.Fatalf("bad magic/version: %x", b[:min(len(b), 9)])
	}
	hlen := binary.BigEndian.Uint32(b[5:9])
	if binary.BigEndian.Uint32(b[9+hlen:]) != crc32.Checksum(b[9:9+hlen], castagnoli) {
		t.Fatalf("header crc mismatch")
	}
	header := mpDecodeOne(t, b[9:9+hlen]).(map[string]any)
	out := blob{header: header, streams: map[string]int64{}, position: asInt(header["position"]), records: map[string]any{}, raw: map[string][]byte{}}
	for name, seq := range header["streams"].(map[string]any) {
		out.streams[name] = asInt(seq)
	}
	p := 13 + int(hlen)
	recStart := p
	var count uint32
	for {
		klen := binary.BigEndian.Uint32(b[p:])
		if klen == 0xFFFFFFFF {
			break
		}
		if klen > 16<<20 {
			t.Fatalf("klen too large")
		}
		key := string(b[p+4 : p+4+int(klen)])
		q := p + 4 + int(klen)
		vlen := binary.BigEndian.Uint32(b[q:])
		val := b[q+4 : q+4+int(vlen)]
		q += 4 + int(vlen)
		crc := binary.BigEndian.Uint32(b[q:])
		if crc != crc32.Checksum(append([]byte(key), val...), castagnoli) {
			t.Fatalf("record crc mismatch for %s", key)
		}
		out.records[key] = mpDecodeOne(t, val)
		out.raw[key] = val
		out.keys = append(out.keys, key)
		p = q + 4
		count++
	}
	recEnd := p
	footer := b[p+4:]
	if len(footer) != 16 {
		t.Fatalf("footer length %d", len(footer))
	}
	if binary.BigEndian.Uint32(footer[0:4]) != count {
		t.Fatalf("footer count %d != %d", binary.BigEndian.Uint32(footer[0:4]), count)
	}
	if binary.BigEndian.Uint64(footer[4:12]) != fnv1a(b[recStart:recEnd]) {
		t.Fatalf("content hash mismatch")
	}
	if binary.BigEndian.Uint32(footer[12:16]) != crc32.Checksum(footer[0:12], castagnoli) {
		t.Fatalf("footer crc mismatch")
	}
	if !sort.StringsAreSorted(out.keys) {
		t.Fatalf("records not sorted: %v", out.keys)
	}
	if n, ok := header["count"]; ok && asInt(n) != int64(count) {
		t.Fatalf("header count %v != %d", n, count)
	}
	return out
}

func fnv1a(b []byte) uint64 {
	h := uint64(14695981039346656037)
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

func TestSnapshots(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	pos := h.ack(admin, cmd("c3", "add-patron", "id", "p2", "name", "Bob"))

	one := h.snapshot(admin, "patron.p1")
	if one.header["ref"] != "patron.p1" || one.position < pos || one.header["fold"] != h.epoch() {
		t.Fatalf("header: %v", one.header)
	}
	if strings.Join(one.keys, ",") != "patron.p1/holds,patron.p1/messages,patron.p1/patron" {
		t.Fatalf("keys: %v", one.keys)
	}
	if one.records["patron.p1/patron"].(map[string]any)["name"] != "Ann" {
		t.Fatalf("value: %v", one.records)
	}

	// a family blob holds every instance, contiguous per instance, and
	// names every live member with its seq
	fam := h.snapshot(admin, "patron.*")
	if len(fam.keys) != 6 || !strings.HasPrefix(fam.keys[0], "patron.p1/") || !strings.HasPrefix(fam.keys[5], "patron.p2/") {
		t.Fatalf("family keys: %v", fam.keys)
	}
	if len(fam.streams) != 2 || fam.streams["patron.p1"] != 2 || fam.streams["patron.p2"] != 2 {
		t.Fatalf("family streams: %v", fam.streams)
	}
	if one.streams["patron.p1"] != 2 || len(one.streams) != 1 {
		t.Fatalf("exact streams: %v", one.streams)
	}

	// the empty ref is everything
	all := h.snapshot(admin, "*")
	if len(all.keys) != 7 || len(all.streams) != 3 || all.header["ref"] != "*" {
		t.Fatalf("everything: %d keys, streams %v", len(all.keys), all.streams)
	}
	if status, _, _ := h.do("GET", "/snapshot/*", h.token("p1"), nil); status != 403 {
		t.Fatalf("everything for p1: status %d", status)
	}

	// the position is consistent with the log: a later write is not in
	// an earlier cut
	book := h.snapshot(admin, "book")
	if len(book.keys) != 1 {
		t.Fatalf("book keys: %v", book.keys)
	}
	later := h.ack(admin, cmd("c4", "add-book", "id", "b2", "title", "Emma"))
	book2 := h.snapshot(admin, "book")
	if len(book2.keys) != 2 || book2.position < later {
		t.Fatalf("book after write: %v @ %d", book2.keys, book2.position)
	}

	// snapshots are authorized against the view
	anon := ""
	if status, _, _ := h.do("GET", "/snapshot/patron.p1", anon, nil); status != 403 {
		t.Fatalf("anonymous snapshot of a patron: status %d", status)
	}
	if status, _, _ := h.do("GET", "/snapshot/book", anon, nil); status != 200 {
		t.Fatalf("anonymous snapshot of book: status %d", status)
	}
}

func TestPasswordAuth(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "ann", "name", "Ann"))

	// anyone may create an account; the password is hashed at intake
	h.ack("", cmd("c2", "create-account", "user", "ann", "password", "hunter2"))
	acct := h.snapshot(admin, "account.ann").records["account.ann/account"].(map[string]any)
	hash := acct["hash"].(string)
	if hash == "hunter2" || !strings.HasPrefix(hash, "$") {
		t.Fatalf("password not hashed at intake: %q", hash)
	}

	// login
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "hunter2",
	}))
	if status != 200 {
		t.Fatalf("login: %d %s", status, out)
	}
	reply := mpDecodeOne(t, out).(map[string]any)
	tok := reply["token"].(string)
	if reply["user"] != "ann" || asInt(reply["exp"]) < time.Now().Unix() {
		t.Fatalf("login reply: %v", reply)
	}
	status, _, out = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "wrong",
	}))
	if status != 401 {
		t.Fatalf("wrong password: %d %s", status, out)
	}

	// the token acts as ann
	outs := h.commands(tok, cmd("c3", "rename-patron", "id", "ann", "name", "Anne"))
	if outs[0].kind != "ack" {
		t.Fatalf("rename as ann: %+v", outs[0])
	}
	outs = h.commands(tok, cmd("c4", "add-book", "id", "b1", "title", "Dune"))
	if outs[0].kind != "reject" || outs[0].reason != "unauthorized" {
		t.Fatalf("ann is not an admin: %+v", outs[0])
	}
	s := h.stream(tok, -1)
	s.live()

	// refresh re-issues
	status, _, out = h.do("POST", "/auth/token", tok, mpEncode(map[string]any{"kind": "refresh"}))
	if status != 200 {
		t.Fatalf("refresh: %d %s", status, out)
	}
	tok2 := mpDecodeOne(t, out).(map[string]any)["token"].(string)
	if tok2 == tok {
		t.Fatalf("refresh should mint a new token")
	}

	// password change through the ordinary command path, as the user
	h.ack(tok2, cmd("c5", "set-password", "user", "ann", "password", "correct horse"))
	status, _, _ = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "hunter2",
	}))
	if status != 401 {
		t.Fatalf("old password still works")
	}
	status, _, _ = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "correct horse",
	}))
	if status != 200 {
		t.Fatalf("new password rejected")
	}

	// logout everywhere: existing tokens die on commands, streams, refresh
	h.ack(tok2, cmd("c6", "revoke-sessions", "user", "ann"))
	if status, _ := h.commandsStatus(tok2, cmd("c7", "rename-patron", "id", "ann", "name", "x")); status != 401 {
		t.Fatalf("stale token accepted for commands: %d", status)
	}
	req, _ := http.NewRequest("GET", h.web.URL+"/stream?since=-1", nil)
	req.Header.Set("Authorization", "Bearer "+tok2)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("stale token accepted for stream: %d", resp.StatusCode)
	}
	status, _, _ = h.do("POST", "/auth/token", tok2, mpEncode(map[string]any{"kind": "refresh"}))
	if status != 401 {
		t.Fatalf("stale token refreshed: %d", status)
	}
	// a fresh login carries the new generation and works
	status, _, out = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "correct horse",
	}))
	if status != 200 {
		t.Fatalf("login after revoke: %d", status)
	}
	tok3 := mpDecodeOne(t, out).(map[string]any)["token"].(string)
	h.ack(tok3, cmd("c8", "rename-patron", "id", "ann", "name", "Ann"))

	// traits ride the account: an admin-created account with the admin trait
	h.ack(admin, cmd("c9", "create-account", "user", "boss", "password", "pw", "traits", []any{"admin"}))
	status, _, out = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "boss", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("boss login: %d", status)
	}
	boss := mpDecodeOne(t, out).(map[string]any)
	if strs(boss["traits"])[0] != "admin" {
		t.Fatalf("boss traits: %v", boss)
	}
	h.ack(boss["token"].(string), cmd("c10", "add-book", "id", "b1", "title", "Dune"))
}

func TestDevAuthCanBeDisabled(t *testing.T) {
	dir := t.TempDir()
	srv, err := Open(t.Context(), Options{DataDir: dir, Bundle: filepath.Join("testdata", "bundle.js"), Secret: []byte("s")})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	web := httptest.NewServer(srv.Handler())
	defer web.Close()
	body := mpEncode(map[string]any{"kind": "dev", "identity": "root"})
	resp, err := http.Post(web.URL+"/auth/token", "application/msgpack", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("dev auth without --dev-auth: %d", resp.StatusCode)
	}
}

func TestRestartKeepsEverything(t *testing.T) {
	dir := t.TempDir()
	h := startIn(t, dir)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	pos := h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.ack("", cmd("c3", "create-account", "user", "p1", "password", "pw"))
	h.stop()

	h = startIn(t, dir)
	admin = h.admin()
	// dedup survives
	outs := h.commands(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	if outs[0].kind != "dup" || outs[0].position != pos {
		t.Fatalf("dedup lost across restart: %+v", outs[0])
	}
	// history survives and positions continue
	s := h.stream(admin, 0)
	var all []event
	for len(all) < 6 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	if all[5].stream != "account.p1" || all[5].position != 6 {
		t.Fatalf("history after restart: %+v", all)
	}
	next := h.ack(admin, cmd("c4", "add-patron", "id", "p2", "name", "Bob"))
	if next != 8 {
		t.Fatalf("positions should continue at 7,8: got %d", next)
	}
	// state survives
	if h.snapshot(admin, "patron.p1").records["patron.p1/patron"] == nil {
		t.Fatalf("state lost across restart")
	}
	// login survives
	status, _, _ := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "p1", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("login after restart: %d", status)
	}
	// the data directory holds one sqlite database and the token secret
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) == 0 {
		t.Fatalf("empty data dir")
	}
}

func TestMsgpackCodec(t *testing.T) {
	times := []time.Time{
		time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),      // 32-bit
		time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC),  // 64-bit
		time.Date(1960, 6, 7, 8, 9, 10, 123e6, time.UTC), // 96-bit
		time.Date(2600, 1, 1, 0, 0, 0, 0, time.UTC),      // past 2514: 96-bit
	}
	for i, want := range times {
		b := mpEncode(want)
		if n := []int{6, 10, 15, 15}[i]; len(b) != n {
			t.Fatalf("%v encodes to %d bytes, want %d", want, len(b), n)
		}
		v, err := newMpDecoder(bytes.NewReader(b)).Decode()
		if err != nil {
			t.Fatalf("%v: %v", want, err)
		}
		if got, ok := v.(time.Time); !ok || !got.Equal(want) {
			t.Fatalf("roundtrip %v -> %v", want, v)
		}
	}
	cases := []any{
		nil, true, false, int64(0), int64(-1), int64(127), int64(-33), int64(1 << 40), int64(-(1 << 40)),
		float64(1.5), "", "hi", strings.Repeat("x", 300), []byte{1, 2, 3},
		[]any{int64(1), "two", nil}, map[string]any{"a": int64(1), "b": []any{true}},
	}
	for _, c := range cases {
		b := mpEncode(c)
		v, err := newMpDecoder(bytes.NewReader(b)).Decode()
		if err != nil {
			t.Fatalf("%v: %v", c, err)
		}
		if fmt.Sprint(v) != fmt.Sprint(c) {
			t.Fatalf("roundtrip %v -> %v", c, v)
		}
	}
}

func TestLongCatchupNoOverflow(t *testing.T) {
	h := start(t)
	admin := h.admin()
	name := strings.Repeat("x", 2000)
	var cmds []command
	for i := 0; i < 1500; i++ {
		cmds = append(cmds, cmd(fmt.Sprintf("h%d", i), "add-patron", "id", fmt.Sprintf("p%d", i), "name", name))
	}
	outs := h.commands(admin, cmds...)
	history := outs[len(outs)-1].position
	if history != 3000 {
		t.Fatalf("expected 3000 history positions, got %d", history)
	}

	// the reader stays paused so the cold catchup blocks on the socket
	// while more commits land
	startReading := make(chan struct{})
	s := h.streamPaused(admin, 0, startReading)
	var last int64
	for i := 0; i < 300; i++ {
		last = h.ack(admin, cmd(fmt.Sprintf("l%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i)))
	}
	close(startReading)

	// every position arrives exactly once, in order, across cold
	// catchup, hot catchup, live frame, and live streaming
	next := int64(1)
	sawLive := false
	for next <= last {
		f := s.next()
		switch f[0] {
		case "events":
			for _, e := range events(f) {
				if e.position != next {
					t.Fatalf("expected position %d, got %d (live seen: %v)", next, e.position, sawLive)
				}
				next++
			}
		case "live":
			if sawLive {
				t.Fatalf("live frame twice")
			}
			sawLive = true
			if asInt(f[1]) != next-1 {
				t.Fatalf("live at %d but replay reached %d", asInt(f[1]), next-1)
			}
		case "vouch", "view":
		default:
			t.Fatalf("unexpected frame %v", f[0])
		}
	}
	if !sawLive {
		t.Fatalf("no live frame")
	}
	// still connected and still live
	pos := h.ack(admin, cmd("final", "rename-patron", "id", "p1", "name", "done"))
	if evs := events(s.nextTagged("events")); evs[0].position != pos {
		t.Fatalf("expected live event at %d, got %+v", pos, evs)
	}
}

func TestStreamByteCounters(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.ack(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne"))

	s := h.stream(admin, 0)
	var evs []event
	for len(evs) < 3 {
		evs = append(evs, events(s.nextTagged("events"))...)
	}
	var eventBytes int64
	for _, e := range evs {
		eventBytes += int64(len(mpEncode(e.data)))
	}

	blob := h.snapshot(admin, "patron.p1")
	var stateBytes int64
	for _, k := range blob.keys {
		stateBytes += int64(len(k)) + int64(len(blob.raw[k]))
	}
	if blob.streams["patron.p1"] != 3 || len(blob.streams) != 1 {
		t.Fatalf("streams in header: %v", blob.streams)
	}
	if asInt(blob.header["event_bytes"]) != eventBytes {
		t.Fatalf("event_bytes %v, expected %d", blob.header["event_bytes"], eventBytes)
	}
	if asInt(blob.header["state_bytes"]) != stateBytes || stateBytes == 0 {
		t.Fatalf("state_bytes %v, expected %d", blob.header["state_bytes"], stateBytes)
	}

	// family blobs carry no per-stream counters
	if _, ok := h.snapshot(admin, "patron.*").header["state_bytes"]; ok {
		t.Fatalf("family blob should not carry stream counters")
	}

	// death zeroes state and still counts its own event bytes
	h.ack(admin, cmd("c3", "remove-patron", "id", "p1"))
	dead := h.snapshot(admin, "patron.p1")
	if asInt(dead.header["state_bytes"]) != 0 || asInt(dead.header["event_bytes"]) <= eventBytes {
		t.Fatalf("after death: %v", dead.header)
	}
}

func TestExpectAndConflict(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann")) // seq 1, 2

	// expectations are the stream's seq: exact, so a met one passes and
	// the same one then conflicts, reporting the actual seq
	o := h.expecting(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne"), map[string]any{"patron.p1": 2})
	if o.kind != "ack" {
		t.Fatalf("matching expect: %+v", o)
	}
	o = h.expecting(admin, cmd("c3", "rename-patron", "id", "p1", "name", "Annie"), map[string]any{"patron.p1": 2})
	if o.kind != "conflict" || o.current["patron.p1"] != 3 {
		t.Fatalf("stale expect: %+v", o)
	}
	// a conflicting command never entered the log
	if got := h.snapshot(admin, "patron.p1").records["patron.p1/patron"].(map[string]any)["name"]; got != "Anne" {
		t.Fatalf("conflict should not fold: %v", got)
	}

	// 0 asserts a stream was never born
	o = h.expecting(admin, cmd("c4", "add-book", "id", "b1", "title", "Dune"), map[string]any{"book": 0})
	if o.kind != "ack" {
		t.Fatalf("expect 0 on unborn stream: %+v", o)
	}
	o = h.expecting(admin, cmd("c5", "add-patron", "id", "p2", "name", "Bob"), map[string]any{"patron.p2": 1})
	if o.kind != "conflict" || o.current["patron.p2"] != 0 {
		t.Fatalf("expect on unborn stream reports 0: %+v", o)
	}

	// several expectations: only the mismatches are reported
	o = h.expecting(admin, cmd("c6", "rename-patron", "id", "p1", "name", "x"), map[string]any{"patron.p1": 3, "book": 5})
	if o.kind != "conflict" || len(o.current) != 1 || o.current["book"] != 2 {
		t.Fatalf("mixed expect: %+v", o)
	}

	// the snapshot's seq is the token to expect for a stream with nothing
	// after the cut
	seq := h.snapshot(admin, "book").streams["book"]
	o = h.expecting(admin, cmd("c6b", "add-book", "id", "b1", "title", "Dune"), map[string]any{"book": seq})
	if o.kind != "reject" || o.reason != "book exists" { // precommit's rejection: it got past expect
		t.Fatalf("snapshot seq as expectation: %+v", o)
	}

	// dedup wins over a stale expectation
	o = h.expecting(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne"), map[string]any{"patron.p1": 0})
	if o.kind != "dup" {
		t.Fatalf("resubmit with stale expect: %+v", o)
	}

	// a hashed command keeps its expectation through intake
	o = h.expecting("", cmd("c7", "create-account", "user", "p1", "password", "pw"), map[string]any{"account.p1": 1})
	if o.kind != "conflict" || o.current["account.p1"] != 0 {
		t.Fatalf("expect survives hash intake: %+v", o)
	}
	o = h.expecting("", cmd("c8", "create-account", "user", "p1", "password", "pw"), map[string]any{"account.p1": 0})
	if o.kind != "ack" {
		t.Fatalf("hashed command with matching expect: %+v", o)
	}
}

// eventsRange reads one page of /events and returns its events and the
// scanned header.
func (h *harness) eventsRange(token, stream string, after, before int64, reverse bool, max int) ([]event, int64, int) {
	h.t.Helper()
	q := "/events/" + stream + "?"
	if after >= 0 {
		q += fmt.Sprintf("&after=%d", after)
	}
	if before >= 0 {
		q += fmt.Sprintf("&before=%d", before)
	}
	if reverse {
		q += "&reverse=true"
	}
	if max > 0 {
		q += fmt.Sprintf("&max=%d", max)
	}
	status, hdr, out := h.do("GET", q, token, nil)
	if status != 200 {
		return nil, 0, status
	}
	var evs []event
	dec := newMpDecoder(bytes.NewReader(out))
	for {
		f, err := dec.Decode()
		if err == io.EOF {
			break
		}
		if err != nil {
			h.t.Fatalf("decode events: %v", err)
		}
		evs = append(evs, events(f.([]any))...)
	}
	scanned, err := strconv.ParseInt(hdr.Get("PhaseLock-Scanned"), 10, 64)
	if err != nil {
		h.t.Fatalf("scanned header: %q", hdr.Get("PhaseLock-Scanned"))
	}
	return evs, scanned, status
}

func TestEventsRange(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann")) // 1, 2
	h.ack(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob")) // 3, 4
	for i := 0; i < 5; i++ {
		h.ack(admin, cmd(fmt.Sprintf("r%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i))) // 5..9
	}
	last := h.ack(admin, cmd("c3", "rename-patron", "id", "p2", "name", "Robert")) // 10
	head := last + 1                                                               // a position the client does not have yet

	// forward: only p1's events, ascending, range exhausted in one page
	evs, scanned, _ := h.eventsRange(admin, "patron.p1", 0, head, false, 0)
	if len(evs) != 7 || evs[0].position != 1 || evs[6].position != 9 || scanned != head {
		t.Fatalf("forward: %d events, scanned %d", len(evs), scanned)
	}
	for i := 1; i < len(evs); i++ {
		if evs[i].stream != "patron.p1" || evs[i].seq != evs[i-1].seq+1 {
			t.Fatalf("forward order/seq: %+v", evs)
		}
	}

	// both bounds are exclusive: positions the client holds
	evs, _, _ = h.eventsRange(admin, "patron.p1", 2, 6, false, 0)
	if len(evs) != 1 || evs[0].position != 5 {
		t.Fatalf("bounds: %+v", evs)
	}

	// reverse: descending, scanned is the next before
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 0, head, true, 0)
	if len(evs) != 7 || evs[0].position != 9 || evs[6].position != 1 || scanned != 0 {
		t.Fatalf("reverse: %+v scanned %d", evs, scanned)
	}

	// paging with max: the scanned value plugs straight into the next
	// request, in both directions, with no arithmetic
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 0, head, false, 3)
	if len(evs) != 3 || evs[2].position != 5 || scanned != 5 {
		t.Fatalf("forward page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", scanned, head, false, 3)
	if len(evs) != 3 || evs[0].position != 6 || evs[2].position != 8 || scanned != 8 {
		t.Fatalf("forward page 2: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", scanned, head, false, 3)
	if len(evs) != 1 || evs[0].position != 9 || scanned != head {
		t.Fatalf("forward page 3: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 0, head, true, 3)
	if len(evs) != 3 || evs[2].position != 7 || scanned != 7 {
		t.Fatalf("reverse page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 0, scanned, true, 3)
	if len(evs) != 3 || evs[0].position != 6 || evs[2].position != 2 || scanned != 2 {
		t.Fatalf("reverse page 2: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 0, scanned, true, 3)
	if len(evs) != 1 || evs[0].position != 1 || scanned != 0 {
		t.Fatalf("reverse page 3: %+v scanned %d", evs, scanned)
	}

	// the stream must be visible to the principal
	if _, _, status := h.eventsRange(h.token("p1"), "patron.p2", 0, head, false, 0); status != 403 {
		t.Fatalf("invisible stream: status %d", status)
	}
	if _, _, status := h.eventsRange(h.token("p1"), "patron.p1", 0, head, false, 0); status != 200 {
		t.Fatalf("own stream: status %d", status)
	}

	// both bounds are optional: the start of the log and the head.  At the
	// head, scanned is the last position delivered, or after if nothing was
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", -1, -1, false, 0)
	if len(evs) != 7 || evs[0].position != 1 || evs[6].position != 9 || scanned != 9 {
		t.Fatalf("unbounded forward: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", 9, -1, false, 0)
	if len(evs) != 0 || scanned != 9 {
		t.Fatalf("empty at head: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", -1, -1, true, 0)
	if len(evs) != 7 || evs[0].position != 9 || scanned != 0 {
		t.Fatalf("unbounded reverse: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.p1", -1, 6, false, 0)
	if len(evs) != 3 || evs[2].position != 5 || scanned != 6 {
		t.Fatalf("no after: %+v scanned %d", evs, scanned)
	}

	// a family ref interleaves its streams in position order
	evs, scanned, _ = h.eventsRange(admin, "patron.*", 0, head, true, 4)
	if len(evs) != 4 || evs[0].position != 10 || evs[1].position != 9 || evs[3].position != 7 || scanned != 7 {
		t.Fatalf("family reverse page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron.*", 0, scanned, true, 0)
	if len(evs) != 6 || evs[0].position != 6 || evs[5].position != 1 || scanned != 0 {
		t.Fatalf("family reverse page 2: %+v scanned %d", evs, scanned)
	}
	evs, _, _ = h.eventsRange(admin, "patron.*", 2, 5, false, 0)
	if len(evs) != 2 || evs[0].position != 3 || evs[1].position != 4 || evs[0].stream != "patron.p2" {
		t.Fatalf("family bounds: %+v", evs)
	}

	// "*" is every stream; only a view granting "*" covers it, and a
	// ref must be well formed
	evs, _, _ = h.eventsRange(admin, "*", 0, head, false, 0)
	if len(evs) != 10 || evs[0].position != 1 || evs[9].position != 10 {
		t.Fatalf("everything: %d events", len(evs))
	}
	if _, _, status := h.eventsRange(h.token("p1"), "*", 0, head, false, 0); status != 403 {
		t.Fatalf("everything for p1: status %d", status)
	}
	if _, _, status := h.eventsRange(h.token("p1"), "patron.*", 0, head, false, 0); status != 403 {
		t.Fatalf("family for p1: status %d", status)
	}
	for _, bad := range []string{"", "patron.", "patron.p1/", "patron*", "pat*ron", "*.patron"} {
		if _, _, status := h.eventsRange(admin, bad, 0, head, false, 0); status != 400 {
			t.Fatalf("ref %q: status %d", bad, status)
		}
	}
}

// the command check //////////////////////////////////////////////////////////

func TestCommandCheck(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// each malformed command is rejected where it stands, naming the problem,
	// and the well-formed ones around it are acked
	outs := h.commands(admin,
		cmd("c1", "add-book", "id", "b1", "title", "Dune"),
		cmd("c2", "add-book", "id", "b2"),
		cmd("c3", "add-book", "id", 7, "title", "Emma"),
		cmd("c4", "add-book", "id", "b4", "title", "Emma", "extra", true),
		cmd("c5", "no-such-command", "id", "x"),
		cmd("c6", "add-book", "id", "b6", "title", "Persuasion"),
	)
	kinds := []string{"ack", "reject", "reject", "reject", "reject", "ack"}
	for i, k := range kinds {
		if outs[i].kind != k {
			t.Fatalf("outcome %d: %+v, want %s", i, outs[i], k)
		}
	}
	for i, needle := range map[int]string{
		1: "$.title: missing required field",
		2: "$.id: expected a string",
		3: "$.extra: unknown field",
		4: "no-such-command",
	} {
		if !strings.Contains(outs[i].reason, needle) {
			t.Fatalf("outcome %d: %q should mention %q", i, outs[i].reason, needle)
		}
	}
	if outs[5].position <= outs[0].position {
		t.Fatalf("acks around the rejects: %+v", outs)
	}

	// a malformed command never reached dedup: its id is free for a good one
	if o := h.commands(admin, cmd("c2", "add-book", "id", "b2", "title", "Mansfield Park"))[0]; o.kind != "ack" {
		t.Fatalf("id of a rejected command reused: %+v", o)
	}

	// the discriminator may sit anywhere in the map, and the log has it first
	body := rawCommand("c7", "id", "b7", "title", "Emma", "type", "add-book")
	if status, _, out := h.do("POST", "/commands", admin, body); status != 200 || decodeOutcomes(t, out)[0].kind != "ack" {
		t.Fatalf("discriminator last: %d %s", status, out)
	}
	_, _, logged := h.do("GET", "/events/book", admin, nil)
	written := append(mpMapHeader(nil, 3), mpEncode("type")...)
	written = append(append(written, mpEncode("add-book")...), mpEncode("id")...)
	if !bytes.Contains(logged, append(written, mpEncode("b7")...)) {
		t.Fatalf("the logged event does not lead with its discriminator: %x", logged)
	}

	// an empty body is fine; a body that is not msgpack is a 400
	if status, _, _ := h.do("POST", "/commands", admin, []byte{}); status != 200 {
		t.Fatalf("empty body: %d", status)
	}
	if status, _, _ := h.do("POST", "/commands", admin, []byte{0xc1}); status != 400 {
		t.Fatalf("not msgpack: %d", status)
	}
	// a command that is not [id, data] is a 400 too, since nothing can be answered for it
	if status, _, _ := h.do("POST", "/commands", admin, mpEncode("just a string")); status != 400 {
		t.Fatalf("not a command pair: %d", status)
	}
}

func TestTypedValues(t *testing.T) {
	h := start(t)
	admin := h.admin()
	added := time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC)

	// a date field travels as a timestamp: into the log, through the reducer, out of the store
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune", "added", added))
	s := h.stream(admin, 0)
	evs := events(s.nextTagged("events"))
	if got, ok := evs[1].data["added"].(time.Time); !ok || !got.Equal(added) {
		t.Fatalf("event date: %v", evs[1].data["added"])
	}
	book := h.snapshot(admin, "book").records["book/book.b1"].(map[string]any)
	if got, ok := book["added"].(time.Time); !ok || !got.Equal(added) {
		t.Fatalf("stored date: %v", book["added"])
	}
	// the stored value is the schema's shape: declaration order, nothing foreign
	keys := make([]string, 0, len(book))
	for k := range book {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "added,id,title" {
		t.Fatalf("stored keys: %v", keys)
	}

	// a date given as a string is rejected before anything runs
	o := h.commands(admin, cmd("c2", "add-book", "id", "b2", "title", "Emma", "added", "2026-01-02T03:04:05Z"))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.added: expected a timestamp") {
		t.Fatalf("string date: %+v", o)
	}

	// an optional field left out stays out
	h.ack(admin, cmd("c3", "add-book", "id", "b3", "title", "Emma"))
	if _, ok := h.snapshot(admin, "book").records["book/book.b3"].(map[string]any)["added"]; ok {
		t.Fatalf("absent optional field written")
	}
}

func TestPreparedFields(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "ann", "name", "Ann"))

	// a NewPassword is replaced by its argon2id hash before precommit sees it
	h.ack("", cmd("c2", "create-account", "user", "ann", "password", "hunter2"))
	acct := h.snapshot(admin, "account.ann").records["account.ann/account"].(map[string]any)
	hash := acct["hash"].(string)
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("expected an argon2id hash, got %q", hash)
	}
	// and the check saw the wire type: a password that is not a string is rejected
	o := h.commands("", cmd("c3", "create-account", "user", "bob", "password", 42))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.password: expected a string") {
		t.Fatalf("non-string password: %+v", o)
	}

	// a kind the database recognizes but cannot verify yet rejects the command
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "ann", "password": "hunter2",
	}))
	if status != 200 {
		t.Fatalf("login: %d %s", status, out)
	}
	tok := mpDecodeOne(t, out).(map[string]any)["token"].(string)
	o = h.commands(tok, cmd("c4", "authenticated-command", "user", "ann", "check", map[string]any{"kind": "password", "password": "hunter2"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "CommandAuth") {
		t.Fatalf("unverifiable kind: %+v", o)
	}
	// its wire shape is still checked first
	o = h.commands(tok, cmd("c5", "authenticated-command", "user", "ann", "check", map[string]any{"kind": "carrier-pigeon"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.check") {
		t.Fatalf("malformed proof: %+v", o)
	}
}

func TestUnknownIntakeKindRefusesToStart(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "bundle.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(src, []byte(`"NewPassword"`)) {
		t.Fatalf("the test bundle should name NewPassword in its schema")
	}
	dir := t.TempDir()
	bundle := filepath.Join(dir, "bundle.js")
	if err := os.WriteFile(bundle, bytes.ReplaceAll(src, []byte(`"NewPassword"`), []byte(`"NewThing"`)), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = Open(t.Context(), Options{DataDir: filepath.Join(dir, "data"), Bundle: bundle, Secret: []byte("s")})
	if err == nil || !strings.Contains(err.Error(), "NewThing") {
		t.Fatalf("expected a refusal naming the kind, got %v", err)
	}
}

// raw is msgpack bytes spliced as they are into a command built by rawCommand.
type raw []byte

// rawCommand encodes one [id, data] command whose data map holds the fields in order, raw
// values spliced in as they are.
func rawCommand(id string, kv ...any) []byte {
	b := mpArrayHeader(nil, 2)
	b = mpAppendStr(b, id)
	b = mpMapHeader(b, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		b = mpAppendStr(b, kv[i].(string))
		if r, ok := kv[i+1].(raw); ok {
			b = append(b, r...)
		} else {
			b = mpAppend(b, kv[i+1])
		}
	}
	return b
}

func TestCheckEdges(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a date in each of the timestamp's three sizes survives the log, the reducer, and the store
	whole := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	old := time.Date(1960, 6, 7, 8, 9, 10, 123e6, time.UTC)
	h.ack(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune", "added", whole))
	h.ack(admin, cmd("c2", "add-book", "id", "b2", "title", "Emma", "added", old))
	records := h.snapshot(admin, "book").records
	for key, want := range map[string]time.Time{"book/book.b1": whole, "book/book.b2": old} {
		if got, ok := records[key].(map[string]any)["added"].(time.Time); !ok || !got.Equal(want) {
			t.Fatalf("%s: stored date %v, want %v", key, records[key], want)
		}
	}

	// values no type accepts are rejected by name, each in its own command of one request, and
	// the commands after each still check and ack
	badStamp := raw{0xc7, 5, 0xff, 0, 0, 0, 0, 0} // a timestamp extension of no valid size
	badNanos := raw{0xd7, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0}
	otherExt := raw{0xd6, 5, 0, 0, 0, 0}
	bin := raw{0xc4, 2, 'h', 'i'}
	bigUint := raw{0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	intKey := raw{0x81, 0x01, 0xa1, 'x'}
	var body []byte
	body = append(body, rawCommand("d1", "type", "add-book", "id", "b3", "title", "T", "added", badStamp)...)
	body = append(body, rawCommand("d2", "type", "add-book", "id", "b4", "title", "T", "added", badNanos)...)
	body = append(body, rawCommand("d3", "type", "add-book", "id", "b5", "title", "T", "added", otherExt)...)
	body = append(body, rawCommand("d4", "type", "add-book", "id", "b6", "title", bin)...)
	body = append(body, rawCommand("d5", "type", "add-book", "id", bigUint, "title", "T")...)
	body = append(body, rawCommand("d6", "type", "add-book", "id", "b8", "title", "T", "added", intKey)...)
	body = append(body, rawCommand("d7", "type", "add-book", "id", "b9", "title", "T")...)
	status, _, out := h.do("POST", "/commands", admin, body)
	if status != 200 {
		t.Fatalf("commands: %d %s", status, out)
	}
	outs := decodeOutcomes(t, out)
	for i, want := range []string{
		"$.added: malformed timestamp",
		"$.added: malformed timestamp",
		"$.added: expected a timestamp, not an extension other than a timestamp",
		"$.title: expected a string, not a bin value",
		"$.id: expected a string, not an integer past int64",
		"$.added: expected a timestamp, not an object",
	} {
		if outs[i].kind != "reject" || outs[i].reason != want {
			t.Fatalf("outcome %d: %+v, want reject %q", i, outs[i], want)
		}
	}
	if outs[6].kind != "ack" {
		t.Fatalf("the command after the rejects: %+v", outs[6])
	}

	// a map key that is not a string, where the walk reads keys
	body = mpArrayHeader(nil, 2)
	body = mpAppendStr(body, "e1")
	body = append(body, 0x84)
	body = append(mpAppendStr(body, "type"), mpAppendStr(nil, "add-book")...)
	body = append(mpAppendStr(body, "id"), mpAppendStr(nil, "b10")...)
	body = append(mpAppendStr(body, "title"), mpAppendStr(nil, "T")...)
	body = append(body, 0x07, 0xc0)
	if o := h.commandsRaw(admin, body)[0]; o.kind != "reject" || o.reason != "$: a map key is not a string" {
		t.Fatalf("non-string key: %+v", o)
	}

	// elements a later protocol appends to a command are ignored
	body = mpEncode([]any{"e2", map[string]any{"type": "add-book", "id": "b11", "title": "T"}, map[string]any{}, "newer"})
	if o := h.commandsRaw(admin, body)[0]; o.kind != "ack" {
		t.Fatalf("a command with an appended element: %+v", o)
	}
}

// commandsRaw posts a request body as it is and returns the outcomes.
func (h *harness) commandsRaw(token string, body []byte) []outcome {
	h.t.Helper()
	status, _, out := h.do("POST", "/commands", token, body)
	if status != 200 {
		h.t.Fatalf("commands: status %d: %s", status, out)
	}
	return decodeOutcomes(h.t, out)
}

// password hashing ///////////////////////////////////////////////////////////

func login(h *harness, identity, password string) int {
	h.t.Helper()
	status, _, _ := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": identity, "password": password,
	}))
	return status
}

func TestLoginAttemptsAreRateLimitedPerClient(t *testing.T) {
	h := startWith(t, t.Context(), Options{AuthBurst: 3, AuthRate: 0.001})
	admin := h.admin()
	h.ack(admin, cmd("c1", "create-account", "user", "ann", "password", "hunter2"))

	// the account's creation hashed once, so two attempts remain, right or wrong
	if status := login(h, "ann", "wrong"); status != 401 {
		t.Fatalf("a wrong password: %d", status)
	}
	if status := login(h, "ann", "hunter2"); status != 200 {
		t.Fatalf("the right password: %d", status)
	}
	if status := login(h, "ann", "hunter2"); status != 429 {
		t.Fatalf("an attempt past the budget: %d, want 429", status)
	}
}

func TestLoginForAnUnknownAccountCostsAHash(t *testing.T) {
	h := startWith(t, t.Context(), Options{AuthBurst: 1, AuthRate: 0.001})

	// it verifies against a dummy hash, so it spends the budget like a wrong password
	if status := login(h, "nobody", "x"); status != 401 {
		t.Fatalf("an unknown account: %d", status)
	}
	if status := login(h, "nobody", "x"); status != 429 {
		t.Fatalf("an unknown account past the budget: %d, want 429", status)
	}
}

func TestIntakeHashingIsRateLimitedPerClient(t *testing.T) {
	h := startWith(t, t.Context(), Options{AuthBurst: 1, AuthRate: 0.001})
	h.ack("", cmd("c1", "create-account", "user", "ann", "password", "hunter2"))

	// a request whose hash finds the budget spent is refused whole, so it can be retried later
	// under the same ids
	status, _ := h.commandsStatus("", cmd("c2", "create-account", "user", "bob", "password", "pw"))
	if status != 429 {
		t.Fatalf("a hash past the budget: %d, want 429", status)
	}

	// commands that hash nothing are not limited
	if o := h.commands(h.admin(), cmd("c3", "add-book", "id", "b1", "title", "Dune"))[0]; o.kind != "ack" {
		t.Fatalf("a command with no password: %+v", o)
	}
}

// shutdown ///////////////////////////////////////////////////////////////////

func TestShutdownEndsOpenStreams(t *testing.T) {
	ctx, stop := context.WithCancel(t.Context())
	h := startWith(t, ctx, Options{})
	s := h.stream(h.admin(), -1)
	s.live()

	// the server's context ends, and so does every request under it, at once
	stop()
	select {
	case <-s.errs:
	case <-time.After(2 * time.Second):
		t.Fatalf("an open stream outlived the server's context")
	}

	// the server then closes cleanly
	h.stop()
}

// sign-in and bootstrap //////////////////////////////////////////////////////

func devSignIn(h *harness, body map[string]any) (int, map[string]any) {
	h.t.Helper()
	body["kind"] = "dev"
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(body))
	if status != 200 {
		return status, nil
	}
	return status, mpDecodeOne(h.t, out).(map[string]any)
}

func TestDevSignInIsAnExistingAccount(t *testing.T) {
	h := start(t)

	// a name with no account is refused
	if status, _ := devSignIn(h, map[string]any{"identity": "nobody"}); status != 401 {
		t.Fatalf("dev sign-in with no account: %d", status)
	}

	// the traits are the account's, whatever the request says
	_, reply := devSignIn(h, map[string]any{"identity": "p1", "traits": []any{"admin"}})
	if traits := reply["traits"].([]any); len(traits) != 0 {
		t.Fatalf("dev sign-in took its traits from the request: %v", traits)
	}
	_, reply = devSignIn(h, map[string]any{"identity": "root"})
	if strs(reply["traits"])[0] != "admin" {
		t.Fatalf("root's traits: %v", reply["traits"])
	}
}

func TestATokenForNoAccountIsRefusedEverywhere(t *testing.T) {
	h := start(t)
	ghost, _ := h.srv.mint("ghost", []string{"admin"}, 0)

	if status, _ := h.commandsStatus(ghost, cmd("c1", "add-book", "id", "b1", "title", "Dune")); status != 401 {
		t.Fatalf("commands: %d", status)
	}
	req, _ := http.NewRequest("GET", h.web.URL+"/stream?since=-1", nil)
	req.Header.Set("Authorization", "Bearer "+ghost)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("stream: %d", resp.StatusCode)
	}
	if status, _, _ := h.do("POST", "/auth/token", ghost, mpEncode(map[string]any{"kind": "refresh"})); status != 401 {
		t.Fatalf("refresh: %d", status)
	}
}

func TestBootstrapSeedsAnEmptyLog(t *testing.T) {
	t.Setenv("BOOTSTRAP_ADMIN", "boss")
	t.Setenv("BOOTSTRAP_PASSWORD", "pw")
	dir := t.TempDir()
	env := []string{"BOOTSTRAP_ADMIN", "BOOTSTRAP_PASSWORD"}
	h := startWith(t, t.Context(), Options{DataDir: dir, BootstrapEnv: env})

	// one atom, under bootstrap's command id: the stream's birth and the account's creation
	s := h.stream(h.admin(), 0)
	evs := events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].data["$sys"] != "birth" || evs[1].data["type"] != "account-created" {
		t.Fatalf("bootstrap's atom: %+v", evs)
	}
	for _, e := range evs {
		if e.stream != "account.boss" || e.commandid != "bootstrap" {
			t.Fatalf("bootstrap's event: %+v", e)
		}
	}
	if hash := evs[1].data["hash"].(string); !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("bootstrap's hash: %q", hash)
	}

	// the seeded admin signs in with the password, and its traits ride the account
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "boss", "password": "pw",
	}))
	if status != 200 || strs(mpDecodeOne(t, out).(map[string]any)["traits"])[0] != "admin" {
		t.Fatalf("seeded admin sign-in: %d %s", status, out)
	}

	// a log that is not empty is not seeded again
	h.stop()
	h = startWith(t, t.Context(), Options{DataDir: dir, BootstrapEnv: env})
	if next := h.ack(h.admin(), cmd("c1", "add-book", "id", "b1", "title", "Dune")); next != 4 {
		t.Fatalf("after a restart, the next atom lands at %d, want 4: bootstrap ran again", next)
	}
}

func TestBootstrapReadsOnlyTheEnvironmentItIsGiven(t *testing.T) {
	t.Setenv("BOOTSTRAP_ADMIN", "boss")
	t.Setenv("BOOTSTRAP_PASSWORD", "pw")
	h := start(t)
	if status := login(h, "boss", "pw"); status != 401 {
		t.Fatalf("an admin seeded from variables nobody named: %d", status)
	}
}

func TestABootstrapThatFailsStopsTheOpen(t *testing.T) {
	t.Setenv("BOOTSTRAP_ADMIN", "bad/name")
	_, err := Open(t.Context(), Options{
		DataDir:      t.TempDir(),
		Bundle:       filepath.Join("testdata", "bundle.js"),
		Secret:       []byte("s"),
		BootstrapEnv: []string{"BOOTSTRAP_ADMIN"},
	})
	if err == nil || !strings.Contains(err.Error(), "bootstrap") {
		t.Fatalf("a bootstrap emitting to a malformed stream: %v", err)
	}
}

func TestValidRef(t *testing.T) {
	for ref, want := range map[string]bool{
		"*":                 true,
		"book":              true,
		"patron.p1":         true,
		"patron.*":          true,
		"chat.acme.*":       true,
		"chat.acme.gen.e~1": true,
		"patron.p1.":        true,
		"":                  false,
		".*":                false,
		"*.*":               false,
		"patron.":           false,
		"patron..*":         false,
		"pa~tron.p1":        false,
		"pa.tron":           true,
		"patron.p/1":        false,
		"patron.p*":         false,
		"patron.p 1":        false,
		"patron.p%2F1":      false,
	} {
		if got := validRef(ref); got != want {
			t.Errorf("validRef(%q) = %v, want %v", ref, got, want)
		}
	}
}

func TestStreamNamesFillTheirTemplates(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a family template's terminal parameter may hold . and ~
	h.ack(admin, cmd("c1", "add-patron", "id", "p.1~x", "name", "Ann"))
	if _, ok := h.snapshot(admin, "patron.p.1~x").records["patron.p.1~x/patron"]; !ok {
		t.Fatalf("patron.p.1~x was not written")
	}

	// a precommit reading through a parameter that no stream name could hold is rejected before
	// it labels anything
	outs := h.commands(admin,
		cmd("c2", "add-patron", "id", "p/1", "name", "Bob"),
		cmd("c3", "add-patron", "id", "", "name", "Cy"),
	)
	for i, id := range []string{"p/1", ""} {
		if outs[i].kind != "reject" || !strings.Contains(outs[i].reason, fmt.Sprintf("patron: patron %q", id)) {
			t.Fatalf("add-patron %q: %+v", id, outs[i])
		}
	}

	// a dev bundle's error carries its stack, mapped through the bundle's source map
	if !strings.Contains(outs[0].reason, "(db.ts:") || strings.Contains(outs[0].reason, "bundle.js:") {
		t.Fatalf("an unmapped stack: %s", outs[0].reason)
	}
}

func TestAProductionBundleAnswersBugsWithInternalError(t *testing.T) {
	h := startWith(t, t.Context(), Options{Bundle: filepath.Join("testdata", "bundle.prod.js")})
	admin := h.admin()
	if outs := h.commands(admin, cmd("c1", "add-patron", "id", "p/1", "name", "Bob")); outs[0].reason != "internal error" {
		t.Fatalf("a bug in a production bundle: %+v", outs[0])
	}

	// a rejection's reason is still the app's own
	h.ack(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	if outs := h.commands(admin, cmd("c3", "add-patron", "id", "p1", "name", "Ann")); outs[0].reason != "patron exists" {
		t.Fatalf("a rejection in a production bundle: %+v", outs[0])
	}
}

func TestAFailingMaySeeGrantsNothing(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.ack(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.ack(admin, cmd("c2", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")
	s := h.stream(ann, -1)
	s.live()

	// a granted wildcard that cuts into a stream's terminal parameter ends the connection
	h.ack(admin, cmd("c3", "grant-view", "user", "p1", "prefix", "patron.p1.*"))
	f := s.nextTagged("end")
	if f[1] != "error" || !strings.Contains(f[2].(string), "malformed ref: patron.p1.*") {
		t.Fatalf("end frame: %v", f)
	}
	select {
	case <-s.errs:
	case f := <-s.frames:
		t.Fatalf("a frame after end: %v", f)
	case <-time.After(5 * time.Second):
		t.Fatalf("the connection stayed open after end")
	}

	// and a new connection is refused with the failure
	status, _, body := h.do("GET", "/stream?since=-1", ann, nil)
	if status != 500 || !strings.Contains(string(body), "malformed ref: patron.p1.*") {
		t.Fatalf("a stream under a failing maySee: %d %s", status, body)
	}
}
