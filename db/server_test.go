package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
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
// unless o names another, dev auth, and an attempt budget no test of other features runs out of.
func startWith(t *testing.T, ctx context.Context, o Options) *harness {
	t.Helper()
	if o.DataDir == "" {
		o.DataDir = t.TempDir()
	}
	if o.Bundle == "" {
		o.Bundle = filepath.Join("testdata", "bundle.js")
	}
	o.DevAuth = true
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

// command is one command to post: unnumbered unless in names its series and number.
type command struct {
	id     string
	series string
	n      int64
	data   map[string]any
}

func cmd(id, typ string, kv ...any) command {
	data := map[string]any{"type": typ}
	for i := 0; i+1 < len(kv); i += 2 {
		data[kv[i].(string)] = kv[i+1]
	}
	return command{id: id, data: data}
}

// in sends the command as number n of a series.
func (c command) in(series string, n int64) command {
	c.series = series
	c.n = n
	return c
}

// label is a test's command id as the 16 bytes on the wire: its name, padded with zeros.
func label(id string) []byte {
	if len(id) > 16 {
		panic("command id too long: " + id)
	}
	return append([]byte(id), make([]byte, 16-len(id))...)
}

// encode is the command as the wire carries it, with expect when it is not nil.
func (c command) encode(expect map[string]any) []byte {
	var series, n any
	if c.series != "" {
		series, n = c.series, c.n
	}
	v := []any{series, n, label(c.id), c.data}
	if expect != nil {
		v = append(v, expect)
	}
	return mpEncode(v)
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
		body = append(body, c.encode(nil)...)
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
		case "ok":
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
	body := c.encode(expect)
	status, _, out := h.do("POST", "/commands", token, body)
	if status != 200 {
		h.t.Fatalf("commands: status %d", status)
	}
	return decodeOutcomes(h.t, out)[0]
}

// accept posts one command that must be accepted, and returns its position.
func (h *harness) accept(token string, c command) int64 {
	h.t.Helper()
	outs := h.commands(token, c)
	if outs[0].kind != "ok" {
		h.t.Fatalf("expected ok for %s, got %+v", c.id, outs[0])
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
	id         []byte // the command id as it arrived
	commandid  string // the id as a test names it: its bytes without label's zeros
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
			id:         env[3].([]byte),
			commandid:  strings.TrimRight(string(env[3].([]byte)), "\x00"),
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

func TestCommandsOkReject(t *testing.T) {
	h := start(t)
	admin := h.admin()

	outs := h.commands(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < 1 {
		t.Fatalf("expected ok, got %+v", outs[0])
	}
	first := outs[0].position

	// a resend is decided already, at or before the position it is answered with
	outs = h.commands(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < first {
		t.Fatalf("expected ok at %d or later, got %+v", first, outs[0])
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
	if outs[2].kind != "ok" || outs[2].position <= first {
		t.Fatalf("expected ok after rejects, got %+v", outs[2])
	}

	// anonymous is a principal; the bundle says it may not add books
	outs = h.commands("", cmd("c5", "add-book", "id", "b3", "title", "Nope"))
	if outs[0].kind != "reject" || outs[0].reason != "unauthorized" {
		t.Fatalf("expected unauthorized, got %+v", outs[0])
	}
}

func TestSeriesDedup(t *testing.T) {
	h := start(t)
	admin := h.admin()
	dune := func(id string) command { return cmd(id, "add-book", "id", "b1", "title", "Dune") }

	// two copies of one (S, n) in one group: the first runs, and the second sees its decision,
	// where running it again would have been rejected
	outs := h.commands(admin, dune("c1").in("s1", 1), dune("c1").in("s1", 1))
	if outs[0].kind != "ok" || outs[1].kind != "ok" || outs[1].position != outs[0].position {
		t.Fatalf("copies in one group: %+v", outs)
	}

	// a reject is a decision: its resend is decided already, and its reason is gone
	if o := h.commands(admin, dune("c2").in("s1", 2))[0]; o.kind != "reject" || o.reason != "book exists" {
		t.Fatalf("first reply of a reject: %+v", o)
	}
	if o := h.commands(admin, dune("c2").in("s1", 2))[0]; o.kind != "ok" {
		t.Fatalf("resent reject: %+v", o)
	}

	// so is a conflict, and an atom a reducer's failure rolled back
	emma := cmd("c3", "add-book", "id", "b3", "title", "Emma").in("s1", 3)
	if o := h.expecting(admin, emma, map[string]any{"book": 0}); o.kind != "conflict" {
		t.Fatalf("first reply of a conflict: %+v", o)
	}
	if o := h.commands(admin, emma)[0]; o.kind != "ok" {
		t.Fatalf("resent conflict: %+v", o)
	}
	nul := cmd("c4", "add-book", "id", "b1\x00x", "title", "Emma").in("s1", 4)
	if o := h.commands(admin, nul)[0]; o.kind != "reject" || !strings.Contains(o.reason, "holds U+0000") {
		t.Fatalf("first reply of a rolled-back atom: %+v", o)
	}
	if o := h.commands(admin, nul)[0]; o.kind != "ok" {
		t.Fatalf("resent rolled-back atom: %+v", o)
	}

	// numbers may skip, and a number at or below the mark is decided already, run or not
	head := h.accept(admin, cmd("c5", "add-book", "id", "b5", "title", "Persuasion").in("s1", 10))
	if o := h.commands(admin, cmd("c6", "add-book", "id", "b6", "title", "Sanditon").in("s1", 7))[0]; o.kind != "ok" || o.position != head {
		t.Fatalf("a number below the mark: %+v", o)
	}

	// none of the resends reached the log: the book stream holds b1 and b5 alone
	evs, _, _ := h.eventsRange(admin, "book", -1, -1, false, 100)
	if len(evs) != 3 || evs[1].data["id"] != "b1" || evs[2].data["id"] != "b5" {
		t.Fatalf("the book stream: %+v", evs)
	}

	// an unknown series runs from whatever number it starts at, and the numbers below it are
	// then decided already
	h.accept(admin, cmd("c7", "add-book", "id", "b7", "title", "Emma").in("s2", 5))
	if o := h.commands(admin, cmd("c8", "add-book", "id", "b8", "title", "Sanditon").in("s2", 1))[0]; o.kind != "ok" {
		t.Fatalf("a number below an unknown series' first: %+v", o)
	}
	if o := h.commands(admin, dune("c8").in("s2", 6))[0]; o.kind != "reject" {
		t.Fatalf("the next number of a series that started past 1: %+v", o)
	}

	// an unnumbered command runs every time it is sent
	for range 2 {
		if o := h.commands(admin, dune("c9"))[0]; o.kind != "reject" || o.reason != "book exists" {
			t.Fatalf("an unnumbered command: %+v", o)
		}
	}
}

func TestBootstrapAndLiveAtoms(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))

	s := h.stream(admin, -1)
	if s.header.Get("PhaseLock-Protocol") != "1" || len(s.header.Get("PhaseLock-Epoch")) != 32 {
		t.Fatalf("bad headers: %v", s.header)
	}
	if s.header.Get("PhaseLock-View") == "" || s.header.Get("PhaseLock-Time") == "" {
		t.Fatalf("missing view or time header: %v", s.header)
	}
	live := s.live()

	// a new patron: birth then the event, one atom, one frame
	pos := h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	f := s.nextTagged("events")
	evs := events(f)
	if len(evs) != 2 {
		t.Fatalf("expected birth + event, got %v", evs)
	}
	if evs[0].data["$sys"] != "birth" || evs[0].stream != "patron:p1" {
		t.Fatalf("expected birth on patron:p1, got %+v", evs[0])
	}
	if evs[1].data["type"] != "add-patron" || evs[1].stream != "patron:p1" {
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
	h.accept(admin, cmd("c3", "try-hold", "id", "h1", "book", "b1", "patron", "p1"))
	evs = events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].stream != "book" || evs[1].stream != "patron:p1" {
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
	pos := h.accept(admin, cmd("c0", "add-book", "id", "b0", "title", "Zero"))
	s := h.stream(admin, -1)
	if s.header.Get("PhaseLock-Position") != fmt.Sprint(pos) {
		t.Fatalf("PhaseLock-Position %q, want %d", s.header.Get("PhaseLock-Position"), pos)
	}
	s.nextTagged("live")
	// one POST, two commands, one group commit: two atoms on the wire
	body := append(cmd("c1", "add-patron", "id", "p1", "name", "Ann").encode(nil),
		cmd("c2", "add-patron", "id", "p2", "name", "Bob").encode(nil)...)
	if status, _, _ := h.do("POST", "/commands", admin, body); status != 200 {
		t.Fatalf("commands: status %d", status)
	}
	first := events(s.nextTagged("events"))
	second := events(s.nextTagged("events"))
	if first[0].stream != "patron:p1" || second[0].stream != "patron:p2" {
		t.Fatalf("expected both atoms live: %+v then %+v", first, second)
	}
}

func TestHistoryReplay(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	p2 := h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	p3 := h.accept(admin, cmd("c3", "rename-patron", "id", "p1", "name", "Anne"))

	// from genesis: book birth+add, patron birth+add, rename
	s := h.stream(admin, 0)
	var all []event
	for len(all) < 5 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	want := []string{"book", "book", "patron:p1", "patron:p1", "patron:p1"}
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
	h.accept(admin, cmd("c4", "rename-patron", "id", "p1", "name", "Annie"))
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
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c3", "add-patron", "id", "p2", "name", "Bob"))

	// a patron sees the book shard and its own shard, from history
	ann := h.token("p1")
	s := h.stream(ann, 0)
	var all []event
	for len(all) < 4 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	for _, e := range all {
		if e.stream != "book" && e.stream != "patron:p1" {
			t.Fatalf("leaked event: %+v", e)
		}
	}
	// the replay ended on p2's invisible events, which a vouch covers
	if f := s.next(); f[0] != "vouch" || asInt(f[1]) != 6 {
		t.Fatalf("expected a vouch at 6 past the last frame, got %v", f)
	}
	s.live()
	// other patrons' events are invisible and produce no frame at all
	h.accept(admin, cmd("c4", "rename-patron", "id", "p2", "name", "Robert"))
	s.quiet()
	h.accept(admin, cmd("c5", "rename-patron", "id", "p1", "name", "Anne"))
	evs := events(s.nextTagged("events"))
	if evs[0].stream != "patron:p1" {
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
	h.accept(admin, cmd("c6", "rename-patron", "id", "p1", "name", "Annie"))
	s2.quiet()
	h.accept(admin, cmd("c7", "add-book", "id", "b2", "title", "Emma"))
	evs = events(s2.nextTagged("events"))
	if evs[0].stream != "book" {
		t.Fatalf("expected book event, got %+v", evs)
	}

	// the narrower of a want and a grant is kept, and a want nothing grants
	// vanishes: patron:* against patron:p1 is patron:p1, author:* is nothing
	s4 := h.stream(ann, -1, "patron:*", "author:*")
	if s4.first == nil || strings.Join(strs(s4.first[3]), ",") != "patron:p1" {
		t.Fatalf("intersected view frame: %v", s4.first)
	}
	s4.live()
	s5 := h.stream(admin, -1, "patron:*")
	if s5.first == nil || strings.Join(strs(s5.first[3]), ",") != "patron:*" {
		t.Fatalf("admin view cut down to a family: %v", s5.first)
	}
	s5.live()

	// anonymous sees only the book shard
	s3 := h.stream("", -1)
	s3.live()
	h.accept(admin, cmd("c8", "rename-patron", "id", "p1", "name", "Ann"))
	s3.quiet()
}

func TestMaySeeInvalidation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, cmd("c3", "create-account", "user", "p1", "password", "hunter2"))

	ann := h.token("p1")
	s := h.stream(ann, -1)
	s.live()
	token0 := s.header.Get("PhaseLock-View")
	// two connections of the same principal with narrower wants
	sb := h.stream(ann, -1, "book")
	sb.live()
	sp := h.stream(ann, -1, "patron:*")
	sp.live()

	// granting a view rewrites maySee's read-set key: a view frame arrives,
	// before any events of the same commit, carrying the whole set of refs
	grantPos := h.accept(admin, cmd("c4", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	f := s.nextTagged("view")
	if f[1].(string) == token0 {
		t.Fatalf("token should change on grant")
	}
	// the frame names the commit position the view changed at
	if asInt(f[2]) != grantPos {
		t.Fatalf("view position %v, want %d", f[2], grantPos)
	}
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1,patron:p2" {
		t.Fatalf("grant frame refs: %v", got)
	}
	token1 := f[1].(string)
	// the grant is inside one connection's wants and outside the other's: the
	// first gets its own view, the second's view is as it was, so no frame
	f = sp.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "patron:p1,patron:p2" {
		t.Fatalf("grant frame refs under wants: %v", got)
	}
	sb.quiet()

	// now p2's events flow
	h.accept(admin, cmd("c5", "rename-patron", "id", "p2", "name", "Robert"))
	evs := events(s.nextTagged("events"))
	if evs[0].stream != "patron:p2" {
		t.Fatalf("expected granted stream, got %+v", evs)
	}

	// a connection presenting a stale token gets the view frame first, with
	// the current refs; one presenting the current token goes straight to live
	s2 := h.streamView(ann, -1, token0)
	v := s2.nextTagged("view")
	if v[1].(string) != token1 || fmt.Sprint(asInt(v[2])) != s2.header.Get("PhaseLock-Position") {
		t.Fatalf("first view frame: %v (stream token %v)", v, token1)
	}
	if got := strings.Join(strs(v[3]), ","); got != "book,patron:p1,patron:p2" {
		t.Fatalf("first view refs: %v", got)
	}
	s2.resp.Body.Close()
	s3 := h.streamView(ann, -1, token1)
	if f := s3.next(); f[0] != "live" {
		t.Fatalf("current token: expected live first, got %v", f)
	}
	s3.resp.Body.Close()

	// revocation: a view frame, and the same commit's events are withheld
	h.accept(admin, cmd("c6", "revoke-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1" {
		t.Fatalf("revoke frame refs: %v", got)
	}
	if f[1].(string) != token0 {
		t.Fatalf("token should return to the original after revoke")
	}
	h.accept(admin, cmd("c7", "rename-patron", "id", "p2", "name", "Bob"))
	s.quiet()

	// refs are never expanded: a family grant is one ref, and the client
	// learns the members from the blob
	h.accept(admin, cmd("c8", "add-patron", "id", "p3", "name", "Cy"))
	h.accept(admin, cmd("c9", "grant-view", "user", "p1", "prefix", "patron:*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:*,patron:p1" {
		t.Fatalf("wildcard grant frame refs: %v", got)
	}
	tokenFamily := f[1].(string)
	// every change to the set is sent, even one that leaves coverage as it
	// was: patron:p2 is inside the held patron:*
	h.accept(admin, cmd("c9b", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:*,patron:p1,patron:p2" || f[1].(string) == tokenFamily {
		t.Fatalf("grant inside a held family: %v", f)
	}
	h.accept(admin, cmd("c9c", "revoke-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if f[1].(string) != tokenFamily {
		t.Fatalf("revoke inside a held family: %v", f)
	}
	h.accept(admin, cmd("c10", "add-patron", "id", "p4", "name", "Di"))
	evs = events(s.nextTagged("events"))
	if evs[0].stream != "patron:p4" || evs[0].data["$sys"] != "birth" {
		t.Fatalf("births under a held wildcard arrive in-stream: %+v", evs)
	}
	h.accept(admin, cmd("c11", "revoke-view", "user", "p1", "prefix", "patron:*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1" {
		t.Fatalf("wildcard revoke frame refs: %v", got)
	}
}

func TestAnErasureDeletesTheStreamsHistory(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne"))
	h.accept(admin, cmd("c3", "add-patron", "id", "p2", "name", "Bob"))
	pos := h.accept(admin, cmd("c4", "forget-patron", "id", "p1"))

	// the death is all that remains of the stream, at its seq; the other stream is untouched
	evs, _, _ := h.eventsRange(admin, "patron:p1", -1, -1, false, 0)
	if len(evs) != 1 || evs[0].data["$sys"] != "death" || evs[0].seq != 4 || evs[0].position != pos {
		t.Fatalf("after erasure: %+v", evs)
	}
	if evs, _, _ := h.eventsRange(admin, "patron:p2", -1, -1, false, 0); len(evs) != 2 {
		t.Fatalf("other stream: %+v", evs)
	}

	// the stream's state is gone, and its event bytes are the death's alone
	dead := h.snapshot(admin, "patron:p1")
	deathBytes := int64(len(mpEncode(map[string]any{"$sys": "death"})))
	if len(dead.records) != 0 || asInt(dead.header["event_bytes"]) != deathBytes {
		t.Fatalf("dead stream: %v %v", dead.records, dead.header)
	}

	// a replay from the start delivers the death alone, whose seq shows the gap
	s := h.stream(admin, 0)
	var p1 []event
	for {
		f := s.next()
		if f[0] == "live" {
			break
		}
		if f[0] != "events" {
			continue
		}
		for _, e := range events(f) {
			if e.stream == "patron:p1" {
				p1 = append(p1, e)
			}
		}
	}
	if len(p1) != 1 || p1[0].seq != 4 {
		t.Fatalf("replayed: %+v", p1)
	}

	// a rebirth takes the next seq, and a plain death keeps its stream's history
	h.accept(admin, cmd("c5", "add-patron", "id", "p1", "name", "Ann"))
	evs, _, _ = h.eventsRange(admin, "patron:p1", -1, -1, false, 0)
	if len(evs) != 3 || evs[1].data["$sys"] != "birth" || evs[1].seq != 5 {
		t.Fatalf("after rebirth: %+v", evs)
	}
	h.accept(admin, cmd("c6", "remove-patron", "id", "p2"))
	if evs, _, _ := h.eventsRange(admin, "patron:p2", -1, -1, false, 0); len(evs) != 3 {
		t.Fatalf("after a plain death: %+v", evs)
	}
}

func TestBirthDeath(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob"))

	// a bootstrap presents no token and gets the view frame first
	s := h.stream(admin, -1)
	if v := s.first; v == nil || strings.Join(strs(v[3]), ",") != "*" || asInt(v[2]) != 4 {
		t.Fatalf("first view frame: %v", v)
	}
	s.live()
	pos := h.accept(admin, cmd("c3", "remove-patron", "id", "p1"))
	evs := events(s.nextTagged("events"))
	if len(evs) != 1 || evs[0].data["$sys"] != "death" || evs[0].stream != "patron:p1" || evs[0].position != pos {
		t.Fatalf("expected death, got %+v", evs)
	}
	if evs[0].seq != 3 {
		t.Fatalf("death takes the next seq: %+v", evs)
	}

	// the dead stream is gone from the family's blob and its keys are gone
	if fam := h.snapshot(admin, "patron:*"); len(fam.streams) != 1 || fam.streams["patron:p2"] != 2 {
		t.Fatalf("streams after death: %v", fam.streams)
	}
	blob := h.snapshot(admin, "patron:p1")
	if len(blob.records) != 0 {
		t.Fatalf("dead stream still has state: %v", blob.records)
	}

	// rebirth under the same name
	h.accept(admin, cmd("c4", "add-patron", "id", "p1", "name", "Ann II"))
	evs = events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].data["$sys"] != "birth" || evs[1].data["name"] != "Ann II" {
		t.Fatalf("expected rebirth, got %+v", evs)
	}
	if evs[0].seq != 4 || evs[1].seq != 5 {
		t.Fatalf("seq continues across lives: %+v", evs)
	}
	blob = h.snapshot(admin, "patron:p1")
	if blob.records["patron:p1!patron"] == nil {
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
	if hdr.Get("Content-Length") != fmt.Sprint(len(out)) {
		h.t.Fatalf("Content-Length %q for a %d-byte blob", hdr.Get("Content-Length"), len(out))
	}
	b := parseBlob(h.t, out)
	if fmt.Sprint(b.position) != hdr.Get("PhaseLock-Position") {
		h.t.Fatalf("position header %q != blob %d", hdr.Get("PhaseLock-Position"), b.position)
	}
	// every stream with a record is in the streams map
	for _, k := range b.keys {
		if _, ok := b.streams[k[:strings.Index(k, "!")]]; !ok {
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
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	pos := h.accept(admin, cmd("c3", "add-patron", "id", "p2", "name", "Bob"))

	one := h.snapshot(admin, "patron:p1")
	if one.header["ref"] != "patron:p1" || one.position < pos || one.header["fold"] != h.epoch() {
		t.Fatalf("header: %v", one.header)
	}
	if strings.Join(one.keys, ",") != "patron:p1!holds,patron:p1!messages,patron:p1!patron" {
		t.Fatalf("keys: %v", one.keys)
	}
	if one.records["patron:p1!patron"].(map[string]any)["name"] != "Ann" {
		t.Fatalf("value: %v", one.records)
	}

	// a family blob holds every instance, contiguous per instance, and
	// names every live member with its seq
	fam := h.snapshot(admin, "patron:*")
	if len(fam.keys) != 6 || !strings.HasPrefix(fam.keys[0], "patron:p1!") || !strings.HasPrefix(fam.keys[5], "patron:p2!") {
		t.Fatalf("family keys: %v", fam.keys)
	}
	if len(fam.streams) != 2 || fam.streams["patron:p1"] != 2 || fam.streams["patron:p2"] != 2 {
		t.Fatalf("family streams: %v", fam.streams)
	}
	if one.streams["patron:p1"] != 2 || len(one.streams) != 1 {
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
	later := h.accept(admin, cmd("c4", "add-book", "id", "b2", "title", "Emma"))
	book2 := h.snapshot(admin, "book")
	if len(book2.keys) != 2 || book2.position < later {
		t.Fatalf("book after write: %v @ %d", book2.keys, book2.position)
	}

	// snapshots are authorized against the view
	anon := ""
	if status, _, _ := h.do("GET", "/snapshot/patron:p1", anon, nil); status != 403 {
		t.Fatalf("anonymous snapshot of a patron: status %d", status)
	}
	if status, _, _ := h.do("GET", "/snapshot/book", anon, nil); status != 200 {
		t.Fatalf("anonymous snapshot of book: status %d", status)
	}
}

func TestPasswordAuth(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "ann", "name", "Ann"))

	// anyone may create an account; the password is hashed at intake
	h.accept("", cmd("c2", "create-account", "user", "ann", "password", "hunter2"))
	acct := h.snapshot(admin, "account:ann").records["account:ann!account"].(map[string]any)
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
	if outs[0].kind != "ok" {
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
	h.accept(tok2, cmd("c5", "set-password", "user", "ann", "password", "correct horse"))
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
	h.accept(tok2, cmd("c6", "revoke-sessions", "user", "ann"))
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
	h.accept(tok3, cmd("c8", "rename-patron", "id", "ann", "name", "Ann"))

	// an account an admin creates as an admin is one
	h.accept(admin, cmd("c9", "create-account", "user", "boss", "password", "pw", "admin", true))
	status, _, out = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "boss", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("boss login: %d", status)
	}
	boss := mpDecodeOne(t, out).(map[string]any)["token"].(string)
	h.accept(boss, cmd("c10", "add-book", "id", "b1", "title", "Dune"))
}

// token keys ////////////////////////////////////////////////////////////////

// clock is a settable time, for the token keys' tests
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

// tokenParts is a token's header and claims, decoded
func tokenParts(t *testing.T, token string) (header, map[string]any) {
	t.Helper()
	parts := strings.Split(token, ".")
	var h header
	var c map[string]any
	for i, v := range []any{&h, &c} {
		raw, err := b64.DecodeString(parts[i])
		if err != nil || json.Unmarshal(raw, v) != nil {
			t.Fatalf("token part %d: %q", i, parts[i])
		}
	}
	return h, c
}

// kids is the ids of the stored token keys, oldest first
func (h *harness) kids() []string {
	h.t.Helper()
	keys, err := h.srv.core.keys()
	if err != nil {
		h.t.Fatal(err)
	}
	var out []string
	for _, k := range keys {
		out = append(out, k.kid)
	}
	return out
}

// works answers whether a token is accepted for a command
func (h *harness) works(token string) bool {
	h.t.Helper()
	status, _ := h.commandsStatus(token, cmd("w-"+token[len(token)-8:], "rename-patron", "id", "nobody", "name", "x"))
	return status == 200
}

func TestTokensAreEd25519AndNameTheirKey(t *testing.T) {
	h := start(t)
	tok := h.admin()
	hd, claims := tokenParts(t, tok)
	if hd.Alg != "EdDSA" || hd.Typ != "JWT" || len(hd.Kid) != 32 || claims["sub"] != "root" {
		t.Fatalf("token: %+v %v", hd, claims)
	}
	if !h.works(tok) || !slices.Equal(h.kids(), []string{hd.Kid}) {
		t.Fatalf("the token's key: %v", h.kids())
	}

	// a token naming another algorithm, another key, or other claims is refused
	parts := strings.Split(tok, ".")
	reheader := func(v header) string {
		b, _ := json.Marshal(v)
		return b64.EncodeToString(b) + "." + parts[1] + "." + parts[2]
	}
	forged := map[string]string{
		"HS256":        reheader(header{Alg: "HS256", Typ: "JWT", Kid: hd.Kid}),
		"none":         reheader(header{Alg: "none", Typ: "JWT", Kid: hd.Kid}),
		"unknown kid":  reheader(header{Alg: "EdDSA", Typ: "JWT", Kid: strings.Repeat("0", 32)}),
		"other claims": parts[0] + "." + b64.EncodeToString([]byte(`{"sub":"p1","gen":0,"exp":9999999999}`)) + "." + parts[2],
	}
	for name, f := range forged {
		if status, _ := h.commandsStatus(f, cmd("f", "rename-patron", "id", "x", "name", "x")); status != 401 {
			t.Fatalf("a token with %s: %d", name, status)
		}
	}
}

func TestATokenOutlivesItsProcess(t *testing.T) {
	dir := t.TempDir()
	h := startIn(t, dir)
	before := h.admin()
	h.stop()

	// the new process verifies the old token by its stored key, and signs with a key of its own
	h = startIn(t, dir)
	if !h.works(before) {
		t.Fatalf("a token from before the restart is refused")
	}
	after := h.admin()
	old, _ := tokenParts(t, before)
	fresh, _ := tokenParts(t, after)
	if old.Kid == fresh.Kid || !slices.Equal(h.kids(), []string{old.Kid, fresh.Kid}) {
		t.Fatalf("keys after a restart: %s then %s, stored %v", old.Kid, fresh.Kid, h.kids())
	}
}

func TestTokenKeysRotateAndAreSwept(t *testing.T) {
	dir := t.TempDir()
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	clk := &clock{t: t0}
	h := startWith(t, t.Context(), Options{DataDir: dir, now: clk.now})
	kid := func(token string) string {
		hd, _ := tokenParts(t, token)
		return hd.Kid
	}

	// a key signs for a day
	tok1 := h.admin()
	k1 := kid(tok1)
	clk.set(t0.Add(23 * time.Hour))
	if kid(h.admin()) != k1 {
		t.Fatalf("rotated within a day")
	}
	clk.set(t0.Add(25 * time.Hour))
	k2 := kid(h.admin())
	if k2 == k1 || !h.works(tok1) {
		t.Fatalf("after a day: %s then %s", k1, k2)
	}

	// a key retired for longer than a token lives, plus the grace, is swept when the next key is
	// minted; the key it retired stays
	clk.set(t0.Add(25*time.Hour + tokenLifetime + keyGrace + time.Minute))
	k3 := kid(h.admin())
	if got := h.kids(); !slices.Equal(got, []string{k2, k3}) {
		t.Fatalf("after the sweep: %v, want %s %s", got, k2, k3)
	}

	// across a restart, a past process's newest key is retired by the new process's start
	h.stop()
	restart := clk.now().Add(tokenLifetime + keyGrace + time.Minute)
	clk.set(restart)
	h = startWith(t, t.Context(), Options{DataDir: dir, now: clk.now})
	k4 := kid(h.admin())
	if got := h.kids(); !slices.Equal(got, []string{k3, k4}) {
		t.Fatalf("after a restart's sweep: %v, want %s %s", got, k3, k4)
	}
}

func TestTheGraceKeepsAKeyAcrossAClockSteppedBack(t *testing.T) {
	dir := t.TempDir()
	t0 := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	clk := &clock{t: t0}
	h := startWith(t, t.Context(), Options{DataDir: dir, now: clk.now})
	tok := h.admin()
	h.stop()

	// the next process starts on a clock twelve hours behind, so the old key's retirement is
	// recorded before its last signature; near the token's expiry a new key's sweep keeps it
	clk.set(t0.Add(-12 * time.Hour))
	h = startWith(t, t.Context(), Options{DataDir: dir, now: clk.now})
	clk.set(t0.Add(tokenLifetime - time.Minute))
	h.admin()
	if !h.works(tok) {
		t.Fatalf("a live token's key was swept")
	}
}

func TestDevAuthCanBeDisabled(t *testing.T) {
	dir := t.TempDir()
	srv, err := Open(t.Context(), Options{DataDir: dir, Bundle: filepath.Join("testdata", "bundle.js")})
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
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	pos := h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann").in("s1", 1))
	h.accept("", cmd("c3", "create-account", "user", "p1", "password", "pw"))
	h.stop()

	h = startIn(t, dir)
	admin = h.admin()
	// dedup survives: the resend is not run again, which precommit would reject
	outs := h.commands(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < pos {
		t.Fatalf("dedup lost across restart: %+v", outs[0])
	}
	// history survives and positions continue
	s := h.stream(admin, 0)
	var all []event
	for len(all) < 6 {
		all = append(all, events(s.nextTagged("events"))...)
	}
	if all[5].stream != "account:p1" || all[5].position != 6 {
		t.Fatalf("history after restart: %+v", all)
	}
	next := h.accept(admin, cmd("c4", "add-patron", "id", "p2", "name", "Bob"))
	if next != 8 {
		t.Fatalf("positions should continue at 7,8: got %d", next)
	}
	// state survives
	if h.snapshot(admin, "patron:p1").records["patron:p1!patron"] == nil {
		t.Fatalf("state lost across restart")
	}
	// login survives
	status, _, _ := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "p1", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("login after restart: %d", status)
	}
	// the data directory holds the store
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

// injectingWriter is a response writer that runs a callback inside its first body write, which
// the stream handler makes with the view registered and the connection not yet streaming, and
// that ends the request at the live frame
type injectingWriter struct {
	t      *testing.T
	header http.Header
	frames [][]any
	inject func()
	cancel context.CancelFunc
}

func (w *injectingWriter) Header() http.Header { return w.header }
func (w *injectingWriter) WriteHeader(int)     {}
func (w *injectingWriter) Flush()              {}

func (w *injectingWriter) Write(b []byte) (int, error) {
	if len(w.frames) == 0 {
		w.inject()
	}
	f := mpDecodeOne(w.t, b).([]any)
	w.frames = append(w.frames, f)
	if f[0] == "live" {
		w.cancel()
	}
	return len(b), nil
}

func TestBootstrapDeliversEverythingAboveTheViewPosition(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c0", "add-patron", "id", "p0", "name", "Ann"))

	// a commit lands after the view is registered and before the connection streams, inside
	// the view frame's write
	ctx, cancel := context.WithCancel(t.Context())
	var pos int64
	w := &injectingWriter{t: t, header: http.Header{}, cancel: cancel, inject: func() {
		pos = h.accept(admin, cmd("c1", "rename-patron", "id", "p0", "name", "Anne"))
	}}
	req := httptest.NewRequest("GET", "/stream?since=-1", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+admin)
	h.srv.handleStream(w, req)

	// the view frame, then the commit's events, then live at its position
	if len(w.frames) != 3 {
		t.Fatalf("expected view, events, live, got %v", w.frames)
	}
	if w.frames[0][0] != "view" || asInt(w.frames[0][2]) != pos-1 {
		t.Fatalf("expected the view at %d, got %v", pos-1, w.frames[0])
	}
	if w.frames[1][0] != "events" || events(w.frames[1])[0].position != pos {
		t.Fatalf("expected the events at %d, got %v", pos, w.frames[1])
	}
	if w.frames[2][0] != "live" || asInt(w.frames[2][1]) != pos {
		t.Fatalf("expected live at %d, got %v", pos, w.frames[2])
	}
}

func TestColdReplayKeepsAtomsWhole(t *testing.T) {
	h := startWith(t, t.Context(), Options{MaxCommands: coldBatch})
	admin := h.admin()

	// a one-event atom shifts the two-event atoms after it off the window grid, so one of them
	// spans positions coldBatch and coldBatch+1
	h.accept(admin, cmd("c0", "add-patron", "id", "p0", "name", "Ann"))
	h.accept(admin, cmd("c1", "rename-patron", "id", "p0", "name", "Anne"))
	var cmds []command
	for i := 1; i <= coldBatch/2; i++ {
		cmds = append(cmds, cmd(fmt.Sprintf("a%d", i), "add-patron", "id", fmt.Sprintf("p%d", i), "name", "x"))
	}
	h.commands(admin, cmds...)

	// every frame is one whole atom: no command id spans two frames
	s := h.stream(admin, 0)
	seen := map[string]bool{}
	straddled := false
	for {
		f := s.next()
		if f[0] == "live" {
			break
		}
		if f[0] != "events" {
			continue
		}
		evs := events(f)
		id := evs[0].commandid
		if seen[id] {
			t.Fatalf("atom %s split across frames", id)
		}
		seen[id] = true
		for _, e := range evs {
			if e.commandid != id {
				t.Fatalf("frame mixes atoms %s and %s", id, e.commandid)
			}
		}
		if evs[0].position == coldBatch && evs[len(evs)-1].position == coldBatch+1 {
			straddled = true
		}
	}
	if !straddled {
		t.Fatalf("no atom spanned positions %d and %d", coldBatch, coldBatch+1)
	}
}

func TestLongCatchupNoOverflow(t *testing.T) {
	h := startWith(t, t.Context(), Options{MaxCommands: 1500})
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
		last = h.accept(admin, cmd(fmt.Sprintf("l%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i)))
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
	pos := h.accept(admin, cmd("final", "rename-patron", "id", "p1", "name", "done"))
	if evs := events(s.nextTagged("events")); evs[0].position != pos {
		t.Fatalf("expected live event at %d, got %+v", pos, evs)
	}
}

func TestStreamByteCounters(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne"))

	s := h.stream(admin, 0)
	var evs []event
	for len(evs) < 3 {
		evs = append(evs, events(s.nextTagged("events"))...)
	}
	var eventBytes int64
	for _, e := range evs {
		eventBytes += int64(len(mpEncode(e.data)))
	}

	blob := h.snapshot(admin, "patron:p1")
	var stateBytes int64
	for _, k := range blob.keys {
		stateBytes += int64(len(k)) + int64(len(blob.raw[k]))
	}
	if blob.streams["patron:p1"] != 3 || len(blob.streams) != 1 {
		t.Fatalf("streams in header: %v", blob.streams)
	}
	if asInt(blob.header["event_bytes"]) != eventBytes {
		t.Fatalf("event_bytes %v, expected %d", blob.header["event_bytes"], eventBytes)
	}
	if asInt(blob.header["state_bytes"]) != stateBytes || stateBytes == 0 {
		t.Fatalf("state_bytes %v, expected %d", blob.header["state_bytes"], stateBytes)
	}

	// family blobs carry no per-stream counters
	if _, ok := h.snapshot(admin, "patron:*").header["state_bytes"]; ok {
		t.Fatalf("family blob should not carry stream counters")
	}

	// death zeroes state and still counts its own event bytes
	h.accept(admin, cmd("c3", "remove-patron", "id", "p1"))
	dead := h.snapshot(admin, "patron:p1")
	if asInt(dead.header["state_bytes"]) != 0 || asInt(dead.header["event_bytes"]) <= eventBytes {
		t.Fatalf("after death: %v", dead.header)
	}
}

func TestExpectAndConflict(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann")) // seq 1, 2

	// expectations are the stream's seq: exact, so a met one passes and
	// the same one then conflicts, reporting the actual seq
	o := h.expecting(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne").in("s1", 1), map[string]any{"patron:p1": 2})
	if o.kind != "ok" {
		t.Fatalf("matching expect: %+v", o)
	}
	o = h.expecting(admin, cmd("c3", "rename-patron", "id", "p1", "name", "Annie"), map[string]any{"patron:p1": 2})
	if o.kind != "conflict" || o.current["patron:p1"] != 3 {
		t.Fatalf("stale expect: %+v", o)
	}
	// a conflicting command never entered the log
	if got := h.snapshot(admin, "patron:p1").records["patron:p1!patron"].(map[string]any)["name"]; got != "Anne" {
		t.Fatalf("conflict should not fold: %v", got)
	}

	// 0 asserts a stream was never born
	o = h.expecting(admin, cmd("c4", "add-book", "id", "b1", "title", "Dune"), map[string]any{"book": 0})
	if o.kind != "ok" {
		t.Fatalf("expect 0 on unborn stream: %+v", o)
	}
	o = h.expecting(admin, cmd("c5", "add-patron", "id", "p2", "name", "Bob"), map[string]any{"patron:p2": 1})
	if o.kind != "conflict" || o.current["patron:p2"] != 0 {
		t.Fatalf("expect on unborn stream reports 0: %+v", o)
	}

	// several expectations: only the mismatches are reported
	o = h.expecting(admin, cmd("c6", "rename-patron", "id", "p1", "name", "x"), map[string]any{"patron:p1": 3, "book": 5})
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
	o = h.expecting(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Anne").in("s1", 1), map[string]any{"patron:p1": 0})
	if o.kind != "ok" {
		t.Fatalf("resubmit with stale expect: %+v", o)
	}

	// a hashed command keeps its expectation through intake
	o = h.expecting(admin, cmd("c7", "create-account", "user", "p1", "password", "pw"), map[string]any{"account:p1": 1})
	if o.kind != "conflict" || o.current["account:p1"] != 0 {
		t.Fatalf("expect survives hash intake: %+v", o)
	}
	o = h.expecting(admin, cmd("c8", "create-account", "user", "p1", "password", "pw"), map[string]any{"account:p1": 0})
	if o.kind != "ok" {
		t.Fatalf("hashed command with matching expect: %+v", o)
	}

	// an expectation names only streams the sender may see, so it never learns another's seq,
	// nor whether it exists: an anonymous sender sees the book alone
	o = h.expecting("", cmd("c8b", "create-account", "user", "p5", "password", "pw"), map[string]any{"book": h.snapshot(admin, "book").streams["book"]})
	if o.kind != "ok" {
		t.Fatalf("anonymous expect of a stream it may see: %+v", o)
	}
	for _, stream := range []string{"account:p1", "account:p6"} {
		o = h.expecting("", cmd("c8c", "create-account", "user", "p6", "password", "pw"), map[string]any{stream: 0})
		if o.kind != "reject" || o.reason != "expect: "+stream+" is not a stream the sender may see" {
			t.Fatalf("anonymous expect of %s: %+v", stream, o)
		}
	}

	// expect names at most 1024 streams
	many := map[string]any{}
	for i := range 1024 {
		many[fmt.Sprintf("patron:q%d", i)] = 0
	}
	o = h.expecting(admin, cmd("c9", "add-patron", "id", "p3", "name", "Cy"), many)
	if o.kind != "ok" {
		t.Fatalf("1024 expectations: %+v", o)
	}
	many["patron:q1024"] = 0
	o = h.expecting(admin, cmd("c10", "add-patron", "id", "p4", "name", "Di"), many)
	if o.kind != "reject" || o.reason != "expect names 1025 streams, more than 1024" {
		t.Fatalf("1025 expectations: %+v", o)
	}

	// each an exact stream name and a seq from 0 to 2^53 - 1
	malformed := []struct {
		expect map[string]any
		reason string
	}{
		{map[string]any{"nope:p1": 0}, "expect: nope:p1 is not a stream name"},
		{map[string]any{"patron:p1\x00x": 0}, "expect: patron:p1 is not a stream name"},
		{map[string]any{"patron:p1": -1}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
		{map[string]any{"patron:p1": int64(1) << 53}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
		{map[string]any{"patron:p1": 3.0}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
	}
	for i, m := range malformed {
		o = h.expecting(admin, cmd(fmt.Sprintf("c11-%d", i), "rename-patron", "id", "p1", "name", "x"), m.expect)
		if o.kind != "reject" || o.reason != m.reason {
			t.Fatalf("expect %v: %+v", m.expect, o)
		}
	}

	// and each named once, in a map; Go's maps cannot say either otherwise, so these are built by
	// hand
	rename := cmd("c12", "rename-patron", "id", "p1", "name", "x")
	twice := append([]byte{0x82}, mpEncode("patron:p1")...)
	twice = append(twice, 3)
	twice = append(twice, mpEncode("patron:p1")...)
	twice = append(twice, 3)
	for expect, reason := range map[string]string{
		string(twice):                "expect: patron:p1 is named twice",
		string(mpEncode([]any{"x"})): "expect must be a map",
	} {
		body := rename.encode(nil)
		body[0] = 0x95 // the command's array gains expect
		status, _, out := h.do("POST", "/commands", admin, append(body, expect...))
		if status != 200 {
			t.Fatalf("commands: status %d", status)
		}
		if o := decodeOutcomes(t, out)[0]; o.kind != "reject" || o.reason != reason {
			t.Fatalf("expect %x: %+v", expect, o)
		}
	}
}

// A request carries at most 128 commands, and one without a session at most 8; a request past
// its limit is refused whole with 413 and the limit it was held to, before any command is
// checked.  Options change both.
func TestCommandLimits(t *testing.T) {
	books := func(prefix string, n int) []command {
		var cmds []command
		for i := range n {
			id := fmt.Sprintf("%s%d", prefix, i)
			cmds = append(cmds, cmd(id, "add-book", "id", id, "title", "Dune"))
		}
		return cmds
	}
	post := func(h *harness, token string, cmds []command) (int, string) {
		var body []byte
		for _, c := range cmds {
			body = append(body, c.encode(nil)...)
		}
		status, header, _ := h.do("POST", "/commands", token, body)
		return status, header.Get("PhaseLock-Max-Commands")
	}

	// the defaults: anonymous commands are answered, if only with rejects, up to 8
	h := start(t)
	admin := h.admin()
	if status, _ := post(h, admin, books("a", 128)); status != 200 {
		t.Fatalf("128 commands: status %d", status)
	}
	if status, limit := post(h, admin, books("b", 129)); status != 413 || limit != "128" {
		t.Fatalf("129 commands: status %d, limit %q", status, limit)
	}
	if status, _ := post(h, "", books("c", 8)); status != 200 {
		t.Fatalf("8 anonymous commands: status %d", status)
	}
	if status, limit := post(h, "", books("d", 9)); status != 413 || limit != "8" {
		t.Fatalf("9 anonymous commands: status %d, limit %q", status, limit)
	}

	// a refused request decided nothing
	if o := h.commands(admin, books("b", 1)...)[0]; o.kind != "ok" {
		t.Fatalf("a command of a refused request: %+v", o)
	}

	// limits of the server's own
	h = startWith(t, t.Context(), Options{MaxCommands: 4, MaxAnonymousCommands: 2})
	if status, limit := post(h, h.admin(), books("e", 5)); status != 413 || limit != "4" {
		t.Fatalf("5 commands under 4: status %d, limit %q", status, limit)
	}
	if status, limit := post(h, "", books("f", 3)); status != 413 || limit != "2" {
		t.Fatalf("3 anonymous commands under 2: status %d, limit %q", status, limit)
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
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann")) // 1, 2
	h.accept(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob")) // 3, 4
	for i := 0; i < 5; i++ {
		h.accept(admin, cmd(fmt.Sprintf("r%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i))) // 5..9
	}
	last := h.accept(admin, cmd("c3", "rename-patron", "id", "p2", "name", "Robert")) // 10
	head := last + 1                                                                  // a position the client does not have yet

	// forward: only p1's events, ascending, range exhausted in one page
	evs, scanned, _ := h.eventsRange(admin, "patron:p1", 0, head, false, 0)
	if len(evs) != 7 || evs[0].position != 1 || evs[6].position != 9 || scanned != head {
		t.Fatalf("forward: %d events, scanned %d", len(evs), scanned)
	}
	for i := 1; i < len(evs); i++ {
		if evs[i].stream != "patron:p1" || evs[i].seq != evs[i-1].seq+1 {
			t.Fatalf("forward order/seq: %+v", evs)
		}
	}

	// both bounds are exclusive: positions the client holds
	evs, _, _ = h.eventsRange(admin, "patron:p1", 2, 6, false, 0)
	if len(evs) != 1 || evs[0].position != 5 {
		t.Fatalf("bounds: %+v", evs)
	}

	// reverse: descending, scanned is the next before
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 0, head, true, 0)
	if len(evs) != 7 || evs[0].position != 9 || evs[6].position != 1 || scanned != 0 {
		t.Fatalf("reverse: %+v scanned %d", evs, scanned)
	}

	// paging with max: the scanned value plugs straight into the next
	// request, in both directions, with no arithmetic
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 0, head, false, 3)
	if len(evs) != 3 || evs[2].position != 5 || scanned != 5 {
		t.Fatalf("forward page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", scanned, head, false, 3)
	if len(evs) != 3 || evs[0].position != 6 || evs[2].position != 8 || scanned != 8 {
		t.Fatalf("forward page 2: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", scanned, head, false, 3)
	if len(evs) != 1 || evs[0].position != 9 || scanned != head {
		t.Fatalf("forward page 3: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 0, head, true, 3)
	if len(evs) != 3 || evs[2].position != 7 || scanned != 7 {
		t.Fatalf("reverse page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 0, scanned, true, 3)
	if len(evs) != 3 || evs[0].position != 6 || evs[2].position != 2 || scanned != 2 {
		t.Fatalf("reverse page 2: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 0, scanned, true, 3)
	if len(evs) != 1 || evs[0].position != 1 || scanned != 0 {
		t.Fatalf("reverse page 3: %+v scanned %d", evs, scanned)
	}

	// the stream must be visible to the principal
	if _, _, status := h.eventsRange(h.token("p1"), "patron:p2", 0, head, false, 0); status != 403 {
		t.Fatalf("invisible stream: status %d", status)
	}
	if _, _, status := h.eventsRange(h.token("p1"), "patron:p1", 0, head, false, 0); status != 200 {
		t.Fatalf("own stream: status %d", status)
	}

	// both bounds are optional: the start of the log and the head.  At the
	// head, scanned is the last position delivered, or after if nothing was
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", -1, -1, false, 0)
	if len(evs) != 7 || evs[0].position != 1 || evs[6].position != 9 || scanned != 9 {
		t.Fatalf("unbounded forward: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", 9, -1, false, 0)
	if len(evs) != 0 || scanned != 9 {
		t.Fatalf("empty at head: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", -1, -1, true, 0)
	if len(evs) != 7 || evs[0].position != 9 || scanned != 0 {
		t.Fatalf("unbounded reverse: %d events, scanned %d", len(evs), scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:p1", -1, 6, false, 0)
	if len(evs) != 3 || evs[2].position != 5 || scanned != 6 {
		t.Fatalf("no after: %+v scanned %d", evs, scanned)
	}

	// a family ref interleaves its streams in position order
	evs, scanned, _ = h.eventsRange(admin, "patron:*", 0, head, true, 4)
	if len(evs) != 4 || evs[0].position != 10 || evs[1].position != 9 || evs[3].position != 7 || scanned != 7 {
		t.Fatalf("family reverse page: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.eventsRange(admin, "patron:*", 0, scanned, true, 0)
	if len(evs) != 6 || evs[0].position != 6 || evs[5].position != 1 || scanned != 0 {
		t.Fatalf("family reverse page 2: %+v scanned %d", evs, scanned)
	}
	evs, _, _ = h.eventsRange(admin, "patron:*", 2, 5, false, 0)
	if len(evs) != 2 || evs[0].position != 3 || evs[1].position != 4 || evs[0].stream != "patron:p2" {
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
	if _, _, status := h.eventsRange(h.token("p1"), "patron:*", 0, head, false, 0); status != 403 {
		t.Fatalf("family for p1: status %d", status)
	}
	for _, bad := range []string{"", "patron:", "patron:p1!", "patron*", "patron:p*", "pat*ron", "*:patron"} {
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
	// and the well-formed ones around it are accepted
	outs := h.commands(admin,
		cmd("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1),
		cmd("c2", "add-book", "id", "b2").in("s1", 2),
		cmd("c3", "add-book", "id", 7, "title", "Emma"),
		cmd("c4", "add-book", "id", "b4", "title", "Emma", "extra", true),
		cmd("c5", "no-such-command", "id", "x"),
		cmd("c6", "add-book", "id", "b6", "title", "Persuasion"),
	)
	kinds := []string{"ok", "reject", "reject", "reject", "reject", "ok"}
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
		t.Fatalf("oks around the rejects: %+v", outs)
	}

	// a malformed command never reached dedup, so it was not a decision: its number is free for
	// a good one, which runs and lands past everything before it
	if o := h.commands(admin, cmd("c2", "add-book", "id", "b2", "title", "Mansfield Park").in("s1", 2))[0]; o.kind != "ok" || o.position <= outs[5].position {
		t.Fatalf("number of a malformed command reused: %+v", o)
	}

	// the discriminator may sit anywhere in the map, and the log has it first
	body := rawCommand("c7", "id", "b7", "title", "Emma", "type", "add-book")
	if status, _, out := h.do("POST", "/commands", admin, body); status != 200 || decodeOutcomes(t, out)[0].kind != "ok" {
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
	// a command that is not [S, n, id, data, expect?] is a 400 too, since nothing can be
	// answered for it
	data := map[string]any{"type": "add-book", "id": "b9", "title": "Emma"}
	for name, c := range map[string][]any{
		"a string":           {"just a string"},
		"the old pair":       {"c9", data},
		"a series, no n":     {"s1", nil, label("c9"), data},
		"an n, no series":    {nil, int64(3), label("c9"), data},
		"an empty series":    {"", int64(3), label("c9"), data},
		"a long series":      {strings.Repeat("s", 65), int64(3), label("c9"), data},
		"a zero n":           {"s1", int64(0), label("c9"), data},
		"an n past 2^53 - 1": {"s1", int64(1) << 53, label("c9"), data},
		"a string id":        {nil, nil, "c9", data},
		"a short id":         {nil, nil, []byte("c9"), data},
	} {
		v := any(c)
		if len(c) == 1 {
			v = c[0]
		}
		if status, _, _ := h.do("POST", "/commands", admin, mpEncode(v)); status != 400 {
			t.Fatalf("%s: %d", name, status)
		}
	}
	// a series id of the longest length and the largest n are well-formed
	big := []any{strings.Repeat("s", 64), int64(1)<<53 - 1, label("c9"), data}
	if status, _, out := h.do("POST", "/commands", admin, mpEncode(big)); status != 200 || decodeOutcomes(t, out)[0].kind != "ok" {
		t.Fatalf("the largest series id and n: %d %s", status, out)
	}
}

func TestTypedValues(t *testing.T) {
	h := start(t)
	admin := h.admin()
	added := time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC)

	// a date field travels as a timestamp: into the log, through the reducer, out of the store
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune", "added", added))
	s := h.stream(admin, 0)
	evs := events(s.nextTagged("events"))
	if got, ok := evs[1].data["added"].(time.Time); !ok || !got.Equal(added) {
		t.Fatalf("event date: %v", evs[1].data["added"])
	}
	book := h.snapshot(admin, "book").records["book!book:b1"].(map[string]any)
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

	// a date reaches as far as a JS Date does either side of the epoch, and no further
	for i, ms := range []int64{8.64e15, -8.64e15} {
		id := fmt.Sprintf("e%d", i)
		h.accept(admin, cmd(id, "add-book", "id", id, "title", "Emma", "added", time.UnixMilli(ms)))
		stored := h.snapshot(admin, "book").records["book!book:"+id].(map[string]any)["added"]
		if got, ok := stored.(time.Time); !ok || got.UnixMilli() != ms {
			t.Fatalf("date at %d ms: %v", ms, stored)
		}
	}
	for i, ms := range []int64{8.64e15 + 1, -8.64e15 - 1, 1 << 62} {
		id := fmt.Sprintf("f%d", i)
		o := h.commands(admin, cmd(id, "add-book", "id", id, "title", "Emma", "added", time.UnixMilli(ms)))[0]
		if o.kind != "reject" || o.reason != "$.added: a timestamp outside the range of a Date" {
			t.Fatalf("date at %d ms: %+v", ms, o)
		}
	}

	// an optional field left out stays out
	h.accept(admin, cmd("c3", "add-book", "id", "b3", "title", "Emma"))
	if _, ok := h.snapshot(admin, "book").records["book!book:b3"].(map[string]any)["added"]; ok {
		t.Fatalf("absent optional field written")
	}
}

func TestPreparedFields(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "ann", "name", "Ann"))

	// a NewPassword is replaced by its argon2id hash before precommit sees it
	h.accept("", cmd("c2", "create-account", "user", "ann", "password", "hunter2"))
	acct := h.snapshot(admin, "account:ann").records["account:ann!account"].(map[string]any)
	hash := acct["hash"].(string)
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("expected an argon2id hash, got %q", hash)
	}
	// and the check saw the wire type: a password that is not a string is rejected
	o := h.commands("", cmd("c3", "create-account", "user", "bob", "password", 42))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.password: expected a string") {
		t.Fatalf("non-string password: %+v", o)
	}
}

// command-time authentication ///////////////////////////////////////////////

// proof is a password CommandAuth
func proof(password string) map[string]any {
	return map[string]any{"kind": "password", "password": password}
}

// signUp creates an account with a password, and signs in to it
func (h *harness) signUp(user, password string) string {
	h.t.Helper()
	h.accept("", cmd("signup-"+user, "create-account", "user", user, "password", password))
	return h.signIn(user, password)
}

// signIn signs in with a password, which must be right
func (h *harness) signIn(user, password string) string {
	h.t.Helper()
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": user, "password": password,
	}))
	if status != 200 {
		h.t.Fatalf("login as %s: %d %s", user, status, out)
	}
	return mpDecodeOne(h.t, out).(map[string]any)["token"].(string)
}

// setPasswordWhenProved arms the server to set a user's password, as an admin and once, right
// after the next login's password or request's proofs are checked and before the server reads
// the credentials again; the channel answers how the change went
func (h *harness) setPasswordWhenProved(user, password string) chan error {
	h.t.Helper()
	admin := h.admin()
	done := make(chan error, 1)
	var once sync.Once
	h.srv.proved = func() {
		once.Do(func() {
			body := cmd("hook-"+password, "set-password", "user", user, "password", password).encode(nil)
			req, _ := http.NewRequest("POST", h.web.URL+"/commands", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+admin)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				done <- err
				return
			}
			out, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			v, err := mpDecodeBytes(out)
			if err == nil && (resp.StatusCode != 200 || v.([]any)[0].([]any)[0] != "ok") {
				err = fmt.Errorf("set-password: %d %v", resp.StatusCode, v)
			}
			done <- err
		})
	}
	return done
}

// changed fails the test unless the armed password change ran and was accepted
func changed(t *testing.T, done chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("the password change never ran")
	}
}

func TestAPasswordProofIsCheckedAgainstTheSendersAccount(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")
	proven := func(id, password string) command {
		return cmd(id, "authenticated-command", "user", "ann", "check", proof(password))
	}

	// the right password passes, and precommit sees only what it proved
	if o := h.commands(tok, proven("c1", "hunter2"))[0]; o.kind != "ok" {
		t.Fatalf("the right password: %+v", o)
	}
	tok = h.signUp("bob", "pw")

	// the proof is the sender's own: ann's password proves nothing for bob
	o := h.commands(tok, cmd("c2", "authenticated-command", "user", "bob", "check", proof("hunter2")))[0]
	if o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("another account's password: %+v", o)
	}

	// a failed proof is rejected before its expectations are compared, so it learns no seq
	stale := map[string]any{"patron:bob": 99}
	bobs := func(id, password string) command {
		return cmd(id, "authenticated-command", "user", "bob", "check", proof(password))
	}
	if o := h.expecting(tok, bobs("c3", "wrong"), stale); o.kind != "reject" {
		t.Fatalf("a wrong password with a stale expectation: %+v", o)
	}
	if o := h.expecting(tok, bobs("c4", "pw"), stale); o.kind != "conflict" {
		t.Fatalf("the right password with a stale expectation: %+v", o)
	}

	// an account without a password, and the anonymous principal, prove nothing
	for _, sender := range []string{h.token("p1"), ""} {
		o := h.commands(sender, cmd("c5", "authenticated-command", "user", "p1", "check", proof("x")))[0]
		if o.kind != "reject" || o.reason != "invalid credentials" {
			t.Fatalf("a proof with no password to check it against: %+v", o)
		}
	}

	// the other kinds are refused at intake, after the wire shape is checked
	o = h.commands(tok, cmd("c6", "authenticated-command", "user", "bob", "check",
		map[string]any{"kind": "totp", "code": "123456"}))[0]
	if o.kind != "reject" || o.reason != "totp proofs are not supported by this database yet" {
		t.Fatalf("a totp proof: %+v", o)
	}
	o = h.commands(tok, cmd("c7", "authenticated-command", "user", "bob", "check",
		map[string]any{"kind": "carrier-pigeon"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.check") {
		t.Fatalf("a malformed proof: %+v", o)
	}
}

func TestAResentPasswordChangeThatLandedIsOk(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")
	change := cmd("c1", "change-password", "user", "ann", "check", proof("hunter2"), "password", "fresh").in("s1", 1)

	// the change lands, and its resend proves a password that is no longer ann's, but the resend
	// is the decided command, so dedup answers it
	if o := h.commands(tok, change)[0]; o.kind != "ok" {
		t.Fatalf("the change: %+v", o)
	}
	if o := h.commands(tok, change)[0]; o.kind != "ok" {
		t.Fatalf("the resend: %+v", o)
	}
	again := cmd("c2", "change-password", "user", "ann", "check", proof("hunter2"), "password", "x").in("s1", 2)
	if o := h.commands(tok, again)[0]; o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("a new command proving the old password: %+v", o)
	}
	if status := login(h, "ann", "fresh"); status != 200 {
		t.Fatalf("login with the changed password: %d", status)
	}
}

func TestACallProvesThePasswordItsEarlierCommandSet(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")

	// both proofs are checked against hunter2 before either runs; the second bounces when its turn
	// comes and passes against the password the first set
	outs := h.commands(tok,
		cmd("c1", "change-password", "user", "ann", "check", proof("hunter2"), "password", "fresh"),
		cmd("c2", "authenticated-command", "user", "ann", "check", proof("fresh")))
	if outs[0].kind != "ok" || outs[1].kind != "ok" {
		t.Fatalf("outcomes: %+v", outs)
	}
}

func TestAProofIsCheckedAgainWhenTheCredentialsChangeBeforeItsTurn(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("p", "add-patron", "id", "ann", "name", "Ann"))
	tok := h.signUp("ann", "hunter2")

	// a proof that passed against the old password fails against the new one
	done := h.setPasswordWhenProved("ann", "fresh")
	o := h.commands(tok, cmd("c1", "authenticated-command", "user", "ann", "check", proof("hunter2")))[0]
	changed(t, done)
	if o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("the old password after a change: %+v", o)
	}

	// a proof that failed against the old password passes against the new one, and the call's
	// commands are still decided once each, in order
	done = h.setPasswordWhenProved("ann", "fresher")
	call := []command{
		cmd("c2", "rename-patron", "id", "ann", "name", "A1").in("s1", 1),
		cmd("c3", "authenticated-command", "user", "ann", "check", proof("fresher")).in("s1", 2),
		cmd("c4", "rename-patron", "id", "ann", "name", "A2").in("s1", 3),
	}
	outs := h.commands(tok, call...)
	changed(t, done)
	for i, o := range outs {
		if o.kind != "ok" {
			t.Fatalf("outcome %d: %+v", i, o)
		}
	}
	if outs[0].position >= outs[2].position {
		t.Fatalf("decided out of order: %+v", outs)
	}
	patron := h.snapshot(admin, "patron:ann").records["patron:ann!patron"].(map[string]any)
	if patron["name"] != "A2" {
		t.Fatalf("patron after the call: %v", patron)
	}

	// the proven command revoked the token, so the resend signs in again, and is answered by dedup
	tok = h.signIn("ann", "fresher")
	for i, o := range h.commands(tok, call...) {
		if o.kind != "ok" {
			t.Fatalf("resent outcome %d: %+v", i, o)
		}
	}
}

func TestALoginIsCheckedAgainWhenTheCredentialsChange(t *testing.T) {
	h := start(t)
	h.signUp("ann", "hunter2")

	// the password that passed is replaced before the login is decided
	done := h.setPasswordWhenProved("ann", "fresh")
	if status := login(h, "ann", "hunter2"); status != 401 {
		t.Fatalf("the old password after a change: %d", status)
	}
	changed(t, done)

	// the password that failed becomes the account's before the login is decided
	done = h.setPasswordWhenProved("ann", "fresher")
	if status := login(h, "ann", "fresher"); status != 200 {
		t.Fatalf("the new password after a change: %d", status)
	}
	changed(t, done)
}

func TestALookupThatChangesOnEveryReadIsABug(t *testing.T) {
	h := start(t)

	// the writer bounces the call a few times, then rejects it as lookup's bug, in full in dev
	o := h.commands(h.token("flaky"), cmd("c1", "authenticated-command", "user", "flaky", "check", proof("x")))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "different passwordHash on each of 5 reads") {
		t.Fatalf("a proof against a flaky lookup: %+v", o)
	}

	// a login gives up the same way
	if status := login(h, "flaky", "x"); status != 500 {
		t.Fatalf("a login against a flaky lookup: %d", status)
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
	_, err = Open(t.Context(), Options{DataDir: filepath.Join(dir, "data"), Bundle: bundle})
	if err == nil || !strings.Contains(err.Error(), "NewThing") {
		t.Fatalf("expected a refusal naming the kind, got %v", err)
	}
}

// raw is msgpack bytes spliced as they are into a command built by rawCommand.
type raw []byte

// rawCommand encodes one [id, data] command whose data map holds the fields in order, raw
// values spliced in as they are.
func rawCommand(id string, kv ...any) []byte {
	b := mpArrayHeader(nil, 4)
	b = mpAppend(mpAppend(b, nil), nil)
	b = mpAppend(b, label(id))
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
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune", "added", whole))
	h.accept(admin, cmd("c2", "add-book", "id", "b2", "title", "Emma", "added", old))
	records := h.snapshot(admin, "book").records
	for key, want := range map[string]time.Time{"book!book:b1": whole, "book!book:b2": old} {
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
	if outs[6].kind != "ok" {
		t.Fatalf("the command after the rejects: %+v", outs[6])
	}

	// a map key that is not a string, where the walk reads keys
	body = mpArrayHeader(nil, 4)
	body = mpAppend(mpAppend(mpAppend(body, nil), nil), label("e1"))
	body = append(body, 0x84)
	body = append(mpAppendStr(body, "type"), mpAppendStr(nil, "add-book")...)
	body = append(mpAppendStr(body, "id"), mpAppendStr(nil, "b10")...)
	body = append(mpAppendStr(body, "title"), mpAppendStr(nil, "T")...)
	body = append(body, 0x07, 0xc0)
	if o := h.commandsRaw(admin, body)[0]; o.kind != "reject" || o.reason != "$: a map key is not a string" {
		t.Fatalf("non-string key: %+v", o)
	}

	// elements a later protocol appends to a command are ignored
	body = mpEncode([]any{nil, nil, label("e2"), map[string]any{"type": "add-book", "id": "b11", "title": "T"}, map[string]any{}, "newer"})
	if o := h.commandsRaw(admin, body)[0]; o.kind != "ok" {
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
	h.accept(admin, cmd("c1", "create-account", "user", "ann", "password", "hunter2"))

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

func TestClientsAreNamedByAddressOrTheirSlash64(t *testing.T) {
	direct := &Server{}
	proxied := &Server{clientIPHeader: "CF-Connecting-IP"}
	for _, c := range []struct {
		s      *Server
		remote string
		header string
		want   string
	}{
		{direct, "203.0.113.7:5000", "", "203.0.113.7"},
		{direct, "[2001:db8:1:2:aaaa::1]:5000", "", "2001:db8:1:2::/64"},
		{direct, "[::ffff:203.0.113.7]:5000", "", "203.0.113.7"},
		{direct, "203.0.113.7:5000", "198.51.100.1", "203.0.113.7"},
		{proxied, "127.0.0.1:5000", "198.51.100.1", "198.51.100.1"},
		{proxied, "127.0.0.1:5000", " 2001:db8:1:2:bbbb::9 ", "2001:db8:1:2::/64"},
		{proxied, "127.0.0.1:5000", "", "127.0.0.1"},
		{proxied, "127.0.0.1:5000", "198.51.100.1, 198.51.100.2", "127.0.0.1"},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		if c.header != "" {
			r.Header.Set("CF-Connecting-IP", c.header)
		}
		if got := c.s.clientOf(r); got != c.want {
			t.Fatalf("%s with header %q (server header %q): %s, want %s",
				c.remote, c.header, c.s.clientIPHeader, got, c.want)
		}
	}
}

func TestAListClientIPHeaderIsRefused(t *testing.T) {
	for _, name := range []string{"X-Forwarded-For", "x-forwarded-for", "Forwarded"} {
		if _, err := Open(t.Context(), Options{DataDir: t.TempDir(), ClientIPHeader: name}); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestIntakeHashingIsRateLimitedPerClient(t *testing.T) {
	h := startWith(t, t.Context(), Options{AuthBurst: 1, AuthRate: 0.001})
	h.accept("", cmd("c1", "create-account", "user", "ann", "password", "hunter2"))

	// a request whose hash finds the budget spent is refused whole, so it can be retried later
	// under the same ids
	status, _ := h.commandsStatus("", cmd("c2", "create-account", "user", "bob", "password", "pw"))
	if status != 429 {
		t.Fatalf("a hash past the budget: %d, want 429", status)
	}

	// commands that hash nothing are not limited
	if o := h.commands(h.admin(), cmd("c3", "add-book", "id", "b1", "title", "Dune"))[0]; o.kind != "ok" {
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

	// a name with an account signs in as it
	if status, reply := devSignIn(h, map[string]any{"identity": "p1"}); status != 200 || reply["user"] != "p1" {
		t.Fatalf("dev sign-in as p1: %d %v", status, reply)
	}
}

func TestATokenForNoAccountIsRefusedEverywhere(t *testing.T) {
	h := start(t)
	ghost, _, err := h.srv.mint("ghost", 0)
	if err != nil {
		t.Fatal(err)
	}

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

	// one atom, under the id the core minted for it: the stream's birth and the account's
	// creation
	s := h.stream(h.admin(), 0)
	evs := events(s.nextTagged("events"))
	if len(evs) != 2 || evs[0].data["$sys"] != "birth" || evs[1].data["type"] != "account-created" {
		t.Fatalf("bootstrap's atom: %+v", evs)
	}
	for _, e := range evs {
		if e.stream != "account:boss" || len(e.id) != 16 || !bytes.Equal(e.id, evs[0].id) {
			t.Fatalf("bootstrap's event: %+v", e)
		}
	}
	if hash := evs[1].data["hash"].(string); !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("bootstrap's hash: %q", hash)
	}

	// the seeded admin signs in with the password
	status, _, out := h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "boss", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("seeded admin sign-in: %d %s", status, out)
	}
	boss := mpDecodeOne(t, out).(map[string]any)["token"].(string)

	// a log that is not empty is not seeded again, and the seeded account acts as an admin
	h.stop()
	h = startWith(t, t.Context(), Options{DataDir: dir, BootstrapEnv: env})
	if next := h.accept(boss, cmd("c1", "add-book", "id", "b1", "title", "Dune")); next != 4 {
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
		"login":             true,
		"patron:p1":         true,
		"patron:*":          true,
		"chat:*":            true,
		"chat:acme,*":       true,
		"chat:acme,gen,*":   true,
		"chat:acme,gen.e~1": true,
		"chat:acme-2,gen-2": true,
		"patron:p1.":        true,
		"pa-tron:p1":        true,
		"":                  false,
		":*":                false,
		"*:*":               false,
		"chat,*":            false,
		"chat*":             false,
		"chat::*":           false,
		"chat:ac*":          false,
		"chat:acme,g*":      false,
		"chat:acme,,*":      false,
		"chat:a.b,*":        false,
		"chat:a.b,gen":      false,
		"chat:acme,":        false,
		"chat:,gen":         false,
		"chat:acme:gen":     false,
		"patron:":           false,
		"patron.p1":         false,
		"patron:p1!":        false,
		"patron!":           false,
		"pa~tron:p1":        false,
		"pa.tron":           false,
		"patron:p/1":        false,
		"patron:p 1":        false,
		"patron:p%2F1":      false,
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
	h.accept(admin, cmd("c1", "add-patron", "id", "p.1~x", "name", "Ann"))
	if _, ok := h.snapshot(admin, "patron:p.1~x").records["patron:p.1~x!patron"]; !ok {
		t.Fatalf("patron:p.1~x was not written")
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

func TestKeysHoldNoControlCharacterOrLoneSurrogate(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a key's terminal parameter may hold any other text, the empty string included
	ok := []string{"b\U0001F600", "b\uFF0Cc", "b\u200Dc", "b\u00A0c", ""}
	for i, id := range ok {
		h.accept(admin, cmd(fmt.Sprintf("ok%d", i), "add-book", "id", id, "title", "T"))
	}
	records := h.snapshot(admin, "book").records
	for _, id := range ok {
		if _, found := records["book!book:"+id]; !found {
			t.Fatalf("book %q was not written", id)
		}
	}

	// a key holding a control character or a lone surrogate is refused, and its command with it
	bad := []string{"a\nb", "a\tb", "a\x7fb", "a\u0085b", "a\xed\xa0\x80b", "a\xed\xb0\x80b"}
	for i, id := range bad {
		o := h.commands(admin, cmd(fmt.Sprintf("bad%d", i), "add-book", "id", id, "title", "T"))[0]
		if o.kind != "reject" || !strings.Contains(o.reason, "holds a control character or a lone surrogate") {
			t.Fatalf("add-book %q: %+v", id, o)
		}
	}

	// a key holding U+0000 is neither read short nor written: precommit's read of b1\x00x finds
	// nothing although b1 is held, and the reducer's write is refused
	h.accept(admin, cmd("c1", "add-book", "id", "b1", "title", "Dune"))
	o := h.commands(admin, cmd("c2", "add-book", "id", "b1\x00x", "title", "Emma"))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "a key beginning book!book:b1 holds U+0000") {
		t.Fatalf("add-book with U+0000: %+v", o)
	}
}

func TestAProductionBundleAnswersBugsWithInternalError(t *testing.T) {
	h := startWith(t, t.Context(), Options{Bundle: filepath.Join("testdata", "bundle.prod.js")})
	admin := h.admin()
	if outs := h.commands(admin, cmd("c1", "add-patron", "id", "p/1", "name", "Bob")); outs[0].reason != "internal error" {
		t.Fatalf("a bug in a production bundle: %+v", outs[0])
	}

	// a rejection's reason is still the app's own
	h.accept(admin, cmd("c2", "add-patron", "id", "p1", "name", "Ann"))
	if outs := h.commands(admin, cmd("c3", "add-patron", "id", "p1", "name", "Ann")); outs[0].reason != "patron exists" {
		t.Fatalf("a rejection in a production bundle: %+v", outs[0])
	}
}

func TestAFailingMaySeeGrantsNothing(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")
	s := h.stream(ann, -1)
	s.live()

	// a granted wildcard that cuts into a stream's terminal parameter ends the connection
	h.accept(admin, cmd("c3", "grant-view", "user", "p1", "prefix", "patron:p1,*"))
	f := s.nextTagged("end")
	if f[1] != "error" || !strings.Contains(f[2].(string), "malformed ref: patron:p1,*") {
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
	if status != 500 || !strings.Contains(string(body), "malformed ref: patron:p1,*") {
		t.Fatalf("a stream under a failing maySee: %d %s", status, body)
	}
}

func TestMaySeeRefsCarryATerminator(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, cmd("c3", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")

	// an exact stream is "name!", which grants the stream
	h.accept(admin, cmd("c4", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	if _, _, status := h.eventsRange(ann, "patron:p2", 0, 100, false, 0); status != 200 {
		t.Fatalf("a granted stream: status %d", status)
	}
	h.accept(admin, cmd("c5", "revoke-view", "user", "p1", "prefix", "patron:p2!"))

	// a bare name, a wildcard cutting into a parameter, and a wildcard after a singleton family
	// are malformed, so the registration fails closed
	for i, ref := range []string{"patron:p2", "patron:p*", "book:*", "patron:p2/"} {
		h.accept(admin, cmd(fmt.Sprintf("g%d", i), "grant-view", "user", "p1", "prefix", ref))
		status, _, body := h.do("GET", "/stream?since=-1", ann, nil)
		if status != 500 || !strings.Contains(string(body), "malformed ref: "+ref) {
			t.Fatalf("maySee returning %q: %d %s", ref, status, body)
		}
		h.accept(admin, cmd(fmt.Sprintf("r%d", i), "revoke-view", "user", "p1", "prefix", ref))
	}
}

func TestAFamilyWalksInParameterOrder(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a stream whose parameter is another's followed by '-' or '.' sorts after it
	for i, id := range []string{"gen.x", "gen-2", "gen"} {
		h.accept(admin, cmd(fmt.Sprintf("c%d", i), "add-patron", "id", id, "name", "N"))
	}
	fam := h.snapshot(admin, "patron:*")
	want := []string{
		"patron:gen!holds", "patron:gen!messages", "patron:gen!patron",
		"patron:gen-2!holds", "patron:gen-2!messages", "patron:gen-2!patron",
		"patron:gen.x!holds", "patron:gen.x!messages", "patron:gen.x!patron",
	}
	if got := strings.Join(fam.keys, ","); got != strings.Join(want, ",") {
		t.Fatalf("family keys: %s", got)
	}

	// and so does a key whose parameter is another's followed by '-'
	for i, id := range []string{"2026-10-06", "2026-10"} {
		h.accept(admin, cmd(fmt.Sprintf("b%d", i), "add-book", "id", id, "title", "T"))
	}
	if got := strings.Join(h.snapshot(admin, "book").keys, ","); got != "book!book:2026-10,book!book:2026-10-06" {
		t.Fatalf("book keys: %s", got)
	}
}
