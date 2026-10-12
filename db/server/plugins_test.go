package main

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// reasons are the reasons of a patron's hold-failed events after a position, in log order.
func (h *harness) reasons(token, patron string, after int64) []string {
	h.t.Helper()
	evs, _, status := h.eventsRange(token, "patron:"+patron, after, -1, false, 0)
	if status != 200 {
		h.t.Fatalf("events: status %d", status)
	}
	var out []string
	for _, ev := range evs {
		if ev.data["type"] == "hold-failed" {
			out = append(out, ev.data["reason"].(string))
		}
	}
	return out
}

func TestPluginRequestsLandInTheCommandsAtom(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))

	// the requests in call order, then the handler's own output, all in one atom
	at := h.accept(admin, cmd("c2", "notify", "patron", "p1", "reasons", []any{"first", "second"}))
	if got := h.reasons(admin, "p1", before); strings.Join(got, ",") != "first,second,own" {
		t.Fatalf("the atom's reasons: %v", got)
	}
	evs, _, _ := h.eventsRange(admin, "patron:p1", before, -1, false, 0)
	for _, ev := range evs {
		if ev.commandid != "c2" {
			t.Fatalf("an event of the atom carries command %q", ev.commandid)
		}
	}

	// a command rejected after its requests leaves none of them
	outs := h.commands(admin,
		cmd("c3", "notify", "patron", "p1", "reasons", []any{"dropped"}, "reject", true),
		cmd("c4", "notify", "patron", "p1", "reasons", []any{"after"}),
	)
	if outs[0].kind != "reject" || outs[0].reason != "rejected after its requests" {
		t.Fatalf("expected the rejection, got %+v", outs[0])
	}
	if outs[1].kind != "ok" {
		t.Fatalf("expected the next command to land, got %+v", outs[1])
	}
	if got := h.reasons(admin, "p1", at); strings.Join(got, ",") != "after,own" {
		t.Fatalf("the reasons after a rejection: %v", got)
	}
}

func TestAMaySeeThatMakesAPluginRequestIsABug(t *testing.T) {
	h := start(t)
	status, _, body := h.do("GET", "/stream?since=-1", h.token("requester"), nil)
	if status != 500 || !strings.Contains(string(body), "maySee made a plugin request") {
		t.Fatalf("a stream under a requesting maySee: %d %s", status, body)
	}

	// the request it made reached no command's atom
	admin := h.admin()
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "notify", "patron", "p1", "reasons", []any{"only"}))
	if got := h.reasons(admin, "p1", before); strings.Join(got, ",") != "only,own" {
		t.Fatalf("the reasons of the next command: %v", got)
	}
}

func TestTheBundleHasCryptoRandomness(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	h.accept(admin, cmd("c2", "notify", "patron", "p1", "reasons", []any{"uuid", "uuid"}))
	got := h.reasons(admin, "p1", before)
	v4 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if len(got) != 3 || !v4.MatchString(got[0]) || !v4.MatchString(got[1]) || got[0] == got[1] {
		t.Fatalf("two fresh version 4 uuids, then the handler's own: %v", got)
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

func TestACronTickRunsItsHookAsOneAtom(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	h.tick("reap", slot)

	// the request the hook made, then what it returned, one atom under a label of its own
	evs, _, _ := h.eventsRange(admin, "patron:p1", before, -1, false, 0)
	if len(evs) != 2 || evs[0].data["reason"] != "requested 2030-01-01T00:00:00.000Z" ||
		evs[0].commandid != evs[1].commandid || evs[0].commandid == "" {
		t.Fatalf("the tick's atom: %+v", evs)
	}
	reason := strings.Fields(evs[1].data["reason"].(string))
	if len(reason) != 3 || reason[0] != "reap" || reason[1] != "2030-01-01T00:00:00.000Z" {
		t.Fatalf("the tick's own output: %v", reason)
	}
	if now, err := time.Parse(time.RFC3339, reason[2]); err != nil || !now.Equal(evs[1].servertime) {
		t.Fatalf("the tick's now, against its atom's server time %v: %v", evs[1].servertime, reason[2])
	}

	// a slot at or below the mark was decided already, and a later one runs
	h.tick("reap", slot)
	h.tick("reap", slot.Add(-time.Hour))
	if got := h.reasons(admin, "p1", before); len(got) != 2 {
		t.Fatalf("a refired slot ran: %v", got)
	}
	h.tick("reap", slot.Add(time.Minute))
	if got := h.reasons(admin, "p1", before); len(got) != 4 {
		t.Fatalf("the next slot did not run: %v", got)
	}
}

func TestACronHookThatThrowsLeavesNothingButItsMark(t *testing.T) {
	h := start(t)
	admin := h.admin()
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	r := h.srv.tick(h.entry("broken"), slot)
	if r.status != 500 || !strings.Contains(r.errmsg, "the broken entry") {
		t.Fatalf("a throwing hook: %d %q", r.status, r.errmsg)
	}

	// the slot was decided, so it does not run again, and the log moved on without it
	h.tick("broken", slot)
	if at := h.accept(admin, cmd("c2", "rename-patron", "id", "p1", "name", "Bea")); at != before+1 {
		t.Fatalf("the next command landed at %d after %d", at, before)
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
	before := h.accept(admin, cmd("c1", "add-patron", "id", "p1", "name", "Ann"))
	slot := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	h.tick("reap", slot)
	h.stop()
	h = startIn(t, dir)
	again := h.srv.arm(time.Now().Add(time.Hour).Truncate(time.Minute)).marks
	if again[h.entry("zoned")] != marks[h.entry("zoned")] || again[h.entry("reap")] != slot.Unix() {
		t.Fatalf("the marks after a restart: %v, from %v", again, marks)
	}
	h.tick("reap", slot)
	if got := h.reasons(h.admin(), "p1", before); len(got) != 2 {
		t.Fatalf("a decided slot ran again after a restart: %v", got)
	}
}
