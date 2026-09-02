#!/usr/bin/env python3
"""Behavioral test of the emitted Python checkers.

Runs the actual generated code: `pnpm gen` compiles fixtures/main.tsp through the Python emitter
into tsp-output/, and the tests below feed native dicts/lists to the check_x functions and inspect
the returned list of problem strings.  Checkers validate structure and discriminate unions; a
valid value yields [], a malformed one yields one or more problems.

No third-party dependencies: tests register themselves with @register_test and `python3
test_checkers.py` runs them all.  The generated module imports the compiled `_quickjs` extension
at load time (only used by the Engine runtime, never by the checkers), so we install a stub
for it before importing.
"""

import os
import sys
import types
import traceback

# --- stub the compiled _quickjs extension the generated module imports at load time ----------


def _install_quickjs_stub() -> None:
    stub = types.ModuleType("_quickjs")

    class _Any:
        def __getattr__(self, _name):
            return _Any()

        def __call__(self, *args, **kwargs):
            return _Any()

    # PEP 562 module __getattr__: any attribute access (e.g. `_quickjs.Value` in an annotation)
    # resolves to a permissive placeholder.  The checkers never touch it.
    stub.__getattr__ = lambda _name: _Any()  # type: ignore[attr-defined]
    sys.modules["_quickjs"] = stub


_install_quickjs_stub()

_HERE = os.path.dirname(os.path.abspath(__file__))
_GEN = os.path.join(_HERE, "..", "tsp-output", "@phaselock", "typespec-py")
sys.path.insert(0, _GEN)

import model  # noqa: E402


# --- tiny test registry ----------------------------------------------------------------------

_TESTS = []


def register_test(fn):
    _TESTS.append(fn)
    return fn


def ok(fn, value):
    """Assert the checker accepts `value` (no problems)."""
    problems = fn(value)
    assert problems == [], f"{fn.__name__}({value!r}): expected no problems, got {problems}"


def fails(fn, value, needle=None):
    """Assert the checker rejects `value`, optionally with a problem containing `needle`."""
    problems = fn(value)
    assert problems, f"{fn.__name__}({value!r}): expected a problem, got none"
    if needle is not None:
        assert any(needle in p for p in problems), (
            f"{fn.__name__}({value!r}): {problems} has no problem containing {needle!r}"
        )


ISO = "2024-01-02T03:04:05Z"
ISO_MS = "2020-06-07T08:09:10.123Z"


# --- plain / scalar structs ------------------------------------------------------------------


@register_test
def test_plain_ok():
    ok(model.check_plain, {"id": "x", "n": 7, "flag": True})


@register_test
def test_plain_wrong_types_and_missing():
    fails(model.check_plain, {"id": 1, "n": 7, "flag": True}, needle="not string")
    fails(model.check_plain, {"id": "x", "n": "7", "flag": True}, needle="not int")
    fails(model.check_plain, {"id": "x", "n": 7}, needle="missing required key flag")
    fails(model.check_plain, ["not", "a", "dict"], needle="not json object")


@register_test
def test_plain_rejects_extra_keys():
    fails(model.check_plain, {"id": "x", "n": 7, "flag": True, "surprise": 1}, needle="contains extra keys")


# --- dates -----------------------------------------------------------------------------------


@register_test
def test_timed_accepts_both_iso_formats():
    ok(model.check_timed, {"at": ISO})
    ok(model.check_timed, {"at": ISO_MS, "note": ISO})


@register_test
def test_timed_optional_note_absent_is_ok():
    ok(model.check_timed, {"at": ISO})


@register_test
def test_timed_bad_and_missing_dates():
    fails(model.check_timed, {"at": "nope"}, needle="invalid timestamp")
    fails(model.check_timed, {"at": 123}, needle="invalid timestamp")
    fails(model.check_timed, {"note": ISO}, needle="missing required key at")


# --- nested / collections --------------------------------------------------------------------


@register_test
def test_nested_recurses_into_inner_struct():
    ok(model.check_nested, {"inner": {"at": ISO}, "tags": ["a", "b"], "count": 3})
    fails(model.check_nested, {"inner": {"at": "bad"}, "tags": [], "count": 3}, needle="invalid timestamp")


@register_test
def test_with_record_ok_and_bad_value():
    ok(model.check_with_record, {"meta": {"a": 1, "b": 2}})
    fails(model.check_with_record, {"meta": {"a": "one"}}, needle="not int")


@register_test
def test_with_date_record_checks_values():
    ok(model.check_with_date_record, {"stamps": {"a": ISO, "b": ISO_MS}})
    fails(model.check_with_date_record, {"stamps": {"a": "nope"}}, needle="invalid timestamp")
    fails(model.check_with_date_record, {"stamps": {"a": 123}}, needle="invalid timestamp")


@register_test
def test_tuple_shape_and_elements():
    ok(model.check_with_tuple, {"pair": ["label", ISO]})
    fails(model.check_with_tuple, {"pair": ["label"]}, needle="expected 2 items")
    fails(model.check_with_tuple, {"pair": [5, ISO]}, needle="not string")
    fails(model.check_with_tuple, {"pair": ["label", "nope"]}, needle="invalid timestamp")
    fails(model.check_with_tuple, {"pair": "notlist"}, needle="not json array")


# --- discriminated union (by `type`) ---------------------------------------------------------


@register_test
def test_greek_discriminates_on_type():
    ok(model.check_greek, {"type": "alpha", "a": 1})
    ok(model.check_greek, {"type": "beta", "at": ISO})


@register_test
def test_greek_rejects_bad_discriminator():
    fails(model.check_greek, {"a": 1}, needle='missing discriminator "type"')
    fails(model.check_greek, {"type": "gamma"}, needle="unexpected value")
    fails(model.check_greek, "not a dict", needle="not allowed here")


# --- sub-discriminated union (by `[type, v]`): the regression the fix targets ----------------


@register_test
def test_versioned_splits_on_type_then_v():
    ok(model.check_versioned, {"type": "va", "v": 1, "a": 9})
    ok(model.check_versioned, {"type": "va", "v": 2, "at": ISO})
    ok(model.check_versioned, {"type": "vb", "v": 1, "b": "z"})


@register_test
def test_versioned_rejects_bad_sub_discriminator():
    # reads `v` off the object, not the extracted `type` string (the bug would raise/mismatch here)
    fails(model.check_versioned, {"type": "va", "v": 99, "a": 1}, needle="unexpected value")
    fails(model.check_versioned, {"type": "va", "a": 1}, needle='missing discriminator "v"')
    fails(model.check_versioned, {"type": "vc"}, needle="unexpected value")


# --- one-of union (by present key) -----------------------------------------------------------


@register_test
def test_target_detects_present_key():
    ok(model.check_target, {"book": "b1"})
    ok(model.check_target, {"at": ISO})


@register_test
def test_target_rejects_no_matching_key():
    fails(model.check_target, {"nope": 1}, needle="no matching keys found")
    fails(model.check_target, 5, needle="not allowed here")


# --- literal unions --------------------------------------------------------------------------


@register_test
def test_literal_unions():
    ok(model.check_color, "green")
    fails(model.check_color, "purple", needle="unexpected value")
    fails(model.check_color, 3, needle="not allowed here")
    ok(model.check_level, 2)
    fails(model.check_level, 9, needle="unexpected value")
    fails(model.check_level, "2", needle="not allowed here")


# --- bool/int strictness (bool is a subclass of int in Python; json keeps them apart) --------


@register_test
def test_bools_are_not_ints():
    fails(model.check_plain, {"id": "x", "n": True, "flag": True}, needle="not int")
    fails(model.check_plain, {"id": "x", "n": 7, "flag": 1}, needle="not bool")
    fails(model.check_level, True, needle="not allowed here")
    fails(model.check_versioned, {"type": "va", "v": True, "a": 1}, needle="unexpected value")


@register_test
def test_bool_literals_are_exact():
    ok(model.check_toggled, {"on": True})
    fails(model.check_toggled, {"on": 1}, needle="is not True")
    fails(model.check_toggled, {"on": False}, needle="is not True")


# --- engine event / command unions --------------------------------------------------------


@register_test
def test_engine_unions():
    ok(model.check_events, {"type": "beta", "at": ISO})
    ok(model.check_events, {"type": "other"})
    fails(model.check_events, {"type": "nope"}, needle="unexpected value")
    ok(model.check_commands, {"type": "do-thing", "when": ISO})
    ok(model.check_commands, {"type": "undo"})
    fails(model.check_commands, {"type": "nope"}, needle="unexpected value")


# --- runner ----------------------------------------------------------------------------------


def main() -> int:
    passed = 0
    failed = 0
    for fn in _TESTS:
        try:
            fn()
        except Exception:  # noqa: BLE001 - a failing test is any exception, incl. AssertionError
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
        else:
            passed += 1
            print(f"ok   {fn.__name__}")
    print(f"\n{passed} passed, {failed} failed ({len(_TESTS)} total)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
