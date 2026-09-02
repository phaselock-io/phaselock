// Behavioral test of the emitted Go checkers.
//
// Runs the actual generated code: `pnpm gen` compiles fixtures/main.tsp through the Go emitter,
// and `pnpm --filter ...-tests test:go` copies the emitted model.go into this package and runs
// `go test`.  Each case parses a JSON literal into a goja.Value (matching how the relay feeds
// values in) and calls CheckX(vm, value, path); a valid value yields a nil error, a malformed one
// a non-nil error whose text names the problem.
//
// Go's timestamp check is the strict `2006-01-02T15:04:05Z` layout (no fractional seconds), so
// the ISO values here omit milliseconds.
package model

import (
	"strings"
	"testing"

	"github.com/dop251/goja"
)

const iso = "2024-01-02T03:04:05Z"

type checkFn func(*goja.Runtime, goja.Value, string) error

func parse(t *testing.T, vm *goja.Runtime, jsonStr string) goja.Value {
	t.Helper()
	if err := vm.Set("__input", jsonStr); err != nil {
		t.Fatalf("set input: %v", err)
	}
	v, err := vm.RunString("JSON.parse(__input)")
	if err != nil {
		t.Fatalf("JSON.parse(%s): %v", jsonStr, err)
	}
	return v
}

func ok(t *testing.T, check checkFn, jsonStr string) {
	t.Helper()
	vm := goja.New()
	if err := check(vm, parse(t, vm, jsonStr), "<root>"); err != nil {
		t.Errorf("expected valid, got: %v\n  input: %s", err, jsonStr)
	}
}

func fails(t *testing.T, check checkFn, jsonStr, needle string) {
	t.Helper()
	vm := goja.New()
	err := check(vm, parse(t, vm, jsonStr), "<root>")
	if err == nil {
		t.Errorf("expected a problem, got nil\n  input: %s", jsonStr)
		return
	}
	if needle != "" && !strings.Contains(err.Error(), needle) {
		t.Errorf("error %q missing %q\n  input: %s", err.Error(), needle, jsonStr)
	}
}

func TestPlain(t *testing.T) {
	ok(t, CheckPlain, `{"id":"x","n":7,"flag":true}`)
	fails(t, CheckPlain, `{"id":1,"n":7,"flag":true}`, "not string")
	fails(t, CheckPlain, `{"id":"x","n":7}`, "missing required field")
	fails(t, CheckPlain, `{"id":"x","n":7,"flag":true,"surprise":1}`, "contains extra keys")
	fails(t, CheckPlain, `5`, "not a json object")
}

func TestTimed(t *testing.T) {
	ok(t, CheckTimed, `{"at":"`+iso+`"}`)
	ok(t, CheckTimed, `{"at":"`+iso+`","note":"`+iso+`"}`)
	fails(t, CheckTimed, `{"at":"nope"}`, "not a valid timestamp")
	fails(t, CheckTimed, `{"note":"`+iso+`"}`, "missing required field")
}

func TestNested(t *testing.T) {
	ok(t, CheckNested, `{"inner":{"at":"`+iso+`"},"tags":["a","b"],"count":3}`)
	fails(t, CheckNested, `{"inner":{"at":"bad"},"tags":[],"count":3}`, "not a valid timestamp")
}

func TestWithRecord(t *testing.T) {
	ok(t, CheckWithRecord, `{"meta":{"a":1,"b":2}}`)
	fails(t, CheckWithRecord, `{"meta":{"a":"one"}}`, "not int")
}

func TestWithTuple(t *testing.T) {
	ok(t, CheckWithTuple, `{"pair":["label","`+iso+`"]}`)
	fails(t, CheckWithTuple, `{"pair":["label"]}`, "expected 2 items")
	fails(t, CheckWithTuple, `{"pair":[5,"`+iso+`"]}`, "not string")
	fails(t, CheckWithTuple, `{"pair":["label","nope"]}`, "not a valid timestamp")
	fails(t, CheckWithTuple, `{"pair":"notlist"}`, "not json array")
}

func TestGreek(t *testing.T) {
	ok(t, CheckGreek, `{"type":"alpha","a":1}`)
	ok(t, CheckGreek, `{"type":"beta","at":"`+iso+`"}`)
	fails(t, CheckGreek, `{"a":1}`, "missing discriminator")
	fails(t, CheckGreek, `{"type":"gamma"}`, "unexpected literal")
	fails(t, CheckGreek, `5`, "not allowed here")
}

// The [type, v] regression: the pre-fix walker reassigned x to the "type" string and then
// panicked on x.(*goja.Object).Get("v").
func TestVersioned(t *testing.T) {
	ok(t, CheckVersioned, `{"type":"va","v":1,"a":9}`)
	ok(t, CheckVersioned, `{"type":"va","v":2,"at":"`+iso+`"}`)
	ok(t, CheckVersioned, `{"type":"vb","v":1,"b":"z"}`)
	fails(t, CheckVersioned, `{"type":"va","v":99,"a":1}`, "unexpected literal")
	fails(t, CheckVersioned, `{"type":"va","a":1}`, "missing discriminator")
	fails(t, CheckVersioned, `{"type":"vc"}`, "unexpected literal")
}

func TestTarget(t *testing.T) {
	ok(t, CheckTarget, `{"book":"b1"}`)
	ok(t, CheckTarget, `{"at":"`+iso+`"}`)
	fails(t, CheckTarget, `{"nope":1}`, "no matching fields")
	fails(t, CheckTarget, `5`, "not allowed here")
}

func TestLiteralUnions(t *testing.T) {
	ok(t, CheckColor, `"green"`)
	fails(t, CheckColor, `"purple"`, "unexpected literal")
	fails(t, CheckColor, `3`, "not allowed here")
	ok(t, CheckLevel, `2`)
	fails(t, CheckLevel, `9`, "unexpected literal")
	fails(t, CheckLevel, `"2"`, "not allowed here")
}

func TestEngineUnions(t *testing.T) {
	ok(t, CheckEvents, `{"type":"beta","at":"`+iso+`"}`)
	ok(t, CheckEvents, `{"type":"other"}`)
	fails(t, CheckEvents, `{"type":"nope"}`, "unexpected literal")
	ok(t, CheckCommands, `{"type":"do-thing","when":"`+iso+`"}`)
	ok(t, CheckCommands, `{"type":"undo"}`)
	fails(t, CheckCommands, `{"type":"nope"}`, "unexpected literal")
}
