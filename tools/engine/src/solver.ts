/**
 * The union solver.
 *
 * Given the members of a union, the solver produces a decision tree ("solution") describing how a
 * decoder can identify which member a JSON value belongs to.  Emitters walk the solution to
 * generate decoding and checking code.
 */

import {
  PArray,
  PLiteral,
  PStruct,
  PTuple,
  PType,
  PTypeRegistry,
  LitValue,
  members,
} from './ptypes.js';

/** Match means there is only one option remaining. */
export class Match {
  constructor(readonly typ: PType) {}
}

/** CheckJsonType means check the json type and proceed with solution = options.get(json_type). */
export class CheckJsonType {
  constructor(readonly options: Map<string, Solution>) {}
}

/** CheckLiteral means you should check the value and proceed with solution = options.get(value). */
export class CheckLiteral {
  constructor(readonly options: Map<LitValue, Solution>) {}
}

/**
 * CheckLength means you should take the length of the array and proceed with
 * solution = options.get(length) ?? default.
 */
export class CheckLength {
  readonly default: Solution | null;
  constructor(
    readonly options: Map<number, Solution>,
    dflt: Solution | null = null,
  ) {
    this.default = dflt;
  }
}

/** GetIndex means you should select the index from the array and feed that to the solution. */
export class GetIndex {
  constructor(
    readonly i: number,
    readonly solution: Solution,
  ) {}
}

/** GetField means you should select the field from the struct and feed that to the solution. */
export class GetField {
  constructor(
    readonly key: string,
    readonly solution: Solution,
  ) {}
}

/** HasField means you should check for each field in order, and pick the corresponding solution. */
export class HasField {
  constructor(readonly solutions: readonly (readonly [string, Solution])[]) {}
}

export type Solution =
  Match | CheckJsonType | CheckLiteral | CheckLength | GetIndex | GetField | HasField;

export function solveUnion(registry: PTypeRegistry, types: Iterable<PType>): CheckJsonType {
  // outer layer: check json type
  const jtypes = new Map<string, PType[]>();
  for (const t of types) {
    let arr = jtypes.get(t.jsonType);
    if (arr === undefined) jtypes.set(t.jsonType, (arr = []));
    arr.push(t);
  }

  const out = new Map<string, Solution>();
  for (const [jt, matches] of jtypes) {
    if (matches.length === 1) {
      // only one option for this json type
      out.set(jt, new Match(matches[0]));
    } else if (jt === 'string' || jt === 'boolean' || jt === 'int') {
      // union of multiple literals
      if (!matches.every((t) => t instanceof PLiteral)) {
        throw new Error(`unable to solve union between ${matches.join(', ')}`);
      }
      out.set(jt, solveUnionLiterals(matches as PLiteral[]));
    } else if (jt === 'object') {
      // union of multiple structs
      if (!matches.every((t) => t instanceof PStruct)) {
        throw new Error(`unable to solve union of non-struct objects: ${matches.join(' | ')}`);
      }
      out.set(jt, solveUnionStructs(matches as PStruct[]));
    } else if (jt === 'array') {
      // union of tuples, or maybe of non-empty arrays
      out.set(jt, solveUnionArrays(registry, matches as (PArray | PTuple)[]));
    } else {
      // null can't have union types because there's only one
      // float can't have union types because equality checks are flaky
      throw new Error('union not allowed between multiple types that encode as ' + jt);
    }
  }

  // Keep the CheckJsonType layer, even if there's only one type, because many languages will need
  // a type check up front to avoid type errors when processing other checks.
  return new CheckJsonType(out);
}

function solveUnionLiterals(types: readonly PLiteral[]): CheckLiteral {
  const out = new Map<LitValue, Solution>();
  for (const t of types) out.set(t.value, new Match(t));
  return new CheckLiteral(out);
}

function solveUnionStructs(types: readonly PStruct[]): Solution {
  if (types.length === 1) return new Match(types[0]);

  // There could be a lot of ways to distinguish different structs, but for now I think we will
  // only solve oneof unions, where there is only one key, and discriminated unions, where each
  // struct has e.g. a .type field.  Discriminated unions also need to support a subdiscriminator,
  // since we expect most types to have a .v field that distinguishes different event schema
  // versions.  As exceptions arise, we can write a more advanced solver.

  // first check for oneof unions, where each member has a single key and they're all different.
  if (types.every((t) => t.fields.size === 1 && t.always.size === 1)) {
    const solutions = new Map<string, PStruct[]>();
    for (const t of types) {
      const field = t.fields.keys().next().value!;
      let arr = solutions.get(field);
      if (arr === undefined) solutions.set(field, (arr = []));
      arr.push(t);
    }
    // grouping must make progress; members all sharing one key fall through to the
    // discriminator logic below
    if (solutions.size > 1) {
      return new HasField([...solutions].map(([f, ts]) => [f, solveUnionStructs(ts)] as const));
    }
  }

  // then look for keys with literals that can distinguish our different elements (a "type" key)
  const litkeys = new Map<string, { count: number; values: Set<LitValue> }>();
  for (const t of types) {
    for (const [k, f] of t.fields) {
      if (f instanceof PLiteral) {
        let entry = litkeys.get(k);
        if (entry === undefined) litkeys.set(k, (entry = { count: 0, values: new Set() }));
        entry.count += 1;
        entry.values.add(f.value);
      }
    }
  }

  if (litkeys.size === 0) {
    throw new Error(`union without discriminator: ${types.join(' | ')}`);
  }

  // we expect a discriminator to exist which is common to all structs
  const keysOnAllTypes = new Map(
    [...litkeys].filter(([, e]) => e.count === types.length).map(([k, e]) => [k, e.values]),
  );
  if (keysOnAllTypes.size === 0) {
    throw new Error(`union has no discriminator common to all structs: ${types.join(' | ')}`);
  }

  // check for a key that uniquely identifies all types
  const perfectKeys = [...keysOnAllTypes]
    .filter(([, vals]) => vals.size === types.length)
    .map(([k]) => k);
  if (perfectKeys.length > 0) {
    // sort "v" to the end; if another discriminator is present we should never need it
    perfectKeys.sort((a, b) => Number(a === 'v') - Number(b === 'v'));
    // multiple discriminators may mean the solver has done something weird, except the special
    // case where one is .v, because that could just mean a new union was created using two
    // event types where the second one is on v=2.
    if (perfectKeys.length - Number(perfectKeys[perfectKeys.length - 1] === 'v') > 1) {
      throw new Error(`warning: multiple discriminators (${perfectKeys}): ${types.join(' | ')}`);
    }
    const k = perfectKeys[0];
    const out = new Map<LitValue, Solution>();
    for (const t of types) {
      out.set((t.fields.get(k) as PLiteral).value, new Match(t));
    }
    return new GetField(k, new CheckLiteral(out));
  }

  // if there was only one option, it should have uniquely identified all types
  if (keysOnAllTypes.size === 1) {
    const k = keysOnAllTypes.keys().next().value;
    throw new Error(
      `union's only discriminator (${k}) does not uniquely identify all options: ${types.join(' | ')}`,
    );
  }

  // at this point, we'll assume the only valid case is a set of discriminators like [.type, .v],
  // which is probably unnecessarily strict, but we'll allow more cases when we have a reason to
  const keys = [...keysOnAllTypes.keys()].sort((a, b) => Number(a === 'v') - Number(b === 'v'));
  if (keys.length !== 2 || keys[keys.length - 1] !== 'v') {
    throw new Error(`unexpected discriminators: (${keys} != [*, v]): ${types.join(' | ')}`);
  }

  // build a map of discriminator value to subtypes
  const k = keys[0];
  const valueToSubtypes = new Map<LitValue, PStruct[]>();
  for (const t of types) {
    const v = (t.fields.get(k) as PLiteral).value;
    let arr = valueToSubtypes.get(v);
    if (arr === undefined) valueToSubtypes.set(v, (arr = []));
    arr.push(t);
  }

  // build a CheckLiteral with subsolvers per value
  const out = new Map<LitValue, Solution>();
  for (const [v, subtypes] of valueToSubtypes) out.set(v, solveUnionStructs(subtypes));
  return new GetField(k, new CheckLiteral(out));
}

function solveUnionArrays(registry: PTypeRegistry, types: readonly (PArray | PTuple)[]): Solution {
  const out = new Map<number, Solution>();
  let remaining = [...types];

  // first handle empties; if more than one type can be empty we'll be unable to distinguish them
  const empties = remaining.filter((t) => t.lengthRange()[0] === 0);
  if (empties.length > 1) {
    throw new Error('unable to union multiple possibly-empty arrays');
  }
  if (empties.length === 1) {
    const t = empties[0];
    out.set(0, new Match(t));
    if (t.lengthRange()[1] === 0) {
      // t was the empty tuple; we've fully detected it now
      remaining = remaining.filter((x) => x !== t);
    }
  }

  // length check for all fixed-length types
  const fixies = new Set(
    remaining
      .map((t) => t.lengthRange())
      .filter(([m, M]) => m === M)
      .map(([m]) => m),
  );
  for (const n of fixies) {
    const matches = remaining.filter((t) => {
      const [m, M] = t.lengthRange();
      return m <= n && n <= M;
    });
    if (matches.length === 1) {
      out.set(n, new Match(matches[0]));
      // done with this type
      remaining = remaining.filter((t) => t !== matches[0]);
      continue;
    }
    // we have n entries for m matches; we need a matrix of checks: "how to distinguish each item
    // in one match from the same item in the other matches"; then we can select the checks that
    // uniquely identify each match from the others, starting with most uniqifying checks.
    //
    // Well, start with the easy cases: try a union_solve on each index and hope one uniquely
    // identifies all matches.  This will probably almost always be the case.
    let solution: Solution | null = null;
    let subtypes: PType[] = [];
    let index = -1;
    for (let i = 0; i < n; i++) {
      subtypes = matches.map((t) => t.typeat(i));
      if (detectUnionOverlap(subtypes)) continue;
      try {
        const union = registry.union(subtypes);
        solution = solveUnion(registry, members(union));
        index = i;
        break;
      } catch {
        continue;
      }
    }
    if (solution === null) {
      // ok, I'm actually not going to write a more advanced solver until I know I have to
      throw new Error('Not implemented: multi-step tuple distinguisher');
    }
    // map subtype matches to our original types and prune the resulting decision tree
    solution = remapAndPrune(solution, subtypes, matches);
    out.set(n, new GetIndex(index, solution));
    // any type which is an exact length match is now fully matched
    remaining = remaining.filter((t) => {
      const [m, M] = t.lengthRange();
      return !(m === M && M === n);
    });
  }

  // we may have zero or one types to distinguish at this point
  if (remaining.length < 2) {
    const dflt = remaining.length ? new Match(remaining[0]) : null;
    return new CheckLength(out, dflt);
  }

  // all tuples should be distinguished, we should be left with only arrays; they must be solvable
  // according to their first element (and we already uniquely identified any incoming empty array)
  const subtypes = remaining.map((t) => t.typeat(0));
  const union = registry.union(subtypes);
  let solution: Solution = solveUnion(registry, members(union));
  solution = remapAndPrune(solution, subtypes, remaining);
  return new CheckLength(out, solution);
}

// solver helpers

/** Return true if any of the maybe-unions in subtypes have any overlap with any of the others. */
function detectUnionOverlap(subtypes: readonly PType[]): boolean {
  const alltypes = new Set<PType>();
  for (const st of subtypes) {
    for (const t of members(st)) {
      if (alltypes.has(t)) return true;
      alltypes.add(t);
    }
  }
  return false;
}

/**
 * After using a solveUnion() on e.g. the first field of a tuple type, we need to take the tree of
 * the solution, remap leaves from subtypes to matches, and prune any branches that all lead to the
 * same final match.
 *
 * subtypes is a list of maybe-unions (which are known to have no overlap) and matches is a list of
 * concrete types.
 */
export function remapAndPrune(
  solution: Solution,
  subtypes: readonly PType[],
  matches: readonly PType[],
): Solution {
  const remap = new Map<PType, PType>();
  subtypes.forEach((st, i) => {
    for (const t of members(st)) remap.set(t, matches[i]);
  });

  // returns a new [solution, possible]
  function visit(solution: Solution): [Solution, Set<PType>] {
    if (solution instanceof Match) {
      const typ = remap.get(solution.typ)!;
      return [new Match(typ), new Set([typ])];
    }
    // CheckJsonType and CheckLiteral happen to have identical logic
    if (solution instanceof CheckJsonType || solution instanceof CheckLiteral) {
      const possible = new Set<PType>();
      const out = new Map<any, Solution>();
      for (const [key, subsln] of solution.options) {
        const [newsubsln, subposs] = visit(subsln);
        out.set(key, newsubsln);
        for (const p of subposs) possible.add(p);
      }
      if (possible.size === 1) return [new Match([...possible][0]), possible];
      const cls = solution instanceof CheckJsonType ? CheckJsonType : CheckLiteral;
      return [new cls(out), possible];
    }
    if (solution instanceof CheckLength) {
      const possible = new Set<PType>();
      const out = new Map<number, Solution>();
      for (const [length, subsln] of solution.options) {
        const [newsubsln, subposs] = visit(subsln);
        out.set(length, newsubsln);
        for (const p of subposs) possible.add(p);
      }
      let dflt: Solution | null = null;
      if (solution.default !== null) {
        const [newdflt, subposs] = visit(solution.default);
        dflt = newdflt;
        for (const p of subposs) possible.add(p);
      }
      if (possible.size === 1) return [new Match([...possible][0]), possible];
      return [new CheckLength(out, dflt), possible];
    }
    if (solution instanceof GetIndex) {
      const [subsln, possible] = visit(solution.solution);
      if (possible.size === 1) return [new Match([...possible][0]), possible];
      return [new GetIndex(solution.i, subsln), possible];
    }
    if (solution instanceof GetField) {
      const [subsln, possible] = visit(solution.solution);
      if (possible.size === 1) return [new Match([...possible][0]), possible];
      return [new GetField(solution.key, subsln), possible];
    }
    throw new Error(`unrecognized solution type: ${solution.constructor.name}`);
  }

  return visit(solution)[0];
}
