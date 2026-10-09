package main

import (
	"regexp"
	"strings"
	"testing"
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
