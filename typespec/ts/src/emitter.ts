/**
 * TypeScript code generator: emits type aliases for the model's types; the type registry as
 * data, one node table with a schema per engine and per database; each slice's accessor
 * fragments, which its contexts are assembled from; each engine's contexts, predictor table, and
 * Engine class; each database's contexts, grantor and decider types, and bundle definition; and
 * the typed query layers, all from the lowered IR.
 *
 * Names derive from the declarations the user wrote: `PatronSlice` gives `patronSliceGet`,
 * `UserEngine` gives `UserEngineTxn`, `UserEnginePredictors`, `userEngineSchema`, and the
 * `UserEngine` class, `LibraryDB` gives `LibraryDBTxn`, `LibraryDBDeciders`, and
 * `defineLibraryDB`, and a handler table's keys are its mutation model names, camelCased.
 */

import {
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  Denter,
  GetField,
  GetIndex,
  HasField,
  type LoweredProgram,
  Match,
  PArray,
  PBool,
  type PDatabase,
  PDate,
  type PEngine,
  PInt,
  PIntake,
  PJson,
  PLiteral,
  type PMutation,
  PNull,
  PObject,
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
  type Solution,
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
   database a Schema naming that table, the identities a Registry answers for, and its mutations
   union.  Hosts walk it to convert values. */

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
  private readonly registry: PTypeRegistry;

  constructor(registry: PTypeRegistry) {
    this.registry = registry;
  }

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

/** the identities of an engine's or a database's slices and mutations, the type of each key
    template and the mutations union, answering the mutations union's */
function audienceIdentities(
  ids: Identities,
  slices: readonly PSlice[],
  mutationType: PType | undefined,
): string | null {
  for (const slice of slices) {
    for (const item of slice.store.items) ids.set(storeTypeName(slice, item), item.type);
  }
  if (mutationType === undefined) return null;
  const mutations = identityOf(mutationType);
  ids.set(mutations, mutationType);
  return mutations;
}

/** the node table, the identity map, and a Schema per engine and per database */
function generateSchema(
  d: Denter,
  registry: PTypeRegistry,
  roots: readonly PType[],
  engines: readonly PEngine[],
  databases: readonly PDatabase[],
  mutationUnions: Map<PDatabase, PType>,
  queries: readonly PQueries[],
): void {
  const ids: Identities = new Map();
  for (const t of roots) ids.set(identityOf(t), t);

  // each audience's own identities
  const audiences: [string, string | null][] = [];
  for (const e of engines) {
    audiences.push([e.name, audienceIdentities(ids, e.slices, e.mutationType)]);
  }
  for (const db of databases) {
    audiences.push([db.name, audienceIdentities(ids, db.slices, mutationUnions.get(db))]);
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
  for (const [name, mutations] of audiences) {
    d.print(`\n/** the registry data of ${name} */\n`);
    d.print(`export const ${lowerFirst(name)}Schema: Schema = {\n`);
    d.indent('  ');
    d.print('nodes: schemaNodes,\n');
    d.print('ids: schemaIds,\n');
    d.print(`mutations: ${JSON.stringify(mutations)},\n`);
    d.dedent();
    d.print('};\n');
  }
}

/**
 * isUpdatable returns if a type is suitable for a txn.update member.
 *
 * The txn.update pattern is to accept a function which updates its parameter in place.
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

// mutations /////////////////////////////////////////////////////////////////

/** a mutation's fields that intake transforms */
function intakeFields(m: PMutation): [string, PIntake][] {
  if (!(m.type instanceof PStruct)) return [];
  return [...m.type.fields].filter((f): f is [string, PIntake] => f[1] instanceof PIntake);
}

/** the type a decider sees a mutation as: its intake view when intake transforms it */
function deciderView(annos: Annos, m: PMutation): string {
  return intakeFields(m).length > 0 ? `${m.name}ForDecider` : annos.get(m.type)!;
}

/** a mutation as the database prepares it for its decider, when intake transforms it */
function generateMutationTypes(d: Denter, annos: Annos, m: PMutation): void {
  // the intake view: each intake field becomes its result
  if (intakeFields(m).length === 0) return;
  const struct = m.type as PStruct;
  const fields = [...struct.fields].map(([k, ft]) => {
    const anno = ft instanceof PIntake ? annos.get(ft.result)! : annos.get(ft)!;
    return k + (struct.maybes.has(k) ? '?' : '') + ': ' + anno;
  });
  d.print(`\n/** ${m.name} as the database prepares it for its decider */\n`);
  d.print(`export type ${m.name}ForDecider = {${fields.join(', ')}};\n`);
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

/* A context has accessors over keys across slices: each takes its slice's family parameters and
   then its local template's, and is named for its key template's name, which validation keeps
   unique across the slices of a context.  Its deleteSlice accessors take a family's parameters,
   and are named for the family, which validation keeps unique too.  Every context of an engine or
   a database is assembled from the same per-slice fragments, so a database's context is
   assignable to each of its engines', writes included. */

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
    terminal parameter of a family template as the rest of a slice name, a terminal parameter of a
    key template as is, and every other parameter as a segment */
function checkedText(accessor: string, tpl: string, family: boolean): string {
  const [chunks, params] = PStoreItem.parseTpl(tpl);
  let out = chunks[0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    const args = `${p}, ${JSON.stringify(accessor)}, ${JSON.stringify(p)}`;
    let value = `$asSegment(${args})`;
    if (i === params.length - 1) value = family ? `$asSliceRest(${args})` : p;
    out += '${' + value + '}' + chunks[i + 1];
  }
  return out;
}

/** the accessors over a slice's keys */
function accessors(annos: Annos, slice: PSlice): Accessor[] {
  return slice.store.items.map((item) => ({
    name: item.name,
    params: [...slice.params, ...item.params],
    key: `${checkedText(item.name, slice.template, true)}!${checkedText(item.name, item.tpl, false)}`,
    anno: annos.get(item.type)!,
    type: storeTypeName(slice, item),
    updatable: isUpdatable(item.type),
  }));
}

/** a slice's deleteSlice accessor, named for its family, naming the slice itself */
function sliceAccessor(slice: PSlice): { name: string; params: readonly string[]; key: string } {
  return {
    name: slice.family,
    params: slice.params,
    key: checkedText(slice.family, slice.template, true),
  };
}

/** the name an accessor's own argument takes, apart from its params */
function own(a: { params: readonly string[] }, name: string): string {
  return a.params.includes(name) ? `$${name}` : name;
}

/** an accessor's parameter list, then any arguments of its own as [name, annotation], a name
    ending in `?` being optional */
function args(a: { params: readonly string[] }, ...extra: [string, string][]): string {
  const params = a.params.map((p) => `${p}: string`);
  const owns = extra.map(([n, t]) => {
    const optional = n.endsWith('?');
    return `${own(a, optional ? n.slice(0, -1) : n)}${optional ? '?' : ''}: ${t}`;
  });
  return [...params, ...owns].join(', ');
}

/** a scan accessor: its name, the parameters that vary, its value's annotation, and its template
    as the skeleton's ScanTemplate, in source */
type Scanner = { name: string; params: readonly string[]; anno: string; template: string };

/** the scan accessors over a slice's keys: one per key template with a parameter, since any other
    names one key */
function scanners(annos: Annos, slice: PSlice): Scanner[] {
  return slice.store.items.flatMap((item) => {
    const params = [...slice.params, ...item.params];
    if (params.length === 0) return [];
    const template = {
      accessor: item.name,
      family: slice.family,
      slice: slice.params,
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

/** print one group of a context type: its opening line, its members, and its closing line */
function printGroup(d: Denter, open: string, close: string, members: () => void): void {
  d.print(open);
  d.indent('  ');
  members();
  d.dedent();
  d.print(close);
}

/** Print a fragment: a function of a box that answers one group's accessors, which read or write
    through the transaction the box holds when each is called.  The box is `$ref`, a name no
    template parameter can take, since a parameter holds no `$`. */
function printFragment(d: Denter, name: string, txn: string, members: string[]): void {
  // a fragment with no members never reads its box, so its parameter is marked unused
  const ref = members.length === 0 ? '_$ref' : '$ref';
  d.print(`\nfunction ${name}(${ref}: { txn: ${txn} }) {\n`);
  d.print('  return {\n');
  for (const m of members) d.print(`    ${m},\n`);
  d.print('  };\n');
  d.print('}\n');
}

/** The fragments every context over a slice is assembled from: its get and scan accessors over a
    read transaction, and its set, del, update, and deleteSlice accessors over a write
    transaction. */
function generateSlice(d: Denter, annos: Annos, slice: PSlice): void {
  const base = lowerFirst(slice.name);
  const list = accessors(annos, slice);
  const ds = sliceAccessor(slice);

  // gets
  printFragment(
    d,
    `${base}Get`,
    'ReadTxn',
    list.map((a) => {
      const read = `$ref.txn.get(\`${a.key}\`, ${JSON.stringify(a.type)})`;
      return `${prop(a.name)}: (${args(a)}) => ${read} as ${a.anno} | undefined`;
    }),
  );

  // scans
  printFragment(
    d,
    `${base}Scan`,
    'ReadTxn',
    scanners(annos, slice).map(
      (s) => `${prop(s.name)}: $globalScan<${scanTypeArgs(s)}>($ref, ${s.template})`,
    ),
  );

  // sets
  printFragment(
    d,
    `${base}Set`,
    'WriteTxn',
    list.map((a) => {
      const write = `$ref.txn.set(\`${a.key}\`, ${JSON.stringify(a.type)}, ${own(a, 'value')})`;
      return `${prop(a.name)}: (${args(a, ['value', a.anno])}) => ${write}`;
    }),
  );

  // dels
  printFragment(
    d,
    `${base}Del`,
    'WriteTxn',
    list.map((a) => `${prop(a.name)}: (${args(a)}) => $ref.txn.del(\`${a.key}\`)`),
  );

  // updates, of the keys whose values change in place
  printFragment(
    d,
    `${base}Update`,
    'WriteTxn',
    list
      .filter((a) => a.updatable)
      .map((a) => {
        const call = `$updateKey($ref.txn, \`${a.key}\`, ${JSON.stringify(a.type)}, ${own(a, 'fn')})`;
        return `${prop(a.name)}: <R>(${args(a, ['fn', `(value: ${a.anno}) => R`])}) => ${call}`;
      }),
  );

  // the slice's own deletion
  const del = `$ref.txn.deleteSlice(\`${ds.key}\`, ${own(ds, 'options')}?.erase === true)`;
  printFragment(d, `${base}DeleteSlice`, 'WriteTxn', [
    `${prop(ds.name)}: (${args(ds, ['options?', 'DeleteSliceOptions'])}) => ${del}`,
  ]);
}

/** the members of a read context's type over slices: its get and scan groups */
function printReadTypes(d: Denter, annos: Annos, slices: readonly PSlice[]): void {
  printGroup(d, 'get: {\n', '};\n', () => {
    for (const slice of slices) {
      for (const a of accessors(annos, slice)) {
        d.print(`${prop(a.name)}: (${args(a)}) => ${a.anno} | undefined;\n`);
      }
    }
  });
  printGroup(d, 'scan: {\n', '};\n', () => {
    for (const slice of slices) {
      for (const s of scanners(annos, slice)) {
        d.print(`${prop(s.name)}: ScanAccessor<${scanTypeArgs(s)}>;\n`);
      }
    }
  });
}

/** the members of a write context's type over slices: its set, del, update, and deleteSlice
    groups */
function printWriteTypes(d: Denter, annos: Annos, slices: readonly PSlice[]): void {
  const list = slices.flatMap((slice) => accessors(annos, slice));
  printGroup(d, 'set: {\n', '};\n', () => {
    for (const a of list) d.print(`${prop(a.name)}: (${args(a, ['value', a.anno])}) => void;\n`);
  });
  printGroup(d, 'del: {\n', '};\n', () => {
    for (const a of list) d.print(`${prop(a.name)}: (${args(a)}) => void;\n`);
  });
  const updatable = list.filter((a) => a.updatable);
  if (updatable.length === 0) {
    d.print('update: {};\n');
  } else {
    d.print(
      '/** apply fn to the value at a key in place and set it, answering what fn returns; an\n',
    );
    d.print('    absent key throws */\n');
    printGroup(d, 'update: {\n', '};\n', () => {
      for (const a of updatable) {
        d.print(`${prop(a.name)}: <R>(${args(a, ['fn', `(value: ${a.anno}) => R`])}) => R;\n`);
      }
    });
  }
  d.print('/** delete a slice, and with `{ erase: true }` drop its history from the edit log */\n');
  printGroup(d, 'deleteSlice: {\n', '};\n', () => {
    for (const slice of slices) {
      const ds = sliceAccessor(slice);
      d.print(`${prop(ds.name)}: (${args(ds, ['options?', 'DeleteSliceOptions'])}) => void;\n`);
    }
  });
}

/** a context's groups, as the factory assembles them from the slices' fragments */
function fragments(slices: readonly PSlice[], kind: string): string {
  return `{ ${slices.map((s) => `...${lowerFirst(s.name)}${kind}($ref)`).join(', ')} }`;
}

/** a read context's type over slices */
function generateReadContext(
  d: Denter,
  annos: Annos,
  type: string,
  doc: string,
  slices: readonly PSlice[],
): void {
  d.print(`\n/** ${doc} */\n`);
  printGroup(d, `export type ${type} = {\n`, '};\n', () => printReadTypes(d, annos, slices));
}

/** A write context's type, its read context and its writes, and its create function, which
    answers the context and the box it reads its write transaction through.  A database's context
    takes the database's plugin set, whose request APIs are its fields by plugin name. */
function generateWriteContext(
  d: Denter,
  annos: Annos,
  type: string,
  readType: string,
  doc: string,
  slices: readonly PSlice[],
  plugins: boolean,
): void {
  d.print(`\n/** ${doc} */\n`);
  const params = plugins ? '<P = {}>' : '';
  printGroup(d, `export type ${type}${params} = ${readType} & {\n`, '', () =>
    printWriteTypes(d, annos, slices),
  );
  d.print(plugins ? '} & PluginApis<P>;\n' : '};\n');

  const members = ['get', 'scan', 'set', 'del', 'update', 'deleteSlice'].map(
    (g) => `${g}: ${fragments(slices, g[0].toUpperCase() + g.slice(1))}`,
  );
  d.print(`\nexport function create${type}(): { ctx: ${type}; $ref: { txn: WriteTxn } } {\n`);
  d.print('  const $ref = unboundRef<WriteTxn>();\n');
  d.print(`  const ctx: ${type} = {\n`);
  for (const m of members) d.print(`    ${m},\n`);
  d.print('  };\n');
  d.print('  return { ctx, $ref };\n');
  d.print('}\n');
}

/** the selectors of slice types, one each, as a literal: `family:*`, or the family alone for a
    slice type without parameters, whose one slice is named for it */
function wantsValue(slices: readonly PSlice[]): string {
  const wants = slices.map((s) => (s.params.length === 0 ? s.family : `${s.family}:*`));
  return '[' + wants.map((w) => JSON.stringify(w)).join(', ') + ']';
}

// engines ///////////////////////////////////////////////////////////////////

/** an engine's contexts, its predictor table and the Predictor over it, and its Engine subclass */
function generateEngine(d: Denter, annos: Annos, registry: PTypeRegistry, e: PEngine): void {
  const readType = `${e.name}ReadTxn`;
  const txnType = `${e.name}Txn`;
  const queryTxnType = `${e.name}QueryTxn`;
  const tableType = `${e.name}Predictors`;
  const offline = e.mutations.filter((m) => !m.online);
  const online = e.mutations.filter((m) => m.online);
  const anno = (m: PMutation) => annos.get(m.type)!;

  // what any of its contexts reads
  generateReadContext(
    d,
    annos,
    readType,
    `${e.name}'s read context: what its queries and predictors read, over its slices`,
    e.slices,
  );

  // what its predictors read and write
  const doc = `${e.name}'s predict context: what its predictors read and write, over its slices`;
  generateWriteContext(d, annos, txnType, readType, doc, e.slices, false);

  // what its queries read, which includes the Engine's status
  d.print(`\n/** ${e.name}'s query context: what its queries read, over its slices, and the`);
  d.print(" Engine's status */\n");
  d.print(`export type ${queryTxnType} = ${readType} & { status: EngineStatus };\n`);
  d.print(
    `\nexport function create${queryTxnType}(): { ctx: ${queryTxnType}; $ref: { txn: ReadTxn } } {\n`,
  );
  d.print('  const $ref = unboundRef<ReadTxn>();\n');
  d.print(`  const ctx: ${queryTxnType} = {\n`);
  d.print(`    get: ${fragments(e.slices, 'Get')},\n`);
  d.print(`    scan: ${fragments(e.slices, 'Scan')},\n`);
  d.print('    status: $engineStatus($ref),\n');
  d.print('  };\n');
  d.print('  return { ctx, $ref };\n');
  d.print('}\n');

  // the predictor table: one predictor per mutation that is not @online, every one required, so
  // a table claiming to be complete is checked; an Engine takes a Partial of it
  d.print(
    `\n/** ${e.name}'s predictors, one per mutation that is not @online.  An Engine takes a Partial of`,
  );
  d.print(' it, and a mutation left out predicts nothing. */\n');
  d.print(`export type ${tableType} = {\n`);
  d.indent('  ');
  for (const m of offline) {
    d.print(`${prop(lowerFirst(m.name))}: Predictor<${txnType}, ${anno(m)}>;\n`);
  }
  d.dedent();
  d.print('};\n');

  // each mutation to its predictor; an @online mutation is never predicted
  const mutationOf = new Map(e.mutations.map((m) => [m.type, m]));
  const predict = `predict${e.name}`;
  generateDispatch(
    d,
    registry,
    `${predict}(table: Partial<${tableType}>, txn: ${txnType}, val: any, pending?: true): void`,
    e.mutationType,
    (t) => {
      const m = mutationOf.get(t)!;
      if (m.online) return 'return;\n';
      return `return table.${prop(lowerFirst(m.name))}?.(txn, val as ${anno(m)}, pending);\n`;
    },
  );

  // the mutations sendMutation takes, and those sendOnlineMutation takes
  const M =
    offline.length === 0
      ? 'never'
      : online.length === 0
        ? annos.get(e.mutationType)!
        : offline.map(anno).join(' | ');
  const N = online.length === 0 ? 'never' : online.map(anno).join(' | ');

  d.print(`\n/** the Predictor that runs ${e.name}'s predictors */\n`);
  d.print(`export function ${lowerFirst(e.name)}Predictor(table: Partial<${tableType}>): `);
  d.print(`Predictor<${txnType}, ${M}> {\n`);
  d.print(`  return (txn, mutation, pending) => ${predict}(table, txn, mutation, pending);\n`);
  d.print('}\n');

  // the engine itself
  const names = e.slices.map((s) => s.name).join(', ');
  d.print(`
/** the Engine of ${e.name}, syncing ${names} */
export class ${e.name} extends Engine<${queryTxnType}, ${txnType}, ${M}, ${N}> {
  constructor(
    transport: Transport,
    options: {
      // who the Engine syncs as, or null for anonymous
      session: Session | null;
      // optional: predict what the database will do with a mutation
      predictors?: Partial<${tableType}>;
      // optional: makes the Engine's store from its Registry; without it, an InMemStore
      store?: StoreFactory;
      // optional: ends the Engine, its connection, and every backfill
      signal?: Signal;
      // optional: receives the error that ended the Engine
      onError?: (e: unknown) => void;
    },
  ) {
    const predictors = options.predictors;
    const schema = ${lowerFirst(e.name)}Schema;
    super(create${queryTxnType}(), create${txnType}(), schema, transport, {
      session: options.session,
      wants: ${wantsValue(e.slices)},
      store: options.store,
      predictor: predictors === undefined ? undefined : ${lowerFirst(e.name)}Predictor(predictors),
      signal: options.signal,
      onError: options.onError,
    });
  }
}
`);
}

// databases /////////////////////////////////////////////////////////////////

/** a database's contexts, its grantor and decider types, its slots, the definition of its bundle,
    and the post of its mutations */
function generateDatabase(
  d: Denter,
  annos: Annos,
  registry: PTypeRegistry,
  db: PDatabase,
  mutationUnion: PType | undefined,
): void {
  const readType = `${db.name}ReadTxn`;
  const txnType = `${db.name}Txn`;
  const typesType = `${db.name}Types`;
  const grantorType = `${db.name}Grantor`;
  const tableType = `${db.name}Deciders`;
  const slotsType = `${db.name}Slots`;

  // what grant and lookup read
  const readDoc = `${db.name}'s read context: what its grantor and lookup read, over every slice`;
  generateReadContext(d, annos, readType, readDoc, db.slices);

  // what deciders, bootstrap, and plugin hooks read and write, with the plugins of P
  const doc =
    `${db.name}'s context: what its deciders, bootstrap, and plugin hooks read and write, ` +
    'over every slice, and the request APIs of the plugin set P';
  generateWriteContext(d, annos, txnType, readType, doc, db.slices, true);

  // the types a plugin's hooks are typed by
  d.print(`\n/** ${db.name}'s types, as an installed plugin's hooks take them */\n`);
  d.print(`export type ${typesType}<P = {}> = { txn: ${txnType}<P> };\n`);

  // the grantor
  d.print(`\n/** ${db.name}'s grantor: the selectors of the slices a principal may see */\n`);
  d.print(`export type ${grantorType} = Grantor<${readType}>;\n`);

  // the decider table: one decider per mutation, each seeing the mutation after intake
  d.print(`\n/** ${db.name}'s deciders, one per mutation, with the plugin set P */\n`);
  d.print(`export type ${tableType}<P = {}> = {\n`);
  d.indent('  ');
  for (const m of db.mutations) {
    d.print(`${prop(lowerFirst(m.name))}: Decider<${txnType}<P>, ${deciderView(annos, m)}>;\n`);
  }
  d.dedent();
  d.print('};\n');

  // each mutation to its decider, run with a fresh Auth
  const decide = `decide${db.name}`;
  const signature =
    `${decide}(table: ${tableType}<any>, principal: Principal, txn: ${txnType}<any>, ` +
    'val: any): string | null';
  if (mutationUnion !== undefined) {
    const mutationOf = new Map(db.mutations.map((m) => [m.type, m]));
    generateDispatch(d, registry, signature, mutationUnion, (t) => {
      const m = mutationOf.get(t)!;
      const k = lowerFirst(m.name);
      const call = `table.${prop(k)}(auth, txn, val as ${deciderView(annos, m)})`;
      return `return runDecider(${JSON.stringify(k)}, principal, (auth) => ${call});\n`;
    });
  } else {
    d.print(`\nfunction ${signature} {\n`);
    d.print('  throw new Error(`no mutations: ${val}`);\n');
    d.print('}\n');
  }

  // the bundle's slots, as the app writes them
  d.print(`
/** what ${db.name}'s bundle is made of: its deciders, its grantor, lookup, an optional bootstrap,
    and the installed plugins of the set P, every one of them under its name */
export type ${slotsType}<P = {}> = {
  deciders: ${tableType}<P>;
  grant: ${grantorType};
  lookup: (txn: ${readType}, ident: LookupIdent) => LookupResult | null;
  bootstrap?: (txn: ${txnType}<P>, ctx: BootstrapContext) => void;
} & ({} extends P
  ? { plugins?: PluginSlots<P, ${typesType}<P>> }
  : { plugins: PluginSlots<P, ${typesType}<P>> });
`);

  // the bundle, over the generated wrappers
  d.print(`
/** Install ${db.name}'s bundle as globalThis.__bundle, the app's slots behind the generated
    wrappers, and answer it.  P is the plugin set, which the slots' deciders and plugins share.
    It builds two contexts once: the write context of the deciders, bootstrap, and the plugins,
    and the read context grant and lookup share, whose writes throw. */
export function define${db.name}<P = {}>(slots: ${slotsType}<P>): Bundle {
  const bootstrap = slots.bootstrap;
  const installs = (slots.plugins ?? {}) as Record<string, PluginInstall>;
  const write = create${txnType}();
  const read = create${txnType}();
  const { plugins, bind } = installPlugins(write.ctx, installs);
  const txn = write.ctx as ${txnType}<P>;
  const bundle: Bundle = {
    schema: ${lowerFirst(db.name)}Schema,
    bindWrite: (raw) => {
      write.$ref.txn = raw;
      bind(raw);
    },
    bindRead: (raw) => {
      read.$ref.txn = readOnlyTxn(raw);
    },
    decide: (data, principal) => ${decide}(slots.deciders, principal, txn, data),
    grant: (principal) => slots.grant(read.ctx, principal),
    lookup: (ident) => slots.lookup(read.ctx, ident),
    bootstrap: bootstrap === undefined ? undefined : (ctx) => bootstrap(txn, ctx),
    plugins,
    dev: DEV,
    mapStack,
  };
  (globalThis as { __bundle?: Bundle }).__bundle = bundle;
  return bundle;
}
`);

  // a post of any of the database's mutations outside any Engine, named for the database without
  // a trailing DB or Database
  if (mutationUnion === undefined) return;
  const post = `post${db.name.replace(/(db|database)$/i, '')}Mutation`;
  d.print(`
/** Posts one of ${db.name}'s mutations outside any Engine, such as one sent before anyone has
    signed in, as the session or as anonymous, and answers with the database's outcome */
export function ${post}(
  transport: Transport,
  mutation: ${annos.get(mutationUnion)!},
  options: { session?: Session | null } = {},
): Promise<MutationResult> {
  return postWithSchema(${lowerFirst(db.name)}Schema, transport, mutation, options);
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
  const { registry, roots, slices, mutations, engines, databases, queries } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  const d = new Denter();

  // Start with the skeleton
  d.print(skeleton);

  const typesToVisit = [...roots, ...slices.flatMap((s) => s.store.items.map((si) => si.type))];

  // A database needs the PasswordHash its bootstrap makes, and the union of its mutations, which
  // its bundle checks and dispatches on.
  const mutationUnions = new Map<PDatabase, PType>();
  for (const db of databases) {
    typesToVisit.push(registry.result('PasswordHash', registry.string()));
    if (db.mutations.length === 0) continue;
    const union = registry.union(db.mutations.map((m) => m.type));
    if (union.name === null) union.name = `${db.name}Mutation`;
    mutationUnions.set(db, union);
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
  generateSchema(d, registry, roots, engines, databases, mutationUnions, queries);

  // Generate each mutation's intake view
  for (const m of mutations) generateMutationTypes(d, annos, m);

  // Generate slices, engines, and databases
  for (const s of slices) generateSlice(d, annos, s);
  for (const e of engines) generateEngine(d, annos, registry, e);
  for (const db of databases) generateDatabase(d, annos, registry, db, mutationUnions.get(db));

  // Generate query layers
  for (const kq of queries) generateQueries(d, annos, kq);

  // the generated file ends with a trailing newline
  return d.getvalue() + '\n';
}
