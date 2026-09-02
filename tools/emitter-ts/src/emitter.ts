/**
 * TypeScript code generator: emits type aliases, decoders, JSON structural checkers, typed store
 * contexts, Engine classes, and typed query layers from the lowered IR.
 */

import {
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  Denter,
  GetField,
  GetIndex,
  HasField,
  PArray,
  PBool,
  PDate,
  PEngine,
  PInt,
  PJson,
  PLiteral,
  PNull,
  PObject,
  PQueries,
  PQuery,
  PStore,
  PString,
  PStruct,
  PTuple,
  PType,
  PTypeRegistry,
  PUnion,
  LoweredProgram,
  Match,
  Solution,
  solveUnion,
} from '@phaselock/typespec';

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

function decodeSolution(d: Denter, decoders: Decoders, solution: Solution): void {
  d.print('let x = val;\n');

  // `x` holds the object currently being inspected; only GetIndex descends it (into an array
  // element).  `subj` is the expression the enclosing switch tests — `x` itself, or a field of it
  // (`x.type`) provided by a GetField.  Sub-solutions of a switch navigate from `x` again, so
  // sibling discriminators like [type, v] each read from the same object rather than from the
  // previously extracted field.
  const visit = (solution: Solution, subj: string): void => {
    if (solution instanceof Match) {
      const decoder = decoders.get(solution.typ) ?? null;
      d.print('return ' + (decoder === null ? 'val' : decoder('val')) + ';\n');
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
        d.print(`\n${t.name ? 'export ' : ''}function decode${name}(val: any): ${annos.get(t)} {\n`);
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

function generateStorePrereqs(d: Denter): void {
  d.print('\n');
  d.print('function *queryGet<T>(key: string, decoder: StoreDecoder): QueryGenerator<T> {\n');
  d.print("  const ans = yield {'store': {[key]: decoder}};\n");
  d.print('  const sv = ans.store[key];\n');
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print('  return readOnly(sv.value) as T\n');
  d.print('}\n');
  d.print('\n');
  d.print('function *reducerOld<T>(key: string, decoder: StoreDecoder): Reducer<T> {\n');
  d.print("  const ans = yield {'old': {[key]: decoder}};\n");
  d.print('  const sv = ans.old[key];\n');
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print('  return copyOnWrite(sv.value) as T\n');
  d.print('}\n');
  d.print('\n');
  d.print('function *reducerGet<T>(key: string, decoder: StoreDecoder): Reducer<T> {\n');
  d.print("  const ans = yield {'get': {[key]: decoder}};\n");
  d.print('  const sv = ans.get[key];\n');
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print('  return copyOnWrite(sv.value) as T\n');
  d.print('}\n');
  d.print('\n');
  d.print('function *reducerSet<T>(key: string, value: T): Reducer<void> {\n');
  d.print("  const ans = yield {'set': {[key]: value}};\n");
  d.print('  const sv = ans.set[key];\n');
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print('}\n');
  d.print('function *reducerDel(key: string): Reducer<void> {\n');
  d.print("  const ans = yield {'del': {[key]: true}};\n");
  d.print('  const sv = ans.del[key];\n');
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print('}\n');
  d.print(
    'function *reducerUpdate<T, R>(key: string, decoder: StoreDecoder, fn: (t: T) => R): Reducer<R> {\n',
  );
  d.print('  const obj = yield* reducerGet<T>(key, decoder);\n');
  d.print('  const out = fn(obj);\n');
  d.print('  yield* reducerSet(key, obj);\n');
  d.print('  return out;\n');
  d.print('}\n');
  d.print('export type NoSet<T extends {\n');
  d.print('  "get": unknown, "old": unknown, "del": unknown, "update": unknown\n');
  d.print('}> = Pick<T, "get"|"old"|"del"|"update">;\n');
}

function contextName(name: string): string {
  return name.endsWith('Store') ? name.slice(0, -5) : name;
}

/**
 * isUpdatable returns if a type is suitable for an rx.update member.
 *
 * The rx.update pattern is to accept a mutator function which updates-in-place its parameter.
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

function printTemplate(
  d: Denter,
  si: { chunks: readonly string[]; params: readonly string[] },
): void {
  for (let i = 0; i < si.params.length; i++) {
    d.print(si.chunks[i] + '${' + si.params[i] + '}');
  }
  d.print(si.chunks[si.chunks.length - 1]);
}

function printDecoder(d: Denter, decoders: Decoders, t: PType) {
  const decoder = decoders.get(t);
  if (decoder === null) {
    d.print('null');
  } else {
    d.print(`(x: any) => ${decoder!('x')}`);
  }
}

function generateStore(d: Denter, annos: Annos, decoders: Decoders, store: PStore): void {
  const ctxName = contextName(store.name!);
  // Generate the QueryContext singleton.
  d.print(`\nexport const ${ctxName}QueryContext = {\n`);
  d.indent('  ');
  // generate getters like:
  // topic: (topic_uuid: Uuid) => queryGet<Topic>(`topic.${topic_uuid}`, (x) => decodeTopic(x))
  d.print('get: {\n');
  d.indent('  ');
  const originalItems = store.originalItems;
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ': string').join(', '));
    d.print(`) => queryGet<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print('`, ');
    printDecoder(d, decoders, si.type);
    d.print('),\n');
  }
  // also use the spread operator to reuse definitions from our deps
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}QueryContext.get,\n`);
  }
  d.dedent();
  d.print('},\n');
  d.dedent();
  d.print(`};\n`);
  d.print('\n');
  // also create typeof shorthand
  d.print(`\nexport type ${ctxName}QX = typeof ${ctxName}QueryContext;\n`);

  // Generate the ReducerContext singleton.
  d.print(`export const ${ctxName}ReducerContext = {\n`);
  d.indent('  ');

  // generate old getters like:
  // topic: (topic_uuid: Uuid) => reducerOld<Topic>(`topic.${topic_uuid}`, (x) => decodeTopic(x))
  d.print('old: {\n');
  d.indent('  ');
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ': string').join(', '));
    d.print(`) => reducerOld<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print('`, ');
    printDecoder(d, decoders, si.type);
    d.print('),\n');
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.old,\n`);
  }
  d.dedent();
  d.print('},\n');

  // generate getters like:
  // topic: (topic_uuid: Uuid) => reducerGet<Topic>(`topic.${topic_uuid}`, (x) => decodeTopic(x))
  d.print('get: {\n');
  d.indent('  ');
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ': string').join(', '));
    d.print(`) => reducerGet<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print('`, ');
    printDecoder(d, decoders, si.type);
    d.print('),\n');
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.get,\n`);
  }
  d.dedent();
  d.print('},\n');

  // generate setters like:
  // topic: (topic_uuid: Uuid, value: Topic) => reducerSetter(`topic.${topic_uuid}`, value)
  d.print('set: {\n');
  d.indent('  ');
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print([...si.params.map((p) => p + ': string'), `value: ${annos.get(si.type)}`].join(', '));
    d.print(') => reducerSet(`');
    printTemplate(d, si);
    d.print('`, value),\n');
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.set,\n`);
  }
  d.dedent();
  d.print('},\n');

  // generate deleters like:
  // topic: (topic_uuid: Uuid) => reducerDeleter(`topic.${topic_uuid}`)
  d.print('del: {\n');
  d.indent('  ');
  for (const si of originalItems) {
    // no point in adding deleters for indices (when there isn't a param)
    if (!si.params.length) continue;
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ': string').join(', '));
    d.print(') => reducerDel(`');
    printTemplate(d, si);
    d.print('`),\n');
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.del,\n`);
  }
  d.dedent();
  d.print('},\n');

  // compound types (objects and arrays) also get updaters
  d.print('update: {\n');
  d.indent('  ');
  for (const si of originalItems) {
    if (!isUpdatable(si.type)) continue;
    d.print(`${si.name}: <R>(`);
    d.print(si.params.map((p) => p + ': string, ').join(''));
    d.print(`fn: (value: ${annos.get(si.type)}) => R`);
    d.print(') => reducerUpdate(`');
    printTemplate(d, si);
    d.print('`, ');
    printDecoder(d, decoders, si.type);
    d.print(', fn),\n');
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.update,\n`);
  }
  d.dedent();
  d.print('},\n');

  d.dedent();
  d.print(`};\n`);
  // also create typeof shorthand
  d.print(`\nexport type ${ctxName}RX = typeof ${ctxName}ReducerContext;\n`);
}

function generateEngine(d: Denter, annos: Annos, f: PEngine): void {
  const eventType = annos.get(f.eventType)!;
  const commandType = annos.get(f.commandType)!;
  const ctxName = contextName(f.store.name!);
  const rx = `${ctxName}ReducerContext`;
  const qx = `${ctxName}QueryContext`;
  const RX = `${ctxName}RX`;
  const QX = `${ctxName}QX`;
  const decodeEvent = `decode${f.eventType.name}`;
  const decodeCommand = `decode${f.commandType.name}`;

  d.print(`
export class ${f.name} extends Engine<${QX}, ${RX}, ${eventType}, ${commandType}> {
  constructor(
    store: Store,
    callbacks: {
      // optional: configure store before any events arrive
      migrate?: (rx: ${RX}) => Reducer<void>,
      // required: reduce a batch of events into the read model
      reducer: (rx: ${RX}, events: ${eventType}[]) => Reducer<void | any[]>,
      // optional: forecast the events a server will send for a command
      forecaster?: (commands: ${commandType}) => ${eventType}[],
      // required if using sendCommands: receive events to send on the wire (in plain-json format)
      onCommands?: (commands: Identified<any>[])=> void,
    },
  ) {
    super(${qx}, ${rx}, store, {
        ...callbacks,
        decodeEvent: ${decodeEvent},
        decodeCommand: ${decodeCommand},
    });
  }
}
`);

  // Then generate a TestData helper.  This could use typescript's "constrained mixins", but why
  // complicate code that's only used for testing?
  d.print(`\nexport class ${ctxName}TestData {\n`);
  d.indent('  ');
  d.print(`data: Record<string, any>;\n`);
  d.print(`\n`);
  d.print(`constructor(data: Record<string, any>){\n`);
  d.indent('  ');
  d.print(`this.data = data;\n`);
  d.dedent();
  d.print(`}\n`);

  for (const si of f.store.items) {
    d.print(`\n${si.name}(`);
    d.print(si.params.map((p) => p + ': string').join(', '));
    d.print(`): ${annos.get(si.type)} {\n`);
    d.indent('  ');
    d.print('return this.data[`');
    printTemplate(d, si);
    d.print(`\`] as ${annos.get(si.type)}\n`);
    d.dedent();
    d.print(`}\n`);
  }

  d.dedent();
  d.print(`}\n`);

  // Then generate a ReducerTester matching this Engine
  d.print(`
export class ${ctxName}ReducerTester extends ReducerTester<${RX}, ${eventType}, ${ctxName}TestData> {
  constructor(
    migrateOrInitialData: ((rx: ${RX}) => Reducer<void>) | Record<string, any>,
    reducer: (rx: ${RX}, events: ${eventType}[]) => Reducer<void | any[]>,
  ) {
    let migrate: null | ((rx: ${RX}) => Reducer<void>);
    let data: Record<string, any>;
    if (migrateOrInitialData instanceof Function) {
        migrate = migrateOrInitialData;
        data = {};
    } else {
        migrate = null;
        data = migrateOrInitialData;
    }
    super(${rx}, migrate, reducer, new InMemStore(data), new ${ctxName}TestData(data));
  }
}
`);
}

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
 * execution venue by choosing a provider instance; the local provider additionally exposes
 * LocalQuery results, which compose via awaitResult()), and the dispatcher a serving side
 * uses to route a decoded wire message into a provider.
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

  // defs: implemented by the author, one generator body per query.  Generic in QX because the
  // contract binds no store; per-caller context (a user id, ...) is constructor state on the
  // implementation, closed over by the bodies.
  d.print(`\nexport interface ${defsName}<QX> {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    const rest = q.args.length ? ', ' + params(q) : '';
    d.print(`${q.name}(qx: QX${rest}): QueryGenerator<${result(q)}>;\n`);
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

  // local provider: hosts the defs on any engine with a compatible query context.  Its
  // queries are LocalQuery-typed so they compose via awaitResult().
  d.print(`\nexport class Local${name}<QX> implements ${name} {\n`);
  d.indent('  ');
  d.print(`#eng: { newQuery<X>(fn: QueryFunction<QX, X>): LocalQuery<X> };\n`);
  d.print(`#defs: ${defsName}<QX>;\n`);
  d.print('\n');
  d.print(`constructor(\n`);
  d.print(`  eng: { newQuery<X>(fn: QueryFunction<QX, X>): LocalQuery<X> },\n`);
  d.print(`  defs: ${defsName}<QX>,\n`);
  d.print(`) {\n`);
  d.print('  this.#eng = eng;\n');
  d.print('  this.#defs = defs;\n');
  d.print('}\n');
  for (const q of kq.queries) {
    const argNames = q.args.map(([an]) => an);
    d.print(`\n${q.name}(${params(q)}): LocalQuery<${result(q)}> {\n`);
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
  const { registry, roots, stores, engines, queries } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  const d = new Denter();

  // Start with the skeleton
  d.print(skeleton);

  const typesToVisit = [
    ...roots,
    ...stores.flatMap((s) => s.items.map((si) => si.type)),
    ...engines.flatMap((f) => f.store.items.map((si) => si.type)),
  ];

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

  // Generate stores
  if (stores.length) generateStorePrereqs(d);
  for (const s of stores) generateStore(d, annos, decoders, s);

  // Generate engines
  for (const e of engines) generateEngine(d, annos, e);

  // Generate query layers
  for (const kq of queries) generateQueries(d, annos, decoders, kq);

  // the generated file ends with a trailing newline
  return d.getvalue() + '\n';
}
