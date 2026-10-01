/**
 * TypeScript code generator: emits type aliases, decoders, and JSON structural checkers for the
 * model's types; each slice's reducer context and handler table; each engine's read context,
 * forecaster table, and Engine class; each database's read context, precommit table, and bundle
 * definition; and the typed query layers, all from the lowered IR.
 *
 * Names derive from the declarations the user wrote: `PatronSlice` gives `PatronSliceTxn` and
 * `PatronSliceReducers`, `UserEngine` gives `UserEngineTxn` and the `UserEngine` class, and a
 * handler table's keys are its event or command model names, camelCased.
 */

import {
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  Denter,
  GetField,
  GetIndex,
  HasField,
  LoweredProgram,
  Match,
  PArray,
  PBool,
  type PCommand,
  type PDatabase,
  PDate,
  type PEngine,
  PInt,
  PIntake,
  PJson,
  PLiteral,
  PNull,
  PObject,
  type POutput,
  PQueries,
  PQuery,
  PResult,
  type PSlice,
  PStoreItem,
  PString,
  PStruct,
  PTuple,
  PType,
  PTypeRegistry,
  PUnion,
  Solution,
  solveUnion,
} from '@phaselock/typespec-core';

type Annos = Map<PType, string>;
/** a decoder maps a value expression to a decoding expression; null is the identity decoder */
type Decoder = ((val: string) => string) | null;
type Decoders = Map<PType, Decoder>;
/** a checker maps (valueExpr, pathExpr) to TS statements appending to `problems`; noop → "" */
type Checker = (val: string, path: string) => string;
type Checkers = Map<PType, Checker>;

const NOOP: Checker = () => '';

function lowerFirst(name: string): string {
  return name[0].toLowerCase() + name.slice(1);
}

/** a name as an object key or property: bare when it is an identifier, quoted otherwise */
function prop(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function generateAnnotations(d: Denter, annos: Annos, t: PType): void {
  const visit = (t: PType): void => {
    // visit each type only once
    if (annos.has(t)) return;
    // handle builtin types
    const builtin =
      t instanceof PDate
        ? 'Date'
        : t instanceof PString
          ? 'string'
          : t instanceof PInt
            ? 'number'
            : t instanceof PBool
              ? 'boolean'
              : t instanceof PJson
                ? 'unknown'
                : t instanceof PNull
                  ? 'null'
                  : null;
    if (builtin !== null) {
      annos.set(t, builtin);
      return;
    }
    // handle literals, which never need a type definition
    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') annos.set(t, `"${t.value}"`);
      else if (typeof t.value === 'boolean') annos.set(t, t.value ? 'true' : 'false');
      else annos.set(t, String(t.value));
      return;
    }
    // an intake result is an alias of its shape, named for its vocabulary type
    if (t instanceof PResult) {
      visit(t.base);
      d.print(`\nexport type ${t.kind} = ${annos.get(t.base)!};\n`);
      annos.set(t, t.kind);
      return;
    }
    // an intake type is named for its kind, and is its wire type on the client
    if (t instanceof PIntake) {
      visit(t.wire);
      visit(t.result);
      d.print(`\nexport type ${t.kind} = ${annos.get(t.wire)!};\n`);
      annos.set(t, t.kind);
      return;
    }
    let anno: string;
    if (t instanceof PArray) {
      visit(t.itemType);
      anno = annos.get(t.itemType)! + '[]';
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it);
      anno = '[' + t.itemTypes.map((it) => annos.get(it)!).join(', ') + ']';
    } else if (t instanceof PUnion) {
      for (const ut of t.types) visit(ut);
      anno = t.types.map((ut) => annos.get(ut)!).join(' | ');
    } else if (t instanceof PStruct) {
      for (const ft of t.fields.values()) visit(ft);
      const mkfield = (k: string, v: PType) =>
        k + (t.maybes.has(k) ? '?' : '') + ': ' + annos.get(v)!;
      anno = '{' + [...t.fields].map(([k, v]) => mkfield(k, v)).join(', ') + '}';
    } else if (t instanceof PObject) {
      visit(t.valueType);
      anno = 'Record<string, ' + annos.get(t.valueType)! + '>';
    } else {
      throw new Error(`unhandled type in generateAnnotations: ${t.constructor.name}`);
    }

    if (t.name) {
      d.print(`\nexport type ${t.name} = ${anno};\n`);
      annos.set(t, t.name);
    } else {
      annos.set(t, anno);
    }
  };
  visit(t);
}

/** Print the body of a function of `val` that follows a union's solution to the member `val`
    belongs to, where onMatch prints the statements that end each member's arm. */
function walkSolution(d: Denter, solution: Solution, onMatch: (t: PType) => string): void {
  d.print('let x = val;\n');

  // `x` holds the object currently being inspected; only GetIndex descends it (into an array
  // element).  `subj` is the expression the enclosing switch tests — `x` itself, or a field of it
  // (`x.type`) provided by a GetField.  Sub-solutions of a switch navigate from `x` again, so
  // sibling discriminators like [type, v] each read from the same object rather than from the
  // previously extracted field.
  const visit = (solution: Solution, subj: string): void => {
    if (solution instanceof Match) {
      d.print(onMatch(solution.typ));
    } else if (solution instanceof CheckJsonType) {
      if (solution.options.size === 1) {
        visit(solution.options.values().next().value!, subj);
        return;
      }
      // note that typeof() has some weird behaviors:
      // - typeof([]) = "object"
      // - typeof(null) = "object"
      // so we use a custom helper function specific to handling decoded json
      d.print(`switch(jsonTypeof(${subj})){\n`);
      d.indent('  ');
      for (const [jtyp, subsln] of solution.options) {
        d.print(`case "${jtyp}":\n`);
        d.indent('  ');
        visit(subsln, 'x');
        d.dedent();
      }
      d.print(`default: throw new Error(\`unexpected json type: \${jsonTypeof(${subj})}\`);\n`);
      d.dedent();
      d.print('}\n');
    } else if (solution instanceof CheckLiteral) {
      if (solution.options.size === 1) {
        visit(solution.options.values().next().value!, subj);
        return;
      }
      d.print(`switch(${subj}){\n`);
      d.indent('  ');
      for (const [lit, subsln] of solution.options) {
        if (typeof lit === 'string') {
          d.print(`case "${lit}":\n`);
        } else {
          d.print(`case ${lit}:\n`);
        }
        d.indent('  ');
        visit(subsln, 'x');
        d.dedent();
      }
      d.print('default: throw new Error(`unexpected value: ${val}`);\n');
      d.dedent();
      d.print('}\n');
    } else if (solution instanceof CheckLength) {
      if (solution.options.size === 1 && solution.default === null) {
        visit(solution.options.values().next().value!, subj);
        return;
      }
      d.print(`switch(${subj}.length){\n`);
      d.indent('  ');
      for (const [length, subsln] of solution.options) {
        d.print(`case ${length}:\n`);
        d.indent('  ');
        visit(subsln, 'x');
        d.dedent();
      }
      if (solution.default !== null) {
        d.print(`default:\n`);
        d.indent('  ');
        visit(solution.default, 'x');
        d.dedent();
      } else {
        d.print(`default: throw new Error(\`unexpected length: \${${subj}.length}\`);\n`);
      }
      d.dedent();
      d.print('}\n');
    } else if (solution instanceof GetIndex) {
      d.print(`x = ${subj}[${solution.i}];\n`);
      visit(solution.solution, 'x');
    } else if (solution instanceof GetField) {
      visit(solution.solution, `${subj}.${solution.key}`);
    } else if (solution instanceof HasField) {
      for (const [field, subsln] of solution.solutions) {
        d.print(`if ("${field}" in ${subj}) {\n`);
        d.indent('  ');
        visit(subsln, 'x');
        d.dedent();
        d.print('}\n');
      }
      d.print('throw new Error(`no matching field: ${JSON.stringify(val)}`);\n');
    } else {
      throw new Error(`unrecognized solution type: ${(solution as Solution).constructor.name}`);
    }
  };

  visit(solution, 'x');
}

function decodeSolution(d: Denter, decoders: Decoders, solution: Solution): void {
  walkSolution(d, solution, (t) => {
    const decoder = decoders.get(t) ?? null;
    return 'return ' + (decoder === null ? 'val' : decoder('val')) + ';\n';
  });
}

function generateDecoders(
  d: Denter,
  registry: PTypeRegistry,
  annos: Annos,
  decoders: Decoders,
  t: PType,
  anon: { n: number },
): void {
  const visit = (t: PType): void => {
    if (decoders.has(t)) return;

    if (
      t instanceof PString ||
      t instanceof PInt ||
      t instanceof PBool ||
      t instanceof PNull ||
      t instanceof PLiteral ||
      t instanceof PJson
    ) {
      decoders.set(t, null);
      // builtin types and their aliases need no decode{name}() function
      return;
    }

    if (t instanceof PDate) {
      decoders.set(t, (val) => `new Date(${val} as string)`);
      // no decode{name}() needed
      return;
    }

    // a result decodes as its base; an intake type as its result, which is what the database
    // decodes, since intake runs first
    if (t instanceof PResult || t instanceof PIntake) {
      const inner = t instanceof PResult ? t.base : t.result;
      visit(inner);
      decoders.set(t, decoders.get(inner)!);
      return;
    }

    let decoder: Decoder;
    if (t instanceof PUnion) {
      for (const ut of t.types) visit(ut);
      if (t.types.every((ut) => decoders.get(ut) === null)) {
        decoder = null;
      } else {
        // non-identity union; this requires a union solution
        const solution = solveUnion(registry, t.types);
        let name = t.name;
        if (!name) {
          name = `Anon${anon.n}`;
          anon.n += 1;
        }
        d.print(
          `\n${t.name ? 'export ' : ''}function decode${name}(val: any): ${annos.get(t)} {\n`,
        );
        d.indent('  ');
        decodeSolution(d, decoders, solution);
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decode${name}(${val})`;
      }
    } else if (t instanceof PArray) {
      visit(t.itemType);
      // calculate the decoding expression
      const itemDecoder = decoders.get(t.itemType)!;
      if (itemDecoder === null) {
        decoder = null;
      } else {
        const decodeItemX = itemDecoder('x');
        decoder = (val) => `${val}.map((x: any) => ${decodeItemX})`;
      }
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it);
      if (t.itemTypes.every((it) => decoders.get(it) === null)) {
        decoder = null;
      } else {
        decoder = (val) =>
          '[' +
          t.itemTypes
            .map((it, i) => {
              const itd = decoders.get(it);
              return itd === null ? `${val}[${i}]` : itd!(`${val}[${i}]`);
            })
            .join(', ') +
          ']';
      }
    } else if (t instanceof PStruct) {
      for (const ft of t.fields.values()) visit(ft);
      if ([...t.fields.values()].every((ft) => decoders.get(ft) === null)) {
        // all decoders are identity; identity decoder works for the whole struct
        decoder = null;
      } else if ([...t.maybes.values()].every((ft) => decoders.get(ft) === null)) {
        // all maybe decoders are identity; can be inlined with spread operator
        decoder = (val) =>
          '{ ' +
          [
            `...${val}`,
            ...[...t.always]
              .filter(([, ft]) => decoders.get(ft) !== null)
              .map(([fn, ft]) => fn + ': ' + decoders.get(ft)!(`${val}.${fn}`)),
          ].join(', ') +
          ' }';
      } else {
        // non-identity maybes are present; inlining not possible
        const n = anon.n;
        anon.n += 1;
        d.print(`\nfunction decodeAnon${n}(val: any): ${annos.get(t)} {\n`);
        d.indent('  ');
        d.print('const out = { ...val };\n');
        for (const [fn, ft] of t.fields) {
          const fd = decoders.get(ft)!;
          if (fd === null) continue;
          const decodedField = fd(`val.${fn}`);
          if (t.maybes.has(fn)) {
            d.print(`if(val.${fn}) out.${fn} = ${decodedField};\n`);
          } else {
            d.print(`out.${fn} = ${decodedField};\n`);
          }
        }
        d.print(`return out as ${annos.get(t)};\n`);
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decodeAnon${n}(${val})`;
      }
    } else if (t instanceof PObject) {
      visit(t.valueType);
      const vd = decoders.get(t.valueType)!;
      if (vd === null) {
        decoder = null;
      } else {
        // non-identity values; inlining not possible
        const n = anon.n;
        anon.n += 1;
        d.print(`\nfunction decodeAnon${n}(val: any): ${annos.get(t)} {\n`);
        d.indent('  ');
        d.print(
          `return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, ${vd('v')}])) as ${annos.get(t)};\n`,
        );
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decodeAnon${n}(${val})`;
      }
    } else {
      throw new Error(`unhandled type in generateDecoders: ${t}`);
    }

    // either define a named decoder or inline it
    if (t.name) {
      // we always export a named decoder (named unions with a solution already exported theirs)...
      if (!(t instanceof PUnion && decoder !== null)) {
        const decodeVal = decoder === null ? 'val' : decoder('val');
        d.print(`\nexport function decode${t.name}(val: any): ${annos.get(t)} {\n`);
        d.print(`  return ${decodeVal} as ${annos.get(t)};\n`);
        d.print('}\n');
      }
      // ... but if the decoder is the identity_decoder, we don't use it ourselves
      if (decoder === null) {
        decoders.set(t, null);
      } else {
        const nm = t.name;
        decoders.set(t, (val) => `decode${nm}(${val})`);
      }
    } else {
      decoders.set(t, decoder);
    }
  };

  visit(t);
}

// checkers

/** an expression testing that `subj` is of the given json type */
function jsonTypeCond(jtyp: string, subj: string): string {
  switch (jtyp) {
    case 'null':
      return `${subj} === null`;
    case 'string':
      return `typeof ${subj} === "string"`;
    case 'boolean':
      return `typeof ${subj} === "boolean"`;
    case 'int':
      return `Number.isInteger(${subj})`;
    case 'object':
      return `jsonTypeof(${subj}) === "object"`;
    case 'array':
      return `Array.isArray(${subj})`;
    default:
      throw new Error(`json type not checkable in a union: ${jtyp}`);
  }
}

const TIMESTAMP_RE = String.raw`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/`;

function checkSolution(d: Denter, checkers: Checkers, solution: Solution): void {
  d.print('const problems: string[] = [];\n');
  d.print('const x0 = val;\n');
  d.print('const xpath0 = path;\n');

  // `obj` names the value/path currently being navigated; `subj` names the value/path the
  // enclosing check tests.  GetField mints a fresh, uniquely-numbered subject variable from `obj`
  // but leaves `obj` unchanged, so sibling discriminators like [type, v] both read from the same
  // object rather than from a previously extracted field.  Only GetIndex descends `obj` (into an
  // array element).
  let counter = 1;
  const visit = (
    solution: Solution,
    obj: readonly [string, string],
    subj: readonly [string, string],
  ): void => {
    const [objVar, objPath] = obj;
    const [subjVar, subjPath] = subj;
    if (solution instanceof Match) {
      d.print(checkers.get(solution.typ)!('val', 'path'));
      d.print('return problems;\n');
    } else if (solution instanceof CheckJsonType) {
      for (const [jtyp, subsln] of solution.options) {
        d.print(`if (${jsonTypeCond(jtyp, subjVar)}) {\n`);
        d.indent('  ');
        visit(subsln, obj, obj);
        d.dedent();
        d.print('}\n');
      }
      d.print(
        `problems.push(${subjPath} + ": type " + jsonTypeof(${subjVar}) + " not allowed here");\n`,
      );
      d.print('return problems;\n');
    } else if (solution instanceof CheckLiteral) {
      for (const [lit, subsln] of solution.options) {
        const jslit = typeof lit === 'string' ? `"${lit}"` : String(lit);
        d.print(`if (${subjVar} === ${jslit}) {\n`);
        d.indent('  ');
        visit(subsln, obj, obj);
        d.dedent();
        d.print('}\n');
      }
      d.print(`problems.push(${subjPath} + ": unexpected value");\n`);
      d.print('return problems;\n');
    } else if (solution instanceof CheckLength) {
      for (const [length, subsln] of solution.options) {
        d.print(`if (${subjVar}.length === ${length}) {\n`);
        d.indent('  ');
        visit(subsln, obj, obj);
        d.dedent();
        d.print('}\n');
      }
      if (solution.default !== null) {
        visit(solution.default, obj, obj);
      } else {
        d.print(`problems.push(${subjPath} + ": unexpected length");\n`);
        d.print('return problems;\n');
      }
    } else if (solution instanceof GetIndex) {
      const i = counter++;
      d.print(`const x${i} = ${objVar}[${solution.i}];\n`);
      d.print(`const xpath${i} = ${objPath} + "[${solution.i}]";\n`);
      const next = [`x${i}`, `xpath${i}`] as const;
      visit(solution.solution, next, next);
    } else if (solution instanceof GetField) {
      const i = counter++;
      d.print(`if (!("${solution.key}" in ${objVar})) {\n`);
      d.print(`  problems.push(${objPath} + ': missing discriminator "${solution.key}"');\n`);
      d.print(`  return problems;\n`);
      d.print(`}\n`);
      d.print(`const x${i} = ${objVar}["${solution.key}"];\n`);
      d.print(`const xpath${i} = ${objPath} + ".${solution.key}";\n`);
      visit(solution.solution, obj, [`x${i}`, `xpath${i}`]);
    } else if (solution instanceof HasField) {
      for (const [field, subsln] of solution.solutions) {
        d.print(`if ("${field}" in ${objVar}) {\n`);
        d.indent('  ');
        visit(subsln, obj, obj);
        d.dedent();
        d.print('}\n');
      }
      d.print(`problems.push(${subjPath} + ": no matching keys found");\n`);
      d.print('return problems;\n');
    } else {
      throw new Error(`unrecognized solution type: ${(solution as Solution).constructor.name}`);
    }
  };
  visit(solution, ['x0', 'xpath0'], ['x0', 'xpath0']);
}

function generateCheckers(
  d: Denter,
  registry: PTypeRegistry,
  checkers: Checkers,
  t: PType,
  anon: { n: number },
  loop: { n: number },
): void {
  const visit = (t: PType): void => {
    if (checkers.has(t)) return;

    if (t instanceof PJson) {
      checkers.set(t, NOOP);
      return;
    }
    // a result checks as its base; an intake type as its result, since the database checks a
    // command after intake
    if (t instanceof PResult || t instanceof PIntake) {
      const inner = t instanceof PResult ? t.base : t.result;
      visit(inner);
      checkers.set(t, checkers.get(inner)!);
      return;
    }
    if (t instanceof PString) {
      checkers.set(
        t,
        (val, path) =>
          `if (typeof ${val} !== "string") {\n` +
          `  problems.push(${path} + ": is of type " + jsonTypeof(${val}) + ", not string");\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PInt) {
      checkers.set(
        t,
        (val, path) =>
          `if (!Number.isInteger(${val})) {\n` +
          `  problems.push(${path} + ": is of type " + jsonTypeof(${val}) + ", not int");\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PBool) {
      checkers.set(
        t,
        (val, path) =>
          `if (typeof ${val} !== "boolean") {\n` +
          `  problems.push(${path} + ": is of type " + jsonTypeof(${val}) + ", not bool");\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PNull || (t instanceof PLiteral && t.value === null)) {
      checkers.set(
        t,
        (val, path) =>
          `if (${val} !== null) {\n` +
          `  problems.push(${path} + ": is of type " + jsonTypeof(${val}) + ", not null");\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PDate) {
      checkers.set(
        t,
        (val, path) =>
          `if (typeof ${val} !== "string" || !${TIMESTAMP_RE}.test(${val}) || isNaN(Date.parse(${val}))) {\n` +
          `  problems.push(${path} + ": invalid timestamp");\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') {
        checkers.set(
          t,
          (val, path) =>
            `if (${val} !== "${t.value}") {\n` +
            `  problems.push(${path} + ': is not "${t.value}"');\n` +
            `}\n`,
        );
      } else {
        const jslit = String(t.value);
        checkers.set(
          t,
          (val, path) =>
            `if (${val} !== ${jslit}) {\n` +
            `  problems.push(${path} + ": is not ${jslit}");\n` +
            `}\n`,
        );
      }
      return;
    }

    let checker: Checker;
    if (t instanceof PUnion) {
      for (const ut of t.types) visit(ut);
      const solution = solveUnion(registry, t.types);
      const name = t.name ? `check${t.name}` : `checkAnon${anon.n++}`;
      d.print(
        `\n${t.name ? 'export ' : ''}function ${name}(val: any, path: string = "<root>"): string[] {\n`,
      );
      d.indent('  ');
      checkSolution(d, checkers, solution);
      d.dedent();
      d.print('}\n');
      checker = (val, path) => `problems.push(...${name}(${val}, ${path}));\n`;
    } else if (t instanceof PArray) {
      visit(t.itemType);
      checker = (val, path) => {
        const dd = new Denter();
        dd.print(`if (!Array.isArray(${val})) {\n`);
        dd.print(
          `  problems.push(${path} + ": is a " + jsonTypeof(${val}) + ", not json array");\n`,
        );
        if (checkers.get(t.itemType) === NOOP) {
          dd.print('}\n');
          return dd.getvalue();
        }
        dd.print('} else {\n');
        dd.indent('  ');
        const n = loop.n++;
        const iv = `i${n}`;
        const ev = `e${n}`;
        dd.print(`for (const [${iv}, ${ev}] of ${val}.entries()) {\n`);
        dd.indent('  ');
        // build the element's path off the original path expression, so nothing is clobbered
        // when this checker is inlined inside another
        dd.print(checkers.get(t.itemType)!(ev, `${path} + "[" + ${iv} + "]"`));
        dd.dedent();
        dd.print('}\n');
        dd.dedent();
        dd.print('}\n');
        return dd.getvalue();
      };
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it);
      checker = (val, path) => {
        const dd = new Denter();
        const n = t.itemTypes.length;
        dd.print(`if (!Array.isArray(${val})) {\n`);
        dd.print(
          `  problems.push(${path} + ": is a " + jsonTypeof(${val}) + ", not json array");\n`,
        );
        dd.print(`} else if (${val}.length !== ${n}) {\n`);
        dd.print(`  problems.push(${path} + ": expected ${n} items, not " + ${val}.length);\n`);
        // index each element off the original value/path expressions, so nothing is clobbered
        // even when this checker is inlined inside another (e.g. a struct field)
        const parts = t.itemTypes
          .map((it, i) => checkers.get(it)!(`${val}[${i}]`, `${path} + "[${i}]"`))
          .filter((p) => p);
        if (parts.length) {
          dd.print('} else {\n');
          dd.indent('  ');
          for (const p of parts) dd.print(p);
          dd.dedent();
        }
        dd.print('}\n');
        return dd.getvalue();
      };
    } else if (t instanceof PStruct) {
      for (const ft of t.fields.values()) visit(ft);
      let keys: string, func: string;
      if (t.name) {
        keys = `${lowerFirst(t.name)}AllowedKeys`;
        func = `check${t.name}`;
      } else {
        const n = anon.n++;
        keys = `anon${n}AllowedKeys`;
        func = `checkAnon${n}`;
      }
      const keyset = '{ ' + [...t.fields.keys()].map((fn) => `"${fn}": true`).join(', ') + ' }';
      d.print(`\nconst ${keys} = ${keyset};\n`);
      d.print(
        `\n${t.name ? 'export ' : ''}function ${func}(val: any, path: string = "<root>"): string[] {\n`,
      );
      d.indent('  ');
      d.print(`if (jsonTypeof(val) !== "object") {\n`);
      d.print(`  return [path + ": is a " + jsonTypeof(val) + ", not json object"];\n`);
      d.print('}\n');
      d.print('const problems: string[] = [];\n');
      for (const [fn, ft] of t.fields) {
        d.print(`if ("${fn}" in val) {\n`);
        d.indent('  ');
        d.print(`const x = val["${fn}"];\n`);
        d.print(`const xpath = path + ".${fn}";\n`);
        d.print(checkers.get(ft)!('x', 'xpath'));
        d.dedent();
        if (!t.maybes.has(fn)) {
          d.print('} else {\n');
          d.print(`  problems.push(path + ": missing required key ${fn}");\n`);
        }
        d.print('}\n');
      }
      d.print(`if (Object.keys(val).some((k) => !Object.hasOwn(${keys}, k))) {\n`);
      d.print(`  problems.push(path + ": contains extra keys");\n`);
      d.print('}\n');
      d.print('return problems;\n');
      d.dedent();
      d.print('}\n');
      checker = (val, path) => `problems.push(...${func}(${val}, ${path}));\n`;
    } else if (t instanceof PObject) {
      visit(t.valueType);
      checker = (val, path) => {
        const dd = new Denter();
        dd.print(`if (jsonTypeof(${val}) !== "object") {\n`);
        dd.print(
          `  problems.push(${path} + ": is a " + jsonTypeof(${val}) + ", not json object");\n`,
        );
        if (checkers.get(t.valueType) === NOOP) {
          dd.print('}\n');
          return dd.getvalue();
        }
        dd.print('} else {\n');
        dd.indent('  ');
        const kv = `k${loop.n++}`;
        dd.print(`for (const ${kv} of Object.keys(${val})) {\n`);
        dd.indent('  ');
        // index the value and build its path off the original expressions, so nothing is
        // clobbered when this checker is inlined inside another
        dd.print(checkers.get(t.valueType)!(`(${val})[${kv}]`, `${path} + "." + ${kv}`));
        dd.dedent();
        dd.print('}\n');
        dd.dedent();
        dd.print('}\n');
        return dd.getvalue();
      };
    } else {
      throw new Error(`unhandled type in generateCheckers: ${t}`);
    }

    // named types without a function already defined get a wrapper now
    if (t.name && !(t instanceof PUnion) && !(t instanceof PStruct)) {
      d.print(`\nexport function check${t.name}(val: any, path: string = "<root>"): string[] {\n`);
      d.indent('  ');
      d.print('const problems: string[] = [];\n');
      d.print(checker('val', 'path'));
      d.print('return problems;\n');
      d.dedent();
      d.print('}\n');
    }
    checkers.set(t, checker);
  };
  visit(t);
}

/**
 * isUpdatable returns if a type is suitable for a txn.update member.
 *
 * The txn.update pattern is to accept a mutator function which updates-in-place its parameter.
 * This is for two reasons:
 * - ergonomically, it means many updates are one-liners
 * - it makes it possible to write a type-safe updater that works against many variants of a store
 *
 * Therefore we can only create updaters for certain kinds of types.
 */
function isUpdatable(t: PType): boolean {
  if (t instanceof PArray || t instanceof PTuple || t instanceof PStruct || t instanceof PObject) {
    return true;
  }
  if (t instanceof PUnion) return t.types.every(isUpdatable);
  return false;
}

// commands //////////////////////////////////////////////////////////////////

/** a command's fields that intake transforms */
function intakeFields(cmd: PCommand): [string, PIntake][] {
  if (!(cmd.type instanceof PStruct)) return [];
  return [...cmd.type.fields].filter((f): f is [string, PIntake] => f[1] instanceof PIntake);
}

/** the type precommit sees a command as: its intake view when intake transforms it */
function precommitView(annos: Annos, cmd: PCommand): string {
  return intakeFields(cmd).length > 0 ? `${cmd.name}ForPrecommit` : annos.get(cmd.type)!;
}

/** the value of a command's literal `type` field, which is how intake recognizes it */
function commandTag(cmd: PCommand): string {
  const t = cmd.type instanceof PStruct ? cmd.type.fields.get('type') : undefined;
  if (!(t instanceof PLiteral) || typeof t.value !== 'string') {
    throw new Error(`command ${cmd.name} has intake fields, so it needs a literal string 'type'`);
  }
  return t.value;
}

/** the stream label of an event folded by these slices: a singleton's literal name, else any */
function streamLabel(slices: readonly PSlice[]): string {
  const labels = new Set(slices.map((s) => (s.params.length === 0 ? `"${s.family}"` : 'string')));
  if (labels.size === 0 || labels.has('string')) return 'string';
  return [...labels].join(' | ');
}

/** the annotation of what a handler returns for a command, from its @command output */
function outputAnno(annos: Annos, o: POutput): string {
  switch (o.kind) {
    case 'event':
      return `{ stream: ${streamLabel(o.slices)}; event: ${annos.get(o.type)!} }`;
    case 'death':
      return '{ stream: string; death: true }';
    case 'oneOf':
      return o.options.map((x) => outputAnno(annos, x)).join(' | ');
    case 'all':
      return '[' + o.items.map((x) => outputAnno(annos, x)).join(', ') + ']';
    case 'many': {
      const item = outputAnno(annos, o.item);
      return o.item.kind === 'oneOf' ? `(${item})[]` : `${item}[]`;
    }
  }
}

/** a command's output type, and the command as precommit sees it when intake transforms it */
function generateCommandTypes(d: Denter, annos: Annos, cmd: PCommand): void {
  d.print(`\nexport type ${cmd.name}Output = ${outputAnno(annos, cmd.output)};\n`);

  // the intake view: each intake field becomes its result
  if (intakeFields(cmd).length === 0) return;
  const struct = cmd.type as PStruct;
  const fields = [...struct.fields].map(([k, ft]) => {
    const anno = ft instanceof PIntake ? annos.get(ft.result)! : annos.get(ft)!;
    return k + (struct.maybes.has(k) ? '?' : '') + ': ' + anno;
  });
  d.print(`\n/** ${cmd.name} as the database prepares it for precommit */\n`);
  d.print(`export type ${cmd.name}ForPrecommit = {${fields.join(', ')}};\n`);
}

/** Print a function that dispatches `val`, a member of a union, to the arm onMatch prints for
    its member; for a single type there is nothing to dispatch on. */
function generateDispatch(
  d: Denter,
  registry: PTypeRegistry,
  signature: string,
  union: PType,
  onMatch: (t: PType) => string,
): void {
  d.print(`\nfunction ${signature} {\n`);
  d.indent('  ');
  if (union instanceof PUnion) {
    walkSolution(d, solveUnion(registry, union.types), onMatch);
  } else {
    d.print(onMatch(union));
  }
  d.dedent();
  d.print('}\n');
}

// contexts //////////////////////////////////////////////////////////////////

/* A context has accessors over keys.  A slice's reducer context names its own stream's keys, so
   its accessors take only the local template's parameters; a global context, an engine's or a
   database's, names keys across slices, so its accessors take the family's parameters and then
   the local template's.  Every accessor is named for its key template's name, which validation
   keeps unique across the slices of a context. */

/** a key template as the text of a template literal, its parameters interpolated */
function keyText(tpl: string): string {
  const [chunks, params] = PStoreItem.parseTpl(tpl);
  let out = chunks[0];
  for (let i = 0; i < params.length; i++) out += '${' + params[i] + '}' + chunks[i + 1];
  return out;
}

/** the type a store value travels under: its own name, or failing that the key it is kept at */
function storeTypeName(slice: PSlice, item: PStoreItem): string {
  const t = item.type;
  if (t.name !== null) return t.name;
  if (t instanceof PResult) return t.kind;
  return `${slice.family}/${item.name}`;
}

/** one accessor: its name and parameters, the key it names, and its value's annotation and type */
type Accessor = {
  name: string;
  params: readonly string[];
  key: string;
  anno: string;
  type: string;
  updatable: boolean;
};

/** the accessors over a slice's keys, local for its reducer, or global for any other context */
function accessors(annos: Annos, slice: PSlice, global: boolean): Accessor[] {
  const prefix = global ? `${keyText(slice.template)}/` : '';
  return slice.store.items.map((item) => ({
    name: item.name,
    params: global ? [...slice.params, ...item.params] : item.params,
    key: prefix + keyText(item.tpl),
    anno: annos.get(item.type)!,
    type: storeTypeName(slice, item),
    updatable: isUpdatable(item.type),
  }));
}

/** the name an accessor's own argument takes, apart from its params */
function own(a: Accessor, name: string): string {
  return a.params.includes(name) ? `$${name}` : name;
}

/** an accessor's parameter list, then any arguments of its own as [name, annotation] */
function args(a: Accessor, ...extra: [string, string][]): string {
  const params = a.params.map((p) => `${p}: string`);
  return [...params, ...extra.map(([n, t]) => `${own(a, n)}: ${t}`)].join(', ');
}

/** the members of a context's get accessors, as a type */
function printGetTypes(d: Denter, list: Accessor[]): void {
  for (const a of list) d.print(`${prop(a.name)}: (${args(a)}) => ${a.anno} | undefined;\n`);
}

/** the members of a context's get accessors, reading through $txn */
function printGets(d: Denter, list: Accessor[]): void {
  for (const a of list) {
    const read = `$txn.get(\`${a.key}\`, ${JSON.stringify(a.type)})`;
    d.print(`${prop(a.name)}: (${args(a)}) => ${read} as ${a.anno} | undefined,\n`);
  }
}

/** a slice's reducer context type and factory, its handler table type, and its SliceReducer */
function generateSlice(d: Denter, annos: Annos, registry: PTypeRegistry, slice: PSlice): void {
  const base = slice.name;
  const txnType = `${base}Txn`;
  const local = accessors(annos, slice, false);
  const updatable = local.filter((a) => a.updatable);
  const params = slice.params.map((p) => `${p}: string`).join('; ');

  // the reducer context's type
  d.print(`\n/** ${base}'s reducer context: its stream's parameters, and accessors over the`);
  d.print(` stream's own keys */\n`);
  d.print(`export type ${txnType} = {\n`);
  d.indent('  ');
  d.print(`params: {${params === '' ? '' : ` ${params} `}};\n`);
  d.print('get: {\n');
  d.indent('  ');
  printGetTypes(d, local);
  d.dedent();
  d.print('};\nset: {\n');
  d.indent('  ');
  for (const a of local) d.print(`${prop(a.name)}: (${args(a, ['value', a.anno])}) => void;\n`);
  d.dedent();
  d.print('};\ndel: {\n');
  d.indent('  ');
  for (const a of local) d.print(`${prop(a.name)}: (${args(a)}) => void;\n`);
  d.dedent();
  d.print('};\n');
  if (updatable.length === 0) {
    d.print('update: {};\n');
  } else {
    d.print('update: {\n');
    d.indent('  ');
    for (const a of updatable) {
      d.print(`${prop(a.name)}: <R>(${args(a, ['fn', `(value: ${a.anno}) => R`])}) => R;\n`);
    }
    d.dedent();
    d.print('};\n');
  }
  d.dedent();
  d.print('};\n');

  // the reducer context over a stream's transaction
  d.print(`\nfunction ${lowerFirst(base)}Txn($txn: ReducerTxn, params: ${txnType}['params']): `);
  d.print(`${txnType} {\n`);
  d.indent('  ');
  d.print('return {\n');
  d.indent('  ');
  d.print('params,\nget: {\n');
  d.indent('  ');
  printGets(d, local);
  d.dedent();
  d.print('},\nset: {\n');
  d.indent('  ');
  for (const a of local) {
    const v = own(a, 'value');
    const write = `$txn.set(\`${a.key}\`, ${JSON.stringify(a.type)}, ${v})`;
    d.print(`${prop(a.name)}: (${args(a, ['value', a.anno])}) => ${write},\n`);
  }
  d.dedent();
  d.print('},\ndel: {\n');
  d.indent('  ');
  for (const a of local) d.print(`${prop(a.name)}: (${args(a)}) => $txn.del(\`${a.key}\`),\n`);
  d.dedent();
  d.print('},\n');
  if (updatable.length === 0) {
    d.print('update: {},\n');
  } else {
    d.print('update: {\n');
    d.indent('  ');
    for (const a of updatable) {
      const fn = own(a, 'fn');
      const call = `updateKey($txn, \`${a.key}\`, ${JSON.stringify(a.type)}, ${fn})`;
      d.print(`${prop(a.name)}: <R>(${args(a, ['fn', `(value: ${a.anno}) => R`])}) => ${call},\n`);
    }
    d.dedent();
    d.print('},\n');
  }
  d.dedent();
  d.print('};\n');
  d.dedent();
  d.print('}\n');

  // the handler table: one handler per event type
  const tableType = `${base}Reducers`;
  d.print(`\n/** ${base}'s reducer handlers, one per event type */\n`);
  d.print(`export type ${tableType} = {\n`);
  d.indent('  ');
  for (const ev of slice.eventTypes) {
    const anno = annos.get(ev)!;
    d.print(`${prop(lowerFirst(ev.name!))}: (txn: ${txnType}, event: ${anno}, pending: boolean)`);
    d.print(' => void;\n');
  }
  d.dedent();
  d.print('};\n');

  // each event to its handler
  const reduce = `reduce${base}`;
  generateDispatch(
    d,
    registry,
    `${reduce}(handlers: ${tableType}, txn: ${txnType}, pending: boolean, val: any): void`,
    slice.events,
    (t) => `return handlers.${prop(lowerFirst(t.name!))}(txn, val as ${annos.get(t)!}, pending);\n`,
  );

  // the stream's parameters, parsed from its name; the final one is the rest of the name
  const skip = slice.family.length + 1;
  const n = slice.params.length;
  let parsed: string;
  if (n === 0) {
    parsed = '{}';
  } else if (n === 1) {
    parsed = `{ ${slice.params[0]}: stream.slice(${skip}) }`;
  } else {
    const fields = slice.params.map((p, i) =>
      i < n - 1 ? `${p}: parts[${i}]` : `${p}: parts.slice(${i}).join(".")`,
    );
    parsed = `{ ${fields.join(', ')} }`;
  }

  // the SliceReducer the Engine and the database call
  d.print(`\n/** the SliceReducer that folds ${base}'s events through its handlers */\n`);
  d.print(`export function ${lowerFirst(base)}Reducer(handlers: ${tableType}): SliceReducer {\n`);
  d.indent('  ');
  d.print('return {\n');
  d.indent('  ');
  d.print(
    'reducer($txn: ReducerTxn, events: unknown[], stream: string, pending: boolean): void {\n',
  );
  d.indent('  ');
  if (n > 1) d.print(`const parts = stream.slice(${skip}).split(".");\n`);
  d.print(`const txn = ${lowerFirst(base)}Txn($txn, ${parsed});\n`);
  d.print(`for (const event of events) ${reduce}(handlers, txn, pending, event);\n`);
  d.dedent();
  d.print('},\n');
  d.dedent();
  d.print('};\n');
  d.dedent();
  d.print('}\n');

  // the slice's global accessors, for every context that reads it
  d.print(`\nfunction ${lowerFirst(base)}Get($txn: ReadTxn) {\n`);
  d.indent('  ');
  d.print('return {\n');
  d.indent('  ');
  printGets(d, accessors(annos, slice, true));
  d.dedent();
  d.print('};\n');
  d.dedent();
  d.print('}\n');
}

/** a global context's type and its factory over a read transaction */
function generateGlobalContext(
  d: Denter,
  annos: Annos,
  name: string,
  doc: string,
  slices: readonly PSlice[],
): void {
  d.print(`\n/** ${doc} */\n`);
  d.print(`export type ${name}Txn = {\n`);
  d.indent('  ');
  d.print('get: {\n');
  d.indent('  ');
  for (const slice of slices) printGetTypes(d, accessors(annos, slice, true));
  d.dedent();
  d.print('};\n');
  d.dedent();
  d.print('};\n');

  const gets = slices.map((s) => `...${lowerFirst(s.name)}Get($txn)`).join(', ');
  d.print(`\nexport function ${lowerFirst(name)}Txn($txn: ReadTxn): ${name}Txn {\n`);
  d.print(`  return { get: { ${gets} } };\n`);
  d.print('}\n');
}

/** the reducer handler tables of slices, by family, as a type */
function reducersAnno(slices: readonly PSlice[]): string {
  return '{ ' + slices.map((s) => `${prop(s.family)}: ${s.name}Reducers`).join('; ') + ' }';
}

/** the SliceReducers of slices, by family, over the handler tables in `tables` */
function reducersValue(slices: readonly PSlice[], tables: string): string {
  const entries = slices.map(
    (s) => `${prop(s.family)}: ${lowerFirst(s.name)}Reducer(${tables}.${prop(s.family)})`,
  );
  return '{ ' + entries.join(', ') + ' }';
}

// engines ///////////////////////////////////////////////////////////////////

/** an engine's read context, its forecaster table and its wrapper, and its Engine subclass */
function generateEngine(d: Denter, annos: Annos, registry: PTypeRegistry, e: PEngine): void {
  const txnType = `${e.name}Txn`;
  const tableType = `${e.name}Forecasters`;
  const offline = e.commands.filter((c) => !c.online);
  const online = e.commands.filter((c) => c.online);
  const anno = (c: PCommand) => annos.get(c.type)!;

  // the read context of its queries and forecasts
  const doc = `${e.name}'s read context: what its queries and forecasts read, over its slices`;
  generateGlobalContext(d, annos, e.name, doc, e.slices);

  // the forecaster table: one optional forecaster per command that is not @online
  d.print(
    `\n/** ${e.name}'s forecasters, one per command; a command left out forecasts nothing */\n`,
  );
  d.print(`export type ${tableType} = {\n`);
  d.indent('  ');
  for (const c of offline) {
    d.print(
      `${prop(lowerFirst(c.name))}?: (txn: ${txnType}, cmd: ${anno(c)}) => ${c.name}Output;\n`,
    );
  }
  d.dedent();
  d.print('};\n');

  // each command to its forecaster; an @online command is never forecast
  const commandOf = new Map(e.commands.map((c) => [c.type, c]));
  const forecast = `forecast${e.name}`;
  generateDispatch(
    d,
    registry,
    `${forecast}(table: ${tableType}, txn: ${txnType}, val: any): ForecastOutput[]`,
    e.commandType,
    (t) => {
      const c = commandOf.get(t)!;
      if (c.online) return 'return [];\n';
      const k = `table.${prop(lowerFirst(c.name))}`;
      return `return ${k} === undefined ? [] : outputList(${k}(txn, val as ${anno(c)}));\n`;
    },
  );

  // the commands sendCommands takes, and those sendNow takes
  const C =
    offline.length === 0
      ? 'never'
      : online.length === 0
        ? annos.get(e.commandType)!
        : offline.map(anno).join(' | ');
  const N = online.length === 0 ? 'never' : online.map(anno).join(' | ');

  d.print(`\n/** the Forecaster that runs ${e.name}'s forecasters */\n`);
  d.print(`export function ${lowerFirst(e.name)}Forecaster(table: ${tableType}): `);
  d.print(`Forecaster<${txnType}, ${C}> {\n`);
  d.print(`  return (txn, cmd) => ${forecast}(table, txn, cmd);\n`);
  d.print('}\n');

  // the engine itself
  const wants = e.slices.map((s) => (s.params.length === 0 ? s.family : `${s.family}.*`));
  const names = e.slices.map((s) => s.name).join(', ');
  d.print(`
/** the Engine of ${e.name}, syncing ${names} */
export class ${e.name} extends Engine<${txnType}, ${C}, ${N}> {
  constructor(
    // if store is null, InMemStore is used
    store: Store | null,
    reg: Registry,
    connect: ConnectorFactory,
    callbacks: {
      // each slice's reducer handlers, by family
      reducers: ${reducersAnno(e.slices)};
      // optional: forecast what the database will do with a command
      forecasters?: ${tableType};
      // optional: ends the Engine, its connector, and every backfill
      signal?: AbortSignal;
      // optional: receives the error that ended the Engine
      onError?: (e: unknown) => void;
    },
  ) {
    const forecasters = callbacks.forecasters;
    super(${lowerFirst(e.name)}Txn, store, reg, connect, {
      reducers: ${reducersValue(e.slices, 'callbacks.reducers')},
      wants: ${JSON.stringify(wants)},
      forecaster: forecasters === undefined ? undefined : ${lowerFirst(e.name)}Forecaster(forecasters),
      signal: callbacks.signal,
      onError: callbacks.onError,
    });
  }
}
`);
}

// databases /////////////////////////////////////////////////////////////////

/** a database's read context, precommit table, slots, and the definition of its bundle */
function generateDatabase(
  d: Denter,
  annos: Annos,
  registry: PTypeRegistry,
  db: PDatabase,
  commandUnion: PType | undefined,
): void {
  const txnType = `${db.name}Txn`;
  const tableType = `${db.name}Precommit`;
  const ctxType = `${db.name}BootstrapContext`;
  const slotsType = `${db.name}Slots`;

  // the read context of precommit, maySee, and lookup
  const doc = `${db.name}'s read context: what precommit, maySee, and lookup read, over every slice`;
  generateGlobalContext(d, annos, db.name, doc, db.slices);

  // the precommit table: one handler per command, each seeing the command after intake
  d.print(`\n/** ${db.name}'s precommit handlers, one per command */\n`);
  d.print(`export type ${tableType} = {\n`);
  d.indent('  ');
  for (const c of db.commands) {
    d.print(`${prop(lowerFirst(c.name))}: (auth: Auth, txn: ${txnType}, `);
    d.print(`cmd: ${precommitView(annos, c)}) => ${c.name}Output;\n`);
  }
  d.dedent();
  d.print('};\n');

  // each command to its handler, run with a fresh Auth
  const precommit = `precommit${db.name}`;
  const signature =
    `${precommit}(table: ${tableType}, principal: Principal, txn: ${txnType}, val: any): ` +
    'string | ForecastOutput[]';
  if (commandUnion !== undefined) {
    const commandOf = new Map(db.commands.map((c) => [c.type, c]));
    generateDispatch(d, registry, signature, commandUnion, (t) => {
      const c = commandOf.get(t)!;
      const k = lowerFirst(c.name);
      const call = `table.${prop(k)}(auth, txn, val as ${precommitView(annos, c)})`;
      return `return runPrecommit(${JSON.stringify(k)}, principal, (auth) => ${call});\n`;
    });
  } else {
    d.print(`\nfunction ${signature} {\n`);
    d.print('  throw new Error(`no commands: ${val}`);\n');
    d.print('}\n');
  }

  // what bootstrap emits: any event of a slice, labelled with one of its streams
  const seeds = db.slices.map((s) => `[${streamLabel([s])}, ${annos.get(s.events)!}]`);
  d.print(`\n/** what ${db.name}'s bootstrap seeds the empty log with */\n`);
  d.print(`export type ${ctxType} = {\n`);
  d.print(`  emit: (...out: ${seeds.join(' | ')}) => void;\n`);
  d.print('  hashPassword: (plain: string) => PasswordHash;\n');
  d.print('  env: (name: string) => string;\n');
  d.print('};\n');

  // the bundle's slots, as the app writes them
  d.print(`
/** what ${db.name}'s bundle is made of: every slice's reducer handlers, precommit, maySee, lookup,
    and an optional bootstrap */
export type ${slotsType} = {
  reducers: ${reducersAnno(db.slices)};
  precommit: ${tableType};
  maySee: (txn: ${txnType}, principal: Principal) => string[];
  lookup: (txn: ${txnType}, ident: LookupIdent) => LookupResult | null;
  bootstrap?: (ctx: ${ctxType}) => void;
};
`);

  // the fields intake hashes, by command type
  const hashed: Record<string, string[]> = {};
  for (const c of db.commands) {
    const fields = intakeFields(c).filter(([, ft]) => ft.kind === 'NewPassword');
    if (fields.length > 0) hashed[commandTag(c)] = fields.map(([k]) => k);
  }

  // the bundle, over the generated wrappers
  const check = commandUnion === undefined ? `['no commands']` : `check${commandUnion.name!}(data)`;
  d.print(`
/** Install ${db.name}'s bundle as globalThis.__bundle, the app's slots behind the generated
    wrappers, and answer it. */
export function define${db.name}(slots: ${slotsType}): Bundle {
  const bootstrap = slots.bootstrap;
  const bundle: Bundle = {
    hashedFields: ${JSON.stringify(hashed)},
    checkCommand: (data) => {
      const problems = ${check};
      return problems.length === 0 ? null : problems.join("\\n");
    },
    precommit: (txn, cmd, principal) =>
      ${precommit}(slots.precommit, principal, ${lowerFirst(db.name)}Txn(txn), cmd.data),
    reducers: ${reducersValue(db.slices, 'slots.reducers')},
    maySee: (txn, principal) => slots.maySee(${lowerFirst(db.name)}Txn(txn), principal),
    lookup: (txn, ident) => slots.lookup(${lowerFirst(db.name)}Txn(txn), ident),
    bootstrap: bootstrap === undefined ? undefined : (ctx) => bootstrap(ctx as ${ctxType}),
  };
  (globalThis as { __bundle?: Bundle }).__bundle = bundle;
  return bundle;
}
`);
}

// queries ///////////////////////////////////////////////////////////////////

/** "AdminQueries" → "Admin"; the stem names the per-interface artifacts */
function queryStem(name: string): string {
  return name.endsWith('Queries') ? name.slice(0, -'Queries'.length) : name;
}

/** the wire id of one query: unique across all interfaces a connection may carry */
function queryId(kq: PQueries, q: PQuery): string {
  return `${kq.name}.${q.name}`;
}

/**
 * Build the wire message type for a queries interface: a union of `[id, ...args]` tuples,
 * discriminated by the id literal.  Optional arguments are nullable on the wire (a JSON array
 * has no way to omit an element).  Naming the union routes it through the same annotation,
 * decoder, and checker generation as any declared type, which is what gives the serving side
 * `check<Stem>Query` for ingress and `decode<Stem>Query` for typed dispatch.
 */
function queryWireType(registry: PTypeRegistry, kq: PQueries): PType {
  const wire = registry.union(
    kq.queries.map((q) =>
      registry.tuple([
        registry.literal(queryId(kq, q)),
        ...q.args.map(([, at, opt]) => (opt ? registry.union([at, registry.null_()]) : at)),
      ]),
    ),
  );
  if (wire.name === null) wire.name = queryStem(kq.name!) + 'Query';
  return wire;
}

/**
 * Generate the typed query layer for one Queries interface: the wire id constants, the defs
 * interface an author implements, the provider interface call sites consume, the local and
 * remote provider constructions (both satisfy the provider interface, so a call site chooses
 * execution venue by choosing a provider instance), and the dispatcher a serving side uses to
 * route a decoded wire message into a provider.
 */
function generateQueries(d: Denter, annos: Annos, decoders: Decoders, kq: PQueries): void {
  const name = kq.name!;
  const stem = queryStem(name);
  const idsName = `${stem}QueryIds`;
  const defsName = `${stem}QueryDefs`;

  const params = (q: PQuery) =>
    q.args.map(([an, at, opt]) => `${an}${opt ? '?' : ''}: ${annos.get(at)!}`).join(', ');
  const result = (q: PQuery) => annos.get(q.result)!;

  // wire ids
  d.print(`\nexport const ${idsName} = {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    d.print(`${q.name}: "${queryId(kq, q)}",\n`);
  }
  d.dedent();
  d.print('} as const;\n');

  // defs: implemented by the author, one function per query.  Generic in QX because the
  // contract binds no store; per-caller context (a user id, ...) is constructor state on the
  // implementation, closed over by the bodies.
  d.print(`\nexport interface ${defsName}<QX> {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    const rest = q.args.length ? ', ' + params(q) : '';
    d.print(`${q.name}(qx: QX${rest}): ${result(q)};\n`);
  }
  d.dedent();
  d.print('}\n');

  // provider: consumed by call sites
  d.print(`\nexport interface ${name} {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    d.print(`${q.name}(${params(q)}): Query<${result(q)}>;\n`);
  }
  d.dedent();
  d.print('}\n');

  // local provider: hosts the defs on any engine with a compatible query context
  d.print(`\nexport class Local${name}<QX> implements ${name} {\n`);
  d.indent('  ');
  d.print(`#eng: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> };\n`);
  d.print(`#defs: ${defsName}<QX>;\n`);
  d.print('\n');
  d.print(`constructor(\n`);
  d.print(`  eng: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },\n`);
  d.print(`  defs: ${defsName}<QX>,\n`);
  d.print(`) {\n`);
  d.print('  this.#eng = eng;\n');
  d.print('  this.#defs = defs;\n');
  d.print('}\n');
  for (const q of kq.queries) {
    const argNames = q.args.map(([an]) => an);
    d.print(`\n${q.name}(${params(q)}): Query<${result(q)}> {\n`);
    d.print(
      `  return this.#eng.newQuery((qx: QX) => this.#defs.${q.name}(${['qx', ...argNames].join(', ')}));\n`,
    );
    d.print('}\n');
  }
  d.dedent();
  d.print('}\n');

  // remote provider: encode the call, subscribe over the transport, decode results
  d.print(`\nexport class Remote${name} extends RemoteQueries implements ${name} {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    const raw = [
      `${idsName}.${q.name}`,
      ...q.args.map(([an, , opt]) => `encodeProto(${an}${opt ? ' ?? null' : ''})`),
    ];
    const dec = decoders.get(q.result);
    const decodeFn =
      dec == null ? `(val: any): ${result(q)} => val` : `(val: any): ${result(q)} => ${dec('val')}`;
    d.print(`${q.name}(${params(q)}): Query<${result(q)}> {\n`);
    d.print(`  return this.newQuery([${raw.join(', ')}], ${decodeFn});\n`);
    d.print('}\n');
  }
  d.dedent();
  d.print('}\n');

  // dispatcher: decoded wire message → provider call.  Query<any> because the wire message is a
  // union over queries with different result types; the caller is transport code.
  d.print(
    `\nexport function dispatch${stem}Query(queries: ${name}, query: ${stem}Query): Query<any> {\n`,
  );
  d.indent('  ');
  d.print('switch (query[0]) {\n');
  for (const q of kq.queries) {
    // optional args are nullable on the wire; the provider takes them as absent
    const args = q.args.map(([, , opt], i) => `query[${i + 1}]${opt ? ' ?? undefined' : ''}`);
    d.print(`case ${idsName}.${q.name}:\n`);
    d.print(`  return queries.${q.name}(${args.join(', ')});\n`);
  }
  d.print('default:\n');
  d.print('  throw new Error(`unexpected query ID: ${query[0]}`);\n');
  d.print('}\n');
  d.dedent();
  d.print('}\n');
}

/** entrypoint: assemble the complete generated module */
export function generateTs(lowered: LoweredProgram, skeleton: string): string {
  const { registry, roots, slices, commands, engines, databases, queries } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  const d = new Denter();

  // Start with the skeleton
  d.print(skeleton);

  const typesToVisit = [...roots, ...slices.flatMap((s) => s.store.items.map((si) => si.type))];

  // A database needs the PasswordHash its bootstrap makes, and the union of its commands, which
  // its bundle checks and dispatches on.
  const commandUnions = new Map<PDatabase, PType>();
  for (const db of databases) {
    typesToVisit.push(registry.result('PasswordHash', registry.string()));
    if (db.commands.length === 0) continue;
    const union = registry.union(db.commands.map((c) => c.type));
    if (union.name === null) union.name = `${db.name}Command`;
    commandUnions.set(db, union);
    typesToVisit.push(union);
  }

  // Queries need their wire message type (which carries the arg types inside it) plus decoders
  // for their result types.
  for (const kq of queries) {
    if (!kq.queries.length) continue;
    typesToVisit.push(queryWireType(registry, kq));
    for (const q of kq.queries) typesToVisit.push(q.result);
  }

  // Define types and decide on type annotations.
  const annos: Annos = new Map();
  for (const t of typesToVisit) generateAnnotations(d, annos, t);

  // Generate decoders and pick decoding expressions.
  const decoders: Decoders = new Map();
  const anon = { n: 0 };
  for (const t of typesToVisit) generateDecoders(d, registry, annos, decoders, t, anon);

  // Generate structural checkers and pick checking statements.
  const checkers: Checkers = new Map();
  const loop = { n: 0 };
  for (const t of typesToVisit) generateCheckers(d, registry, checkers, t, anon, loop);

  // Generate each command's output type and intake view
  for (const c of commands) generateCommandTypes(d, annos, c);

  // Generate slices, engines, and databases
  for (const s of slices) generateSlice(d, annos, registry, s);
  for (const e of engines) generateEngine(d, annos, registry, e);
  for (const db of databases) generateDatabase(d, annos, registry, db, commandUnions.get(db));

  // Generate query layers
  for (const kq of queries) generateQueries(d, annos, decoders, kq);

  // the generated file ends with a trailing newline
  return d.getvalue() + '\n';
}
