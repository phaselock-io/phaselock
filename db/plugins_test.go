package main

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// messages are a patron's messages, which the notice plugin's requests and the cron hook add to.
func (h *harness) messages(patron string) []string {
	h.t.Helper()
	v := h.snapshot(h.admin(), "patron:"+patron).records["patron:"+patron+"!messages"]
	if v == nil {
		return nil
	}
	return strs(v)
}

func TestPluginRequestsLandInTheMutationsEdit(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))

	// the requests in call order, then the decider's own write, all in one edit of the mutation
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"first", "second"}))
	if got := h.messages("p1"); strings.Join(got, ",") != "first,second,own" {
		t.Fatalf("the mutation's messages: %v", got)
	}
	evs, _, _ := h.editsRange(admin, "patron:p1", before, -1, false, 0)
	if len(evs) != 1 || evs[0].mutation != "c2" {
		t.Fatalf("the mutation's edits: %+v", evs)
	}

	// a mutation rejected after its requests leaves none of them
	outs := h.mutations(admin,
		mut("c3", "notify", "patron", "p1", "reasons", []any{"dropped"}, "reject", true),
		mut("c4", "notify", "patron", "p1", "reasons", []any{"after"}),
	)
	if outs[0].kind != "reject" || outs[0].reason != "rejected after its requests" {
		t.Fatalf("expected the rejection, got %+v", outs[0])
	}
	if outs[1].kind != "ok" {
		t.Fatalf("expected the next mutation to land, got %+v", outs[1])
	}
	if got := h.messages("p1"); strings.Join(got, ",") != "first,second,own,after,own" {
		t.Fatalf("the messages after a rejection: %v", got)
	}
}

func TestAGrantThatWritesIsABug(t *testing.T) {
	h := start(t)
	status, _, body := h.do("GET", "/stream?since=-1", h.token("requester"), nil)
	if status != 500 || !strings.Contains(string(body), "this call reads only, and made a write") {
		t.Fatalf("a connection under a writing grant: %d %s", status, body)
	}

	// the write it made reached no mutation's edit
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"only"}))
	if got := h.messages("p1"); strings.Join(got, ",") != "only,own" {
		t.Fatalf("the messages of the next mutation: %v", got)
	}
}

func TestTheBundleHasCryptoRandomness(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, mut("c2", "notify", "patron", "p1", "reasons", []any{"uuid", "uuid"}))
	got := h.messages("p1")
	v4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if len(got) != 3 || !v4.MatchString(got[0]) || !v4.MatchString(got[1]) || got[0] == got[1] {
		t.Fatalf("two fresh version 4 uuids, then the decider's own: %v", got)
	}
}

// entry is the core's number for the test bundle's cron entry of a name.
func (h *harness) entry(name string) int {
	h.t.Helper()
	for i, e := range h.srv.cron {
		if e.install == "cron" && e.name == name {
			return i
		}
	}
	h.t.Fatalf("no cron entry %s", name)
	return -1
}

// tick decides a slot of a cron entry of the test bundle, failing the test on a hook's failure.
func (h *harness) tick(name string, slot time.Time) {
	h.t.Helper()
	if r := h.srv.tick(h.entry(name), slot); r.status != 0 {
		h.t.Fatalf("tick %s at %v: %d %s", name, slot, r.status, r.errmsg)
	}
}

func TestACronTickRunsItsHookAsOneMutation(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	h.tick("reap", slot)

	// the request the hook made, then its own write, one edit under a label of its own
	evs, _, _ := h.editsRange(admin, "patron:p1", before, -1, false, 0)
	if len(evs) != 1 || len(evs[0].id) != 16 || evs[0].mutation == "c1" {
		t.Fatalf("the tick's edit: %+v", evs)
	}
	got := h.messages("p1")
	if len(got) != 2 || got[0] != "requested 2030-01-01T00:00:00.000Z" {
		t.Fatalf("the tick's messages: %v", got)
	}
	reason := strings.Fields(got[1])
	if len(reason) != 3 || reason[0] != "reap" || reason[1] != "2030-01-01T00:00:00.000Z" {
		t.Fatalf("the tick's own write: %v", reason)
	}
	if now, err := time.Parse(time.RFC3339, reason[2]); err != nil || !now.Equal(evs[0].servertime) {
		t.Fatalf("the tick's now, against its edit's server time %v: %v", evs[0].servertime, reason[2])
	}

	// a slot at or below the mark was decided already, and a later one runs
	h.tick("reap", slot)
	h.tick("reap", slot.Add(-time.Hour))
	if got := h.messages("p1"); len(got) != 2 {
		t.Fatalf("a refired slot ran: %v", got)
	}
	h.tick("reap", slot.Add(time.Minute))
	if got := h.messages("p1"); len(got) != 4 {
		t.Fatalf("the next slot did not run: %v", got)
	}
}

func TestACronHookThatThrowsLeavesNothingButItsMark(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	r := h.srv.tick(h.entry("broken"), slot)
	if r.status != 500 || !strings.Contains(r.errmsg, "the broken entry") {
		t.Fatalf("a throwing hook: %d %q", r.status, r.errmsg)
	}

	// the slot was decided, so it does not run again, and the log moved on without it
	h.tick("broken", slot)
	if at := h.accept(admin, mut("c2", "rename-patron", "id", "p1", "name", "Bea")); at != before+1 {
		t.Fatalf("the next mutation landed at %d after %d", at, before)
	}
}

func TestCronEntriesAreArmedOnceAtStartup(t *testing.T) {
	dir := t.TempDir()
	earliest := time.Now().Truncate(time.Minute)
	h := startIn(t, dir)
	latest := time.Now()

	// every entry was armed at the minute the server started, which a later arm keeps
	marks := h.srv.arm(latest.Add(time.Hour).Truncate(time.Minute)).marks
	if len(marks) != 3 {
		t.Fatalf("three entries' marks: %v", marks)
	}
	for _, m := range marks {
		if m != marks[0] || m < earliest.Unix() || m > latest.Unix() {
			t.Fatalf("the marks %v, armed between %v and %v", marks, earliest, latest)
		}
	}

	// a restart keeps every mark, and the slot a tick decided stays decided
	admin := h.admin()
	h.accept(admin, mut("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	h.tick("reap", slot)
	h.stop()
	h = startIn(t, dir)
	again := h.srv.arm(time.Now().Add(time.Hour).Truncate(time.Minute)).marks
	if again[h.entry("zoned")] != marks[h.entry("zoned")] || again[h.entry("reap")] != slot.Unix() {
		t.Fatalf("the marks after a restart: %v, from %v", again, marks)
	}
	h.tick("reap", slot)
	if got := h.messages("p1"); len(got) != 2 {
		t.Fatalf("a decided slot ran again after a restart: %v", got)
	}
}
