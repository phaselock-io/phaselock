/**
 * Go code generator: emits goja.Value-backed types with typed accessors, union converters and
 * interfaces, JSON structural checkers, query contexts, and Engine aliases from the lowered IR.
 *
 * Library types are stored as the underlying goja.Value with typed getters, since they are
 * primarily accessed from JavaScript and only from Go inside query functions (which run embedded
 * in a JS environment anyway).
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
  Solution,
  solveUnion,
} from '@phaselock/typespec-core';

type Annos = Map<PType, string>;
type Converter = (varExpr: string) => string;
type Converters = Map<PType, Converter>;
type Checker = (varExpr: string, path: string) => string;
type Checkers = Map<PType, Checker>;

interface Anon {
  n: number;
}
function getAnon(anon: Anon): string {
  anon.n += 1;
  return `anon${anon.n}`;
}

/**
 * A readable name for a builtin used to name slice/record converters (`sliceOfString`).  Named
 * types use their own name; builtins have none, so we supply a conventional one, falling back to
 * an anonymous counter only for genuinely unnameable item types (e.g. literals).
 */
function itemName(t: PType): string | null {
  if (t.name) return t.name;
  if (t instanceof PString) return 'String';
  if (t instanceof PInt) return 'Int';
  if (t instanceof PBool) return 'Bool';
  if (t instanceof PDate) return 'Date';
  if (t instanceof PJson) return 'Json';
  return null;
}

/** convert a name (camelCase or snake_case) to PascalCase */
function pascal(s: string): string {
  return s
    .split('_')
    .filter((part) => part)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}
function camel(s: string): string {
  const p = pascal(s);
  return p.slice(0, 1).toLowerCase() + p.slice(1);
}

const JSON_TYPE_TO_REFLECT_TYPE: Record<string, string> = {
  null: 'reflectTypeNil',
  string: 'reflectTypeString',
  boolean: 'reflectTypeBool',
  int: 'reflectTypeInt',
  object: 'reflectTypeMap',
  array: 'reflectTypeArray',
};

/** sort a map's entries by key (numbers or strings; never mixed within one map) */
function sortedEntries<K extends string | number | boolean, V>(m: Map<K, V>): [K, V][] {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function convertUnion(
  d: Denter,
  name: string,
  t: PUnion,
  registry: PTypeRegistry,
  converters: Converters,
): Converter {
  d.print(`\nfunc To${name}(vm *goja.Runtime, value goja.Value) ${name} {\n`);
  d.indent('\t');
  d.print(`x := value\n`);

  // first find out what declarations we need by walking the whole solution tree
  const decls = new Set<string>();
  const declare = (code: string): void => {
    if (decls.has(code)) return;
    decls.add(code);
    d.print(code + '\n');
  };

  const visitDecls = (solution: Solution): void => {
    if (solution instanceof Match) {
      // nothing
    } else if (solution instanceof CheckJsonType) {
      for (const sln of solution.options.values()) visitDecls(sln);
    } else if (solution instanceof CheckLiteral) {
      for (const sln of solution.options.values()) visitDecls(sln);
    } else if (solution instanceof CheckLength) {
      declare('var fn func(this goja.Value, args ...Value) (goja.Value, error)');
      declare('var ok bool');
      declare('var length goja.Value');
      declare('var err error');
      for (const sln of solution.options.values()) visitDecls(sln);
      if (solution.default !== null) visitDecls(solution.default);
    } else if (solution instanceof GetIndex) {
      visitDecls(solution.solution);
    } else if (solution instanceof GetField) {
      visitDecls(solution.solution);
    } else if (solution instanceof HasField) {
      declare('var obj *goja.Object');
      for (const [, sln] of solution.solutions) visitDecls(sln);
    } else {
      throw new Error(`unexpected solution of type: ${(solution as Solution).constructor.name}`);
    }
  };

  const visit = (solution: Solution): void => {
    if (solution instanceof Match) {
      // null has no converter: the union's Go type is an interface, so null converts to nil
      if (solution.typ instanceof PNull) {
        d.print(`return nil\n`);
        return;
      }
      d.print(`out := ${converters.get(solution.typ)!('value')}\n`);
      d.print(`return out\n`);
    } else if (solution instanceof CheckJsonType) {
      d.print(`switch x.ExportType() {\n`);
      for (const [jtyp, sln] of sortedEntries(solution.options)) {
        d.print(`case ${JSON_TYPE_TO_REFLECT_TYPE[jtyp]}:\n`);
        d.indent('\t');
        visit(sln);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      d.print(`panic(fmt.Sprintf("unexpected export type: %v", x.ExportType()))\n`);
      d.dedent();
      d.print(`}\n`);
    } else if (solution instanceof CheckLiteral) {
      const typeset = new Set([...solution.options.keys()].map((v) => typeof v));
      if (typeset.size === 1 && typeset.has('boolean')) {
        d.print(`if x.Export().(bool) {\n`);
        d.indent('\t');
        visit(solution.options.get(true as any)!);
        d.dedent();
        d.print(`} else {\n`);
        d.indent('\t');
        visit(solution.options.get(false as any)!);
        d.dedent();
        d.print(`}\n`);
      } else if (typeset.size === 1 && typeset.has('string')) {
        d.print(`switch x.Export().(string) {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          d.print(`case "${value}":\n`);
          d.indent('\t');
          visit(sln);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`panic(fmt.Sprintf("unexpected literal: %v", x))\n`);
        d.dedent();
        d.print(`}\n`);
      } else if (typeset.size === 1 && typeset.has('number')) {
        d.print(`switch x.Export().(int64) {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          d.print(`case ${value}:\n`);
          d.indent('\t');
          visit(sln);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`panic(fmt.Sprintf("unexpected literal: %v", x))\n`);
        d.dedent();
        d.print(`}\n`);
      } else {
        // mixed literals; use a universal switch statement (less efficient)
        d.print(`switch true {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          let govalue: string;
          if (typeof value === 'string') govalue = `"${value}"`;
          else if (typeof value === 'boolean') govalue = String(value);
          else govalue = `int64(${value})`;
          d.print(`case x.StrictEquals(vm.ToValue(${govalue})):\n`);
          d.indent('\t');
          visit(sln);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`panic(fmt.Sprintf("unexpected literal: %v", x))\n`);
        d.dedent();
        d.print(`}\n`);
      }
    } else if (solution instanceof CheckLength) {
      d.print(`fn, ok = goja.AssertFunction(x.(*goja.Object).Get("length"))\n`);
      d.print(`if !ok {\n`);
      d.indent('\t');
      d.print(`panic(fmt.Sprintf(".length is not a function of value %v", x))\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`length, err = fn(x)\n`);
      d.print(`if err != nil {\n`);
      d.indent('\t');
      d.print(`panic(fmt.Sprintf(".length() of %v failed: %v", x, err))\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`switch length.Export().(int64) {\n`);
      for (const [l, sln] of sortedEntries(solution.options)) {
        d.print(`case ${l}:\n`);
        d.indent('\t');
        visit(sln);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      if (solution.default !== null) visit(solution.default);
      else d.print(`panic(fmt.Sprintf("unexpected length: %v", length))\n`);
      d.dedent();
      d.print(`}\n`);
    } else if (solution instanceof GetIndex) {
      d.print(`x = x.(*goja.Object).Get("${solution.i}")\n`);
      visit(solution.solution);
    } else if (solution instanceof GetField) {
      d.print(`x = x.(*goja.Object).Get("${solution.key}")\n`);
      visit(solution.solution);
    } else if (solution instanceof HasField) {
      d.print(`obj = x.(*goja.Object)\n`);
      d.print(`switch true {\n`);
      for (const [key, sln] of solution.solutions) {
        d.print(`case obj.Get("${key}") != nil:\n`);
        d.indent('\t');
        visit(sln);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      d.print(`panic(fmt.Sprintf("no matching fields: %v", x))\n`);
      d.dedent();
      d.print(`}\n`);
    } else {
      throw new Error(`unexpected solution of type: ${(solution as Solution).constructor.name}`);
    }
  };

  const solution = solveUnion(registry, t.types);
  visitDecls(solution);
  visit(solution);

  d.dedent();
  d.print(`}\n`);
  return (varExpr) => `To${name}(vm, ${varExpr})`;
}

function generateTypes(
  d: Denter,
  imports: Set<string>,
  registry: PTypeRegistry,
  annos: Annos,
  converters: Converters,
  anon: Anon,
  t: PType,
): void {
  const visit = (t: PType, path: string): void => {
    if (annos.has(t)) return;
    // skip Null type; it should affect nullability, but not be used alone
    if (t instanceof PNull) return;

    // builtin scalars
    const goname =
      t instanceof PString
        ? 'string'
        : t instanceof PInt
          ? 'int64'
          : t instanceof PBool
            ? 'bool'
            : t instanceof PJson
              ? 'goja.Value'
              : null;
    if (goname !== null) {
      const anno = goname;
      const converter: Converter = t instanceof PJson ? (v) => v : (v) => `${v}.Export().(${anno})`;
      annos.set(t, anno);
      converters.set(t, converter);
      return;
    }

    if (t instanceof PDate) {
      imports.add('time');
      annos.set(t, 'time.Time');
      // converters run on decoded values, where timestamps are already JS Date objects
      // (goja exports a Date as time.Time)
      d.print('\nfunc ToDate(value goja.Value) time.Time {\n');
      d.indent('\t');
      d.print('out, ok := value.Export().(time.Time)\n');
      d.print('if !ok {\n');
      d.indent('\t');
      d.print('panic(fmt.Sprintf("value is not a Date (%v)", value))\n');
      d.dedent();
      d.print('}\n');
      d.print('return out\n');
      d.dedent();
      d.print('}\n');
      converters.set(t, (v) => `ToDate(${v})`);
      return;
    }

    let anno: string;
    let converter: Converter;

    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') anno = `string /*${t.value}*/`;
      else if (typeof t.value === 'boolean') anno = `bool /*${t.value}*/`;
      else anno = `int64 /*${t.value}*/`;
      converter = (v) => `${v}.Export().(${anno})`;
    } else if (t instanceof PArray) {
      visit(t.itemType, path);
      anno = `[]${annos.get(t.itemType)}`;
      const it = itemName(t.itemType);
      const name = pascal(t.name ?? (it ? `sliceOf${it}` : getAnon(anon)));
      d.print(`\nfunc to${name}(vm *goja.Runtime, value goja.Value) ${anno} {\n`);
      d.indent('\t');
      d.print('if value == nil || goja.IsUndefined(value) {\n');
      d.print('\treturn nil\n');
      d.print('}\n');
      d.print(`var out ${anno}\n`);
      d.print(`vm.ForOf(value, func(i goja.Value) bool {\n`);
      d.indent('\t');
      d.print(`item := ${converters.get(t.itemType)!('i')}\n`);
      d.print(`out = append(out, item)\n`);
      d.print(`return true\n`);
      d.dedent();
      d.print(`})\n`);
      d.print(`return out\n`);
      d.dedent();
      d.print(`}\n`);
      converter = (v) => `to${name}(vm, ${v})`;
    } else if (t instanceof PObject) {
      visit(t.valueType, path);
      anno = `map[string]${annos.get(t.valueType)}`;
      const vt = itemName(t.valueType);
      const name = pascal(t.name ?? (vt ? `recordOf${vt}` : getAnon(anon)));
      d.print(`\nfunc to${name}(vm *goja.Runtime, value goja.Value) ${anno} {\n`);
      d.indent('\t');
      d.print('if value == nil || goja.IsUndefined(value) {\n');
      d.print('\treturn nil\n');
      d.print('}\n');
      d.print(`obj := value.(*goja.Object)\n`);
      // a space between a trailing type comment and the composite-literal brace, per gofmt
      d.print(`out := ${anno}${anno.endsWith('*/') ? ' ' : ''}{}\n`);
      d.print(`for _, key := range obj.Keys() {\n`);
      d.indent('\t');
      d.print(`vin := obj.Get(key)\n`);
      d.print(`vout := ${converters.get(t.valueType)!('vin')}\n`);
      d.print(`out[key] = vout\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`return out\n`);
      d.dedent();
      d.print(`}\n`);
      converter = (v) => `to${name}(vm, ${v})`;
    } else if (t instanceof PUnion) {
      t.types.forEach((ut, i) => visit(ut, path + String(i)));
      const name = pascal(t.name ?? path);
      const nonNull = t.types.filter((ut) => !(ut instanceof PNull));
      const allStructs = nonNull.length > 0 && nonNull.every((ut) => ut instanceof PStruct);
      const literalBase = (lit: PLiteral): string =>
        typeof lit.value === 'string'
          ? 'string'
          : typeof lit.value === 'boolean'
            ? 'bool'
            : 'int64';
      const bases = new Set(t.types.map((ut) => (ut instanceof PLiteral ? literalBase(ut) : null)));
      const uniformLiteral = t.types.every((ut) => ut instanceof PLiteral) && bases.size === 1;

      if (allStructs) {
        // union of named struct types: an interface each member opts into.  The marker method is
        // unexported so the union stays sealed to this package.
        d.print(`\ntype ${name} interface {\n`);
        d.indent('\t');
        d.print(`json.Marshaler\n`);
        d.print(`json.Unmarshaler\n`);
        d.print(`is${name}()\n`);
        d.dedent();
        d.print(`}\n`);
        converter = convertUnion(d, name, t, registry, converters);
        // one-line funcs are blank-line separated so gofmt doesn't want their bodies aligned
        for (const ut of t.types) {
          if (ut instanceof PNull) continue;
          d.print(`\nfunc (x ${annos.get(ut)}) is${name}() {}\n`);
        }
      } else if (uniformLiteral) {
        // union of literals sharing one base type (e.g. an enum): a defined type over that base.
        // The checker enforces which values are allowed, so no interface or marker methods are
        // needed (there is only one underlying type, nothing to dispatch between).
        const base = [...bases][0]!;
        d.print(`\ntype ${name} ${base}\n`);
        d.print(`\nfunc To${name}(vm *goja.Runtime, value goja.Value) ${name} {\n`);
        d.indent('\t');
        d.print(`return ${name}(value.Export().(${base}))\n`);
        d.dedent();
        d.print(`}\n`);
        converter = (v) => `To${name}(vm, ${v})`;
      } else {
        // heterogeneous union (mixed literal types, or literals mixed with structs): no single Go
        // type, so fall back to any.  The checker enforces membership.
        d.print(`\ntype ${name} = any\n`);
        d.print(`\nfunc To${name}(vm *goja.Runtime, value goja.Value) ${name} {\n`);
        d.indent('\t');
        d.print(`return value.Export()\n`);
        d.dedent();
        d.print(`}\n`);
        converter = (v) => `To${name}(vm, ${v})`;
      }
      anno = name;
    } else if (t instanceof PStruct) {
      for (const [fn, ft] of t.fields) visit(ft, path + pascal(fn));
      const name = pascal(t.name ?? path);
      d.print(`\ntype ${name} goja.Object\n`);
      d.print(`\nfunc (x *${name}) MarshalJSON() ([]byte, error) {\n`);
      d.indent('\t');
      d.print(`return (*goja.Object)(x).MarshalJSON()\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`\nfunc (x *${name}) UnmarshalJSON(data []byte) error {\n`);
      d.indent('\t');
      d.print(`return nil // this is as pointless as the goja unmarshaler is\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`\nfunc To${name}(vm *goja.Runtime, value goja.Value) *${name} {\n`);
      d.indent('\t');
      d.print(`out := value.(*goja.Object)\n`);
      d.print(`return (*${name})(out)\n`);
      d.dedent();
      d.print(`}\n`);
      converter = (v) => `To${name}(vm, ${v})`;
      for (const [fn, ft] of t.fields) {
        d.print(`\nfunc (x *${name}) ${pascal(fn)}(vm *goja.Runtime) ${annos.get(ft)} {\n`);
        d.indent('\t');
        d.print(`value := (*goja.Object)(x).Get("${fn}")\n`);
        d.print(`out := ${converters.get(ft)!('value')}\n`);
        d.print(`return out\n`);
        d.dedent();
        d.print(`}\n`);
      }
      anno = `*${name}`;
    } else if (t instanceof PTuple) {
      t.itemTypes.forEach((it, i) => visit(it, path + String(i)));
      const name = pascal(t.name ?? path);
      d.print(`\ntype ${name} goja.Object\n`);
      d.print(`\nfunc To${name}(vm *goja.Runtime, value goja.Value) *${name} {\n`);
      d.indent('\t');
      d.print(`out := value.(*goja.Object)\n`);
      d.print(`return (*${name})(out)\n`);
      d.dedent();
      d.print(`}\n`);
      converter = (v) => `To${name}(vm, ${v})`;
      t.itemTypes.forEach((it, i) => {
        d.print(`\nfunc (x *${name}) Item${i}(vm *goja.Runtime) ${annos.get(it)} {\n`);
        d.indent('\t');
        d.print(`value := (*goja.Object)(x).Get("${i}")\n`);
        d.print(`out := ${converters.get(it)!('value')}\n`);
        d.print(`return out\n`);
        d.dedent();
        d.print(`}\n`);
      });
      anno = `*${name}`;
    } else {
      throw new Error(`unhandled type in generateTypes: ${t.constructor.name}`);
    }

    annos.set(t, anno);
    converters.set(t, converter);
  };
  visit(t, t.name ?? '');
}

// checkers

const NOOP: Checker = () => '';

function checkSolution(d: Denter, checkers: Checkers, solution: Solution): void {
  d.print('x0 := value\n');
  d.print('xpath0 := path\n');

  const decls = new Set<string>();
  const declare = (code: string): void => {
    if (decls.has(code)) return;
    decls.add(code);
    d.print(code + '\n');
  };

  const visitDecls = (solution: Solution): void => {
    if (solution instanceof Match) {
      // nothing
    } else if (solution instanceof CheckJsonType) {
      for (const sln of solution.options.values()) visitDecls(sln);
    } else if (solution instanceof CheckLiteral) {
      const typeset = new Set([...solution.options.keys()].map((v) => typeof v));
      if (typeset.size === 1 && typeset.has('boolean')) {
        declare('var ok bool');
        declare('var b bool');
      } else if (typeset.size === 1 && typeset.has('string')) {
        declare('var ok bool');
        declare('var s string');
      } else if (typeset.size === 1 && typeset.has('number')) {
        declare('var ok bool');
        declare('var n int64');
      }
      for (const sln of solution.options.values()) visitDecls(sln);
    } else if (solution instanceof CheckLength) {
      declare('var obj *goja.Object');
      declare('var ok bool');
      declare('var fn func(this goja.Value, args ...Value) (goja.Value, error)');
      for (const sln of solution.options.values()) visitDecls(sln);
      if (solution.default !== null) visitDecls(solution.default);
    } else if (solution instanceof GetIndex) {
      visitDecls(solution.solution);
    } else if (solution instanceof GetField) {
      visitDecls(solution.solution);
    } else if (solution instanceof HasField) {
      declare('var obj *goja.Object');
      declare('var ok bool');
      for (const [, sln] of solution.solutions) visitDecls(sln);
    } else {
      throw new Error(`unexpected solution of type: ${(solution as Solution).constructor.name}`);
    }
  };

  // `obj` names the value/path currently being navigated; `subj` names the value/path the
  // enclosing check tests.  GetField mints a fresh, uniquely-numbered subject variable from
  // `obj` but leaves `obj` unchanged, so sibling discriminators like [type, v] both read from the
  // same object (`x0.(*goja.Object).Get("type")`, then `x0.(*goja.Object).Get("v")`); only
  // GetIndex descends `obj` into an array element.
  let counter = 0;
  const visit = (
    solution: Solution,
    obj: readonly [string, string],
    subj: readonly [string, string],
  ): void => {
    const [objVar, objPath] = obj;
    const [subjVar, subjPath] = subj;
    if (solution instanceof Match) {
      d.print(checkers.get(solution.typ)!('value', 'path'));
      d.print('return errs\n');
    } else if (solution instanceof CheckJsonType) {
      d.print(`switch ${subjVar}.ExportType() {\n`);
      for (const [jtyp, sln] of sortedEntries(solution.options)) {
        d.print(`case ${JSON_TYPE_TO_REFLECT_TYPE[jtyp]}:\n`);
        d.indent('\t');
        visit(sln, obj, obj);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf(\n`);
      d.print(`\t"%v: type %v not allowed here", ${subjPath}, ${subjVar}.ExportType(),\n`);
      d.print(`))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
    } else if (solution instanceof CheckLiteral) {
      const typeset = new Set([...solution.options.keys()].map((v) => typeof v));
      if (typeset.size === 1 && typeset.has('boolean')) {
        d.print(`b, ok = ${subjVar}.Export().(bool)\n`);
        d.print(`if !ok {\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: not a bool", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`} else if b {\n`);
        d.indent('\t');
        visit(solution.options.get(true as any)!, obj, obj);
        d.dedent();
        d.print(`} else {\n`);
        d.indent('\t');
        visit(solution.options.get(false as any)!, obj, obj);
        d.dedent();
        d.print(`}\n`);
      } else if (typeset.size === 1 && typeset.has('string')) {
        d.print(`s, ok = ${subjVar}.Export().(string)\n`);
        d.print(`if !ok {\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: not a string", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`}\n`);
        d.print(`switch s {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          d.print(`case "${value}":\n`);
          d.indent('\t');
          visit(sln, obj, obj);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: unexpected literal", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`}\n`);
      } else if (typeset.size === 1 && typeset.has('number')) {
        d.print(`n, ok = ${subjVar}.Export().(int64)\n`);
        d.print(`if !ok {\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: not an int", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`}\n`);
        d.print(`switch n {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          d.print(`case ${value}:\n`);
          d.indent('\t');
          visit(sln, obj, obj);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: unexpected literal", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`}\n`);
      } else {
        d.print(`switch true {\n`);
        for (const [value, sln] of sortedEntries(solution.options)) {
          let govalue: string;
          if (typeof value === 'string') govalue = `"${value}"`;
          else if (typeof value === 'boolean') govalue = String(value);
          else govalue = `int64(${value})`;
          d.print(`case ${subjVar}.StrictEquals(vm.ToValue(${govalue})):\n`);
          d.indent('\t');
          visit(sln, obj, obj);
          d.dedent();
        }
        d.print(`default:\n`);
        d.indent('\t');
        d.print(`errs = append(errs, fmt.Errorf("%v: unexpected literal", ${subjPath}))\n`);
        d.print(`return errs\n`);
        d.dedent();
        d.print(`}\n`);
      }
    } else if (solution instanceof CheckLength) {
      d.print(`obj, ok := ${subjVar}.(*goja.Object)\n`);
      d.print(`if !ok {\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf("%v: not an array", ${subjPath}))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`fn, ok = goja.AssertFunction(obj.Get("length"))\n`);
      d.print(`if !ok {\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf("%v: no .length() method", ${subjPath}))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`length, err = fn(${subjVar})\n`);
      d.print(`if err != nil {\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf("%v: .length(): %w", ${subjPath}, err))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`switch length.Export().(int64) {\n`);
      for (const [l, sln] of sortedEntries(solution.options)) {
        d.print(`case ${l}:\n`);
        d.indent('\t');
        visit(sln, obj, obj);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      if (solution.default !== null) {
        visit(solution.default, obj, obj);
      } else {
        d.print(`errs = append(errs, fmt.Errorf("%v: unexpected length", ${subjPath}))\n`);
        d.print(`return errs\n`);
      }
      d.dedent();
      d.print(`}\n`);
    } else if (solution instanceof GetIndex) {
      const i = ++counter;
      d.print(`x${i} := ${objVar}.(*goja.Object).Get("${solution.i}")\n`);
      d.print(`xpath${i} := ${objPath} + "[${solution.i}]"\n`);
      const next = [`x${i}`, `xpath${i}`] as const;
      visit(solution.solution, next, next);
    } else if (solution instanceof GetField) {
      const i = ++counter;
      d.print(`x${i} := ${objVar}.(*goja.Object).Get("${solution.key}")\n`);
      d.print(`xpath${i} := ${objPath} + ".${solution.key}"\n`);
      d.print(`if x${i} == nil {\n`);
      d.indent('\t');
      d.print(
        `errs = append(errs, fmt.Errorf("%v: missing discriminator \\"${solution.key}\\"", xpath${i}))\n`,
      );
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      visit(solution.solution, obj, [`x${i}`, `xpath${i}`]);
    } else if (solution instanceof HasField) {
      d.print(`obj, ok = ${subjVar}.(*goja.Object)\n`);
      d.print(`if !ok {\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf("%v: not an object", ${subjPath}))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`switch true {\n`);
      for (const [key, sln] of solution.solutions) {
        d.print(`case obj.Get("${key}") != nil:\n`);
        d.indent('\t');
        visit(sln, obj, obj);
        d.dedent();
      }
      d.print(`default:\n`);
      d.indent('\t');
      d.print(`errs = append(errs, fmt.Errorf("%v: no matching fields", ${subjPath}))\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
    } else {
      throw new Error(`unrecognized solution type: ${(solution as Solution).constructor.name}`);
    }
  };

  visitDecls(solution);
  visit(solution, ['x0', 'xpath0'], ['x0', 'xpath0']);
}

function generateCheckers(
  d: Denter,
  registry: PTypeRegistry,
  annos: Annos,
  checkers: Checkers,
  anon: Anon,
  t: PType,
): void {
  const visit = (t: PType): void => {
    if (checkers.has(t)) return;

    if (t instanceof PJson) {
      throw new Error(`JSON-like data is not supported by the go emitter: ${t}`);
    }
    if (t instanceof PString) {
      checkers.set(
        t,
        (v, path) =>
          `if typ := ${v}.ExportType(); typ != reflectTypeString {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: is of type %v, not string", ${path}, typ))\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PInt) {
      checkers.set(
        t,
        (v, path) =>
          `if typ := ${v}.ExportType(); typ != reflectTypeInt {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: is of type %v, not int", ${path}, typ))\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PBool) {
      checkers.set(
        t,
        (v, path) =>
          `if typ := ${v}.ExportType(); typ != reflectTypeBool {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: is of type %v, not bool", ${path}, typ))\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PNull || (t instanceof PLiteral && t.value === null)) {
      checkers.set(
        t,
        (v, path) =>
          `if typ := ${v}.ExportType(); typ != reflectTypeNil {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: is of type %v, not bool", ${path}, typ))\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PDate) {
      checkers.set(
        t,
        (v, path) =>
          `if strtime, ok := ${v}.Export().(string); !ok {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: not a string", ${path}))\n` +
          `} else if _, err := time.Parse("2006-01-02T15:04:05Z", strtime); err != nil {\n` +
          `\terrs = append(errs, fmt.Errorf("%v: not a valid timestamp: %w", ${path}, err))\n` +
          `}\n`,
      );
      return;
    }
    if (t instanceof PLiteral) {
      if (typeof t.value === 'string') {
        checkers.set(
          t,
          (v, path) =>
            `if lit, ok := ${v}.Export().(string); !ok || lit != "${t.value}" {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is not \\"${t.value}\\"", ${path}))\n` +
            `}\n`,
        );
      } else if (typeof t.value === 'boolean') {
        const goval = String(t.value);
        checkers.set(
          t,
          (v, path) =>
            `if lit, ok := ${v}.Export().(bool); !ok || lit != ${goval} {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is not ${goval}", ${path}))\n` +
            `}\n`,
        );
      } else {
        checkers.set(
          t,
          (v, path) =>
            `if lit, ok := ${v}.Export().(int64); !ok || lit != ${t.value} {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is not ${t.value}", ${path}))\n` +
            `}\n`,
        );
      }
      return;
    }

    let checker: Checker;
    if (t instanceof PArray) {
      visit(t.itemType);
      checker = (v, path) => {
        const dd = new Denter();
        dd.print(
          `if typ := ${v}.ExportType(); typ != reflectTypeArray {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is a %v, not json array", ${path}, typ))\n`,
        );
        if (checkers.get(t.itemType) !== NOOP) {
          dd.print(`} else {\n`);
          dd.indent('\t');
          dd.print(`i := 0\n`);
          dd.print(`err := vm.Try(func() {\n`);
          dd.indent('\t');
          dd.print(`vm.ForOf(${v}, func(item goja.Value) bool {\n`);
          dd.indent('\t');
          dd.print(`xpath := fmt.Sprintf("%s[%d]", ${path}, i)\n`);
          dd.print(`i++\n`);
          dd.print(checkers.get(t.itemType)!('item', 'xpath'));
          dd.print(`return true\n`);
          dd.dedent();
          dd.print(`})\n`);
          dd.dedent();
          dd.print(`})\n`);
          dd.print(`if err != nil {\n`);
          dd.print(`\terrs = append(errs, fmt.Errorf("%v: ForOf: %w", ${path}, err))\n`);
          dd.print(`}\n`);
          dd.dedent();
        }
        dd.print(`}\n`);
        return dd.getvalue();
      };
    } else if (t instanceof PTuple) {
      for (const it of t.itemTypes) visit(it);
      checker = (v, path) => {
        const dd = new Denter();
        const n = t.itemTypes.length;
        dd.print(
          `if typ := ${v}.ExportType(); typ != reflectTypeArray {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is a %v, not json array", ${path}, typ))\n`,
        );
        dd.print(`} else {\n`);
        dd.indent('\t');
        // a distinct name from the struct checker's `obj`, so an inlined tuple field does not
        // shadow it
        dd.print(`arr := ${v}.(*goja.Object)\n`);
        dd.print(`if length := arr.Get("length").ToInteger(); length != ${n} {\n`);
        dd.print(
          `\terrs = append(errs, fmt.Errorf("%v: expected ${n} items, not %v", ${path}, length))\n`,
        );
        dd.print(`} else {\n`);
        dd.indent('\t');
        // Go block scoping gives each element a fresh item/xpath, so nested tuples and arrays
        // can't shadow each other's variables
        t.itemTypes.forEach((it, i) => {
          dd.print('{\n');
          dd.indent('\t');
          dd.print(`item := arr.Get("${i}")\n`);
          dd.print(`xpath := ${path} + "[${i}]"\n`);
          dd.print(checkers.get(it)!('item', 'xpath'));
          dd.dedent();
          dd.print('}\n');
        });
        dd.dedent();
        dd.print(`}\n`);
        dd.dedent();
        dd.print(`}\n`);
        return dd.getvalue();
      };
    } else if (t instanceof PObject) {
      visit(t.valueType);
      checker = (v, path) => {
        const dd = new Denter();
        dd.print(
          `if typ := ${v}.ExportType(); typ != reflectTypeMap {\n` +
            `\terrs = append(errs, fmt.Errorf("%v: is a %v, not json object", ${path}, typ))\n`,
        );
        if (checkers.get(t.valueType) !== NOOP) {
          dd.print(`} else {\n`);
          dd.indent('\t');
          dd.print(`obj := ${v}.(*goja.Object)\n`);
          dd.print(`for _, key := range obj.Keys() {\n`);
          dd.indent('\t');
          dd.print(`val := obj.Get(key)\n`);
          dd.print(`xpath := ${path} + "." + key\n`);
          dd.print(checkers.get(t.valueType)!('val', 'xpath'));
          dd.dedent();
          dd.print(`}\n`);
          dd.dedent();
        }
        dd.print(`}\n`);
        return dd.getvalue();
      };
    } else if (t instanceof PUnion) {
      for (const ut of t.types) visit(ut);
      const solution = solveUnion(registry, t.types);
      const name = t.name ? `check${t.name}` : `check${getAnon(anon)}`;
      d.print(`\nfunc ${name}(vm *goja.Runtime, value goja.Value, path string) []error {\n`);
      d.indent('\t');
      d.print(`var errs []error\n`);
      checkSolution(d, checkers, solution);
      d.dedent();
      d.print(`}\n`);
      checker = (v, path) => `errs = append(errs, ${name}(vm, ${v}, ${path})...)\n`;
    } else if (t instanceof PStruct) {
      for (const ft of t.fields.values()) visit(ft);
      let keys: string, func: string;
      if (t.name) {
        keys = `${camel(t.name)}AllowedKeys`;
        func = `check${t.name}`;
      } else {
        const a = getAnon(anon);
        keys = `${a}AllowedKeys`;
        func = `check${a}`;
      }
      d.print(`\nvar ${keys} = map[string]bool{\n`);
      d.indent('\t');
      // pad the keys so the values align, as gofmt would have it
      const width = Math.max(...[...t.fields.keys()].map((fn) => fn.length));
      for (const fn of t.fields.keys()) {
        d.print(`"${fn}":${' '.repeat(width - fn.length + 1)}true,\n`);
      }
      d.dedent();
      d.print(`}\n`);
      d.print(`\nfunc ${func}(vm *goja.Runtime, value goja.Value, path string) []error {\n`);
      d.indent('\t');
      d.print(`var errs []error\n`);
      d.print(`obj, ok := value.(*goja.Object)\n`);
      d.print(`if !ok {\n`);
      d.indent('\t');
      d.print(
        `errs = append(errs,` +
          ` fmt.Errorf("%v: is a %v, not a json object", path, value.ExportType())` +
          `)\n`,
      );
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      for (const [fn, ft] of t.fields) {
        d.print(`if field := obj.Get("${fn}"); field != nil {\n`);
        d.indent('\t');
        d.print(`xpath := path + ".${fn}"\n`);
        d.print(checkers.get(ft)!('field', 'xpath'));
        d.dedent();
        if (t.maybes.has(fn)) {
          d.print(`}\n`);
        } else {
          d.print(`} else {\n`);
          d.indent('\t');
          d.print(`errs = append(errs, fmt.Errorf("%v: missing required field", path))\n`);
          d.dedent();
          d.print(`}\n`);
        }
      }
      d.print(`for _, key := range obj.Keys() {\n`);
      d.indent('\t');
      d.print(`if ${keys}[key] {\n`);
      d.print(`\tcontinue\n`);
      d.print(`}\n`);
      d.print(`\n`);
      d.print(`errs = append(errs, fmt.Errorf("%v: contains extra keys", path))\n`);
      d.dedent();
      d.print(`}\n`);
      d.print(`return errs\n`);
      d.dedent();
      d.print(`}\n`);
      checker = (v, path) => `errs = append(errs, ${func}(vm, ${v}, ${path})...)\n`;
    } else {
      throw new Error(`unhandled type in generateCheckers: ${t}`);
    }

    // named types get a wrapper function that calls errors.Join() on the list of errors
    if (t.name) {
      d.print(`\nfunc Check${t.name}(vm *goja.Runtime, value goja.Value, path string) error {\n`);
      d.indent('\t');
      d.print(`var errs []error\n`);
      d.print(checker('value', 'path'));
      d.print(`return errors.Join(errs...)\n`);
      d.dedent();
      d.print(`}\n`);
    }
    checkers.set(t, checker);
  };
  visit(t);
}

// stores and engines

function contextName(name: string): string {
  return pascal(name.endsWith('Store') ? name.slice(0, -5) : name);
}

function generateStore(d: Denter, annos: Annos, converters: Converters, store: PStore): void {
  const iface = contextName(store.name!) + 'QueryContext';
  const impl = camel(iface);
  const byName = <T extends { name: string }>(a: T, b: T) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

  d.print(`\ntype ${iface} interface {\n`);
  d.indent('\t');
  d.print(`QueryContext\n`);
  for (const dep of store.deps) d.print(`${contextName(dep.name!)}QueryContext\n`);
  const originalItems = [...store.originalItems].sort(byName);
  for (const si of originalItems) {
    d.print(`${pascal(si.name)}(`);
    if (si.params.length) d.print(si.params.map(camel).join(', ') + ' string');
    d.print(`) ${annos.get(si.type)}\n`);
  }
  d.dedent();
  d.print(`}\n`);

  d.print(`\ntype ${impl} struct {\n`);
  d.indent('\t');
  d.print(`vm   *goja.Runtime\n`);
  d.print(`jsqx goja.Value\n`);
  d.print(`ask  Ask\n`);
  d.dedent();
  d.print(`}\n`);

  d.print(`\nfunc New${iface}(vm *goja.Runtime, jsqx goja.Value, ask Ask) ${iface} {\n`);
  d.indent('\t');
  d.print(`return &${impl}{vm, jsqx, ask}\n`);
  d.dedent();
  d.print(`}\n`);

  d.print(`\nfunc (qx *${impl}) Ask(question goja.Value) goja.Value {\n`);
  d.indent('\t');
  d.print(`return qx.ask(question)\n`);
  d.dedent();
  d.print(`}\n`);

  for (const si of [...store.items].sort(byName)) {
    d.print(`\nfunc (qx *${impl}) ${pascal(si.name)}(`);
    if (si.params.length) d.print(si.params.map(camel).join(', ') + ' string');
    d.print(`) ${annos.get(si.type)} {\n`);
    d.indent('\t');
    d.print(`vm := qx.vm\n`);
    d.print(`value := queryAsk(vm, qx.jsqx, qx.ask, "${si.name}"`);
    for (const p of si.params) d.print(`, ${camel(p)}`);
    d.print(`)\n`);
    d.print(`out := ${converters.get(si.type)!('value')}\n`);
    d.print(`return out\n`);
    d.dedent();
    d.print(`}\n`);
  }
}

function engineName(name: string): string {
  return pascal(name.endsWith('Engine') ? name : name + 'Engine');
}

function generateEngine(d: Denter, annos: Annos, f: PEngine): void {
  const name = engineName(f.name!);
  const QX = contextName(f.store.name!) + 'QueryContext';
  const E = annos.get(f.eventType);
  const C = annos.get(f.commandType);

  d.print(`\ntype ${name} = Engine[${QX}, ${E}, ${C}]\n`);
  d.print(`\nfunc New${name}(\n`);
  d.indent('\t');
  d.print(`script string,\n`);
  d.print(`store Store,\n`);
  d.print(`migrate string,\n`);
  d.print(`reducer string,\n`);
  d.dedent();
  d.print(`) (*${name}, error) {\n`);
  d.indent('\t');
  d.print(`return NewEngine[${QX}, ${E}, ${C}](\n`);
  d.indent('\t');
  d.print(`NewStringSource("bundle.js", script),\n`);
  d.print(`"${name}",\n`);
  d.print(`store,\n`);
  d.print(`migrate,\n`);
  d.print(`reducer,\n`);
  d.print(`New${QX},\n`);
  d.dedent();
  d.print(`)\n`);
  d.dedent();
  d.print(`}\n`);
}

/** entrypoint: assemble the complete generated module */
export function generateGo(lowered: LoweredProgram, skeleton: string, pkg: string): string {
  const { registry, roots, stores, engines } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  const imports = new Set<string>([
    'crypto/rand',
    'encoding/json',
    'errors',
    'fmt',
    'iter',
    'os',
    'reflect',
    'slices',
    'strconv',
    'strings',
    'unsafe',
    'github.com/dop251/goja',
    'github.com/romshark/jscan',
  ]);
  const sub = new Denter();

  const typesToVisit = [
    ...roots,
    ...stores.flatMap((s) => s.items.map((si) => si.type)),
    ...engines.flatMap((f) => f.store.items.map((si) => si.type)),
  ];

  const annos: Annos = new Map();
  const converters: Converters = new Map();
  const anon: Anon = { n: 0 };
  for (const t of typesToVisit) generateTypes(sub, imports, registry, annos, converters, anon, t);

  const checkers: Checkers = new Map();
  for (const t of typesToVisit) generateCheckers(sub, registry, annos, checkers, anon, t);

  for (const s of stores) generateStore(sub, annos, converters, s);
  for (const e of engines) generateEngine(sub, annos, e);

  const d = new Denter();
  d.print(`// Code generated by @phaselock/typespec-go. DO NOT EDIT.\n`);
  d.print(`\n`);
  d.print(`package ${pkg}\n`);
  d.print('\nimport (\n');
  d.indent('\t');
  const sorted = [...imports].sort();
  for (const imprt of sorted) if (!imprt.includes('.')) d.print(`"${imprt}"\n`);
  d.print('\n');
  for (const imprt of sorted) if (imprt.includes('.')) d.print(`"${imprt}"\n`);
  d.dedent();
  d.print(')\n');
  d.print('\n');
  d.print('var (\n');
  d.indent('\t');
  d.print('reflectTypeInt    = reflect.TypeOf(int64(0))\n');
  d.print('reflectTypeBool   = reflect.TypeOf(false)\n');
  d.print('reflectTypeMap    = reflect.TypeOf(map[string]any{})\n');
  d.print('reflectTypeArray  = reflect.TypeOf([]any{})\n');
  d.print('reflectTypeString = reflect.TypeOf("")\n');
  d.print('reflectTypeNil    = reflect.TypeOf(nil)\n');
  d.print('reflectTypeFloat  = reflect.TypeOf(float64(0))\n');
  d.print('\n');
  d.print('// return types we do not expect to appear in a valid protos-based type:\n');
  d.print('// reflectTypeArrayPtr = reflect.TypeOf((*[]any)(nil))\n');
  d.print('// reflectTypeFunc     = reflect.TypeOf((func(FunctionCall) Value)(nil))\n');
  d.print('// reflectTypeCtor     = reflect.TypeOf((func(ConstructorCall) *Object)(nil))\n');
  d.print('// reflectTypeError    = reflect.TypeOf((*error)(nil)).Elem()\n');
  d.dedent();
  d.print(')\n');
  d.print('\n');

  d.print(skeleton);
  d.print(sub.getvalue());

  return d.getvalue();
}
