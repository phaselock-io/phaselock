/**
 * TypeScript code generator: emits type aliases for the model's types; the type registry as
 * data, one node table with a schema per engine and per database; each slice's reducer context
 * and handler table; each engine's read context, forecaster table, and Engine class; each
 * database's read context, precommit table, and bundle definition; and the typed query layers,
 * all from the lowered IR.
 *
 * Names derive from the declarations the user wrote: `PatronSlice` gives `PatronSliceTxn` and
 * `PatronSliceReducers`, `UserEngine` gives `UserEngineTxn`, `userEngineSchema`, and the
 * `UserEngine` class, and a handler table's keys are its event or command model names,
 * camelCased.
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

// the type registry ////////////////////////////////////////////////////////

/* The registry is data: a table of nodes, each type once, referring to each other by index,
   with the union solver's decision tree inside each union node; and for each engine and
   database a Schema naming that table, the identities a Registry answers for, and its commands,
   eventTypes, and storeTypes.  Hosts walk it to convert values. */

/** the type identities a Schema answers for, each to its type */
type Identities = Map<string, PType>;

/** the node table being built: each type's index, in visiting order */
class NodeTable {
  readonly index = new Map<PType, number>();
  readonly order: PType[] = [];
  // each union's solution, and the key each struct writes first: the field a union tells it
  // apart from its other members by, the first union to name one winning
  readonly #solutions = new Map<PUnion, Solution>();
  readonly #discriminators = new Map<PType, string>();

  constructor(private readonly registry: PTypeRegistry) {}

  /** the index of a type's node, visiting its children first; a result is its base's node */
  visit(t: PType): number {
    if (t instanceof PResult) return this.visit(t.base);
    const seen = this.index.get(t);
    if (seen !== undefined) return seen;
    const i = this.order.length;
    this.index.set(t, i);
    this.order.push(t);
    if (t instanceof PStruct) for (const ft of t.fields.values()) this.visit(ft);
    else if (t instanceof PObject) this.visit(t.valueType);
    else if (t instanceof PArray) this.visit(t.itemType);
    else if (t instanceof PTuple) for (const it of t.itemTypes) this.visit(it);
    else if (t instanceof PUnion) for (const ut of t.types) this.visit(ut);
    else if (t instanceof PIntake) this.visit(t.wire);
    return i;
  }

  /** solve every union in the table, and learn the discriminator of each struct a `field` test
      tells apart */
  learn(): void {
    const visit = (sln: Solution, key: string | null): void => {
      if (sln instanceof Match) {
        if (key !== null && !this.#discriminators.has(sln.typ)) {
          this.#discriminators.set(sln.typ, key);
        }
      } else if (sln instanceof CheckJsonType || sln instanceof CheckLiteral) {
        for (const sub of sln.options.values()) visit(sub, key);
      } else if (sln instanceof CheckLength) {
        for (const sub of sln.options.values()) visit(sub, key);
        if (sln.default !== null) visit(sln.default, key);
      } else if (sln instanceof GetIndex) {
        visit(sln.solution, null);
      } else if (sln instanceof GetField) {
        visit(sln.solution, key ?? sln.key);
      } else if (sln instanceof HasField) {
        for (const [, sub] of sln.solutions) visit(sub, key);
      }
    };
    for (const t of this.order) {
      if (!(t instanceof PUnion)) continue;
      const sln = solveUnion(this.registry, t.types);
      this.#solutions.set(t, sln);
      visit(sln, null);
    }
  }

  /** a solution as data */
  solution(sln: Solution): string {
    if (sln instanceof Match) return `["match", ${this.visit(sln.typ)}]`;
    if (sln instanceof CheckJsonType) {
      const opts = [...sln.options].map(
        ([jt, sub]) => `[${JSON.stringify(jt)}, ${this.solution(sub)}]`,
      );
      return `["jsontype", [${opts.join(', ')}]]`;
    }
    if (sln instanceof CheckLiteral) {
      const opts = [...sln.options].map(
        ([lit, sub]) => `[${JSON.stringify(lit)}, ${this.solution(sub)}]`,
      );
      return `["literal", [${opts.join(', ')}]]`;
    }
    if (sln instanceof CheckLength) {
      const opts = [...sln.options].map(([n, sub]) => `[${n}, ${this.solution(sub)}]`);
      const dflt = sln.default === null ? 'null' : this.solution(sln.default);
      return `["length", [${opts.join(', ')}], ${dflt}]`;
    }
    if (sln instanceof GetIndex) return `["index", ${sln.i}, ${this.solution(sln.solution)}]`;
    if (sln instanceof GetField) {
      return `["field", ${JSON.stringify(sln.key)}, ${this.solution(sln.solution)}]`;
    }
    if (sln instanceof HasField) {
      const opts = sln.solutions.map(([k, sub]) => `[${JSON.stringify(k)}, ${this.solution(sub)}]`);
      return `["hasfield", [${opts.join(', ')}]]`;
    }
    throw new Error(`unrecognized solution type: ${(sln as Solution).constructor.name}`);
  }

  /** one node as data; children were visited when the type was */
  node(t: PType): string {
    const name = JSON.stringify(t.name);
    const at = (c: PType) => this.index.get(c instanceof PResult ? c.base : c)!;
    if (t instanceof PNull) return '["null"]';
    if (t instanceof PInt) return '["int"]';
    if (t instanceof PString) return '["str"]';
    if (t instanceof PBool) return '["bool"]';
    if (t instanceof PDate) return '["date"]';
    if (t instanceof PJson) return '["json"]';
    if (t instanceof PLiteral) return `["lit", ${JSON.stringify(t.value)}]`;
    if (t instanceof PStruct) {
      const fields = [...t.fields].map(
        ([k, ft]) => `[${JSON.stringify(k)}, ${at(ft)}, ${t.maybes.has(k)}]`,
      );
      const key = this.#discriminators.get(t);
      const disc = key === undefined ? -1 : [...t.fields.keys()].indexOf(key);
      return `["struct", ${name}, [${fields.join(', ')}], ${disc}]`;
    }
    if (t instanceof PObject) return `["record", ${name}, ${at(t.valueType)}]`;
    if (t instanceof PArray) return `["array", ${name}, ${at(t.itemType)}]`;
    if (t instanceof PTuple) return `["tuple", ${name}, [${t.itemTypes.map(at).join(', ')}]]`;
    if (t instanceof PUnion) {
      return `["union", ${name}, ${this.solution(this.#solutions.get(t)!)}]`;
    }
    if (t instanceof PIntake) return `["intake", ${JSON.stringify(t.kind)}, ${at(t.wire)}]`;
    throw new Error(`unhandled type in the registry: ${t.constructor.name}`);
  }
}

/** the type identity of a type: its name, or a result's vocabulary name */
function identityOf(t: PType): string {
  if (t instanceof PResult) return t.kind;
  if (t.name === null) throw new Error(`a type with no identity: ${t}`);
  return t.name;
}

/** the identities of an engine's or a database's slices and commands: the events union of
    each family, the type of each key template, and the commands union */
function audienceIdentities(
  ids: Identities,
  slices: readonly PSlice[],
  commandType: PType | undefined,
): {
  commands: string | null;
  eventTypes: Record<string, string>;
  storeTypes: Record<string, string>;
} {
  const eventTypes: Record<string, string> = {};
  const storeTypes: Record<string, string> = {};
  for (const slice of slices) {
    eventTypes[slice.family] = identityOf(slice.events);
    ids.set(eventTypes[slice.family], slice.events);
    for (const item of slice.store.items) {
      const id = storeTypeName(slice, item);
      storeTypes[`${slice.family}/${item.name}`] = id;
      ids.set(id, item.type);
    }
  }
  let commands: string | null = null;
  if (commandType !== undefined) {
    commands = identityOf(commandType);
    ids.set(commands, commandType);
  }
  return { commands, eventTypes, storeTypes };
}

/** the node table, the identity map, and a Schema per engine and per database */
function generateSchema(
  d: Denter,
  registry: PTypeRegistry,
  roots: readonly PType[],
  engines: readonly PEngine[],
  databases: readonly PDatabase[],
  commandUnions: Map<PDatabase, PType>,
  queries: readonly PQueries[],
): void {
  const ids: Identities = new Map();
  for (const t of roots) ids.set(identityOf(t), t);

  // each audience's own identities
  const audiences: [string, ReturnType<typeof audienceIdentities>][] = [];
  for (const e of engines) {
    audiences.push([e.name, audienceIdentities(ids, e.slices, e.commandType)]);
  }
  for (const db of databases) {
    audiences.push([db.name, audienceIdentities(ids, db.slices, commandUnions.get(db))]);
  }

  // every query's wire type, and each result under the query's id plus #result
  for (const kq of queries) {
    if (!kq.queries.length) continue;
    const wire = queryWireType(registry, kq);
    ids.set(identityOf(wire), wire);
    for (const q of kq.queries) ids.set(`${queryId(kq, q)}#result`, q.result);
  }

  // the table, in identity order
  const table = new NodeTable(registry);
  for (const t of ids.values()) table.visit(t);
  table.learn();

  d.print('\n// the type registry: one node table, and the schema of each engine and database\n');
  d.print('const schemaNodes: SchemaNode[] = [\n');
  d.indent('  ');
  for (const t of table.order) d.print(`${table.node(t)},\n`);
  d.dedent();
  d.print('];\n');
  d.print('const schemaIds: Record<string, number> = {\n');
  d.indent('  ');
  for (const [id, t] of ids) d.print(`${JSON.stringify(id)}: ${table.visit(t)},\n`);
  d.dedent();
  d.print('};\n');
  for (const [name, a] of audiences) {
    d.print(`\n/** the registry data of ${name} */\n`);
    d.print(`export const ${lowerFirst(name)}Schema: Schema = {\n`);
    d.indent('  ');
    d.print('nodes: schemaNodes,\n');
    d.print('ids: schemaIds,\n');
    d.print(`commands: ${JSON.stringify(a.commands)},\n`);
    d.print(`eventTypes: ${JSON.stringify(a.eventTypes)},\n`);
    d.print(`storeTypes: ${JSON.stringify(a.storeTypes)},\n`);
    d.dedent();
    d.print('};\n');
  }
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

/** the stream label of an event folded by these slices: the union of their stream patterns */
function streamLabel(slices: readonly PSlice[]): string {
  const labels = new Set(slices.map(streamPattern));
  if (labels.size === 0) return 'string';
  return [...labels].join(' | ');
}

/** A slice's stream names as a type: a singleton's literal name, or its family template as a
    template literal type with a string for each parameter, as in `patron:${string}`.  The type
    checks the family and the separators; the parameters' characters are the database's to check. */
function streamPattern(slice: PSlice): string {
  if (slice.params.length === 0) return JSON.stringify(slice.family);
  return '`' + slice.family + ':' + slice.params.map(() => '${string}').join(',') + '`';
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

/** a template as the text of a template literal, each parameter interpolated through its check: a
    terminal parameter of a family template as the rest of a stream name, a terminal parameter of a
    key template as is, and every other parameter as a segment */
function checkedText(accessor: string, tpl: string, family: boolean): string {
  const [chunks, params] = PStoreItem.parseTpl(tpl);
  let out = chunks[0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const args = `${p}, ${JSON.stringify(accessor)}, ${JSON.stringify(p)}`;
    let value = `asSegment(${args})`;
    if (i === params.length - 1) value = family ? `asStreamRest(${args})` : p;
    out += '${' + value + '}' + chunks[i + 1];
  }
  return out;
}

/** the accessors over a slice's keys, local for its reducer, or global for any other context */
function accessors(annos: Annos, slice: PSlice, global: boolean): Accessor[] {
  return slice.store.items.map((item) => ({
    name: item.name,
    params: global ? [...slice.params, ...item.params] : item.params,
    key:
      (global ? `${checkedText(item.name, slice.template, true)}!` : '') +
      checkedText(item.name, item.tpl, false),
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

/** a scan accessor: its name, the parameters that vary in its context, its value's annotation, and
    its template as the skeleton's ScanTemplate, in source */
type Scanner = { name: string; params: readonly string[]; anno: string; template: string };

/** the scan accessors over a slice's keys, local for its reducer, or global for any other context:
    one per key template with a parameter that varies there, since any other names one key */
function scanners(annos: Annos, slice: PSlice, global: boolean): Scanner[] {
  return slice.store.items.flatMap((item) => {
    const params = global ? [...slice.params, ...item.params] : item.params;
    if (params.length === 0) return [];
    const template = {
      accessor: item.name,
      family: slice.family,
      stream: global ? slice.params : [],
      name: item.name,
      local: item.params,
      type: storeTypeName(slice, item),
    };
    return [
      { name: item.name, params, anno: annos.get(item.type)!, template: JSON.stringify(template) },
    ];
  });
}

/** a scan accessor's type arguments: the parameters that vary, as a union, and its value */
function scanTypeArgs(s: Scanner): string {
  return `${s.params.map((p) => JSON.stringify(p)).join(' | ')}, ${s.anno}`;
}

/** the members of a context's scan accessors, as a type */
function printScanTypes(d: Denter, list: Scanner[]): void {
  for (const s of list) d.print(`${prop(s.name)}: ScanAccessor<${scanTypeArgs(s)}>;\n`);
}

/** the members of a context's scan accessors, walking through $txn with the skeleton's global or
    local scan */
function printScans(d: Denter, list: Scanner[], global: boolean): void {
  const make = global ? 'globalScan' : 'localScan';
  for (const s of list) {
    d.print(`${prop(s.name)}: ${make}<${scanTypeArgs(s)}>($txn, ${s.template}),\n`);
  }
}

/** a slice's reducer context type and factory, its handler table type, and its SliceReducer */
function generateSlice(d: Denter, annos: Annos, registry: PTypeRegistry, slice: PSlice): void {
  const base = slice.name;
  const txnType = `${base}Txn`;
  const local = accessors(annos, slice, false);
  const localScans = scanners(annos, slice, false);
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
  d.print('};\nscan: {\n');
  d.indent('  ');
  printScanTypes(d, localScans);
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
    d.print(
      '/** apply fn to the value at a key in place and set it, answering what fn returns; an\n',
    );
    d.print(
      '    absent key throws, as a reducer does whenever the state is not what its event implies */\n',
    );
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
  d.print('},\nscan: {\n');
  d.indent('  ');
  printScans(d, localScans, false);
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

  // the stream's parameters, parsed from its name: after the family and its ':', separated by
  // ',', which no parameter holds
  const skip = slice.family.length + 1;
  const n = slice.params.length;
  let parsed: string;
  if (n === 0) {
    parsed = '{}';
  } else if (n === 1) {
    parsed = `{ ${slice.params[0]}: stream.slice(${skip}) }`;
  } else {
    parsed = `{ ${slice.params.map((p, i) => `${p}: parts[${i}]`).join(', ')} }`;
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
  if (n > 1) d.print(`const parts = stream.slice(${skip}).split(",");\n`);
  d.print(`const txn = ${lowerFirst(base)}Txn($txn, ${parsed});\n`);
  d.print(`for (const event of events) ${reduce}(handlers, txn, pending, event);\n`);
  d.dedent();
  d.print('},\n');
  d.print(`template: ${JSON.stringify(slice.template)},\n`);
  d.print(`keys: ${JSON.stringify(slice.store.items.map((item) => item.tpl))},\n`);
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
  d.print(`\nfunction ${lowerFirst(base)}Scan($txn: ReadTxn) {\n`);
  d.indent('  ');
  d.print('return {\n');
  d.indent('  ');
  printScans(d, scanners(annos, slice, true), true);
  d.dedent();
  d.print('};\n');
  d.dedent();
  d.print('}\n');
}

/** a global context's type and its factory over a read transaction, with the Engine's status
    when the context is a query's */
function generateGlobalContext(
  d: Denter,
  annos: Annos,
  type: string,
  doc: string,
  slices: readonly PSlice[],
  status = false,
): void {
  d.print(`\n/** ${doc} */\n`);
  d.print(`export type ${type} = {\n`);
  d.indent('  ');
  d.print('get: {\n');
  d.indent('  ');
  for (const slice of slices) printGetTypes(d, accessors(annos, slice, true));
  d.dedent();
  d.print('};\nscan: {\n');
  d.indent('  ');
  for (const slice of slices) printScanTypes(d, scanners(annos, slice, true));
  d.dedent();
  d.print('};\n');
  if (status) d.print('status: EngineStatus;\n');
  d.dedent();
  d.print('};\n');

  const gets = slices.map((s) => `...${lowerFirst(s.name)}Get($txn)`).join(', ');
  const scans = slices.map((s) => `...${lowerFirst(s.name)}Scan($txn)`).join(', ');
  const members = [`get: { ${gets} }`, `scan: { ${scans} }`];
  if (status) members.push('status: engineStatus($txn)');
  d.print(`\nexport function ${lowerFirst(type)}($txn: ReadTxn): ${type} {\n`);
  d.print(`  return { ${members.join(', ')} };\n`);
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
  const queryTxnType = `${e.name}QueryTxn`;
  const tableType = `${e.name}Forecasters`;
  const offline = e.commands.filter((c) => !c.online);
  const online = e.commands.filter((c) => c.online);
  const anno = (c: PCommand) => annos.get(c.type)!;

  // the read context of its forecasts, and of its queries, which also read the Engine's status
  const doc = `${e.name}'s read context: what its forecasts read, over its slices`;
  generateGlobalContext(d, annos, txnType, doc, e.slices);
  const queryDoc =
    `${e.name}'s query context: what its queries read, over its slices, ` +
    "and the Engine's status";
  generateGlobalContext(d, annos, queryTxnType, queryDoc, e.slices, true);

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

  // the commands sendCommand takes, and those sendOnlineCommand takes
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
  const wants = e.slices.map((s) => (s.params.length === 0 ? s.family : `${s.family}:*`));
  const names = e.slices.map((s) => s.name).join(', ');
  d.print(`
/** the Engine of ${e.name}, syncing ${names} */
export class ${e.name} extends Engine<${queryTxnType}, ${txnType}, ${C}, ${N}> {
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
      signal?: Signal;
      // optional: receives the error that ended the Engine
      onError?: (e: unknown) => void;
    },
  ) {
    const forecasters = callbacks.forecasters;
    super(${lowerFirst(queryTxnType)}, ${lowerFirst(txnType)}, store, reg, connect, {
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
  generateGlobalContext(d, annos, txnType, doc, db.slices);

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

  // the bundle, over the generated wrappers
  d.print(`
/** Install ${db.name}'s bundle as globalThis.__bundle, the app's slots behind the generated
    wrappers, and answer it. */
export function define${db.name}(slots: ${slotsType}): Bundle {
  const bootstrap = slots.bootstrap;
  const bundle: Bundle = {
    schema: ${lowerFirst(db.name)}Schema,
    precommit: (txn, data, principal) =>
      ${precommit}(slots.precommit, principal, ${lowerFirst(db.name)}Txn(txn), data),
    reducers: ${reducersValue(db.slices, 'slots.reducers')},
    maySee: (txn, principal) => slots.maySee(${lowerFirst(db.name)}Txn(txn), principal),
    lookup: (txn, ident) => slots.lookup(${lowerFirst(db.name)}Txn(txn), ident),
    bootstrap: bootstrap === undefined ? undefined : (ctx) => bootstrap(ctx as ${ctxType}),
    dev: DEV,
    mapStack,
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
function generateQueries(d: Denter, annos: Annos, kq: PQueries): void {
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

  // remote provider: the call goes through the Registry under the wire type, and each result
  // under the query's id
  d.print(`\nexport class Remote${name} extends RemoteQueries implements ${name} {\n`);
  d.indent('  ');
  for (const q of kq.queries) {
    const call = [
      `${idsName}.${q.name}`,
      ...q.args.map(([an, , opt]) => `${an}${opt ? ' ?? null' : ''}`),
    ];
    d.print(`${q.name}(${params(q)}): Query<${result(q)}> {\n`);
    d.print(
      `  return this.newQuery(${JSON.stringify(`${stem}Query`)}, [${call.join(', ')}], ${idsName}.${q.name});\n`,
    );
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

  // Queries need their wire message type (which carries the arg types inside it) and their
  // result types.
  for (const kq of queries) {
    if (!kq.queries.length) continue;
    typesToVisit.push(queryWireType(registry, kq));
    for (const q of kq.queries) typesToVisit.push(q.result);
  }

  // Define types and decide on type annotations.
  const annos: Annos = new Map();
  for (const t of typesToVisit) generateAnnotations(d, annos, t);

  // The type registry, which every host converts by.
  generateSchema(d, registry, roots, engines, databases, commandUnions, queries);

  // Generate each command's output type and intake view
  for (const c of commands) generateCommandTypes(d, annos, c);

  // Generate slices, engines, and databases
  for (const s of slices) generateSlice(d, annos, registry, s);
  for (const e of engines) generateEngine(d, annos, registry, e);
  for (const db of databases) generateDatabase(d, annos, registry, db, commandUnions.get(db));

  // Generate query layers
  for (const kq of queries) generateQueries(d, annos, kq);

  // the generated file ends with a trailing newline
  return d.getvalue() + '\n';
}
