// Shared fixture model for the emitter behavioral tests (TS decoders, TS/Py/Go checkers).
//
// The models here are chosen to exercise every solver / codegen branch independently of the
// demos: plain identity decode, date decode (required + optional), nested-struct recursion,
// arrays, tuples, records, discriminated unions (by `type` and by `[type, v]`), one-of unions,
// string- and int-literal unions, plus a Store and Engine so the store-context and engine
// generation paths are exercised too.  All three emitters read this same source.

import "@phaselock/typespec";

using PhaseLock;

// --- plain / scalar structs -------------------------------------------------

// no fields need transformation -> identity decode
model Plain {
  id: string;
  n: int32;
  flag: boolean;
}

// required and optional date fields -> `new Date(...)`, the optional one guarded
model Timed {
  at: utcDateTime;
  note?: utcDateTime;
}

// nested struct (recurses into Timed) + array + scalar
model Nested {
  inner: Timed;
  tags: string[];
  count: int32;
}

// tuple with a date element, and a record of ints
model WithTuple {
  pair: [string, utcDateTime];
}

model WithRecord {
  meta: Record<int32>;
}

// record whose values need real decoding -> a decodeAnonN function (not the identity spread)
model WithDateRecord {
  stamps: Record<utcDateTime>;
}

// --- discriminated union by `type` ------------------------------------------

model Alpha {
  type: "alpha";
  a: int32;
}

model Beta {
  type: "beta";
  at: utcDateTime;
}

model Other {
  type: "other";
}

union Greek {
  Alpha,
  Beta,
}

// --- sub-discriminated union by `[type, v]` ---------------------------------
//
// `type` alone is not unique (two members share "va") and `v` alone is not unique (two members
// share 1), so the solver must split on `type` first and then on `v` within the "va" bucket.
// VA2 carries a date, so the decoder recurses inside the nested switch.

model VA1 {
  type: "va";
  v: 1;
  a: int32;
}

model VA2 {
  type: "va";
  v: 2;
  at: utcDateTime;
}

model VB {
  type: "vb";
  v: 1;
  b: string;
}

union Versioned {
  VA1,
  VA2,
  VB,
}

// --- one-of union (distinguished by which key is present) -------------------
//
// ByEdition carries a date, so the one-of decoder must detect the present key and decode the
// matching member (a plain identity pass-through would drop the Date conversion).

model ByBook {
  book: string;
}

model ByEdition {
  at: utcDateTime;
}

union Target {
  ByBook,
  ByEdition,
}

// --- literal unions ---------------------------------------------------------

union Color {
  "red",
  "green",
  "blue",
}

union Level {
  1,
  2,
  3,
}

// bool-literal field -> exact check (in Python, True == 1 must not leak through)
model Toggled {
  on: true;
}

// --- engine events / commands -----------------------------------------------

// distinct member set from Greek so it interns to a different union
union Events {
  Alpha,
  Beta,
  Other,
}

model DoThing {
  type: "do-thing";
  when: utcDateTime;
}

model Undo {
  type: "undo";
}

union Commands {
  DoThing,
  Undo,
}

// --- store + engine ---------------------------------------------------------

interface DemoStore
  extends Store<{
    `plain.{id}`: Plain;
    `timed.{id}`: Timed;
  }> {}

interface DemoEngine extends Engine<Events, Commands, DemoStore> {}
