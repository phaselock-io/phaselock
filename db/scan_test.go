package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// the store type the conformance keys are written under: a plain string, so each key's value is
// its own name
const conformanceType = "shelf/lend"

type conformanceCase struct {
	Name    string          `json:"name"`
	Pattern json.RawMessage `json:"pattern"`
	Expect  []string        `json:"expect"`
}

// openConformanceStore holds every key of the TypeScript skeleton's scan conformance fixture,
// each with its own name as its value, and answers the fixture's cases.  Its scans step through
// budget keys before a seek, or the core's own number for a negative budget.
func openConformanceStore(t *testing.T, budget int) (*scanTest, []conformanceCase) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "typespec", "tests", "fixtures", "scan-conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Keys  []string          `json:"keys"`
		Cases []conformanceCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	st, err := openScanTest(filepath.Join("testdata", "bundle.js"), filepath.Join(t.TempDir(), "scan.db"), budget)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.close)
	for _, k := range fixture.Keys {
		if err := st.put(k, conformanceType, k); err != nil {
			t.Fatalf("put %q: %v", k, err)
		}
	}
	return st, fixture.Cases
}

type scanBatch struct {
	Entries [][]any `json:"entries"`
	Next    *string `json:"next"`
}

// scanAll walks a pattern batch by batch, each batch resuming from the last one's next, and
// checks each batch's shape on the way.
func scanAll(t *testing.T, st *scanTest, pattern json.RawMessage, typ any, reverse bool, limit int) [][]any {
	t.Helper()
	var all [][]any
	var after *string
	for {
		req := map[string]any{"pattern": pattern, "type": typ, "reverse": reverse, "limit": limit}
		if after != nil {
			req["after"] = *after
		}
		body, _ := json.Marshal(req)
		out, err := st.scan(body)
		if err != nil {
			t.Fatalf("scan %s: %v", body, err)
		}
		var b scanBatch
		if err := json.Unmarshal(out, &b); err != nil {
			t.Fatalf("batch %s: %v", out, err)
		}
		if len(b.Entries) > limit {
			t.Fatalf("a batch of %d at limit %d", len(b.Entries), limit)
		}
		all = append(all, b.Entries...)
		if b.Next == nil {
			return all
		}
		if len(b.Entries) != limit || *b.Next != b.Entries[len(b.Entries)-1][0] {
			t.Fatalf("next %q after a batch of %v at limit %d", *b.Next, b.Entries, limit)
		}
		after = b.Next
	}
}

// The fixture's gaps between matches are short enough that the core's own budget steps over
// every one, so the cases run again seeking at every gap.
func TestScanConformance(t *testing.T) {
	for _, budget := range []int{-1, 0} {
		st, cases := openConformanceStore(t, budget)
		checkConformance(t, st, cases)
	}
}

// every case, forward and reversed, whole and resumed at every batch boundary
func checkConformance(t *testing.T, st *scanTest, cases []conformanceCase) {
	checks := 0
	for _, c := range cases {
		var p struct {
			Name *string `json:"name"`
		}
		if err := json.Unmarshal(c.Pattern, &p); err != nil {
			t.Fatal(err)
		}
		var typ any = false
		if p.Name != nil {
			typ = conformanceType
		}
		for _, reverse := range []bool{false, true} {
			want := slices.Clone(c.Expect)
			if reverse {
				slices.Reverse(want)
			}
			for _, limit := range []int{1, 2, 3, 1000} {
				entries := scanAll(t, st, c.Pattern, typ, reverse, limit)
				var got []string
				for _, e := range entries {
					got = append(got, e[0].(string))
					// the value is the key's own name when the pattern names a template, and
					// absent for keys only
					if p.Name != nil && e[1] != e[0] {
						t.Errorf("%s: the value at %q is %v", c.Name, e[0], e[1])
					}
					if p.Name == nil && e[1] != nil {
						t.Errorf("%s: a keys-only scan answered %v at %q", c.Name, e[1], e[0])
					}
				}
				if !slices.Equal(got, want) {
					t.Errorf("%s (reverse %v, limit %d):\n got %q\nwant %q", c.Name, reverse, limit, got, want)
				}
				checks++
			}
		}
	}
	t.Logf("%d cases, %d walks", len(cases), checks)
}

func TestScanRequestErrors(t *testing.T) {
	st, _ := openConformanceStore(t, -1)
	for _, c := range []struct{ req, want string }{
		{`{"pattern": {"slice": "chat:acme,gen", "name": null, "local": []}, "type": "shelf/lend", "limit": 1}`,
			"a scan of every local key reads keys only"},
		{`{"pattern": {"slice": null, "name": "post", "local": []}, "type": false, "limit": 1}`,
			"a pattern over every slice picks out every local key"},
		{`{"pattern": {"slice": "login", "name": null, "local": [null]}, "type": false, "limit": 1}`,
			"a pattern over every local key matches no parameter"},
		{`{"pattern": {"slice": "login", "name": "user", "local": [null]}, "type": "nope", "limit": 1}`,
			"no registry entry for type nope"},
		{`{"pattern": {"slice": "login", "name": "user", "local": [null]}, "type": false, "limit": 0}`,
			"a scan's limit is at least 1"},
	} {
		if _, err := st.scan([]byte(c.req)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.req, err, c.want)
		}
	}
}

func TestADeciderScans(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("b1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("b2", "add-book", "id", "b2", "title", "Emma"))
	h.accept(admin, mut("b3", "add-book", "id", "b3", "title", "Dune"))

	// shelve reads the shelf's copies, with their values
	h.accept(admin, mut("s1", "shelve", "branch", "x", "book", "b1"))
	h.accept(admin, mut("s2", "shelve", "branch", "x", "book", "b2"))
	if o := h.mutations(admin, mut("s3", "shelve", "branch", "x", "book", "b3"))[0]; o.kind != "reject" || o.reason != "title on shelf" {
		t.Fatalf("a title already on the shelf: %+v", o)
	}

	// and only that shelf's
	h.accept(admin, mut("s4", "shelve", "branch", "y", "book", "b3"))
}

func TestADeciderScanSeesItsOwnWrites(t *testing.T) {
	h := start(t)
	admin := h.admin()
	for _, b := range [][2]string{{"b1", "Dune"}, {"b2", "Emma"}, {"b3", "Ivanhoe"}} {
		h.accept(admin, mut(b[0], "add-book", "id", b[0], "title", b[1]))
	}
	shelved := func(branch string) string {
		t.Helper()
		v := h.snapshot(admin, "shelf:"+branch).records["shelf:"+branch+"!shelved"]
		if v == nil {
			t.Fatalf("shelf:%s has no shelved key", branch)
		}
		return strings.Join(strs(v), ",")
	}

	// the decider's scan sees the copy it set just before it
	h.accept(admin, mut("s1", "shelve", "branch", "x", "book", "b1"))
	if got := shelved("x"); got != "copy:b1" {
		t.Fatalf("after the first copy: %s", got)
	}

	// and its own shelf's copies only, not a neighbour's whose name extends its own
	h.accept(admin, mut("s2", "shelve", "branch", "x-2", "book", "b2"))
	h.accept(admin, mut("s3", "shelve", "branch", "x", "book", "b3"))
	if got := shelved("x"); got != "copy:b1,copy:b3" {
		t.Fatalf("shelf:x: %s", got)
	}
	if got := shelved("x-2"); got != "copy:b2" {
		t.Fatalf("shelf:x-2: %s", got)
	}
}

func TestAGrantScanRerunsForKeysItsWalkCovers(t *testing.T) {
	h := start(t)
	admin := h.admin()
	h.accept(admin, mut("l1", "lend", "branch", "x", "patron", "r1"))

	// r1 is audited, so each run of its grantor changes its view; it sees the shelves that lend
	// to it, from a walk of every shelf's lend key for r1
	r1 := h.token("r1")
	s := h.connect(r1, -1)
	if s.first == nil || strings.Join(strs(s.first[3]), ",") != "book,patron:r1,shelf:run-1,shelf:x" {
		t.Fatalf("first view frame: %v", s.first)
	}
	s.live()

	// a key inside the walk re-runs the grantor, and the grant arrives ahead of the edits
	h.accept(admin, mut("l2", "lend", "branch", "y", "patron", "r1"))
	f := s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:r1,shelf:run-2,shelf:x,shelf:y" {
		t.Fatalf("a lend to r1: %v", got)
	}
	if evs := edits(s.nextTagged("edits")); evs[0].slice != "shelf:y" {
		t.Fatalf("the granted shelf's edits: %+v", evs)
	}

	// keys outside it do not, in a shelf r1 sees, whose edits come with no view frame ahead of
	// them, or in one it does not
	h.accept(admin, mut("l3", "lend", "branch", "x", "patron", "p9"))
	if evs := edits(s.nextTagged("edits")); evs[0].slice != "shelf:x" {
		t.Fatalf("a lend to another patron: %+v", evs)
	}
	h.accept(admin, mut("l4", "lend", "branch", "z", "patron", "p9"))
	s.quiet()
	h.accept(admin, mut("s1", "add-book", "id", "b1", "title", "Dune"))
	h.accept(admin, mut("s2", "shelve", "branch", "x", "book", "b1"))
	edits(s.nextTagged("edits")) // the book
	edits(s.nextTagged("edits")) // the copy

	// nor does a death outside the walk's slices
	h.accept(admin, mut("p1", "add-patron", "id", "p2", "name", "Bob"))
	h.accept(admin, mut("p2", "remove-patron", "id", "p2"))
	s.quiet()

	// the death of a shelf r1 lends at deletes a key the walk read, so the grantor runs again
	h.accept(admin, mut("c1", "close-shelf", "branch", "y"))
	f = s.nextTagged("view")
	if got := strings.Join(strs(f[3]), ","); got != "book,patron:r1,shelf:run-3,shelf:x" {
		t.Fatalf("a closed shelf: %v", got)
	}
}
