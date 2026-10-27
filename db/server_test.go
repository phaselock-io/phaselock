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
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// mutation is one mutation to post: unnumbered unless in names its series and number.
type mutation struct {
	id     string
	series string
	n      int64
	data   map[string]any
}

func mut(id, typ string, kv ...any) mutation {
	data := map[string]any{"type": typ}
	for i := 0; i+1 < len(kv); i += 2 {
		data[kv[i].(string)] = kv[i+1]
	}
	return mutation{id: id, data: data}
}

// in sends the mutation as number n of a series.
func (c mutation) in(series string, n int64) mutation {
	c.series = series
	c.n = n
	return c
}

// label is a test's mutation id as the 16 bytes on the wire: its name, padded with zeros.
func label(id string) []byte {
	if len(id) > 16 {
		panic("mutation id too long: " + id)
	}
	return append([]byte(id), make([]byte, 16-len(id))...)
}

// encode is the mutation as the wire carries it, with expect when it is not nil.
func (c mutation) encode(expect map[string]any) []byte {
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

// mutations posts mutations and returns the outcomes.
func (h *harness) mutations(token string, muts ...mutation) []outcome {
	h.t.Helper()
	status, outs := h.mutationsStatus(token, muts...)
	if status != 200 {
		h.t.Fatalf("mutations: status %d", status)
	}
	return outs
}

func (h *harness) mutationsStatus(token string, muts ...mutation) (int, []outcome) {
	h.t.Helper()
	var body []byte
	for _, c := range muts {
		body = append(body, c.encode(nil)...)
	}
	status, _, out := h.do("POST", "/mutations", token, body)
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

// expecting posts one mutation with an expect map and returns its outcome.
func (h *harness) expecting(token string, c mutation, expect map[string]any) outcome {
	h.t.Helper()
	body := c.encode(expect)
	status, _, out := h.do("POST", "/mutations", token, body)
	if status != 200 {
		h.t.Fatalf("mutations: status %d", status)
	}
	return decodeOutcomes(h.t, out)[0]
}

// accept posts one mutation that must be accepted, and returns its position.
func (h *harness) accept(token string, c mutation) int64 {
	h.t.Helper()
	outs := h.mutations(token, c)
	if outs[0].kind != "ok" {
		h.t.Fatalf("expected ok for %s, got %+v", c.id, outs[0])
	}
	return outs[0].position
}

// connection is an open /stream connection.
type connection struct {
	t      *testing.T
	resp   *http.Response
	frames chan any
	errs   chan error
	header http.Header
	// the view frame a connection without the current token gets first
	first []any
}

func (h *harness) connect(token string, since int64, wants ...string) *connection {
	h.t.Helper()
	return h.connectOpen(token, since, "", nil, wants...)
}

// connectView opens a connection presenting a stored view token.
func (h *harness) connectView(token string, since int64, view string) *connection {
	h.t.Helper()
	return h.connectOpen(token, since, view, nil)
}

// connectPaused opens a connection whose reader waits on start before reading.
func (h *harness) connectPaused(token string, since int64, start chan struct{}, wants ...string) *connection {
	h.t.Helper()
	return h.connectOpen(token, since, "", start, wants...)
}

func (h *harness) connectOpen(token string, since int64, view string, start chan struct{}, wants ...string) *connection {
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
		h.t.Fatalf("connect: status %d: %s", resp.StatusCode, body)
	}
	s := &connection{t: h.t, resp: resp, frames: make(chan any, 64), errs: make(chan error, 1), header: resp.Header}
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
	// a connection opened without presenting a token gets the view frame first; keep it aside so
	// tests see the same frames as a client with the current token, unless they asked for the raw
	// frames
	if view == "" && start == nil {
		if f := s.next(); f[0] == "view" {
			s.first = f
		} else {
			s.frames <- f
		}
	}
	return s
}

func (s *connection) close() { s.resp.Body.Close() }

// next returns the next frame or fails; a frame read before the connection ended comes first.
func (s *connection) next() []any {
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
		s.t.Fatalf("connection ended: %v", err)
	case <-time.After(5 * time.Second):
		s.t.Fatalf("timeout waiting for frame")
	}
	return nil
}

// nextTagged skips vouches until a frame with the tag arrives.
func (s *connection) nextTagged(tag string) []any {
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
func (s *connection) live() int64 {
	s.t.Helper()
	f := s.next()
	if f[0] != "live" {
		s.t.Fatalf("expected live frame, got %v", f)
	}
	return asInt(f[1])
}

func (s *connection) quiet() {
	s.t.Helper()
	select {
	case f := <-s.frames:
		if f.([]any)[0].(string) != "vouch" {
			s.t.Fatalf("expected silence, got %v", f)
		}
	case <-time.After(200 * time.Millisecond):
	}
}

// an edit's lifecycle, as its envelope carries it
const (
	normal = 0
	birth  = 1
	death  = 2
)

// edit is one decoded edit: its envelope, and its payload's operations in order, with its sets
// by key and its deletions
type edit struct {
	position   int64
	slice      string
	seq        int64
	id         []byte // the mutation id as it arrived
	mutation   string // the id as a test names it: its bytes without label's zeros
	servertime time.Time
	lifecycle  int64
	ops        []editOp
	sets       map[string]any
	dels       []string
}

// editOp is one operation of an edit's payload: a set of key to value, or a deletion of key
type editOp struct {
	del   bool
	key   string
	value any
}

// decodeEdit decodes an edit's wire array: the envelope, then the payload's items flat
func decodeEdit(v any) edit {
	arr := v.([]any)
	env := arr[0].([]any)
	e := edit{
		position:   asInt(env[0]),
		slice:      env[1].(string),
		seq:        asInt(env[2]),
		id:         env[3].([]byte),
		mutation:   strings.TrimRight(string(env[3].([]byte)), "\x00"),
		servertime: env[4].(time.Time),
		lifecycle:  asInt(env[5]),
		sets:       map[string]any{},
	}
	for i := 1; i < len(arr); {
		key := arr[i+1].(string)
		switch asInt(arr[i]) {
		case 0:
			e.ops = append(e.ops, editOp{key: key, value: arr[i+2]})
			e.sets[key] = arr[i+2]
			i += 3
		case 1:
			e.ops = append(e.ops, editOp{del: true, key: key})
			e.dels = append(e.dels, key)
			i += 2
		default:
			panic(fmt.Sprintf("unknown opcode %v", arr[i]))
		}
	}
	return e
}

// edits are the edits of an edits frame
func edits(f []any) []edit {
	var out []edit
	for _, v := range f[1].([]any) {
		out = append(out, decodeEdit(v))
	}
	return out
}

// field is a field of the value an edit sets at key, nil when it sets none
func (e edit) field(key, name string) any {
	v, _ := e.sets[key].(map[string]any)
	return v[name]
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

func TestMutationsOkReject(t *testing.T) {
	h := start(t)
	admin := h.admin()

	outs := h.mutations(admin, mut("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < 1 {
		t.Fatalf("expected ok, got %+v", outs[0])
	}
	first := outs[0].position

	// a resend is decided already, at or before the position it is answered with
	outs = h.mutations(admin, mut("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < first {
		t.Fatalf("expected ok at %d or later, got %+v", first, outs[0])
	}

	// decider rejection, structural rejection, and a later ack in one post
	outs = h.mutations(admin,
		mut("c2", "add-book", "id", "b1", "title", "Dune again"),
		mut("c3", "add-book", "id", "b2"),
		mut("c4", "add-book", "id", "b2", "title", "Emma"),
	)
	if outs[0].kind != "reject" || outs[0].reason != "book exists" {
		t.Fatalf("expected decider reject, got %+v", outs[0])
	}
	if outs[1].kind != "reject" || !strings.Contains(outs[1].reason, "$.title: missing required field") {
		t.Fatalf("expected structural reject, got %+v", outs[1])
	}
	if outs[2].kind != "ok" || outs[2].position <= first {
		t.Fatalf("expected ok after rejects, got %+v", outs[2])
	}

	// anonymous is a principal; the bundle says it may not add books
	outs = h.mutations("", mut("c5", "add-book", "id", "b3", "title", "Nope"))
	if outs[0].kind != "reject" || outs[0].reason != "unauthorized" {
		t.Fatalf("expected unauthorized, got %+v", outs[0])
	}
}

func TestSeriesDedup(t *testing.T) {
	h := start(t)
	admin := h.admin()
	dune := func(id string) mutation { return mut(id, "add-book", "id", "b1", "title", "Dune") }

	// two copies of one (S, n) in one group: the first runs, and the second sees its decision,
	// where running it again would have been rejected
	outs := h.mutations(admin, dune("c1").in("s1", 1), dune("c1").in("s1", 1))
	if outs[0].kind != "ok" || outs[1].kind != "ok" || outs[1].position != outs[0].position {
		t.Fatalf("copies in one group: %+v", outs)
	}

	// a reject is a decision: its resend is decided already, and its reason is gone
	if o := h.mutations(admin, dune("c2").in("s1", 2))[0]; o.kind != "reject" || o.reason != "book exists" {
		t.Fatalf("first reply of a reject: %+v", o)
	}
	if o := h.mutations(admin, dune("c2").in("s1", 2))[0]; o.kind != "ok" {
		t.Fatalf("resent reject: %+v", o)
	}

	// so is a conflict, and a mutation whose decider threw
	emma := mut("c3", "add-book", "id", "b3", "title", "Emma").in("s1", 3)
	if o := h.expecting(admin, emma, map[string]any{"book": 0}); o.kind != "conflict" {
		t.Fatalf("first reply of a conflict: %+v", o)
	}
	if o := h.mutations(admin, emma)[0]; o.kind != "ok" {
		t.Fatalf("resent conflict: %+v", o)
	}
	nul := mut("c4", "add-book", "id", "b1\x00x", "title", "Emma").in("s1", 4)
	if o := h.mutations(admin, nul)[0]; o.kind != "reject" || !strings.Contains(o.reason, "holds U+0000") {
		t.Fatalf("first reply of a decider's throw: %+v", o)
	}
	if o := h.mutations(admin, nul)[0]; o.kind != "ok" {
		t.Fatalf("resent decider's throw: %+v", o)
	}

	// numbers may skip, and a number at or below the mark is decided already, run or not
	head := h.accept(admin, mut("c5", "add-book", "id", "b5", "title", "Persuasion").in("s1", 10))
	if o := h.mutations(admin, mut("c6", "add-book", "id", "b6", "title", "Sanditon").in("s1", 7))[0]; o.kind != "ok" || o.position != head {
		t.Fatalf("a number below the mark: %+v", o)
	}

	// none of the resends reached the log: the book slice holds b1 and b5 alone
	evs, _, _ := h.editsRange(admin, "book", -1, -1, false, 100)
	if len(evs) != 2 || evs[0].sets["book!book:b1"] == nil || evs[1].sets["book!book:b5"] == nil {
		t.Fatalf("the book slice: %+v", evs)
	}

	// an unknown series runs from whatever number it starts at, and the numbers below it are
	// then decided already
	h.accept(admin, mut("c7", "add-book", "id", "b7", "title", "Emma").in("s2", 5))
	if o := h.mutations(admin, mut("c8", "add-book", "id", "b8", "title", "Sanditon").in("s2", 1))[0]; o.kind != "ok" {
		t.Fatalf("a number below an unknown series' first: %+v", o)
	}
	if o := h.mutations(admin, dune("c8").in("s2", 6))[0]; o.kind != "reject" {
		t.Fatalf("the next number of a series that started past 1: %+v", o)
	}

	// an unnumbered mutation runs every time it is sent
	for range 2 {
		if o := h.mutations(admin, dune("c9"))[0]; o.kind != "reject" || o.reason != "book exists" {
			t.Fatalf("an unnumbered mutation: %+v", o)
		}
	}
}

func TestLiveEdits(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))

	s := h.connect(admin, -1)
	if s.header.Get("PhaseLock-Protocol") != "1" || len(s.header.Get("PhaseLock-Epoch")) != 32 {
		t.Fatalf("bad headers: %v", s.header)
	}
	if s.header.Get("PhaseLock-View") == "" || s.header.Get("PhaseLock-Time") == "" {
		t.Fatalf("missing view or time header: %v", s.header)
	}
	live := s.live()

	// a new patron: one birth edit, its writes in key order, one frame
	pos := h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	evs := edits(s.nextTagged("edits"))
	if len(evs) != 1 {
		t.Fatalf("expected one edit, got %+v", evs)
	}
	e := evs[0]
	if e.slice != "patron:p1" || e.lifecycle != birth || e.seq != 1 || e.position != pos || pos != live+1 {
		t.Fatalf("the birth: live=%d ack=%d %+v", live, pos, e)
	}
	var keys []string
	for _, op := range e.ops {
		keys = append(keys, op.key)
	}
	if strings.Join(keys, ",") != "patron:p1!holds,patron:p1!messages,patron:p1!patron" ||
		e.field("patron:p1!patron", "name") != "Ann" {
		t.Fatalf("the birth's writes: %+v", e.ops)
	}
	if e.mutation != "c2" {
		t.Fatalf("the edit carries the mutation id: %+v", e)
	}
	if e.servertime.Before(time.Now().Add(-time.Minute)) || e.servertime.After(time.Now()) {
		t.Fatalf("servertime looks wrong: %+v", e)
	}

	// a mutation that edits two slices arrives as one frame, its edits at one position
	pos = h.accept(admin, mut("c3", "try-hold", "id", "h1", "book", "b1", "patron", "p1"))
	evs = edits(s.nextTagged("edits"))
	if len(evs) != 2 || evs[0].slice != "book" || evs[1].slice != "patron:p1" {
		t.Fatalf("expected book + patron edits, got %+v", evs)
	}
	for _, e := range evs {
		if e.mutation != "c3" || e.position != pos || e.lifecycle != normal || e.seq != 2 {
			t.Fatalf("the hold's edits: %+v", evs)
		}
	}
	if evs[0].field("book!book:b1", "hold") != true || evs[1].field("patron:p1!holds", "b1") != true {
		t.Fatalf("the hold's writes: %+v", evs)
	}
}

func TestLiveMultiMutationCommit(t *testing.T) {
	h := start(t)
	admin := h.admin()
	pos := h.accept(admin, mut("c0", "add-book", "id", "b0", "title", "Zero"))
	s := h.connect(admin, -1)
	if s.header.Get("PhaseLock-Position") != fmt.Sprint(pos) {
		t.Fatalf("PhaseLock-Position %q, want %d", s.header.Get("PhaseLock-Position"), pos)
	}
	s.nextTagged("live")
	// one POST, two mutations, one group commit: two frames on the wire
	body := append(mut("c1", "add-patron", "id", "p1", "name", "Ann").encode(nil),
		mut("c2", "add-patron", "id", "p2", "name", "Bob").encode(nil)...)
	if status, _, _ := h.do("POST", "/mutations", admin, body); status != 200 {
		t.Fatalf("mutations: status %d", status)
	}
	first := edits(s.nextTagged("edits"))
	second := edits(s.nextTagged("edits"))
	if first[0].slice != "patron:p1" || second[0].slice != "patron:p2" {
		t.Fatalf("expected both mutations live: %+v then %+v", first, second)
	}
}

func TestHistoryReplay(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	p2 := h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	p3 := h.accept(admin, mut("c3", "rename-patron", "id", "p1", "name", "Anne"))

	// from genesis: the book's birth, the patron's birth, the rename
	s := h.connect(admin, 0)
	var all []edit
	for len(all) < 3 {
		all = append(all, edits(s.nextTagged("edits"))...)
	}
	want := []string{"book", "patron:p1", "patron:p1"}
	wantSeq := []int64{1, 1, 2}
	wantLife := []int64{birth, birth, normal}
	for i, e := range all {
		if e.slice != want[i] || e.position != int64(i+1) || e.seq != wantSeq[i] || e.lifecycle != wantLife[i] {
			t.Fatalf("history[%d] = %+v, want slice %s pos %d seq %d", i, e, want[i], i+1, wantSeq[i])
		}
	}
	if s.live() != p3 {
		t.Fatalf("live frame should carry the position history ended at")
	}
	// then live
	h.accept(admin, mut("c4", "rename-patron", "id", "p1", "name", "Annie"))
	evs := edits(s.nextTagged("edits"))
	if evs[0].field("patron:p1!patron", "name") != "Annie" {
		t.Fatalf("expected live rename, got %+v", evs)
	}

	// resume after p2: only the rename, at p3
	s2 := h.connect(admin, p2)
	evs = edits(s2.nextTagged("edits"))
	if len(evs) != 1 || evs[0].position != p3 || evs[0].field("patron:p1!patron", "name") != "Anne" {
		t.Fatalf("resume from %d: got %+v", p2, evs)
	}
	s2.nextTagged("edits") // the live rename
	s2.live()
}

func TestViewAndWants(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c3", "add-patron", "id", "p2", "name", "Bob"))

	// a patron sees the book slice and its own slice, from history
	ann := h.token("p1")
	s := h.connect(ann, 0)
	var all []edit
	for len(all) < 2 {
		all = append(all, edits(s.nextTagged("edits"))...)
	}
	for _, e := range all {
		if e.slice != "book" && e.slice != "patron:p1" {
			t.Fatalf("leaked edit: %+v", e)
		}
	}
	// the replay ended on p2's invisible edit, which a vouch covers
	if f := s.next(); f[0] != "vouch" || asInt(f[1]) != 3 {
		t.Fatalf("expected a vouch at 3 past the last frame, got %v", f)
	}
	s.live()
	// other patrons' edits are invisible and produce no frame at all
	h.accept(admin, mut("c4", "rename-patron", "id", "p2", "name", "Robert"))
	s.quiet()
	h.accept(admin, mut("c5", "rename-patron", "id", "p1", "name", "Anne"))
	evs := edits(s.nextTagged("edits"))
	if evs[0].slice != "patron:p1" {
		t.Fatalf("expected own edit, got %+v", evs)
	}

	// wants narrow the view: the frame carries the grant cut down to the wants, and the token
	// hashes that set, so it differs from the unrestricted one
	s2 := h.connect(ann, -1, "book")
	if s2.first == nil || strings.Join(strs(s2.first[3]), ",") != "book" {
		t.Fatalf("narrowed view frame: %v", s2.first)
	}
	if s2.header.Get("PhaseLock-View") == s.header.Get("PhaseLock-View") {
		t.Fatalf("token should reflect the wants")
	}
	s2.live()
	h.accept(admin, mut("c6", "rename-patron", "id", "p1", "name", "Annie"))
	s2.quiet()
	h.accept(admin, mut("c7", "add-book", "id", "b2", "title", "Emma"))
	evs = edits(s2.nextTagged("edits"))
	if evs[0].slice != "book" {
		t.Fatalf("expected book edit, got %+v", evs)
	}

	// the narrower of a want and a grant is kept, and a want nothing grants
	// vanishes: patron:* against patron:p1 is patron:p1, author:* is nothing
	s4 := h.connect(ann, -1, "patron:*", "author:*")
	if s4.first == nil || strings.Join(strs(s4.first[3]), ",") != "patron:p1" {
		t.Fatalf("intersected view frame: %v", s4.first)
	}
	s4.live()
	s5 := h.connect(admin, -1, "patron:*")
	if s5.first == nil || strings.Join(strs(s5.first[3]), ",") != "patron:*" {
		t.Fatalf("admin view cut down to a family: %v", s5.first)
	}
	s5.live()

	// anonymous sees only the book slice
	s3 := h.connect("", -1)
	s3.live()
	h.accept(admin, mut("c8", "rename-patron", "id", "p1", "name", "Ann"))
	s3.quiet()
}

// a grant a connection holds always matches a fresh run of the grantor: a grantor that branches on
// a scan's next depends on what the scan handed it, and a full batch hands it nothing past its
// last key, so a write past that key changes neither
func TestAGrantThatBranchesOnAScansNextStaysWhatAFreshRunAnswers(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	peeker := h.token("peeker")
	s := h.connect(peeker, -1)
	s.live()
	if !slices.Contains(strs(s.first[3]), "patron:p1") {
		t.Fatalf("expected p1 granted, got %v", s.first)
	}

	// p2, past the one-row batch, goes; the held grant is what a fresh run, under another principal
	// of the same grant, answers
	h.accept(admin, mut("c3", "remove-patron", "id", "p2"))
	fresh := h.connect(h.token("peeker2"), -1)
	if got, want := fresh.header.Get("PhaseLock-View"), s.header.Get("PhaseLock-View"); got != want {
		t.Fatalf("a fresh run answers %v, the held view is %v", fresh.first, s.first)
	}
	s.quiet()

	// p1, inside the batch, goes too, and the grant follows
	h.accept(admin, mut("c4", "remove-patron", "id", "p1"))
	if f := s.nextTagged("view"); slices.Contains(strs(f[3]), "patron:p1") {
		t.Fatalf("expected p1 revoked, got %v", f)
	}
}

func TestGrantInvalidation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "create-account", "user", "p1", "password", "hunter2"))

	ann := h.token("p1")
	s := h.connect(ann, -1)
	s.live()
	token0 := s.header.Get("PhaseLock-View")
	// two connections of the same principal with narrower wants
	sb := h.connect(ann, -1, "book")
	sb.live()
	sp := h.connect(ann, -1, "patron:*")
	sp.live()

	// granting a view rewrites the grantor's read-set key: a view frame arrives,
	// before any edits of the same commit, carrying the whole set of selectors
	grantPos := h.accept(admin, mut("c4", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	f := s.nextTagged("view")
	if f[1].(string) == token0 {
		t.Fatalf("token should change on grant")
	}
	// the frame names the last position sent under the old view, the one before the grant's
	if asInt(f[2]) != grantPos-1 {
		t.Fatalf("view position %v, want %d", f[2], grantPos-1)
	}
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1,patron:p2" {
		t.Fatalf("grant frame selectors: %v", got)
	}
	token1 := f[1].(string)
	// the grant is inside one connection's wants and outside the other's: the
	// first gets its own view, the second's view is as it was, so no frame
	f = sp.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "patron:p1,patron:p2" {
		t.Fatalf("grant frame selectors under wants: %v", got)
	}
	sb.quiet()

	// now p2's edits flow
	h.accept(admin, mut("c5", "rename-patron", "id", "p2", "name", "Robert"))
	evs := edits(s.nextTagged("edits"))
	if evs[0].slice != "patron:p2" {
		t.Fatalf("expected the granted slice, got %+v", evs)
	}

	// a connection presenting a stale token gets the view frame first, with
	// the current selectors; one presenting the current token goes straight to live
	s2 := h.connectView(ann, -1, token0)
	v := s2.nextTagged("view")
	if v[1].(string) != token1 || fmt.Sprint(asInt(v[2])) != s2.header.Get("PhaseLock-Position") {
		t.Fatalf("first view frame: %v (connection token %v)", v, token1)
	}
	if got := strings.Join(strs(v[3]), ","); got != "book,patron:p1,patron:p2" {
		t.Fatalf("first view selectors: %v", got)
	}
	s2.resp.Body.Close()
	s3 := h.connectView(ann, -1, token1)
	if f := s3.next(); f[0] != "live" {
		t.Fatalf("current token: expected live first, got %v", f)
	}
	s3.resp.Body.Close()

	// revocation: a view frame, and the same commit's edits are withheld
	h.accept(admin, mut("c6", "revoke-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1" {
		t.Fatalf("revoke frame selectors: %v", got)
	}
	if f[1].(string) != token0 {
		t.Fatalf("token should return to the original after revoke")
	}
	h.accept(admin, mut("c7", "rename-patron", "id", "p2", "name", "Bob"))
	s.quiet()

	// selectors are never expanded: a family grant is one selector, and the client
	// learns the members from the blob
	h.accept(admin, mut("c8", "add-patron", "id", "p3", "name", "Cy"))
	h.accept(admin, mut("c9", "grant-view", "user", "p1", "prefix", "patron:*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:*,patron:p1" {
		t.Fatalf("wildcard grant frame selectors: %v", got)
	}
	tokenFamily := f[1].(string)
	// every change to the set is sent, even one that leaves coverage as it
	// was: patron:p2 is inside the held patron:*
	h.accept(admin, mut("c9b", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:*,patron:p1,patron:p2" || f[1].(string) == tokenFamily {
		t.Fatalf("grant inside a held family: %v", f)
	}
	h.accept(admin, mut("c9c", "revoke-view", "user", "p1", "prefix", "patron:p2!"))
	f = s.nextTagged("view")
	if f[1].(string) != tokenFamily {
		t.Fatalf("revoke inside a held family: %v", f)
	}
	h.accept(admin, mut("c10", "add-patron", "id", "p4", "name", "Di"))
	evs = edits(s.nextTagged("edits"))
	if evs[0].slice != "patron:p4" || evs[0].lifecycle != birth {
		t.Fatalf("births under a held wildcard arrive on the connection: %+v", evs)
	}
	h.accept(admin, mut("c11", "revoke-view", "user", "p1", "prefix", "patron:*"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:p1" {
		t.Fatalf("wildcard revoke frame selectors: %v", got)
	}
}

func TestAnErasureDeletesTheSlicesHistory(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "rename-patron", "id", "p1", "name", "Anne"))
	h.accept(admin, mut("c3", "add-patron", "id", "p2", "name", "Bob"))
	pos := h.accept(admin, mut("c4", "forget-patron", "id", "p1"))

	// the death is all that remains of the slice, at its seq; the other slice is untouched
	evs, _, _ := h.editsRange(admin, "patron:p1", -1, -1, false, 0)
	if len(evs) != 1 || evs[0].lifecycle != death || len(evs[0].ops) != 0 || evs[0].seq != 3 ||
		evs[0].position != pos {
		t.Fatalf("after erasure: %+v", evs)
	}
	if evs, _, _ := h.editsRange(admin, "patron:p2", -1, -1, false, 0); len(evs) != 1 {
		t.Fatalf("other slice: %+v", evs)
	}

	// the slice's state is gone, and its edit bytes are the death's alone: the /edits page of one
	// edit is the edit inside ["edits", [edit]], whose framing is 8 bytes
	dead := h.snapshot(admin, "patron:p1")
	_, _, page := h.do("GET", "/edits/patron:p1", admin, nil)
	if len(dead.records) != 0 || asInt(dead.header["edit_bytes"]) != int64(len(page)-8) {
		t.Fatalf("dead slice: %v %v, the death %d bytes", dead.records, dead.header, len(page)-8)
	}

	// a replay from the start delivers the death alone, whose seq shows the gap
	s := h.connect(admin, 0)
	var p1 []edit
	for {
		f := s.next()
		if f[0] == "live" {
			break
		}
		if f[0] != "edits" {
			continue
		}
		for _, e := range edits(f) {
			if e.slice == "patron:p1" {
				p1 = append(p1, e)
			}
		}
	}
	if len(p1) != 1 || p1[0].seq != 3 {
		t.Fatalf("replayed: %+v", p1)
	}

	// a rebirth takes the next seq, and a plain death keeps its slice's history
	h.accept(admin, mut("c5", "add-patron", "id", "p1", "name", "Ann"))
	evs, _, _ = h.editsRange(admin, "patron:p1", -1, -1, false, 0)
	if len(evs) != 2 || evs[1].lifecycle != birth || evs[1].seq != 4 {
		t.Fatalf("after rebirth: %+v", evs)
	}
	h.accept(admin, mut("c6", "remove-patron", "id", "p2"))
	if evs, _, _ := h.editsRange(admin, "patron:p2", -1, -1, false, 0); len(evs) != 2 {
		t.Fatalf("after a plain death: %+v", evs)
	}
}

func TestBirthDeath(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))

	// a bootstrap presents no token and gets the view frame first
	s := h.connect(admin, -1)
	if v := s.first; v == nil || strings.Join(strs(v[3]), ",") != "*" || asInt(v[2]) != 2 {
		t.Fatalf("first view frame: %v", v)
	}
	s.live()
	pos := h.accept(admin, mut("c3", "remove-patron", "id", "p1"))
	evs := edits(s.nextTagged("edits"))
	if len(evs) != 1 || evs[0].lifecycle != death || evs[0].slice != "patron:p1" || evs[0].position != pos ||
		len(evs[0].ops) != 0 {
		t.Fatalf("expected death, got %+v", evs)
	}
	if evs[0].seq != 2 {
		t.Fatalf("death takes the next seq: %+v", evs)
	}

	// the deleted slice is gone from the family's blob and its keys are gone
	if fam := h.snapshot(admin, "patron:*"); len(fam.slices) != 1 || fam.slices["patron:p2"] != 1 {
		t.Fatalf("slices after death: %v", fam.slices)
	}
	blob := h.snapshot(admin, "patron:p1")
	if len(blob.records) != 0 {
		t.Fatalf("deleted slice still has state: %v", blob.records)
	}

	// rebirth under the same name, its seqs dense across the death
	h.accept(admin, mut("c4", "add-patron", "id", "p1", "name", "Ann II"))
	evs = edits(s.nextTagged("edits"))
	if len(evs) != 1 || evs[0].lifecycle != birth || evs[0].field("patron:p1!patron", "name") != "Ann II" {
		t.Fatalf("expected rebirth, got %+v", evs)
	}
	if evs[0].seq != 3 {
		t.Fatalf("seq continues across lives: %+v", evs)
	}
	blob = h.snapshot(admin, "patron:p1")
	if blob.records["patron:p1!patron"] == nil {
		t.Fatalf("reborn slice has no state: %v", blob.records)
	}
}

// a mutation that deletes a slice and writes it again makes one edit, a birth, which clears the
// slice and carries only what was written after the deletion
func TestADeletionAndRewriteIsOneBirth(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c3", "try-hold", "id", "h1", "book", "b1", "patron", "p1"))
	s := h.connect(admin, -1)
	s.live()

	pos := h.accept(admin, mut("c4", "reset-patron", "id", "p1", "name", "Bea"))
	evs := edits(s.nextTagged("edits"))
	if len(evs) != 1 || evs[0].lifecycle != birth || evs[0].seq != 3 || evs[0].position != pos {
		t.Fatalf("the reset: %+v", evs)
	}
	if len(evs[0].dels) != 0 || len(evs[0].ops) != 3 || evs[0].field("patron:p1!patron", "name") != "Bea" {
		t.Fatalf("the reset's writes: %+v", evs[0].ops)
	}
	if holds := h.snapshot(admin, "patron:p1").records["patron:p1!holds"]; len(holds.(map[string]any)) != 0 {
		t.Fatalf("the hold survived the reset: %v", holds)
	}
}

// deleting a slice that is unborn, or already deleted, is no edit, and a mutation that edits
// nothing takes no position
func TestDeletingANonLiveSliceIsNoEdit(t *testing.T) {
	h := start(t)
	admin := h.admin()
	head := h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	if at := h.accept(admin, mut("c2", "close-shelf", "branch", "x")); at != head {
		t.Fatalf("closing an unborn shelf landed at %d after %d", at, head)
	}
	h.accept(admin, mut("c3", "lend", "branch", "x", "patron", "p1"))
	closed := h.accept(admin, mut("c4", "close-shelf", "branch", "x"))
	if at := h.accept(admin, mut("c5", "close-shelf", "branch", "x")); at != closed {
		t.Fatalf("closing a closed shelf landed at %d after %d", at, closed)
	}
	evs, _, _ := h.editsRange(admin, "shelf:x", -1, -1, false, 0)
	if len(evs) != 2 || evs[0].lifecycle != birth || evs[1].lifecycle != death {
		t.Fatalf("the shelf's edits: %+v", evs)
	}
}

// a key a mutation writes twice appears in its edit once, with its last value
func TestAKeyWrittenTwiceIsOneOperation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	pos := h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"first", "second"}))
	evs, _, _ := h.editsRange(admin, "patron:p1", pos-1, -1, false, 0)
	if len(evs) != 1 || len(evs[0].ops) != 1 || strings.Join(strs(evs[0].sets["patron:p1!messages"]), ",") != "first,second,own" {
		t.Fatalf("the notice's edit: %+v", evs)
	}
}

// a decider that throws after writing, or writes a key under no slice name, leaves nothing
func TestAFailedDeciderLeavesNothing(t *testing.T) {
	h := start(t)
	admin := h.admin()
	head := h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))

	// a key with a control character fails its write
	o := h.mutations(admin, mut("c2", "add-book", "id", "b\x01", "title", "Dune"))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "control character") {
		t.Fatalf("a key with a control character: %+v", o)
	}

	// a key under no slice name fails its write, after another write
	o = h.mutations(admin, mut("c5", "notify", "patron", "p1", "reasons", []any{"first", "set patron:p1,!messages"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "key patron:p1,!messages has no slice name before its first '!'") {
		t.Fatalf("a key under no slice name: %+v", o)
	}

	// so does deleting a slice by a malformed name
	o = h.mutations(admin, mut("c6", "notify", "patron", "p1", "reasons", []any{"first", "delete patron:p1/x"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "patron:p1/x is not a slice name") {
		t.Fatalf("deleting a malformed slice name: %+v", o)
	}

	// a rejection after writes, the plugin's requests among them
	o = h.mutations(admin, mut("c3", "notify", "patron", "p1", "reasons", []any{"x"}, "reject", true))[0]
	if o.kind != "reject" {
		t.Fatalf("a rejection after writes: %+v", o)
	}
	if at := h.accept(admin, mut("c4", "close-shelf", "branch", "none")); at != head {
		t.Fatalf("the failures took positions: %d after %d", at, head)
	}
	if m := h.snapshot(admin, "patron:p1").records["patron:p1!messages"]; len(m.([]any)) != 0 {
		t.Fatalf("a rejection's writes landed: %v", m)
	}
}

// a key of a declared slice that no key template names lands as inert bytes beside its slice's keys
func TestAKeyNoTemplateNamesLands(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"stray"}))
	records := h.snapshot(admin, "patron:p1").records
	if got := strs(records["patron:p1!stray"]); strings.Join(got, ",") != "stray" {
		t.Fatalf("the stray key: %v", records["patron:p1!stray"])
	}
	if got := strs(records["patron:p1!messages"]); strings.Join(got, ",") != "own" {
		t.Fatalf("the messages beside it: %v", records["patron:p1!messages"])
	}
}

// The write gate checks a key's slice, and a slice deleted, by the syntax of a slice name alone: a
// well-formed name lands whatever its family and number of parameters, and a malformed one fails
// its write.
func TestTheWriteGateChecksSliceNamesBySyntax(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))

	// a key in a family no slice type declares, and one under too many parameters, land
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"set nope:a!k", "set patron:p1,x!k"}))
	for slice, key := range map[string]string{"nope:a": "nope:a!k", "patron:p1,x": "patron:p1,x!k"} {
		if got := strs(h.snapshot(admin, slice).records[key]); strings.Join(got, ",") != "set "+key {
			t.Fatalf("the key %s: %v", key, got)
		}
	}

	// and their slices delete
	h.accept(admin, mut("c3", "notify", "patron", "p1", "reasons", []any{"delete nope:a", "delete patron:p1,x"}))
	for _, slice := range []string{"nope:a", "patron:p1,x"} {
		if b := h.snapshot(admin, slice); len(b.records) != 0 || len(b.slices) != 0 {
			t.Fatalf("the deleted slice %s: %v %v", slice, b.records, b.slices)
		}
	}

	// a key under no slice name fails its write
	for i, key := range []string{
		"patron:p1",      // no '!'
		"!seq:patron:p1", // an engine-reserved key
		":p1!k",          // an empty family
		"patron:!k",      // an empty parameter
		"patron:a,,b!k",  // an empty parameter between two others
		"patron:p/1!k",   // a character no parameter holds
		"patron:a.b,c!k", // a '.' in a parameter before the last
	} {
		o := h.mutations(admin, mut(fmt.Sprintf("k%d", i), "notify", "patron", "p1", "reasons", []any{"set " + key}))[0]
		if o.kind != "reject" || !strings.Contains(o.reason, "key "+key+" has no slice name before its first '!'") {
			t.Fatalf("writing %q: %+v", key, o)
		}
	}

	// and a malformed slice name fails its deletion
	for i, slice := range []string{"", "patron:", "patron:p1!", "patron:p/1", "patron:a.b,c", "patron:*"} {
		o := h.mutations(admin, mut(fmt.Sprintf("d%d", i), "notify", "patron", "p1", "reasons", []any{"delete " + slice}))[0]
		if o.kind != "reject" || !strings.Contains(o.reason, slice+" is not a slice name") {
			t.Fatalf("deleting %q: %+v", slice, o)
		}
	}
}

// snapshot blob parsing per the README ///////////////////////////////////

type blob struct {
	header   map[string]any
	slices   map[string]int64
	position int64
	records  map[string]any
	raw      map[string][]byte
	keys     []string
}

func (h *harness) snapshot(token, selector string) blob {
	h.t.Helper()
	status, hdr, out := h.do("GET", "/snapshot/"+selector, token, nil)
	if status != 200 {
		h.t.Fatalf("snapshot %s: status %d: %s", selector, status, out)
	}
	if hdr.Get("Content-Length") != fmt.Sprint(len(out)) {
		h.t.Fatalf("Content-Length %q for a %d-byte blob", hdr.Get("Content-Length"), len(out))
	}
	b := parseBlob(h.t, out)
	if fmt.Sprint(b.position) != hdr.Get("PhaseLock-Position") {
		h.t.Fatalf("position header %q != blob %d", hdr.Get("PhaseLock-Position"), b.position)
	}
	if hdr.Get("PhaseLock-Epoch") != b.header["epoch"] {
		h.t.Fatalf("epoch header %q != blob %v", hdr.Get("PhaseLock-Epoch"), b.header["epoch"])
	}
	// every slice with a key is in the slices map
	for _, k := range b.keys {
		if _, ok := b.slices[k[:strings.Index(k, "!")]]; !ok {
			h.t.Fatalf("key %s of a slice missing from %v", k, b.slices)
		}
	}
	return b
}

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// mpSize is the length of the msgpack value b starts with
func mpSize(t *testing.T, b []byte) int {
	t.Helper()
	c := b[0]
	be := func(n int) int {
		v := 0
		for i := 1; i <= n; i++ {
			v = v<<8 | int(b[i])
		}
		return v
	}
	items := func(at, n int) int {
		for range n {
			at += mpSize(t, b[at:])
		}
		return at
	}
	switch {
	case c <= 0x7f, c >= 0xe0, c == 0xc0, c == 0xc2, c == 0xc3:
		return 1
	case c >= 0xa0 && c <= 0xbf:
		return 1 + int(c&0x1f)
	case c >= 0x90 && c <= 0x9f:
		return items(1, int(c&0x0f))
	case c >= 0x80 && c <= 0x8f:
		return items(1, 2*int(c&0x0f))
	}
	switch c {
	case 0xcc, 0xd0:
		return 2
	case 0xcd, 0xd1:
		return 3
	case 0xca, 0xce, 0xd2:
		return 5
	case 0xcb, 0xcf, 0xd3:
		return 9
	case 0xd9, 0xc4:
		return 2 + be(1)
	case 0xda, 0xc5:
		return 3 + be(2)
	case 0xdb, 0xc6:
		return 5 + be(4)
	case 0xd6:
		return 6
	case 0xd7:
		return 10
	case 0xc7:
		return 3 + be(1)
	case 0xdc:
		return items(3, be(2))
	case 0xdd:
		return items(5, be(4))
	case 0xde:
		return items(3, 2*be(2))
	case 0xdf:
		return items(5, 2*be(4))
	}
	t.Fatalf("msgpack byte %x", c)
	return 0
}

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
	out := blob{header: header, slices: map[string]int64{}, position: asInt(header["position"]), records: map[string]any{}, raw: map[string][]byte{}}
	for name, seq := range header["slices"].(map[string]any) {
		out.slices[name] = asInt(seq)
	}

	// the set operations, back to back, up to the end marker
	p := 13 + int(hlen)
	opsStart := p
	var count uint32
	for binary.BigEndian.Uint32(b[p:]) != 0xFFFFFFFF {
		if b[p] != 0 {
			t.Fatalf("opcode %x in a snapshot", b[p])
		}
		p++
		kn := mpSize(t, b[p:])
		key := mpDecodeOne(t, b[p:p+kn]).(string)
		p += kn
		vn := mpSize(t, b[p:])
		val := b[p : p+vn]
		p += vn
		out.records[key] = mpDecodeOne(t, val)
		out.raw[key] = val
		out.keys = append(out.keys, key)
		count++
	}
	opsEnd := p

	// the footer: the count, the hash of the operations' bytes, and its crc
	footer := b[p+4:]
	if len(footer) != 16 {
		t.Fatalf("footer length %d", len(footer))
	}
	if binary.BigEndian.Uint32(footer[0:4]) != count {
		t.Fatalf("footer count %d != %d", binary.BigEndian.Uint32(footer[0:4]), count)
	}
	if binary.BigEndian.Uint64(footer[4:12]) != fnv1a(b[opsStart:opsEnd]) {
		t.Fatalf("content hash mismatch")
	}
	if binary.BigEndian.Uint32(footer[12:16]) != crc32.Checksum(footer[0:12], castagnoli) {
		t.Fatalf("footer crc mismatch")
	}
	if !sort.StringsAreSorted(out.keys) {
		t.Fatalf("keys not sorted: %v", out.keys)
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

// a snapshot's visible is the last position any slice under its selector changed, a dead slice's
// death included and other slices' edits not, so a client caught up to it holds what the blob does
func TestASnapshotsVisibleIsTheLastChangeUnderItsSelector(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	renamed := h.accept(admin, mut("c2", "rename-patron", "id", "p1", "name", "Anne"))
	h.accept(admin, mut("c3", "add-patron", "id", "p2", "name", "Bob"))
	removed := h.accept(admin, mut("c4", "remove-patron", "id", "p2"))
	head := h.accept(admin, mut("c5", "add-book", "id", "b1", "title", "Dune"))

	// the family's last change is p2's death, which its header does not name
	fam := h.snapshot(admin, "patron:*")
	if asInt(fam.header["visible"]) != removed || fam.position != head {
		t.Fatalf("family: visible %v, position %d; want %d, %d", fam.header["visible"], fam.position,
			removed, head)
	}
	if _, ok := fam.slices["patron:p2"]; ok {
		t.Fatalf("the dead p2 is named: %v", fam.slices)
	}

	// an exact selector's is its own slice's last edit, live or dead
	if p1 := h.snapshot(admin, "patron:p1"); asInt(p1.header["visible"]) != renamed {
		t.Fatalf("p1: visible %v, want %d", p1.header["visible"], renamed)
	}
	if p2 := h.snapshot(admin, "patron:p2"); asInt(p2.header["visible"]) != removed {
		t.Fatalf("p2: visible %v, want %d", p2.header["visible"], removed)
	}

	// and a slice never born has none
	if p9 := h.snapshot(admin, "patron:p9"); asInt(p9.header["visible"]) != 0 {
		t.Fatalf("p9: visible %v", p9.header["visible"])
	}
}

func TestSnapshots(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c3", "rename-patron", "id", "p1", "name", "Anne"))
	pos := h.accept(admin, mut("c4", "add-patron", "id", "p2", "name", "Bob"))

	one := h.snapshot(admin, "patron:p1")
	if one.header["selector"] != "patron:p1" || one.position < pos || one.header["epoch"] != h.epoch() {
		t.Fatalf("header: %v", one.header)
	}

	// the snapshot response's epoch, which the blob's matches, is the stream's
	if epoch := h.connect(admin, -1).header.Get("PhaseLock-Epoch"); one.header["epoch"] != epoch {
		t.Fatalf("snapshot epoch %v, stream epoch %q", one.header["epoch"], epoch)
	}
	if strings.Join(one.keys, ",") != "patron:p1!holds,patron:p1!messages,patron:p1!patron" {
		t.Fatalf("keys: %v", one.keys)
	}
	if one.records["patron:p1!patron"].(map[string]any)["name"] != "Anne" {
		t.Fatalf("value: %v", one.records)
	}

	// a family blob holds every slice, contiguous per slice, and names every live member with
	// its seq
	fam := h.snapshot(admin, "patron:*")
	if len(fam.keys) != 6 || !strings.HasPrefix(fam.keys[0], "patron:p1!") || !strings.HasPrefix(fam.keys[5], "patron:p2!") {
		t.Fatalf("family keys: %v", fam.keys)
	}
	if len(fam.slices) != 2 || fam.slices["patron:p1"] != 2 || fam.slices["patron:p2"] != 1 {
		t.Fatalf("family slices: %v", fam.slices)
	}
	if one.slices["patron:p1"] != 2 || len(one.slices) != 1 {
		t.Fatalf("exact slices: %v", one.slices)
	}

	// the selector "*" is everything
	all := h.snapshot(admin, "*")
	if len(all.keys) != 7 || len(all.slices) != 3 || all.header["selector"] != "*" {
		t.Fatalf("everything: %d keys, slices %v", len(all.keys), all.slices)
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
	later := h.accept(admin, mut("c5", "add-book", "id", "b2", "title", "Emma"))
	book2 := h.snapshot(admin, "book")
	if len(book2.keys) != 2 || book2.position < later {
		t.Fatalf("book after write: %v @ %d", book2.keys, book2.position)
	}

	// a value travels in store format: the blob holds the bytes the edit carried
	evs, _, _ := h.editsRange(admin, "book", later-1, -1, false, 0)
	if !reflect.DeepEqual(mpDecodeOne(t, book2.raw["book!book:b2"]), evs[0].sets["book!book:b2"]) {
		t.Fatalf("the blob's value %v, the edit's %v", book2.records["book!book:b2"], evs[0].sets)
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
	h.accept(admin, mut("c1", "add-patron", "id", "ann", "name", "Ann"))

	// anyone may create an account; the password is hashed at intake
	h.accept("", mut("c2", "create-account", "user", "ann", "password", "hunter2"))
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
	outs := h.mutations(tok, mut("c3", "rename-patron", "id", "ann", "name", "Anne"))
	if outs[0].kind != "ok" {
		t.Fatalf("rename as ann: %+v", outs[0])
	}
	outs = h.mutations(tok, mut("c4", "add-book", "id", "b1", "title", "Dune"))
	if outs[0].kind != "reject" || outs[0].reason != "unauthorized" {
		t.Fatalf("ann is not an admin: %+v", outs[0])
	}
	s := h.connect(tok, -1)
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

	// password change through the ordinary mutation path, as the user
	h.accept(tok2, mut("c5", "set-password", "user", "ann", "password", "correct horse"))
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

	// logout everywhere: existing tokens die on mutations, connections, refresh
	h.accept(tok2, mut("c6", "revoke-sessions", "user", "ann"))
	if status, _ := h.mutationsStatus(tok2, mut("c7", "rename-patron", "id", "ann", "name", "x")); status != 401 {
		t.Fatalf("stale token accepted for mutations: %d", status)
	}
	req, _ := http.NewRequest("GET", h.web.URL+"/stream?since=-1", nil)
	req.Header.Set("Authorization", "Bearer "+tok2)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("stale token accepted for a connection: %d", resp.StatusCode)
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
	h.accept(tok3, mut("c8", "rename-patron", "id", "ann", "name", "Ann"))

	// an account an admin creates as an admin is one
	h.accept(admin, mut("c9", "create-account", "user", "boss", "password", "pw", "admin", true))
	status, _, out = h.do("POST", "/auth/token", "", mpEncode(map[string]any{
		"kind": "password", "identity": "boss", "password": "pw",
	}))
	if status != 200 {
		t.Fatalf("boss login: %d", status)
	}
	boss := mpDecodeOne(t, out).(map[string]any)["token"].(string)
	h.accept(boss, mut("c10", "add-book", "id", "b1", "title", "Dune"))
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

// works answers whether a token is accepted for a mutation
func (h *harness) works(token string) bool {
	h.t.Helper()
	status, _ := h.mutationsStatus(token, mut("w-"+token[len(token)-8:], "rename-patron", "id", "nobody", "name", "x"))
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
		if status, _ := h.mutationsStatus(f, mut("f", "rename-patron", "id", "x", "name", "x")); status != 401 {
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

// a mutation's answer reports the database's own time, as Server-Timing
func TestMutationsServerTiming(t *testing.T) {
	h := start(t)
	body := mut("c1", "add-patron", "id", "p1", "name", "Ann").encode(nil)
	status, header, _ := h.do("POST", "/mutations", h.admin(), body)
	if status != 200 {
		t.Fatalf("mutations: status %d", status)
	}
	if st := header.Get("Server-Timing"); !regexp.MustCompile(`^db;dur=\d+\.\d\d$`).MatchString(st) {
		t.Fatalf("Server-Timing: %q", st)
	}
}

// the routes answer under the path prefix and nowhere else, and a malformed prefix is refused
func TestPathPrefix(t *testing.T) {
	h := startWith(t, t.Context(), Options{PathPrefix: "/phaselock"})
	body := mpEncode(map[string]any{"kind": "dev", "identity": "root"})
	for path, want := range map[string]int{"/phaselock/auth/token": 200, "/auth/token": 404} {
		resp, err := http.Post(h.web.URL+path, "application/msgpack", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s: %d, want %d", path, resp.StatusCode, want)
		}
	}
	for _, bad := range []string{"phaselock", "/phaselock/", "/"} {
		_, err := Open(t.Context(), Options{DataDir: t.TempDir(), Bundle: filepath.Join("testdata", "bundle.js"),
			PathPrefix: bad})
		if err == nil {
			t.Fatalf("path prefix %q was accepted", bad)
		}
	}
}

func TestRestartKeepsEverything(t *testing.T) {
	dir := t.TempDir()
	h := startIn(t, dir)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	pos := h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann").in("s1", 1))
	h.accept("", mut("c3", "create-account", "user", "p1", "password", "pw"))
	h.stop()

	h = startIn(t, dir)
	admin = h.admin()
	// dedup survives: the resend is not run again, which the decider would reject
	outs := h.mutations(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann").in("s1", 1))
	if outs[0].kind != "ok" || outs[0].position < pos {
		t.Fatalf("dedup lost across restart: %+v", outs[0])
	}
	// history survives and positions continue
	s := h.connect(admin, 0)
	var all []edit
	for len(all) < 3 {
		all = append(all, edits(s.nextTagged("edits"))...)
	}
	if all[2].slice != "account:p1" || all[2].position != 3 {
		t.Fatalf("history after restart: %+v", all)
	}
	next := h.accept(admin, mut("c4", "add-patron", "id", "p2", "name", "Bob"))
	if next != 4 {
		t.Fatalf("positions should continue at 4: got %d", next)
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
// the connection handler makes with the view registered and the connection not yet streaming, and
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
	h.accept(admin, mut("c0", "add-patron", "id", "p0", "name", "Ann"))

	// a commit lands after the view is registered and before the connection streams, inside
	// the view frame's write
	ctx, cancel := context.WithCancel(t.Context())
	var pos int64
	w := &injectingWriter{t: t, header: http.Header{}, cancel: cancel, inject: func() {
		pos = h.accept(admin, mut("c1", "rename-patron", "id", "p0", "name", "Anne"))
	}}
	req := httptest.NewRequest("GET", "/stream?since=-1", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+admin)
	h.srv.handleStream(w, req)

	// the view frame, then the commit's edits, then live at its position
	if len(w.frames) != 3 {
		t.Fatalf("expected view, edits, live, got %v", w.frames)
	}
	if w.frames[0][0] != "view" || asInt(w.frames[0][2]) != pos-1 {
		t.Fatalf("expected the view at %d, got %v", pos-1, w.frames[0])
	}
	if w.frames[1][0] != "edits" || edits(w.frames[1])[0].position != pos {
		t.Fatalf("expected the edits at %d, got %v", pos, w.frames[1])
	}
	if w.frames[2][0] != "live" || asInt(w.frames[2][1]) != pos {
		t.Fatalf("expected live at %d, got %v", pos, w.frames[2])
	}
}

func TestColdReplayKeepsMutationsWhole(t *testing.T) {
	h := startWith(t, t.Context(), Options{MaxMutations: coldBatch})
	admin := h.admin()

	// a book and a hold on it per pair of positions, so the hold at coldBatch+1, which edits two
	// slices, opens the replay's second window
	h.accept(admin, mut("c0", "add-patron", "id", "p0", "name", "Ann"))
	var muts []mutation
	for i := 1; i <= coldBatch/2+1; i++ {
		book := fmt.Sprintf("b%d", i)
		muts = append(muts, mut("a"+book, "add-book", "id", book, "title", book),
			mut("h"+book, "try-hold", "id", book, "book", book, "patron", "p0"))
	}
	for len(muts) > 0 {
		n := min(len(muts), coldBatch)
		h.mutations(admin, muts[:n]...)
		muts = muts[n:]
	}

	// every frame is one whole mutation: its edits share a position and an id no other frame has
	s := h.connect(admin, 0)
	seen := map[string]bool{}
	whole := false
	for {
		f := s.next()
		if f[0] == "live" {
			break
		}
		if f[0] != "edits" {
			continue
		}
		evs := edits(f)
		id := evs[0].mutation
		if seen[id] {
			t.Fatalf("mutation %s split across frames", id)
		}
		seen[id] = true
		for _, e := range evs {
			if e.mutation != id || e.position != evs[0].position {
				t.Fatalf("frame mixes mutations: %+v", evs)
			}
		}
		if evs[0].position == coldBatch+1 && len(evs) == 2 {
			whole = true
		}
	}
	if !whole {
		t.Fatalf("no hold of two edits at position %d", coldBatch+1)
	}
}

func TestLongCatchupNoOverflow(t *testing.T) {
	h := startWith(t, t.Context(), Options{MaxMutations: 1500})
	admin := h.admin()
	name := strings.Repeat("x", 2000)
	var muts []mutation
	for i := 0; i < 1500; i++ {
		muts = append(muts, mut(fmt.Sprintf("h%d", i), "add-patron", "id", fmt.Sprintf("p%d", i), "name", name))
	}
	outs := h.mutations(admin, muts...)
	history := outs[len(outs)-1].position
	if history != 1500 {
		t.Fatalf("expected 1500 history positions, got %d", history)
	}

	// the reader stays paused so the cold catchup blocks on the socket
	// while more commits land
	startReading := make(chan struct{})
	s := h.connectPaused(admin, 0, startReading)
	var last int64
	for i := 0; i < 300; i++ {
		last = h.accept(admin, mut(fmt.Sprintf("l%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i)))
	}
	close(startReading)

	// every position arrives exactly once, in order, across cold
	// catchup, hot catchup, live frame, and live frames
	next := int64(1)
	sawLive := false
	for next <= last {
		f := s.next()
		switch f[0] {
		case "edits":
			for _, e := range edits(f) {
				if e.position != next {
					t.Fatalf("expected position %d, got %d (live seen: %v)", next, e.position, sawLive)
				}
			}
			next++
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
	pos := h.accept(admin, mut("final", "rename-patron", "id", "p1", "name", "done"))
	if evs := edits(s.nextTagged("edits")); evs[0].position != pos {
		t.Fatalf("expected live edit at %d, got %+v", pos, evs)
	}
}

// a vouch at N follows every edit at or below N that the connection can see
func TestAVouchNeverOvertakesAnEditItCovers(t *testing.T) {
	// the dispatcher holds the commit it is armed for before pushing its frames, while
	// heartbeats keep firing
	var armed atomic.Bool
	held := make(chan int64)
	release := make(chan struct{})
	h := startWith(t, t.Context(), Options{heartbeat: time.Millisecond,
		beforePush: func(position uint64) {
			if armed.CompareAndSwap(true, false) {
				held <- int64(position)
				<-release
			}
		}})
	free := sync.OnceFunc(func() { close(release) })
	t.Cleanup(free)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	s := h.connect(h.token("p1"), -1)

	// every frame read is checked against the highest vouch before it
	vouched := int64(-1)
	read := func() []any {
		t.Helper()
		f := s.next()
		switch f[0] {
		case "vouch", "live":
			vouched = max(vouched, asInt(f[1]))
		case "edits":
			if at := edits(f)[0].position; at <= vouched {
				t.Fatalf("an edits frame at %d follows a vouch at %d", at, vouched)
			}
		}
		return f
	}
	for read()[0] != "live" {
	}

	// a visible commit is held before its frames are pushed, for many heartbeats
	armed.Store(true)
	posted := make(chan error, 1)
	go func() {
		body := mut("c3", "rename-patron", "id", "p1", "name", "Anne").encode(nil)
		req, _ := http.NewRequest("POST", h.web.URL+"/mutations", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+admin)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		posted <- err
	}()
	pos := <-held
	time.Sleep(50 * time.Millisecond)
	free()

	// its edits arrive after no vouch at or above their position
	for f := read(); f[0] != "edits" || edits(f)[0].position != pos; f = read() {
	}
	if err := <-posted; err != nil {
		t.Fatal(err)
	}

	// a commit the connection cannot see is vouched for on a heartbeat
	invisible := h.accept(admin, mut("c4", "rename-patron", "id", "p2", "name", "Robert"))
	for i := 0; vouched < invisible; i++ {
		if i == 1000 {
			t.Fatalf("no vouch at %d, the last at %d", invisible, vouched)
		}
		if f := read(); f[0] == "edits" {
			t.Fatalf("an invisible commit's edits: %v", f)
		}
	}
	if vouched != invisible {
		t.Fatalf("vouched %d past the head %d", vouched, invisible)
	}
}

// a commit takes one place in a connection's backlog, however many mutations it carries
func TestACommitOfMoreMutationsThanTheBacklogHoldsKeepsItsConnection(t *testing.T) {
	h := startWith(t, t.Context(), Options{MaxStreamBacklog: 1})
	admin := h.admin()
	s := h.connect(admin, -1)
	s.live()

	// one request's mutations commit together, each in its own edits frame
	outs := h.mutations(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"),
		mut("c2", "add-patron", "id", "p2", "name", "Bob"),
		mut("c3", "add-patron", "id", "p3", "name", "Cy"))
	for _, o := range outs {
		if at := edits(s.nextTagged("edits"))[0].position; at != o.position {
			t.Fatalf("expected the edits at %d, got %d", o.position, at)
		}
	}

	// the connection is still live
	pos := h.accept(admin, mut("c4", "rename-patron", "id", "p1", "name", "Anne"))
	if at := edits(s.nextTagged("edits"))[0].position; at != pos {
		t.Fatalf("expected the edits at %d, got %d", pos, at)
	}
}

// a connection whose backlog is full when a commit comes ends with an overflow, after what was
// queued before it, and the commits after it pass the connection by
func TestAConnectionThatCannotKeepUpEndsWithAnOverflow(t *testing.T) {
	// the connection is held as it wakes for the commit it is armed for, before it takes its backlog
	var armed atomic.Bool
	held := make(chan struct{})
	release := make(chan struct{})
	h := startWith(t, t.Context(), Options{MaxStreamBacklog: 1, beforeForward: func() {
		if armed.CompareAndSwap(true, false) {
			held <- struct{}{}
			<-release
		}
	}})
	free := sync.OnceFunc(func() { close(release) })
	t.Cleanup(free)
	admin := h.admin()
	s := h.connect(admin, -1)
	s.live()

	// while the connection is held with one commit in its backlog, the next overflows it, and the
	// one after that finds it ended
	armed.Store(true)
	first := h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	<-held
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "add-patron", "id", "p3", "name", "Cy"))
	free()

	// the connection sends the first commit's edits, then the overflow
	if at := edits(s.nextTagged("edits"))[0].position; at != first {
		t.Fatalf("expected the edits at %d, got %d", first, at)
	}
	if f := s.nextTagged("end"); asInt(f[1]) != endOverflow {
		t.Fatalf("expected an overflow, got %v", f)
	}

	// the server goes on
	h.accept(admin, mut("c4", "add-patron", "id", "p4", "name", "Di"))
}

// a view change reaches the client ahead of the edits of the commit that caused it, even when the
// view changes while the connection switches from its replay to streaming
func TestAViewFrameLeadsTheEditsItGrantsIntoStreaming(t *testing.T) {
	// the connection pauses once its replay is done, before it switches to streaming
	paused := make(chan struct{}, 1)
	resume := make(chan struct{})
	h := startWith(t, t.Context(), Options{beforeStreaming: func() {
		paused <- struct{}{}
		<-resume
	}})
	t.Cleanup(sync.OnceFunc(func() { close(resume) }))
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	s := h.connect(h.token("p1"), -1)

	// while it is paused, a lend births a shelf and grants it to the patron in one mutation
	<-paused
	pos := h.accept(admin, mut("c2", "lend", "branch", "x", "patron", "p1"))
	resume <- struct{}{}

	// the view frame granting the shelf comes before the shelf's edits, which the hot catchup
	// replays, at the last position the replay sent, the one before the lend's
	granted, shelved := false, false
	for f := s.next(); f[0] != "live"; f = s.next() {
		switch f[0] {
		case "view":
			if asInt(f[2]) != pos-1 || !slices.Contains(strs(f[3]), "shelf:x") {
				t.Fatalf("expected the view at %d granting shelf:x, got %v", pos-1, f)
			}
			granted = true
		case "edits":
			if e := edits(f)[0]; e.slice == "shelf:x" {
				if !granted {
					t.Fatalf("the shelf's edits at %d came before its grant", e.position)
				}
				shelved = true
			}
		}
	}
	if !shelved {
		t.Fatalf("the shelf's edits never came")
	}
}

// a view frame's position is the last position the connection sent under the previous view: on a
// reconnect whose token is stale, nothing has been sent yet, so it is the since presented, and
// the replay after it is filtered by the new view
func TestAStaleTokensViewFrameIsAtTheSincePresented(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	since := h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "lend", "branch", "x", "patron", "p1"))
	s := h.connectView(h.token("p1"), since, "stale")
	f := s.next()
	if f[0] != "view" || asInt(f[2]) != since || !slices.Contains(strs(f[3]), "shelf:x") {
		t.Fatalf("expected the view at %d granting shelf:x, got %v", since, f)
	}
	if e := edits(s.nextTagged("edits"))[0]; e.slice != "shelf:x" || e.position != since+1 {
		t.Fatalf("expected the replay to bring the shelf at %d under the new view, got %+v",
			since+1, e)
	}
}

// a live view frame's position is the last position before the batch that changed the view, past
// commits the old view could not see, which no frame told the connection of: the new view's edits
// at or below it are the backfill's, through its tail
func TestALiveViewFramesPositionPassesCommitsTheOldViewCouldNotSee(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	s := h.connect(h.token("p1"), -1)
	s.live()

	// a commit the connection cannot see, then a lend that grants it a shelf
	unseen := h.accept(admin, mut("c3", "rename-patron", "id", "p2", "name", "Robert"))
	h.accept(admin, mut("c4", "lend", "branch", "x", "patron", "p1"))
	f := s.nextTagged("view")
	if asInt(f[2]) != unseen || !slices.Contains(strs(f[3]), "shelf:x") {
		t.Fatalf("expected the view at %d granting shelf:x, got %v", unseen, f)
	}
}

// together runs the calls with the core's batches held, each started once the one before it has
// queued its request, so their requests land in one batch, in order; it answers once every call
// has returned
func (h *harness) together(calls ...func()) {
	h.t.Helper()
	h.srv.core.holdBatches(true)
	var wg sync.WaitGroup
	for i, call := range calls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			call()
		}()
		deadline := time.Now().Add(5 * time.Second)
		for h.srv.core.queued() < i+1 {
			if time.Now().After(deadline) {
				h.srv.core.holdBatches(false)
				h.t.Fatalf("call %d queued no request", i)
			}
			time.Sleep(time.Millisecond)
		}
	}
	h.srv.core.holdBatches(false)
	wg.Wait()
}

// a connection registered in the batch whose writes grant it a slice streams under the view as of
// the batch's end, the slice included
func TestARegistrationInTheBatchThatGrantsItASliceGetsTheSlice(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-book", "id", "b1", "title", "Dune"))

	p1 := h.token("p1")
	var s *connection
	h.together(
		func() { s = h.connect(p1, -1) },
		func() { h.accept(admin, mut("c3", "lend", "branch", "x", "patron", "p1")) },
	)
	if f := s.first; f == nil || !slices.Contains(strs(f[3]), "shelf:x") {
		t.Fatalf("expected the view granting shelf:x, got %v", f)
	}
	s.live()

	// the shelf's edits flow
	h.accept(admin, mut("c4", "shelve", "branch", "x", "book", "b1"))
	if e := edits(s.nextTagged("edits"))[0]; e.slice != "shelf:x" {
		t.Fatalf("expected the shelf's edit, got %+v", e)
	}
}

// a connection registered in the batch whose writes revoke one of its slices streams under the view
// as of the batch's end, and none of that slice's later edits reach it
func TestARegistrationInTheBatchThatRevokesASliceNeverGetsItsEdits(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("c3", "lend", "branch", "x", "patron", "p1"))

	p1 := h.token("p1")
	var s *connection
	h.together(
		func() { s = h.connect(p1, -1) },
		func() { h.accept(admin, mut("c4", "close-shelf", "branch", "x")) },
	)
	if f := s.first; f == nil || slices.Contains(strs(f[3]), "shelf:x") {
		t.Fatalf("expected the view without shelf:x, got %v", f)
	}
	s.live()

	// the shelf, written again with no lend, is no longer the patron's
	h.accept(admin, mut("c5", "shelve", "branch", "x", "book", "b1"))
	s.quiet()
}

// permissions ///////////////////////////////////////////////////////////////

// a revocation ends the token's connections ahead of the edits of its batch, and Go refuses the
// token from then on without a trip to the writer
func TestARevocationEndsTheTokensConnections(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "ann", "name", "Ann"))
	tok := h.signUp("ann", "hunter2")
	s := h.connect(tok, -1)
	s.live()

	h.together(
		func() { h.accept(admin, mut("c2", "revoke-sessions", "user", "ann")) },
		func() { h.accept(admin, mut("c3", "rename-patron", "id", "ann", "name", "Anne")) },
	)
	if f := s.nextTagged("end"); asInt(f[1]) != endRevoked || f[2] != "token revoked" {
		t.Fatalf("expected the revocation's end, got %v", f)
	}

	// the writer takes no request while the token is refused
	h.srv.core.holdBatches(true)
	status, _ := h.mutationsStatus(tok, mut("c4", "rename-patron", "id", "ann", "name", "x"))
	queued := h.srv.core.queued()
	h.srv.core.holdBatches(false)
	if status != 401 || queued != 0 {
		t.Fatalf("a revoked token: status %d, %d queued", status, queued)
	}

	// a fresh sign-in carries the new generation
	h.accept(h.signIn("ann", "hunter2"), mut("c5", "rename-patron", "id", "ann", "name", "Ann"))
}

// a revocation applies to the mutations after it in its own batch
func TestARevocationStopsTheMutationsAfterItInItsBatch(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "ann", "name", "Ann"))
	tok := h.signUp("ann", "hunter2")

	// the writer holds ann's account from her first mutation, so the revocation must reach it
	h.accept(tok, mut("c2", "rename-patron", "id", "ann", "name", "Anne"))
	var status int
	h.together(
		func() { h.accept(admin, mut("c3", "revoke-sessions", "user", "ann")) },
		func() { status, _ = h.mutationsStatus(tok, mut("c4", "rename-patron", "id", "ann", "name", "x")) },
	)
	if status != 401 {
		t.Fatalf("a token revoked earlier in the batch: %d", status)
	}
}

// a grant applies to the expectations after it in its own batch
func TestAGrantCoversTheExpectationsAfterItInItsBatch(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")

	// the writer holds ann's grant from her first expectation, so the grant must reach it
	if o := h.expecting(ann, mut("c4", "rename-patron", "id", "p1", "name", "y"),
		map[string]any{"patron:p2": 99}); o.kind != "reject" {
		t.Fatalf("an expectation outside the grant: %+v", o)
	}
	var o outcome
	h.together(
		func() { h.accept(admin, mut("c5", "grant-view", "user", "p1", "prefix", "patron:p2!")) },
		func() {
			o = h.expecting(ann, mut("c6", "rename-patron", "id", "p1", "name", "x"),
				map[string]any{"patron:p2": 99})
		},
	)
	if o.kind != "conflict" {
		t.Fatalf("an expectation the batch's grant covers: %+v", o)
	}
}

// a connection ends shortly before its token expires, while its client can still refresh it
func TestAStreamEndsBeforeItsTokenExpires(t *testing.T) {
	c := &clock{t: time.Now()}
	h := startWith(t, t.Context(), Options{now: c.now})
	tok := h.token("p1")
	_, claims := tokenParts(t, tok)
	c.set(time.Unix(asInt(claims["exp"]), 0).Add(-expiryLead - 300*time.Millisecond))

	s := h.connect(tok, -1)
	s.live()
	if f := s.nextTagged("end"); asInt(f[1]) != endRevoked || f[2] != "token expiring" {
		t.Fatalf("expected the expiry's end, got %v", f)
	}
	if status, _, out := h.do("POST", "/auth/token", tok, mpEncode(map[string]any{"kind": "refresh"})); status != 200 {
		t.Fatalf("refreshing the token after the end: %d %s", status, out)
	}
}

// /snapshot and /edits check the grant as of what they read, so a revocation that lands after the
// request registers and before the read hides the selector
func TestASnapshotOrEditsReadAfterARevocationIsRefused(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")
	reads := []string{"/snapshot/patron:p2", "/edits/patron:p2"}

	// lands a mutation once, as an admin, when the next read is about to run
	beforeTheRead := func(m mutation) {
		var once sync.Once
		h.srv.beforeRead = func() {
			once.Do(func() {
				req, _ := http.NewRequest("POST", h.web.URL+"/mutations", bytes.NewReader(m.encode(nil)))
				req.Header.Set("Authorization", "Bearer "+admin)
				if resp, err := http.DefaultClient.Do(req); err == nil {
					resp.Body.Close()
				}
			})
		}
	}

	// each read lands between a grant and its revocation
	for i, path := range reads {
		h.accept(admin, mut(fmt.Sprintf("g%d", i), "grant-view", "user", "p1", "prefix", "patron:p2!"))
		if status, _, out := h.do("GET", path, ann, nil); status != 200 {
			t.Fatalf("%s while granted: %d %s", path, status, out)
		}
		beforeTheRead(mut(fmt.Sprintf("r%d", i), "revoke-view", "user", "p1", "prefix", "patron:p2!"))
		if status, _, out := h.do("GET", path, ann, nil); status != 403 {
			t.Fatalf("%s revoked before the read: %d %s", path, status, out)
		}
	}

	// a token revoked before the read is refused
	beforeTheRead(mut("rs", "revoke-sessions", "user", "p1"))
	if status, _, out := h.do("GET", "/snapshot/patron:p1", ann, nil); status != 401 {
		t.Fatalf("a snapshot whose token was revoked before the read: %d %s", status, out)
	}
}

// a principal's registration outlives its last connection for the TTL, so a reconnect is answered
// from it, and past the TTL the grant runs again
func TestARegistrationOutlivesItsConnectionsForTheTTL(t *testing.T) {
	for _, ttl := range []time.Duration{time.Minute, time.Millisecond} {
		h := startWith(t, t.Context(), Options{PrincipalTTL: ttl})
		admin := h.admin()
		r1 := h.token("r1")

		// the audited user's every grant run changes its view
		s := h.connect(r1, -1)
		s.live()
		view := s.header.Get("PhaseLock-View")
		s.close()
		deadline := time.Now().Add(5 * time.Second)
		for {
			h.srv.mu.Lock()
			n := len(h.srv.conns)
			h.srv.mu.Unlock()
			if n == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the connection never closed")
			}
			time.Sleep(time.Millisecond)
		}
		time.Sleep(10 * time.Millisecond)
		h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))

		s = h.connectView(r1, -1, view)
		same := s.header.Get("PhaseLock-View") == view
		s.close()
		if same != (ttl == time.Minute) {
			t.Fatalf("under a TTL of %v, the reconnect's view was the same: %v", ttl, same)
		}
	}
}

func TestSliceByteCounters(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "rename-patron", "id", "p1", "name", "Anne"))

	// the slice's edits as the log holds them: the /edits page, less each frame's 8 bytes of
	// ["edits", [edit]]
	_, _, page := h.do("GET", "/edits/patron:p1", admin, nil)
	editBytes := int64(len(page) - 2*8)

	blob := h.snapshot(admin, "patron:p1")
	var stateBytes int64
	for _, k := range blob.keys {
		stateBytes += int64(len(k)) + int64(len(blob.raw[k]))
	}
	if blob.slices["patron:p1"] != 2 || len(blob.slices) != 1 {
		t.Fatalf("slices in header: %v", blob.slices)
	}
	if asInt(blob.header["edit_bytes"]) != editBytes {
		t.Fatalf("edit_bytes %v, expected %d", blob.header["edit_bytes"], editBytes)
	}
	if asInt(blob.header["state_bytes"]) != stateBytes || stateBytes == 0 {
		t.Fatalf("state_bytes %v, expected %d", blob.header["state_bytes"], stateBytes)
	}

	// family blobs carry no per-slice counters
	if _, ok := h.snapshot(admin, "patron:*").header["state_bytes"]; ok {
		t.Fatalf("family blob should not carry slice counters")
	}

	// a death zeroes state and still counts its own edit's bytes
	h.accept(admin, mut("c3", "remove-patron", "id", "p1"))
	dead := h.snapshot(admin, "patron:p1")
	if asInt(dead.header["state_bytes"]) != 0 || asInt(dead.header["edit_bytes"]) <= editBytes {
		t.Fatalf("after death: %v", dead.header)
	}
}

func TestExpectAndConflict(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann")) // seq 1

	// expectations are the slice's seq: exact, so a met one passes and
	// the same one then conflicts, reporting the actual seq
	o := h.expecting(admin, mut("c2", "rename-patron", "id", "p1", "name", "Anne").in("s1", 1), map[string]any{"patron:p1": 1})
	if o.kind != "ok" {
		t.Fatalf("matching expect: %+v", o)
	}
	o = h.expecting(admin, mut("c3", "rename-patron", "id", "p1", "name", "Annie"), map[string]any{"patron:p1": 1})
	if o.kind != "conflict" || o.current["patron:p1"] != 2 {
		t.Fatalf("stale expect: %+v", o)
	}
	// a conflicting mutation never entered the log
	if got := h.snapshot(admin, "patron:p1").records["patron:p1!patron"].(map[string]any)["name"]; got != "Anne" {
		t.Fatalf("a conflict should not write: %v", got)
	}

	// 0 asserts a slice was never born
	o = h.expecting(admin, mut("c4", "add-book", "id", "b1", "title", "Dune"), map[string]any{"book": 0})
	if o.kind != "ok" {
		t.Fatalf("expect 0 on an unborn slice: %+v", o)
	}
	o = h.expecting(admin, mut("c5", "add-patron", "id", "p2", "name", "Bob"), map[string]any{"patron:p2": 1})
	if o.kind != "conflict" || o.current["patron:p2"] != 0 {
		t.Fatalf("expect on an unborn slice reports 0: %+v", o)
	}

	// several expectations: only the mismatches are reported
	o = h.expecting(admin, mut("c6", "rename-patron", "id", "p1", "name", "x"), map[string]any{"patron:p1": 2, "book": 5})
	if o.kind != "conflict" || len(o.current) != 1 || o.current["book"] != 1 {
		t.Fatalf("mixed expect: %+v", o)
	}

	// the snapshot's seq is the token to expect for a slice with nothing
	// after the cut
	seq := h.snapshot(admin, "book").slices["book"]
	o = h.expecting(admin, mut("c6b", "add-book", "id", "b1", "title", "Dune"), map[string]any{"book": seq})
	if o.kind != "reject" || o.reason != "book exists" { // decider's rejection: it got past expect
		t.Fatalf("snapshot seq as expectation: %+v", o)
	}

	// dedup wins over a stale expectation
	o = h.expecting(admin, mut("c2", "rename-patron", "id", "p1", "name", "Anne").in("s1", 1), map[string]any{"patron:p1": 0})
	if o.kind != "ok" {
		t.Fatalf("resubmit with stale expect: %+v", o)
	}

	// a hashed mutation keeps its expectation through intake
	o = h.expecting(admin, mut("c7", "create-account", "user", "p1", "password", "pw"), map[string]any{"account:p1": 1})
	if o.kind != "conflict" || o.current["account:p1"] != 0 {
		t.Fatalf("expect survives hash intake: %+v", o)
	}
	o = h.expecting(admin, mut("c8", "create-account", "user", "p1", "password", "pw"), map[string]any{"account:p1": 0})
	if o.kind != "ok" {
		t.Fatalf("hashed mutation with matching expect: %+v", o)
	}

	// an expectation names only slices the sender may see, so it never learns another's seq,
	// nor whether it exists: an anonymous sender sees the book alone
	o = h.expecting("", mut("c8b", "create-account", "user", "p5", "password", "pw"), map[string]any{"book": h.snapshot(admin, "book").slices["book"]})
	if o.kind != "ok" {
		t.Fatalf("anonymous expect of a slice it may see: %+v", o)
	}
	for _, slice := range []string{"account:p1", "account:p6"} {
		o = h.expecting("", mut("c8c", "create-account", "user", "p6", "password", "pw"), map[string]any{slice: 0})
		if o.kind != "reject" || o.reason != "expect: "+slice+" is not a slice the sender may see" {
			t.Fatalf("anonymous expect of %s: %+v", slice, o)
		}
	}

	// a slice name is checked by its syntax alone, so one in a family no slice type declares, or
	// under too many parameters, names a slice never born, which the sender may see or not as any
	// other
	for i, slice := range []string{"nope:p1", "patron:p1,x"} {
		o = h.expecting(admin, mut(fmt.Sprintf("c8d-%d", i), "rename-patron", "id", "p1", "name", "x"), map[string]any{slice: 0})
		if o.kind != "ok" {
			t.Fatalf("expect of %s: %+v", slice, o)
		}
		o = h.expecting("", mut(fmt.Sprintf("c8e-%d", i), "create-account", "user", "p6", "password", "pw"), map[string]any{slice: 0})
		if o.kind != "reject" || o.reason != "expect: "+slice+" is not a slice the sender may see" {
			t.Fatalf("anonymous expect of %s: %+v", slice, o)
		}
	}

	// expect names at most 1024 slices
	many := map[string]any{}
	for i := range 1024 {
		many[fmt.Sprintf("patron:q%d", i)] = 0
	}
	o = h.expecting(admin, mut("c9", "add-patron", "id", "p3", "name", "Cy"), many)
	if o.kind != "ok" {
		t.Fatalf("1024 expectations: %+v", o)
	}
	many["patron:q1024"] = 0
	o = h.expecting(admin, mut("c10", "add-patron", "id", "p4", "name", "Di"), many)
	if o.kind != "reject" || o.reason != "expect names 1025 slices, more than 1024" {
		t.Fatalf("1025 expectations: %+v", o)
	}

	// each an exact slice name and a seq from 0 to 2^53 - 1
	malformed := []struct {
		expect map[string]any
		reason string
	}{
		{map[string]any{"patron:": 0}, "expect: patron: is not a slice name"},
		{map[string]any{"patron:p/1": 0}, "expect: patron:p/1 is not a slice name"},
		{map[string]any{"patron:p1!": 0}, "expect: patron:p1! is not a slice name"},
		{map[string]any{"patron:*": 0}, "expect: patron:* is not a slice name"},
		{map[string]any{"patron:p1\x00x": 0}, "expect: patron:p1 is not a slice name"},
		{map[string]any{"patron:p1": -1}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
		{map[string]any{"patron:p1": int64(1) << 53}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
		{map[string]any{"patron:p1": 3.0}, "expect: the seq of patron:p1 is not an integer from 0 to 2^53 - 1"},
	}
	for i, m := range malformed {
		o = h.expecting(admin, mut(fmt.Sprintf("c11-%d", i), "rename-patron", "id", "p1", "name", "x"), m.expect)
		if o.kind != "reject" || o.reason != m.reason {
			t.Fatalf("expect %v: %+v", m.expect, o)
		}
	}

	// and each named once, in a map; Go's maps cannot say either otherwise, so these are built by
	// hand
	rename := mut("c12", "rename-patron", "id", "p1", "name", "x")
	twice := append([]byte{0x82}, mpEncode("patron:p1")...)
	twice = append(twice, 3)
	twice = append(twice, mpEncode("patron:p1")...)
	twice = append(twice, 3)
	for expect, reason := range map[string]string{
		string(twice):                "expect: patron:p1 is named twice",
		string(mpEncode([]any{"x"})): "expect must be a map",
	} {
		body := rename.encode(nil)
		body[0] = 0x95 // the mutation's array gains expect
		status, _, out := h.do("POST", "/mutations", admin, append(body, expect...))
		if status != 200 {
			t.Fatalf("mutations: status %d", status)
		}
		if o := decodeOutcomes(t, out)[0]; o.kind != "reject" || o.reason != reason {
			t.Fatalf("expect %x: %+v", expect, o)
		}
	}
}

// A request carries at most 128 mutations, and one without a session at most 8; a request past
// its limit is refused whole with 413 and the limit it was held to, before any mutation is
// checked.  Options change both.
func TestMutationLimits(t *testing.T) {
	books := func(prefix string, n int) []mutation {
		var muts []mutation
		for i := range n {
			id := fmt.Sprintf("%s%d", prefix, i)
			muts = append(muts, mut(id, "add-book", "id", id, "title", "Dune"))
		}
		return muts
	}
	post := func(h *harness, token string, muts []mutation) (int, string) {
		var body []byte
		for _, c := range muts {
			body = append(body, c.encode(nil)...)
		}
		status, header, _ := h.do("POST", "/mutations", token, body)
		return status, header.Get("PhaseLock-Max-Mutations")
	}

	// the defaults: anonymous mutations are answered, if only with rejects, up to 8
	h := start(t)
	admin := h.admin()
	if status, _ := post(h, admin, books("a", 128)); status != 200 {
		t.Fatalf("128 mutations: status %d", status)
	}
	if status, limit := post(h, admin, books("b", 129)); status != 413 || limit != "128" {
		t.Fatalf("129 mutations: status %d, limit %q", status, limit)
	}
	if status, _ := post(h, "", books("c", 8)); status != 200 {
		t.Fatalf("8 anonymous mutations: status %d", status)
	}
	if status, limit := post(h, "", books("d", 9)); status != 413 || limit != "8" {
		t.Fatalf("9 anonymous mutations: status %d, limit %q", status, limit)
	}

	// a refused request decided nothing
	if o := h.mutations(admin, books("b", 1)...)[0]; o.kind != "ok" {
		t.Fatalf("a mutation of a refused request: %+v", o)
	}

	// limits of the server's own
	h = startWith(t, t.Context(), Options{MaxMutations: 4, MaxAnonymousMutations: 2})
	if status, limit := post(h, h.admin(), books("e", 5)); status != 413 || limit != "4" {
		t.Fatalf("5 mutations under 4: status %d, limit %q", status, limit)
	}
	if status, limit := post(h, "", books("f", 3)); status != 413 || limit != "2" {
		t.Fatalf("3 anonymous mutations under 2: status %d, limit %q", status, limit)
	}
}

// editsRange reads one page of /edits and returns its edits and the scanned header.
func (h *harness) editsRange(token, selector string, after, before int64, reverse bool, max int) ([]edit, int64, int) {
	h.t.Helper()
	q := "/edits/" + selector + "?"
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
	var evs []edit
	dec := newMpDecoder(bytes.NewReader(out))
	for {
		f, err := dec.Decode()
		if err == io.EOF {
			break
		}
		if err != nil {
			h.t.Fatalf("decode edits: %v", err)
		}
		evs = append(evs, edits(f.([]any))...)
	}
	scanned, err := strconv.ParseInt(hdr.Get("PhaseLock-Scanned"), 10, 64)
	if err != nil {
		h.t.Fatalf("scanned header: %q", hdr.Get("PhaseLock-Scanned"))
	}
	return evs, scanned, status
}

// positions are the positions of edits, in order
func positions(evs []edit) []int64 {
	var out []int64
	for _, e := range evs {
		out = append(out, e.position)
	}
	return out
}

func TestEditsRange(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann")) // 1
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob")) // 2
	for i := 0; i < 5; i++ {
		h.accept(admin, mut(fmt.Sprintf("r%d", i), "rename-patron", "id", "p1", "name", fmt.Sprint(i))) // 3..7
	}
	last := h.accept(admin, mut("c3", "rename-patron", "id", "p2", "name", "Robert")) // 8
	head := last + 1                                                                  // a position the client does not have yet
	at := func(evs []edit, want ...int64) bool { return slices.Equal(positions(evs), want) }

	// forward: only p1's edits, ascending, range exhausted in one page
	evs, scanned, _ := h.editsRange(admin, "patron:p1", 0, head, false, 0)
	if !at(evs, 1, 3, 4, 5, 6, 7) || scanned != head {
		t.Fatalf("forward: %v, scanned %d", positions(evs), scanned)
	}
	for i := 1; i < len(evs); i++ {
		if evs[i].slice != "patron:p1" || evs[i].seq != evs[i-1].seq+1 {
			t.Fatalf("forward order/seq: %+v", evs)
		}
	}

	// both bounds are exclusive: positions the client holds
	evs, _, _ = h.editsRange(admin, "patron:p1", 3, 5, false, 0)
	if !at(evs, 4) {
		t.Fatalf("bounds: %+v", evs)
	}

	// reverse: descending, scanned is the next before
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 0, head, true, 0)
	if !at(evs, 7, 6, 5, 4, 3, 1) || scanned != 0 {
		t.Fatalf("reverse: %v scanned %d", positions(evs), scanned)
	}

	// paging with max: the scanned value plugs straight into the next
	// request, in both directions, with no arithmetic
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 0, head, false, 3)
	if !at(evs, 1, 3, 4) || scanned != 4 {
		t.Fatalf("forward page: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", scanned, head, false, 3)
	if !at(evs, 5, 6, 7) || scanned != 7 {
		t.Fatalf("forward page 2: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", scanned, head, false, 3)
	if len(evs) != 0 || scanned != head {
		t.Fatalf("forward page 3: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 0, head, true, 3)
	if !at(evs, 7, 6, 5) || scanned != 5 {
		t.Fatalf("reverse page: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 0, scanned, true, 3)
	if !at(evs, 4, 3, 1) || scanned != 1 {
		t.Fatalf("reverse page 2: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 0, scanned, true, 3)
	if len(evs) != 0 || scanned != 0 {
		t.Fatalf("reverse page 3: %v scanned %d", positions(evs), scanned)
	}

	// the slice must be visible to the principal
	if _, _, status := h.editsRange(h.token("p1"), "patron:p2", 0, head, false, 0); status != 403 {
		t.Fatalf("invisible slice: status %d", status)
	}
	if _, _, status := h.editsRange(h.token("p1"), "patron:p1", 0, head, false, 0); status != 200 {
		t.Fatalf("own slice: status %d", status)
	}

	// both bounds are optional: the start of the log and the head.  At the
	// head, scanned is the last position delivered, or after if nothing was
	evs, scanned, _ = h.editsRange(admin, "patron:p1", -1, -1, false, 0)
	if !at(evs, 1, 3, 4, 5, 6, 7) || scanned != 7 {
		t.Fatalf("unbounded forward: %v, scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", 7, -1, false, 0)
	if len(evs) != 0 || scanned != 7 {
		t.Fatalf("empty at head: %v, scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", -1, -1, true, 0)
	if !at(evs, 7, 6, 5, 4, 3, 1) || scanned != 0 {
		t.Fatalf("unbounded reverse: %v, scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:p1", -1, 4, false, 0)
	if !at(evs, 1, 3) || scanned != 4 {
		t.Fatalf("no after: %v scanned %d", positions(evs), scanned)
	}

	// a family selector interleaves its slices in position order
	evs, scanned, _ = h.editsRange(admin, "patron:*", 0, head, true, 4)
	if !at(evs, 8, 7, 6, 5) || scanned != 5 {
		t.Fatalf("family reverse page: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "patron:*", 0, scanned, true, 0)
	if !at(evs, 4, 3, 2, 1) || scanned != 0 {
		t.Fatalf("family reverse page 2: %v scanned %d", positions(evs), scanned)
	}
	evs, _, _ = h.editsRange(admin, "patron:*", 0, 3, false, 0)
	if !at(evs, 1, 2) || evs[0].slice != "patron:p1" || evs[1].slice != "patron:p2" {
		t.Fatalf("family bounds: %+v", evs)
	}

	// "*" is every slice; only a view granting "*" covers it, and a
	// selector must be well formed
	evs, _, _ = h.editsRange(admin, "*", 0, head, false, 0)
	if len(evs) != 8 || evs[0].position != 1 || evs[7].position != 8 {
		t.Fatalf("everything: %v", positions(evs))
	}
	if _, _, status := h.editsRange(h.token("p1"), "*", 0, head, false, 0); status != 403 {
		t.Fatalf("everything for p1: status %d", status)
	}
	if _, _, status := h.editsRange(h.token("p1"), "patron:*", 0, head, false, 0); status != 403 {
		t.Fatalf("family for p1: status %d", status)
	}
	for _, bad := range []string{"", "patron:", "patron:p1!", "patron*", "patron:p*", "pat*ron", "*:patron"} {
		if _, _, status := h.editsRange(admin, bad, 0, head, false, 0); status != 400 {
			t.Fatalf("selector %q: status %d", bad, status)
		}
	}
}

// a page of /edits holds max edits and the rest of the last one's position, so it never splits
// a mutation's edits, in either direction
func TestAnEditsPageNeverSplitsAMutation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))                      // 1
	h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))                      // 2
	hold := h.accept(admin, mut("c3", "try-hold", "id", "h1", "book", "b1", "patron", "p1")) // 3, two edits

	evs, scanned, _ := h.editsRange(admin, "*", 0, hold+1, false, 3)
	if !slices.Equal(positions(evs), []int64{1, 2, 3, 3}) || scanned != 3 {
		t.Fatalf("a page ending inside a mutation: %v scanned %d", positions(evs), scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "*", 2, hold+1, false, 1)
	if !slices.Equal(positions(evs), []int64{3, 3}) || evs[0].slice != "book" || scanned != 3 {
		t.Fatalf("a page of one mutation's edits: %+v scanned %d", evs, scanned)
	}
	evs, scanned, _ = h.editsRange(admin, "*", 0, hold+1, true, 1)
	if !slices.Equal(positions(evs), []int64{3, 3}) || evs[0].slice != "book" || evs[1].slice != "patron:p1" ||
		scanned != 3 {
		t.Fatalf("a reverse page of one mutation's edits: %+v scanned %d", evs, scanned)
	}
}

// the mutation check //////////////////////////////////////////////////////////

func TestMutationCheck(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// each malformed mutation is rejected where it stands, naming the problem,
	// and the well-formed ones around it are accepted
	outs := h.mutations(admin,
		mut("c1", "add-book", "id", "b1", "title", "Dune").in("s1", 1),
		mut("c2", "add-book", "id", "b2").in("s1", 2),
		mut("c3", "add-book", "id", 7, "title", "Emma"),
		mut("c4", "add-book", "id", "b4", "title", "Emma", "extra", true),
		mut("c5", "no-such-mutation", "id", "x"),
		mut("c6", "add-book", "id", "b6", "title", "Persuasion"),
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
		4: "no-such-mutation",
	} {
		if !strings.Contains(outs[i].reason, needle) {
			t.Fatalf("outcome %d: %q should mention %q", i, outs[i].reason, needle)
		}
	}
	if outs[5].position <= outs[0].position {
		t.Fatalf("oks around the rejects: %+v", outs)
	}

	// a malformed mutation never reached dedup, so it was not a decision: its number is free for
	// a good one, which runs and lands past everything before it
	if o := h.mutations(admin, mut("c2", "add-book", "id", "b2", "title", "Mansfield Park").in("s1", 2))[0]; o.kind != "ok" || o.position <= outs[5].position {
		t.Fatalf("number of a malformed mutation reused: %+v", o)
	}

	// the discriminator may sit anywhere in the map
	body := rawMutation("c7", "id", "b7", "title", "Emma", "type", "add-book")
	if status, _, out := h.do("POST", "/mutations", admin, body); status != 200 || decodeOutcomes(t, out)[0].kind != "ok" {
		t.Fatalf("discriminator last: %d %s", status, out)
	}

	// an empty body is fine; a body that is not msgpack is a 400
	if status, _, _ := h.do("POST", "/mutations", admin, []byte{}); status != 200 {
		t.Fatalf("empty body: %d", status)
	}
	if status, _, _ := h.do("POST", "/mutations", admin, []byte{0xc1}); status != 400 {
		t.Fatalf("not msgpack: %d", status)
	}
	// a mutation that is not [S, n, id, data, expect?] is a 400 too, since nothing can be
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
		if status, _, _ := h.do("POST", "/mutations", admin, mpEncode(v)); status != 400 {
			t.Fatalf("%s: %d", name, status)
		}
	}
	// a series id of the longest length and the largest n are well-formed
	big := []any{strings.Repeat("s", 64), int64(1)<<53 - 1, label("c9"), data}
	if status, _, out := h.do("POST", "/mutations", admin, mpEncode(big)); status != 200 || decodeOutcomes(t, out)[0].kind != "ok" {
		t.Fatalf("the largest series id and n: %d %s", status, out)
	}
}

func TestTypedValues(t *testing.T) {
	h := start(t)
	admin := h.admin()
	added := time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC)

	// a date field travels as a timestamp: through the decider, into the edit, out of the store
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune", "added", added))
	s := h.connect(admin, 0)
	evs := edits(s.nextTagged("edits"))
	if got, ok := evs[0].field("book!book:b1", "added").(time.Time); !ok || !got.Equal(added) {
		t.Fatalf("edit date: %v", evs[0].field("book!book:b1", "added"))
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
	o := h.mutations(admin, mut("c2", "add-book", "id", "b2", "title", "Emma", "added", "2026-01-02T03:04:05Z"))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.added: expected a timestamp") {
		t.Fatalf("string date: %+v", o)
	}

	// a date reaches as far as a JS Date does either side of the epoch, and no further
	for i, ms := range []int64{8.64e15, -8.64e15} {
		id := fmt.Sprintf("e%d", i)
		h.accept(admin, mut(id, "add-book", "id", id, "title", "Emma", "added", time.UnixMilli(ms)))
		stored := h.snapshot(admin, "book").records["book!book:"+id].(map[string]any)["added"]
		if got, ok := stored.(time.Time); !ok || got.UnixMilli() != ms {
			t.Fatalf("date at %d ms: %v", ms, stored)
		}
	}
	for i, ms := range []int64{8.64e15 + 1, -8.64e15 - 1, 1 << 62} {
		id := fmt.Sprintf("f%d", i)
		o := h.mutations(admin, mut(id, "add-book", "id", id, "title", "Emma", "added", time.UnixMilli(ms)))[0]
		if o.kind != "reject" || o.reason != "$.added: a timestamp outside the range of a Date" {
			t.Fatalf("date at %d ms: %+v", ms, o)
		}
	}

	// an optional field left out stays out
	h.accept(admin, mut("c3", "add-book", "id", "b3", "title", "Emma"))
	if _, ok := h.snapshot(admin, "book").records["book!book:b3"].(map[string]any)["added"]; ok {
		t.Fatalf("absent optional field written")
	}
}

func TestPreparedFields(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "ann", "name", "Ann"))

	// a NewPassword is replaced by its argon2id hash before the decider sees it
	h.accept("", mut("c2", "create-account", "user", "ann", "password", "hunter2"))
	acct := h.snapshot(admin, "account:ann").records["account:ann!account"].(map[string]any)
	hash := acct["hash"].(string)
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("expected an argon2id hash, got %q", hash)
	}
	// and the check saw the wire type: a password that is not a string is rejected
	o := h.mutations("", mut("c3", "create-account", "user", "bob", "password", 42))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.password: expected a string") {
		t.Fatalf("non-string password: %+v", o)
	}
}

// mutation-time authentication ///////////////////////////////////////////////

// proof is a password MutationAuth
func proof(password string) map[string]any {
	return map[string]any{"kind": "password", "password": password}
}

// signUp creates an account with a password, and signs in to it
func (h *harness) signUp(user, password string) string {
	h.t.Helper()
	h.accept("", mut("signup-"+user, "create-account", "user", user, "password", password))
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
			body := mut("hook-"+password, "set-password", "user", user, "password", password).encode(nil)
			req, _ := http.NewRequest("POST", h.web.URL+"/mutations", bytes.NewReader(body))
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
	proven := func(id, password string) mutation {
		return mut(id, "authenticated-mutation", "user", "ann", "check", proof(password))
	}

	// the right password passes, and the decider sees only what it proved
	if o := h.mutations(tok, proven("c1", "hunter2"))[0]; o.kind != "ok" {
		t.Fatalf("the right password: %+v", o)
	}
	tok = h.signUp("bob", "pw")

	// the proof is the sender's own: ann's password proves nothing for bob
	o := h.mutations(tok, mut("c2", "authenticated-mutation", "user", "bob", "check", proof("hunter2")))[0]
	if o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("another account's password: %+v", o)
	}

	// a failed proof is rejected before its expectations are compared, so it learns no seq
	stale := map[string]any{"patron:bob": 99}
	bobs := func(id, password string) mutation {
		return mut(id, "authenticated-mutation", "user", "bob", "check", proof(password))
	}
	if o := h.expecting(tok, bobs("c3", "wrong"), stale); o.kind != "reject" {
		t.Fatalf("a wrong password with a stale expectation: %+v", o)
	}
	if o := h.expecting(tok, bobs("c4", "pw"), stale); o.kind != "conflict" {
		t.Fatalf("the right password with a stale expectation: %+v", o)
	}

	// an account without a password, and the anonymous principal, prove nothing
	for _, sender := range []string{h.token("p1"), ""} {
		o := h.mutations(sender, mut("c5", "authenticated-mutation", "user", "p1", "check", proof("x")))[0]
		if o.kind != "reject" || o.reason != "invalid credentials" {
			t.Fatalf("a proof with no password to check it against: %+v", o)
		}
	}

	// the other kinds are refused at intake, after the wire shape is checked
	o = h.mutations(tok, mut("c6", "authenticated-mutation", "user", "bob", "check",
		map[string]any{"kind": "totp", "code": "123456"}))[0]
	if o.kind != "reject" || o.reason != "totp proofs are not supported by this database yet" {
		t.Fatalf("a totp proof: %+v", o)
	}
	o = h.mutations(tok, mut("c7", "authenticated-mutation", "user", "bob", "check",
		map[string]any{"kind": "carrier-pigeon"}))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "$.check") {
		t.Fatalf("a malformed proof: %+v", o)
	}
}

func TestAResentPasswordChangeThatLandedIsOk(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")
	change := mut("c1", "change-password", "user", "ann", "check", proof("hunter2"), "password", "fresh").in("s1", 1)

	// the change lands, and its resend proves a password that is no longer ann's, but the resend
	// is the decided mutation, so dedup answers it
	if o := h.mutations(tok, change)[0]; o.kind != "ok" {
		t.Fatalf("the change: %+v", o)
	}
	if o := h.mutations(tok, change)[0]; o.kind != "ok" {
		t.Fatalf("the resend: %+v", o)
	}
	again := mut("c2", "change-password", "user", "ann", "check", proof("hunter2"), "password", "x").in("s1", 2)
	if o := h.mutations(tok, again)[0]; o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("a new mutation proving the old password: %+v", o)
	}
	if status := login(h, "ann", "fresh"); status != 200 {
		t.Fatalf("login with the changed password: %d", status)
	}
}

func TestACallProvesThePasswordItsEarlierMutationSet(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")

	// both proofs are checked against hunter2 before either runs; the second bounces when its turn
	// comes and passes against the password the first set
	outs := h.mutations(tok,
		mut("c1", "change-password", "user", "ann", "check", proof("hunter2"), "password", "fresh"),
		mut("c2", "authenticated-mutation", "user", "ann", "check", proof("fresh")))
	if outs[0].kind != "ok" || outs[1].kind != "ok" {
		t.Fatalf("outcomes: %+v", outs)
	}
}

func TestAProofIsCheckedAgainWhenTheCredentialsChangeBeforeItsTurn(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("p", "add-patron", "id", "ann", "name", "Ann"))
	tok := h.signUp("ann", "hunter2")

	// a proof that passed against the old password fails against the new one
	done := h.setPasswordWhenProved("ann", "fresh")
	o := h.mutations(tok, mut("c1", "authenticated-mutation", "user", "ann", "check", proof("hunter2")))[0]
	changed(t, done)
	if o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("the old password after a change: %+v", o)
	}

	// a proof that failed against the old password passes against the new one, and the call's
	// mutations are still decided once each, in order
	done = h.setPasswordWhenProved("ann", "fresher")
	call := []mutation{
		mut("c2", "rename-patron", "id", "ann", "name", "A1").in("s1", 1),
		mut("c3", "authenticated-mutation", "user", "ann", "check", proof("fresher")).in("s1", 2),
		mut("c4", "rename-patron", "id", "ann", "name", "A2").in("s1", 3),
	}
	outs := h.mutations(tok, call...)
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

	// the proven mutation revoked the token, so the resend signs in again, and is answered by dedup
	tok = h.signIn("ann", "fresher")
	for i, o := range h.mutations(tok, call...) {
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

	// the core reads lookup once for the state it holds, so a proof is checked against that one
	// answer, which no password matches
	o := h.mutations(h.token("flaky"), mut("c1", "authenticated-mutation", "user", "flaky", "check", proof("x")))[0]
	if o.kind != "reject" || o.reason != "invalid credentials" {
		t.Fatalf("a proof against a flaky lookup: %+v", o)
	}

	// a login reads lookup again after its check, and gives up after a few answers that differ
	if status := login(h, "flaky", "x"); status != 500 {
		t.Fatalf("a login against a flaky lookup: %d", status)
	}
}

// a proof whose sender's credentials change before every one of its turns is rejected once the
// call has bounced as often as it may
func TestAProofWhoseCredentialsKeepChangingIsRejected(t *testing.T) {
	h := start(t)
	tok := h.signUp("ann", "hunter2")
	admin := h.admin()

	// every check of the proof is followed by a change of the password
	var changes atomic.Int32
	errs := make(chan error, 8)
	h.srv.proved = func() {
		n := changes.Add(1)
		body := mut(fmt.Sprintf("hook-%d", n), "set-password", "user", "ann", "password",
			fmt.Sprintf("pw%d", n)).encode(nil)
		req, _ := http.NewRequest("POST", h.web.URL+"/mutations", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+admin)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode != 200 {
				err = fmt.Errorf("set-password: %d", resp.StatusCode)
			}
		}
		if err != nil {
			errs <- err
		}
	}
	o := h.mutations(tok, mut("c1", "authenticated-mutation", "user", "ann", "check", proof("hunter2")))[0]
	if o.kind != "reject" || o.reason != "the sender's credentials changed 4 times while its proof was checked" {
		t.Fatalf("a proof whose credentials keep changing: %+v", o)
	}
	if n := changes.Load(); n != 4 {
		t.Fatalf("the proof was checked %d times", n)
	}
	select {
	case err := <-errs:
		t.Fatal(err)
	default:
	}
}

// guards the core's own read-only check, which stops a lookup's write that slips past the bundle
func TestTheCoreRefusesAWriteFromLookup(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))

	// the lookup fails, naming its slot, so the sign-in does
	req := mpEncode(map[string]any{"kind": "dev", "identity": "raw-lookup"})
	status, _, body := h.do("POST", "/auth/token", "", req)
	if status != 500 || !strings.Contains(string(body), "lookup reads only, and made a write") {
		t.Fatalf("a sign-in under a lookup that writes past the bundle: %d %s", status, body)
	}

	// the write it made reached neither the store nor the next mutation's edit
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"only"}))
	if got := h.messages("p1"); strings.Join(got, ",") != "only,own" {
		t.Fatalf("the messages of the next mutation: %v", got)
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

// raw is msgpack bytes spliced as they are into a mutation built by rawMutation.
type raw []byte

// rawMutation encodes one [id, data] mutation whose data map holds the fields in order, raw
// values spliced in as they are.
func rawMutation(id string, kv ...any) []byte {
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

	// a date in each of the timestamp's three sizes survives the decider, the edit, and the store
	whole := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	old := time.Date(1960, 6, 7, 8, 9, 10, 123e6, time.UTC)
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune", "added", whole))
	h.accept(admin, mut("c2", "add-book", "id", "b2", "title", "Emma", "added", old))
	records := h.snapshot(admin, "book").records
	for key, want := range map[string]time.Time{"book!book:b1": whole, "book!book:b2": old} {
		if got, ok := records[key].(map[string]any)["added"].(time.Time); !ok || !got.Equal(want) {
			t.Fatalf("%s: stored date %v, want %v", key, records[key], want)
		}
	}

	// values no type accepts are rejected by name, each in its own mutation of one request, and
	// the mutations after each still check and ack
	badStamp := raw{0xc7, 5, 0xff, 0, 0, 0, 0, 0} // a timestamp extension of no valid size
	badNanos := raw{0xd7, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0}
	otherExt := raw{0xd6, 5, 0, 0, 0, 0}
	bin := raw{0xc4, 2, 'h', 'i'}
	bigUint := raw{0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	intKey := raw{0x81, 0x01, 0xa1, 'x'}
	var body []byte
	body = append(body, rawMutation("d1", "type", "add-book", "id", "b3", "title", "T", "added", badStamp)...)
	body = append(body, rawMutation("d2", "type", "add-book", "id", "b4", "title", "T", "added", badNanos)...)
	body = append(body, rawMutation("d3", "type", "add-book", "id", "b5", "title", "T", "added", otherExt)...)
	body = append(body, rawMutation("d4", "type", "add-book", "id", "b6", "title", bin)...)
	body = append(body, rawMutation("d5", "type", "add-book", "id", bigUint, "title", "T")...)
	body = append(body, rawMutation("d6", "type", "add-book", "id", "b8", "title", "T", "added", intKey)...)
	body = append(body, rawMutation("d7", "type", "add-book", "id", "b9", "title", "T")...)
	status, _, out := h.do("POST", "/mutations", admin, body)
	if status != 200 {
		t.Fatalf("mutations: %d %s", status, out)
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
		t.Fatalf("the mutation after the rejects: %+v", outs[6])
	}

	// a map key that is not a string, where the walk reads keys
	body = mpArrayHeader(nil, 4)
	body = mpAppend(mpAppend(mpAppend(body, nil), nil), label("e1"))
	body = append(body, 0x84)
	body = append(mpAppendStr(body, "type"), mpAppendStr(nil, "add-book")...)
	body = append(mpAppendStr(body, "id"), mpAppendStr(nil, "b10")...)
	body = append(mpAppendStr(body, "title"), mpAppendStr(nil, "T")...)
	body = append(body, 0x07, 0xc0)
	if o := h.mutationsRaw(admin, body)[0]; o.kind != "reject" || o.reason != "$: a map key is not a string" {
		t.Fatalf("non-string key: %+v", o)
	}

	// elements a later protocol appends to a mutation are ignored
	body = mpEncode([]any{nil, nil, label("e2"), map[string]any{"type": "add-book", "id": "b11", "title": "T"}, map[string]any{}, "newer"})
	if o := h.mutationsRaw(admin, body)[0]; o.kind != "ok" {
		t.Fatalf("a mutation with an appended element: %+v", o)
	}
}

// mutationsRaw posts a request body as it is and returns the outcomes.
func (h *harness) mutationsRaw(token string, body []byte) []outcome {
	h.t.Helper()
	status, _, out := h.do("POST", "/mutations", token, body)
	if status != 200 {
		h.t.Fatalf("mutations: status %d: %s", status, out)
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
	h.accept(admin, mut("c1", "create-account", "user", "ann", "password", "hunter2"))

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

func TestASqliteCacheSizeOverWhatSQLiteTakesIsRefused(t *testing.T) {
	if _, err := Open(t.Context(), Options{DataDir: t.TempDir(), SqliteCacheSize: 1 << 21}); err == nil {
		t.Fatal("accepted")
	}
}

func TestIntakeHashingIsRateLimitedPerClient(t *testing.T) {
	h := startWith(t, t.Context(), Options{AuthBurst: 1, AuthRate: 0.001})
	h.accept("", mut("c1", "create-account", "user", "ann", "password", "hunter2"))

	// a request whose hash finds the budget spent is refused whole, so it can be retried later
	// under the same ids
	status, _ := h.mutationsStatus("", mut("c2", "create-account", "user", "bob", "password", "pw"))
	if status != 429 {
		t.Fatalf("a hash past the budget: %d, want 429", status)
	}

	// mutations that hash nothing are not limited
	if o := h.mutations(h.admin(), mut("c3", "add-book", "id", "b1", "title", "Dune"))[0]; o.kind != "ok" {
		t.Fatalf("a mutation with no password: %+v", o)
	}
}

// shutdown ///////////////////////////////////////////////////////////////////

func TestShutdownEndsOpenConnections(t *testing.T) {
	ctx, stop := context.WithCancel(t.Context())
	h := startWith(t, ctx, Options{})
	s := h.connect(h.admin(), -1)
	s.live()

	// the server's context ends, and so does every request under it, at once
	stop()
	select {
	case <-s.errs:
	case <-time.After(2 * time.Second):
		t.Fatalf("an open connection outlived the server's context")
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

	if status, _ := h.mutationsStatus(ghost, mut("c1", "add-book", "id", "b1", "title", "Dune")); status != 401 {
		t.Fatalf("mutations: %d", status)
	}
	req, _ := http.NewRequest("GET", h.web.URL+"/stream?since=-1", nil)
	req.Header.Set("Authorization", "Bearer "+ghost)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("connection: %d", resp.StatusCode)
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

	// one mutation, under the id the core minted for it: the account slice's birth
	s := h.connect(h.admin(), 0)
	evs := edits(s.nextTagged("edits"))
	if len(evs) != 1 || evs[0].lifecycle != birth || evs[0].slice != "account:boss" || len(evs[0].id) != 16 {
		t.Fatalf("bootstrap's edit: %+v", evs)
	}
	if hash, _ := evs[0].field("account:boss!account", "hash").(string); !strings.HasPrefix(hash, "$argon2id$") {
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
	if next := h.accept(boss, mut("c1", "add-book", "id", "b1", "title", "Dune")); next != 2 {
		t.Fatalf("after a restart, the next mutation lands at %d, want 2: bootstrap ran again", next)
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
		t.Fatalf("a bootstrap writing to a malformed slice: %v", err)
	}
}

func TestValidSelector(t *testing.T) {
	for selector, want := range map[string]bool{
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
		if got := validSelector(selector); got != want {
			t.Errorf("validSelector(%q) = %v, want %v", selector, got, want)
		}
	}
}

func TestSliceNamesFillTheirTemplates(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a family template's terminal parameter may hold . and ~
	h.accept(admin, mut("c1", "add-patron", "id", "p.1~x", "name", "Ann"))
	if _, ok := h.snapshot(admin, "patron:p.1~x").records["patron:p.1~x!patron"]; !ok {
		t.Fatalf("patron:p.1~x was not written")
	}

	// a decider reading through a parameter that no slice name could hold is rejected before it
	// writes anything
	outs := h.mutations(admin,
		mut("c2", "add-patron", "id", "p/1", "name", "Bob"),
		mut("c3", "add-patron", "id", "", "name", "Cy"),
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
		h.accept(admin, mut(fmt.Sprintf("ok%d", i), "add-book", "id", id, "title", "T"))
	}
	records := h.snapshot(admin, "book").records
	for _, id := range ok {
		if _, found := records["book!book:"+id]; !found {
			t.Fatalf("book %q was not written", id)
		}
	}

	// a key holding a control character or a lone surrogate is refused, and its mutation with it
	bad := []string{"a\nb", "a\tb", "a\x7fb", "a\u0085b", "a\xed\xa0\x80b", "a\xed\xb0\x80b"}
	for i, id := range bad {
		o := h.mutations(admin, mut(fmt.Sprintf("bad%d", i), "add-book", "id", id, "title", "T"))[0]
		if o.kind != "reject" || !strings.Contains(o.reason, "holds a control character or a lone surrogate") {
			t.Fatalf("add-book %q: %+v", id, o)
		}
	}

	// a key holding U+0000 is neither read short nor written: the decider's read of b1\x00x
	// finds nothing although b1 is held, and its write is refused
	h.accept(admin, mut("c1", "add-book", "id", "b1", "title", "Dune"))
	o := h.mutations(admin, mut("c2", "add-book", "id", "b1\x00x", "title", "Emma"))[0]
	if o.kind != "reject" || !strings.Contains(o.reason, "a key beginning book!book:b1 holds U+0000") {
		t.Fatalf("add-book with U+0000: %+v", o)
	}
}

func TestAProductionBundleAnswersBugsWithInternalError(t *testing.T) {
	h := startWith(t, t.Context(), Options{Bundle: filepath.Join("testdata", "bundle.prod.js")})
	admin := h.admin()
	if outs := h.mutations(admin, mut("c1", "add-patron", "id", "p/1", "name", "Bob")); outs[0].reason != "internal error" {
		t.Fatalf("a bug in a production bundle: %+v", outs[0])
	}

	// a rejection's reason is still the app's own
	h.accept(admin, mut("c2", "add-patron", "id", "p1", "name", "Ann"))
	if outs := h.mutations(admin, mut("c3", "add-patron", "id", "p1", "name", "Ann")); outs[0].reason != "patron exists" {
		t.Fatalf("a rejection in a production bundle: %+v", outs[0])
	}
}

func TestAFailingGrantGrantsNothing(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")
	s := h.connect(ann, -1)
	s.live()

	// a granted wildcard that cuts into a parameter ends the connection
	h.accept(admin, mut("c3", "grant-view", "user", "p1", "prefix", "patron:p1*"))
	f := s.nextTagged("end")
	if asInt(f[1]) != endGrantorFailed || !strings.Contains(f[2].(string), "malformed selector: patron:p1*") {
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
	if status != 500 || !strings.Contains(string(body), "malformed selector: patron:p1*") {
		t.Fatalf("a connection under a failing grant: %d %s", status, body)
	}
}

// guards the core's own read-only check, which stops a grant's write that slips past the bundle
func TestTheCoreRefusesAWriteFromGrant(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))

	// the grant fails closed, naming its slot, so the connection is refused
	status, _, body := h.do("GET", "/stream?since=-1", h.token("raw-requester"), nil)
	if status != 500 || !strings.Contains(string(body), "grant reads only, and made a write") {
		t.Fatalf("a connection under a grant that writes past the bundle: %d %s", status, body)
	}

	// the write it made reached neither the store nor the next mutation's edit
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"only"}))
	if got := h.messages("p1"); strings.Join(got, ",") != "only,own" {
		t.Fatalf("the messages of the next mutation: %v", got)
	}
}

func TestGrantSelectorsCarryATerminator(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("c3", "create-account", "user", "p1", "password", "hunter2"))
	ann := h.token("p1")

	// an exact slice is "name!", which grants the slice
	h.accept(admin, mut("c4", "grant-view", "user", "p1", "prefix", "patron:p2!"))
	if _, _, status := h.editsRange(ann, "patron:p2", 0, 100, false, 0); status != 200 {
		t.Fatalf("a granted slice: status %d", status)
	}
	h.accept(admin, mut("c5", "revoke-view", "user", "p1", "prefix", "patron:p2!"))

	// a selector is checked by its syntax alone, so one in a family no slice type declares, or
	// under more parameters than its family has, is well-formed and grants what it names
	for i, grant := range []struct{ selector, covered string }{
		{"nope:x!", "nope:x"},
		{"patron:p2,x!", "patron:p2,x"},
		{"patron:p2,*", "patron:p2,x"},
		{"book:*", "book"},
	} {
		h.accept(admin, mut(fmt.Sprintf("w%d", i), "grant-view", "user", "p1", "prefix", grant.selector))
		if status, _, body := h.do("GET", "/snapshot/"+grant.covered, ann, nil); status != 200 {
			t.Fatalf("grant returning %q: %d %s", grant.selector, status, body)
		}
		h.accept(admin, mut(fmt.Sprintf("v%d", i), "revoke-view", "user", "p1", "prefix", grant.selector))
	}

	// a bare name, a malformed name, and a wildcard cutting into a parameter or after a value no
	// leading parameter holds are malformed, so the registration fails closed
	for i, selector := range []string{
		"patron:p2",    // a bare name
		"patron:p2/",   // a bare name with a character no parameter holds
		"!",            // an empty name
		"patron:!",     // an empty parameter
		"patron:p/2!",  // a character no parameter holds
		"patron:*!",    // a star in a name
		"patron:p*",    // a wildcard cutting into a parameter
		"patron:p.2,*", // a '.' in a leading parameter
		":*",           // a wildcard after an empty family
	} {
		h.accept(admin, mut(fmt.Sprintf("g%d", i), "grant-view", "user", "p1", "prefix", selector))
		status, _, body := h.do("GET", "/stream?since=-1", ann, nil)
		if status != 500 || !strings.Contains(string(body), "malformed selector: "+selector) {
			t.Fatalf("grant returning %q: %d %s", selector, status, body)
		}
		h.accept(admin, mut(fmt.Sprintf("r%d", i), "revoke-view", "user", "p1", "prefix", selector))
	}
}

func TestAFamilyWalksInParameterOrder(t *testing.T) {
	h := start(t)
	admin := h.admin()

	// a slice whose parameter is another's followed by '-' or '.' sorts after it
	for i, id := range []string{"gen.x", "gen-2", "gen"} {
		h.accept(admin, mut(fmt.Sprintf("c%d", i), "add-patron", "id", id, "name", "N"))
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
		h.accept(admin, mut(fmt.Sprintf("b%d", i), "add-book", "id", id, "title", "T"))
	}
	if got := strings.Join(h.snapshot(admin, "book").keys, ","); got != "book!book:2026-10,book!book:2026-10-06" {
		t.Fatalf("book keys: %s", got)
	}
}
