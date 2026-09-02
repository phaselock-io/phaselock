/**
 * Python code generator: emits typing.Protocol classes, JSON structural checkers, query
 * contexts, and Engine subclasses from the lowered IR.
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
/** a checker maps (valueExpr, pathExpr) to Python statements appending to `problems`; noop → "" */
type Checker = (val: string, path: string) => string;
type Checkers = Map<PType, Checker>;

const NOOP: Checker = () => '';

/** convert CamelCase to snake_case, handling acronyms properly */
function camelToSnake(name: string): string {
  if (name.length < 2) return name.toLowerCase();
  const upper = (c: string) => /[A-Z]/.test(c);
  const lower = (c: string) => /[a-z]/.test(c);
  let out = name[0].toLowerCase();
  for (let i = 1; i < name.length - 1; i++) {
    const [c0, c1, c2] = [name[i - 1], name[i], name[i + 1]];
    // catch lower->upper transitions
    if (!upper(c0) && upper(c1)) out += '_';
    // catch acronym endings
    if (upper(c0) && upper(c1) && lower(c2)) out += '_';
    out += c1.toLowerCase();
  }
  return out + name[name.length - 1].toLowerCase();
}

/** convert a field name (camelCase or snake_case) to a PascalCase name segment */
function pascalCase(name: string): string {
  return name
    .split('_')
    .filter((part) => part)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

// annotations

function generateAnnotations(d: Denter, annos: Annos, t: PType): void {
  const visit = (t: PType, path: string): void => {
    if (annos.has(t)) return;

    // builtin scalars
    const builtin =
      t instanceof PString
        ? 'str'
        : t instanceof PInt
          ? 'int'
          : t instanceof PBool
            ? 'bool'
            : t instanceof PJson
              ? 'JSON'
              : t instanceof PNull
                ? 'None'
                : t instanceof PDate
                  ? 'datetime.datetime'
                  : null;
    if (builtin !== null) {
      annos.set(t, builtin);
      return;
    }

    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') annos.set(t, `Literal["${t.value}"]`);
      else if (typeof t.value === 'boolean')
        annos.set(t, t.value ? 'Literal[True]' : 'Literal[False]');
      else annos.set(t, `Literal[${t.value}]`);
      return;
    }

    let anno = '';
    if (t instanceof PArray) {
      visit(t.itemType, path);
      anno = `list[${annos.get(t.itemType)}]`;
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it, path);
      anno = 'tuple[' + t.itemTypes.map((it) => annos.get(it)).join(', ') + ']';
    } else if (t instanceof PUnion) {
      t.types.forEach((ut, i) => visit(ut, path + String(i)));
      anno = t.types.map((ut) => annos.get(ut)).join(' | ');
    } else if (t instanceof PStruct) {
      for (const [fn, ft] of t.fields) visit(ft, path + pascalCase(fn));
    } else if (t instanceof PObject) {
      visit(t.valueType, path);
      anno = `dict[str, ${annos.get(t.valueType)}]`;
    } else {
      throw new Error(`unhandled type in generateAnnotations: ${t.constructor.name}`);
    }

    if (t instanceof PStruct) {
      // define a class based on typing.Protocol
      const className = t.name ?? path;
      annos.set(t, className);
      d.print(`class ${className}(Protocol):\n`);
      d.indent('    ');
      for (const [k, v] of t.fields) {
        if (t.always.has(k)) d.print(`${k}: ${annos.get(v)}\n`);
        else d.print(`${k}: ${annos.get(v)} | None\n`);
      }
      d.dedent();
      d.print('\n');
    } else if (t.name) {
      d.print(`${t.name} = ${anno}\n\n`);
      annos.set(t, t.name);
    } else {
      annos.set(t, anno);
    }
  };
  visit(t, t.name ?? '');
}

// checkers

const PYTYPS: Record<string, string> = {
  string: 'str',
  boolean: 'bool',
  int: 'int',
  object: 'dict',
  array: '(list, tuple)',
};

function checkSolution(d: Denter, checkers: Checkers, solution: Solution): void {
  d.print('problems = []\n');
  d.print('x0 = val\n');
  d.print('xpath0 = path\n');

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
      d.print('return problems\n');
    } else if (solution instanceof CheckJsonType) {
      for (const [jtyp, subsln] of solution.options) {
        // bool is a subclass of int in Python, so int checks must exclude it explicitly
        if (jtyp === 'null') d.print(`if ${subjVar} is None:\n`);
        else if (jtyp === 'int')
          d.print(`if isinstance(${subjVar}, int) and not isinstance(${subjVar}, bool):\n`);
        else d.print(`if isinstance(${subjVar}, ${PYTYPS[jtyp]}):\n`);
        d.indent('    ');
        visit(subsln, obj, obj);
        d.dedent();
      }
      d.print(
        `problems += [f'{${subjPath}}: type {type(${subjVar}).__name__} not allowed here']\n`,
      );
      d.print('return problems\n');
    } else if (solution instanceof CheckLiteral) {
      for (const [lit, subsln] of solution.options) {
        // `is` / the bool exclusion keep bools and ints apart (True == 1 in Python)
        if (typeof lit === 'string') d.print(`if ${subjVar} == "${lit}":\n`);
        else if (typeof lit === 'boolean') d.print(`if ${subjVar} is ${lit ? 'True' : 'False'}:\n`);
        else d.print(`if ${subjVar} == ${lit} and not isinstance(${subjVar}, bool):\n`);
        d.indent('    ');
        visit(subsln, obj, obj);
        d.dedent();
      }
      d.print(`problems += [f'{${subjPath}}: unexpected value']\n`);
      d.print('return problems\n');
    } else if (solution instanceof CheckLength) {
      for (const [length, subsln] of solution.options) {
        d.print(`if len(${subjVar}) == ${length}:\n`);
        d.indent('    ');
        visit(subsln, obj, obj);
        d.dedent();
      }
      if (solution.default !== null) {
        visit(solution.default, obj, obj);
      } else {
        d.print(`problems += [f'{${subjPath}}: unexpected length']\n`);
        d.print('return problems\n');
      }
    } else if (solution instanceof GetIndex) {
      const i = counter++;
      d.print(`x${i} = ${objVar}[${solution.i}]\n`);
      d.print(`xpath${i} = ${objPath} + '[${solution.i}]'\n`);
      const next = [`x${i}`, `xpath${i}`] as const;
      visit(solution.solution, next, next);
    } else if (solution instanceof GetField) {
      const i = counter++;
      d.print(`if '${solution.key}' not in ${objVar}:\n`);
      d.print(`    problems += [${objPath} + f': missing discriminator "${solution.key}"']\n`);
      d.print(`    return problems\n`);
      d.print(`x${i} = ${objVar}["${solution.key}"]\n`);
      d.print(`xpath${i} = ${objPath} + ".${solution.key}"\n`);
      visit(solution.solution, obj, [`x${i}`, `xpath${i}`]);
    } else if (solution instanceof HasField) {
      for (const [field, subsln] of solution.solutions) {
        d.print(`if "${field}" in ${objVar}:\n`);
        d.indent('    ');
        visit(subsln, obj, obj);
        d.dedent();
      }
      d.print(`problems += [f'{${subjPath}}: no matching keys found']\n`);
      d.print('return problems\n');
    } else {
      throw new Error(`unrecognized solution type: ${(solution as Solution).constructor.name}`);
    }
  };
  visit(solution, ['x0', 'xpath0'], ['x0', 'xpath0']);
}

function generateCheckers(
  d: Denter,
  registry: PTypeRegistry,
  annos: Annos,
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
          `if not isinstance(${val}, str):\n` +
          `    problems += [${path} + f': is of type {type(${val}).__name__}, not string']\n`,
      );
      return;
    }
    if (t instanceof PInt) {
      // bool is a subclass of int in Python, so the check must exclude it explicitly
      checkers.set(
        t,
        (val, path) =>
          `if not isinstance(${val}, int) or isinstance(${val}, bool):\n` +
          `    problems += [${path} + f': is of type {type(${val}).__name__}, not int']\n`,
      );
      return;
    }
    if (t instanceof PBool) {
      checkers.set(
        t,
        (val, path) =>
          `if not isinstance(${val}, bool):\n` +
          `    problems += [${path} + f': is of type {type(${val}).__name__}, not bool']\n`,
      );
      return;
    }
    if (t instanceof PNull || (t instanceof PLiteral && t.value === null)) {
      checkers.set(
        t,
        (val, path) =>
          `if ${val} is not None:\n` +
          `    problems += [${path} + f': is of type {type(${val}).__name__}, not null']\n`,
      );
      return;
    }
    if (t instanceof PDate) {
      // TypeError covers non-string values, which strptime rejects with the wrong exception
      checkers.set(
        t,
        (val, path) =>
          'try:\n' +
          `    datetime.datetime.strptime(${val}, '%Y-%m-%dT%H:%M:%SZ')\n` +
          'except (ValueError, TypeError):\n' +
          '    try:\n' +
          `        datetime.datetime.strptime(${val}, '%Y-%m-%dT%H:%M:%S.%fZ')\n` +
          '    except (ValueError, TypeError):\n' +
          `        problems += [${path} + ': invalid timestamp']\n`,
      );
      return;
    }
    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') {
        checkers.set(
          t,
          (val, path) =>
            `if ${val} != '${t.value}':\n` +
            `    problems += [${path} + f': is not "${t.value}"']\n`,
        );
      } else if (typeof t.value === 'boolean') {
        // `is` keeps bools and ints apart (True == 1 in Python)
        const pyval = t.value ? 'True' : 'False';
        checkers.set(
          t,
          (val, path) =>
            `if ${val} is not ${pyval}:\n` + `    problems += [${path} + f': is not ${pyval}']\n`,
        );
      } else {
        checkers.set(
          t,
          (val, path) =>
            `if ${val} != ${t.value} or isinstance(${val}, bool):\n` +
            `    problems += [${path} + f': is not ${t.value}']\n`,
        );
      }
      return;
    }

    let checker: Checker;
    if (t instanceof PUnion) {
      for (const ut of t.types) visit(ut);
      const solution = solveUnion(registry, t.types);
      const name = t.name ? `check_${camelToSnake(t.name)}` : `_check_anon_${anon.n++}`;
      d.print(`\ndef ${name}(val: Any, path: str = '<root>') -> list[str]:\n`);
      d.indent('    ');
      checkSolution(d, checkers, solution);
      d.dedent();
      checker = (val, path) => `problems += ${name}(${val}, ${path})\n`;
    } else if (t instanceof PArray) {
      visit(t.itemType);
      checker = (val, path) => {
        const dd = new Denter();
        dd.print(
          `if not isinstance(${val}, (list, tuple)):\n` +
            `    problems += [${path} + f': is a {type(${val}).__name__}, not json array']\n`,
        );
        if (checkers.get(t.itemType) === NOOP) return dd.getvalue();
        dd.print('else:\n');
        dd.indent('    ');
        const n = loop.n++;
        const iv = `i${n}`;
        const ev = `e${n}`;
        dd.print(`for ${iv}, ${ev} in enumerate(${val}):\n`);
        dd.indent('    ');
        // build the element's path off the original path expression, so nothing is clobbered
        // when this checker is inlined inside another
        dd.print(checkers.get(t.itemType)!(ev, `${path} + f'[{${iv}}]'`));
        return dd.getvalue();
      };
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it);
      checker = (val, path) => {
        const dd = new Denter();
        const n = t.itemTypes.length;
        dd.print(
          `if not isinstance(${val}, (list, tuple)):\n` +
            `    problems += [${path} + f': is a {type(${val}).__name__}, not json array']\n`,
        );
        dd.print(`elif len(${val}) != ${n}:\n`);
        dd.print(`    problems += [${path} + f': expected ${n} items, not {len(${val})}']\n`);
        // index each element off the original value/path expressions, so nothing is clobbered
        // even when this checker is inlined inside another (e.g. a struct field)
        const parts = t.itemTypes
          .map((it, i) => checkers.get(it)!(`${val}[${i}]`, `${path} + '[${i}]'`))
          .filter((p) => p);
        if (parts.length) {
          dd.print('else:\n');
          dd.indent('    ');
          for (const p of parts) dd.print(p);
        }
        return dd.getvalue();
      };
    } else if (t instanceof PStruct) {
      for (const ft of t.fields.values()) visit(ft);
      let keys: string, func: string;
      if (t.name) {
        keys = `_${camelToSnake(t.name).toUpperCase()}_ALLOWED_KEYS`;
        func = `check_${camelToSnake(t.name)}`;
      } else {
        const n = anon.n++;
        keys = `_ANON_${n}_ALLOWED_KEYS`;
        func = `_check_anon_${n}`;
      }
      const keyset = '{' + [...t.fields.keys()].map((fn) => `"${fn}"`).join(', ') + '}';
      d.print(`\n${keys} = ${keyset}\n`);
      d.print(`\ndef ${func}(val: Any, path: str = '<root>') -> list[str]:\n`);
      d.indent('    ');
      d.print('if not isinstance(val, dict):\n');
      d.print("    return [path + f': is a {type(val).__name__}, not json object']\n");
      d.print('problems = []\n');
      for (const [fn, ft] of t.fields) {
        d.print(`if '${fn}' in val:\n`);
        d.indent('    ');
        d.print(`x = val['${fn}']\n`);
        d.print(`xpath = path + '.${fn}'\n`);
        d.print(checkers.get(ft)!('x', 'xpath'));
        d.dedent();
        if (!t.maybes.has(fn)) {
          d.print('else:\n');
          d.print(`    problems += [path + ': missing required key ${fn}']\n`);
        }
      }
      d.print(`if set(val).difference(${keys}):\n`);
      d.print(`    problems += [path + ': contains extra keys']\n`);
      d.print('return problems\n');
      d.dedent();
      d.print(`\n`);
      checker = (val, path) => `problems += ${func}(${val}, ${path})\n`;
    } else if (t instanceof PObject) {
      visit(t.valueType);
      checker = (val, path) => {
        const dd = new Denter();
        dd.print(
          `if not isinstance(${val}, dict):\n` +
            `    problems += [${path} + f': is a {type(${val}).__name__}, not json object']\n`,
        );
        if (checkers.get(t.valueType) === NOOP) return dd.getvalue();
        dd.print('else:\n');
        dd.indent('    ');
        dd.print(`for k, v in ${val}.items():\n`);
        dd.indent('    ');
        dd.print(`xpath = ${path} + f'.{k}'\n`);
        dd.print(checkers.get(t.valueType)!('v', 'xpath'));
        return dd.getvalue();
      };
    } else {
      throw new Error(`unhandled type in generateCheckers: ${t}`);
    }

    // named types without a function already defined get a wrapper now
    if (t.name && !(t instanceof PUnion) && !(t instanceof PStruct)) {
      d.print(`\ndef check_${camelToSnake(t.name)}(val: Any, path: str = '<root>') -> list[str]:\n`);
      d.indent('    ');
      d.print('problems = []\n');
      d.print(checker('val', 'path'));
      d.print('return problems\n');
      d.dedent();
    }
    checkers.set(t, checker);
  };
  visit(t);
}

// stores and engines

function contextName(name: string): string {
  return name.endsWith('Store') ? name.slice(0, -5) : name;
}

function generateStore(d: Denter, annos: Annos, store: PStore): void {
  const supers = store.deps.length
    ? '(' + store.deps.map((dep) => `${contextName(dep.name!)}QueryContext`).join(', ') + ')'
    : '';
  d.print(`\nclass ${contextName(store.name!)}QueryContext${supers}:\n`);
  d.indent('    ');
  d.print('def __init__(self, jsqx: _quickjs.Value):\n');
  d.print('    self._jsqx = jsqx\n');
  const originalItems = store.originalItems;
  originalItems.forEach((si, i) => {
    d.print('\n');
    d.print(`def ${si.name}(self, `);
    d.print(si.params.map((p) => p + ': str').join(', '));
    d.print(`) -> Awaitable[${annos.get(si.type)}]:\n`);
    d.indent('    ');
    d.print(`return _StoreResult(self._jsqx.get.${si.name}(`);
    d.print(si.params.join(', '));
    d.print(`))\n`);
    d.dedent();
  });
  d.print('\n');
  d.dedent();
}

function engineName(name: string): string {
  return name.endsWith('Engine') ? name : name + 'Engine';
}

function generateEngine(d: Denter, annos: Annos, f: PEngine): void {
  const QX = `${contextName(f.store.name!)}QueryContext`;
  const E = annos.get(f.eventType);
  const C = annos.get(f.commandType);
  d.print('\n');
  d.print('\n');
  d.print(`class ${engineName(f.name!)}(Engine[\n`);
  d.print(`    ${QX},  # python query context, enabling python queries\n`);
  d.print(`    ${E},  # event type from server\n`);
  d.print(`    ${C},  # command type to server\n`);
  d.print(`]):\n`);
  d.print(`    def __init__(\n`);
  d.print(`        self,\n`);
  d.print(`        bundle: str,\n`);
  d.print(`        store: Callable[[bool], Txn] | None,\n`);
  d.print(`        migrate: str | None,\n`);
  d.print(`        reducer: str,\n`);
  d.print(`    ):\n`);
  d.print(`        super().__init__(\n`);
  d.print(`            bundle=bundle,\n`);
  d.print(`            engine_cls='${engineName(f.name!)}',\n`);
  d.print(`            store=store,\n`);
  d.print(`            qx_factory=${QX},\n`);
  d.print(`            migrate=migrate,\n`);
  d.print(`            reducer=reducer,\n`);
  d.print(`        )\n`);
}

/** entrypoint: assemble the complete generated module */
export function generatePy(lowered: LoweredProgram, skeleton: string): string {
  const { registry, roots, stores, engines } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  const d = new Denter();
  d.print(skeleton);
  d.print('\n\n');

  const typesToVisit = [
    ...roots,
    ...stores.flatMap((s) => s.items.map((si) => si.type)),
    ...engines.flatMap((f) => f.store.items.map((si) => si.type)),
  ];

  const annos: Annos = new Map();
  for (const t of typesToVisit) generateAnnotations(d, annos, t);

  const checkers: Checkers = new Map();
  const anon = { n: 0 };
  const loop = { n: 0 };
  for (const t of typesToVisit) generateCheckers(d, registry, annos, checkers, t, anon, loop);

  for (const s of stores) generateStore(d, annos, s);
  for (const e of engines) generateEngine(d, annos, e);

  return d.getvalue() + '\n';
}
