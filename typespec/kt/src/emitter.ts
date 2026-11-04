/**
 * Kotlin code generator: emits the model's types as Kotlin classes; the type registry as data,
 * the same node table every emitter emits, with each class's constructor and getters beside its
 * node, for the Kotlin walk in io.phaselock.client; each engine's class over the native host,
 * taking its mutations as the model's types; each queries interface's class, answering each
 * query as a Flow of results; and each database's post function.  Predictors and query bodies
 * stay in TypeScript, in the model's native bundle.
 *
 * Types map one to one where Kotlin has the shape: a struct is a data class (a data object
 * when every field is a literal), its literal fields left to the schema; a union of literals is
 * an enum class; a union of structs is a sealed interface, its unnamed members nested in it; a
 * union with null is nullable.  An unnamed type takes its name from where it is first used:
 * `Book.status` gives `BookStatus`.  Integers are Long, dates Instant, lists List, records Map,
 * and tuples List<Any?>.
 */

import {
  buildSchema,
  databaseMutationUnions,
  Denter,
  identityOf,
  type LoweredProgram,
  type NodeData,
  PArray,
  PBool,
  type PDatabase,
  PDate,
  type PEngine,
  PInt,
  PIntake,
  PJson,
  PLiteral,
  PNull,
  PObject,
  type PQueries,
  PResult,
  PString,
  PStruct,
  PTuple,
  type PType,
  PUnion,
  queryId,
  queryStem,
} from '@phaselock/typespec-core';

// names /////////////////////////////////////////////////////////////////////

const KEYWORDS = new Set(
  (
    'as break class continue do else false for fun if in interface is null object package ' +
    'return super this throw true try typealias typeof val var when while'
  ).split(' '),
);

/** a name as a Kotlin identifier, backticked when it is a keyword or holds other characters */
function ident(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `\`${name}\``;
}

/** a name's words run together, each capitalized: `email-code` gives `EmailCode` */
function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

/** a literal as an enum constant: `email-code` gives `EMAIL_CODE` */
function constant(value: string): string {
  const c = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .join('_')
    .toUpperCase();
  return /^[A-Z_]/.test(c) ? c : `_${c}`;
}

/** a Kotlin string literal, its `$` escaped */
function str(s: string): string {
  return JSON.stringify(s).replace(/\$/g, '\\$');
}

/** a literal value as Kotlin: integers are Long, as the walk reads them */
function literal(v: NodeData): string {
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number') return `${v}L`;
  return String(v);
}

/** prints text as a doc comment, wrapped to the 100 columns its indentation leaves */
function doc(d: Denter, text: string, indent = 0): void {
  const width = 100 - indent;
  const lines: string[] = [];
  let line = '/**';
  for (const word of text.split(' ')) {
    if (line.length + 1 + word.length > width - 3) {
      lines.push(line);
      line = '   ';
    }
    line += ' ' + word;
  }
  lines.push(line + ' */');
  for (const l of lines) d.print(l + '\n');
}

// the Kotlin types //////////////////////////////////////////////////////////

/** A struct's class, top-level or nested in its union's sealed interface. */
type DataClass = { kind: 'data'; name: string; struct: PStruct; nested: boolean };
/** A union of literals' enum class. */
type EnumClass = { kind: 'enum'; name: string; union: PUnion; values: string[] };
/** A union of structs' sealed interface, its unnamed members nested in it. */
type Sealed = { kind: 'sealed'; name: string; union: PUnion; nested: DataClass[] };

type Decl = DataClass | EnumClass | Sealed;

/** Names each type of the model as Kotlin, declaring a class for each struct, enum, and sealed
    interface the first time a type needs one. */
class KotlinTypes {
  readonly decls: Decl[] = [];
  // each declared type's class name, qualified by its sealed interface when nested
  readonly names = new Map<PType, string>();
  // each enum's class, by its union
  readonly enums = new Map<PType, EnumClass>();
  // the sealed interfaces each top-level class implements
  readonly implements = new Map<PStruct, Set<string>>();
  readonly #discriminator: (t: PType) => string | undefined;

  constructor(discriminator: (t: PType) => string | undefined) {
    this.#discriminator = discriminator;
  }

  /** adds a sealed interface to those a class implements */
  implement(t: PStruct, iface: string): void {
    let s = this.implements.get(t);
    if (s === undefined) this.implements.set(t, (s = new Set()));
    s.add(iface);
  }

  /** the Kotlin type of a type, naming it after ctx when it has no name of its own */
  type(t: PType, ctx: string): string {
    if (t instanceof PResult) return this.type(t.base, ctx);
    if (t instanceof PIntake) return this.type(t.wire, t.kind);
    if (t instanceof PNull) return 'Nothing?';
    if (t instanceof PInt) return 'Long';
    if (t instanceof PString) return 'String';
    if (t instanceof PBool) return 'Boolean';
    if (t instanceof PDate) return 'Instant';
    if (t instanceof PJson) return 'Any?';
    if (t instanceof PLiteral) {
      return typeof t.value === 'string'
        ? 'String'
        : typeof t.value === 'number'
          ? 'Long'
          : 'Boolean';
    }
    if (t instanceof PArray) return `List<${this.type(t.itemType, `${ctx}Item`)}>`;
    if (t instanceof PObject) return `Map<String, ${this.type(t.valueType, `${ctx}Value`)}>`;
    if (t instanceof PTuple) {
      for (const [i, it] of t.itemTypes.entries()) this.type(it, `${ctx}${i}`);
      return 'List<Any?>';
    }
    if (t instanceof PStruct) return this.#struct(t, t.name ?? ctx, false);
    if (t instanceof PUnion) return this.#union(t, ctx);
    throw new Error(`unhandled type: ${t.constructor.name}`);
  }

  // a struct's class, declared once
  #struct(t: PStruct, name: string, nested: boolean): string {
    const seen = this.names.get(t);
    if (seen !== undefined) return seen;
    this.names.set(t, name);
    const decl: DataClass = { kind: 'data', name, struct: t, nested };
    if (!nested) this.decls.push(decl);
    const base = name.replace(/\./g, '');
    for (const [k, ft] of t.fields) this.type(ft, `${base}${pascal(k)}`);
    return name;
  }

  // a union's type: nullable when it holds null, an enum of literals, a sealed interface of
  // structs, a list for tuples, and Any for any other mix
  #union(t: PUnion, ctx: string): string {
    const others = t.types.filter((m) => !(m instanceof PNull));
    const q = others.length < t.types.length ? '?' : '';
    if (others.length === 0) return 'Nothing?';
    if (others.length === 1) {
      const one = this.type(others[0], ctx);
      return one.endsWith('?') ? one : one + q;
    }
    const seen = this.names.get(t);
    if (seen !== undefined) return seen + q;
    const name = t.name ?? ctx;
    if (others.every((m) => m instanceof PLiteral && typeof m.value === 'string')) {
      const values = others.map((m) => (m as PLiteral).value as string);
      const decl: EnumClass = { kind: 'enum', name, union: t, values };
      this.names.set(t, name);
      this.enums.set(t, decl);
      this.decls.push(decl);
      return name + q;
    }
    if (others.every((m) => m instanceof PStruct)) {
      const decl: Sealed = { kind: 'sealed', name, union: t, nested: [] };
      this.names.set(t, name);
      this.decls.push(decl);
      const taken = new Set<string>();
      for (const [i, m] of (others as PStruct[]).entries()) {
        if (m.name !== null) {
          this.#struct(m, m.name, false);
          this.implement(m, name);
          continue;
        }
        if (this.names.has(m)) continue;
        let simple = this.#memberName(m, i);
        if (taken.has(simple)) simple = `${simple}${i}`;
        taken.add(simple);
        this.#struct(m, `${name}.${simple}`, true);
        decl.nested.push({ kind: 'data', name: `${name}.${simple}`, struct: m, nested: true });
      }
      return name + q;
    }
    for (const [i, m] of others.entries()) this.type(m, `${ctx}${i}`);
    if (others.every((m) => m instanceof PTuple)) return 'List<Any?>' + q;
    return 'Any' + q;
  }

  // an unnamed member's name in its sealed interface: its discriminating literal, or its one
  // field, or its place
  #memberName(m: PStruct, i: number): string {
    const key = this.#discriminator(m);
    const lit = key === undefined ? undefined : m.fields.get(key);
    if (lit instanceof PLiteral && typeof lit.value === 'string') return pascal(lit.value);
    if (m.fields.size === 1) return pascal([...m.fields.keys()][0]);
    return `Member${i}`;
  }

  /** a struct's fields that its class holds: every field but a literal */
  static props(t: PStruct): [string, PType, boolean][] {
    return [...t.fields]
      .filter(([, ft]) => !(ft instanceof PLiteral))
      .map(([k, ft]) => [k, ft, t.maybes.has(k)]);
  }

  /** a field's Kotlin type as its class holds it: nullable when it may be left out */
  fieldType(t: PStruct, k: string, ft: PType): string {
    const base = this.type(ft, `${this.names.get(t)!.replace(/\./g, '')}${pascal(k)}`);
    return t.maybes.has(k) && !base.endsWith('?') ? base + '?' : base;
  }
}

// printing //////////////////////////////////////////////////////////////////

/* Prints a struct's class.  In a sealed interface, a field type named like one of the
   interface's nested classes would name that class, so a top-level type of that name is written
   with its package. */
function printDataClass(
  d: Denter,
  kt: KotlinTypes,
  c: DataClass,
  iface: string[],
  pkg: string,
  siblings: Set<string> = new Set(),
): void {
  const simple = c.nested ? c.name.slice(c.name.lastIndexOf('.') + 1) : c.name;
  const supers = iface.length ? ` : ${iface.join(', ')}` : '';
  const props = KotlinTypes.props(c.struct);
  if (props.length === 0) {
    d.print(`data object ${simple}${supers}\n`);
    return;
  }
  d.print(`data class ${simple}(\n`);
  d.indent('    ');
  for (const [k, ft, opt] of props) {
    const t = kt
      .fieldType(c.struct, k, ft)
      .replace(/\b[A-Z][A-Za-z0-9_]*\b/g, (n) => (siblings.has(n) ? `${pkg}.${n}` : n));
    d.print(`val ${ident(k)}: ${t}${opt ? ' = null' : ''},\n`);
  }
  d.dedent();
  d.print(`)${supers}\n`);
}

function printTypes(d: Denter, kt: KotlinTypes, pkg: string): void {
  d.print('\n// types ///////////////////////////////////////////////////////////////////////\n');
  for (const decl of kt.decls) {
    d.print('\n');
    if (decl.kind === 'data') {
      printDataClass(d, kt, decl, [...(kt.implements.get(decl.struct) ?? [])], pkg);
    } else if (decl.kind === 'enum') {
      d.print(`enum class ${decl.name}(val wire: String) {\n`);
      d.indent('    ');
      for (const v of decl.values) d.print(`${constant(v)}(${str(v)}),\n`);
      d.dedent();
      d.print('}\n');
    } else {
      if (decl.nested.length === 0) {
        d.print(`sealed interface ${decl.name}\n`);
        continue;
      }
      d.print(`sealed interface ${decl.name} {\n`);
      d.indent('    ');
      const siblings = new Set(decl.nested.map((c) => c.name.slice(c.name.lastIndexOf('.') + 1)));
      for (const [i, c] of decl.nested.entries()) {
        if (i > 0) d.print('\n');
        printDataClass(d, kt, c, [decl.name], pkg, siblings);
      }
      d.dedent();
      d.print('}\n');
    }
  }
}

// a solution as Kotlin
function solution(s: NodeData): string {
  const [kind, ...rest] = s as NodeData[];
  const pairs = (opts: NodeData, key: (k: NodeData) => string) =>
    `listOf(${(opts as NodeData[][]).map(([k, sub]) => `${key(k)} to ${solution(sub)}`).join(', ')})`;
  switch (kind) {
    case 'match':
      return `Solution.Match(${rest[0]})`;
    case 'jsontype':
      return `Solution.JsonType(${pairs(rest[0], (k) => str(k as string))})`;
    case 'literal':
      return `Solution.Literal(${pairs(rest[0], literal)})`;
    case 'length':
      return `Solution.Length(${pairs(rest[0], (k) => String(k))}, ${rest[1] === null ? 'null' : solution(rest[1])})`;
    case 'index':
      return `Solution.Index(${rest[0]}, ${solution(rest[1])})`;
    case 'field':
      return `Solution.Field(${str(rest[0] as string)}, ${solution(rest[1])})`;
    case 'hasfield':
      return `Solution.HasField(${pairs(rest[0], (k) => str(k as string))})`;
    default:
      throw new Error(`unrecognized solution ${String(kind)}`);
  }
}

// a name as Kotlin, or null
const optStr = (v: NodeData) => (v === null ? 'null' : str(v as string));

/** the registry: every node, each struct's with its class's constructor and getters, the
    identities, and the class of each struct node */
function printRegistry(d: Denter, kt: KotlinTypes, schema: ReturnType<typeof buildSchema>): void {
  const { table, ids } = schema;
  const classes: [string, number][] = [];

  d.print('\n// the type registry ///////////////////////////////////////////////////////////\n');
  d.print('\ninternal val registry = Registry(\n');
  d.indent('    ');
  d.print('listOf(\n');
  d.indent('    ');
  for (const [i, t] of table.order.entries()) {
    const n = table.node(t) as NodeData[];
    const kind = n[0] as string;
    switch (kind) {
      case 'null':
      case 'int':
      case 'str':
      case 'bool':
      case 'date':
      case 'json':
        d.print(`SchemaNode.${pascal(kind === 'str' ? 'Str' : kind)},\n`);
        break;
      case 'lit':
        d.print(`SchemaNode.Lit(${literal(n[1])}),\n`);
        break;
      case 'struct': {
        const s = t as PStruct;
        const cls = kt.names.get(s);
        if (cls === undefined) throw new Error(`a struct with no class: ${s}`);
        classes.push([cls, i]);
        const fields = (n[2] as NodeData[][])
          .map(([k, ft, opt]) => `SchemaField(${str(k as string)}, ${ft}, ${opt})`)
          .join(', ');
        const props = KotlinTypes.props(s);
        const make = props.length
          ? `{ a -> ${cls}(${props.map(([k, ft], j) => `a[${j}] as ${kt.fieldType(s, k, ft)}`).join(', ')}) }`
          : `{ _ -> ${cls} }`;
        const get = props.length
          ? `{ v -> (v as ${cls}).let { arrayOf(${props.map(([k]) => `it.${ident(k)}`).join(', ')}) } }`
          : '{ _ -> arrayOf() }';
        d.print(
          `SchemaNode.Struct(${optStr(n[1])}, listOf(${fields}), ${n[3]}, ${make}, ${get}),\n`,
        );
        break;
      }
      case 'record':
        d.print(`SchemaNode.Record(${optStr(n[1])}, ${n[2]}),\n`);
        break;
      case 'array':
        d.print(`SchemaNode.Array(${optStr(n[1])}, ${n[2]}),\n`);
        break;
      case 'tuple':
        d.print(`SchemaNode.Tuple(${optStr(n[1])}, listOf(${(n[2] as number[]).join(', ')})),\n`);
        break;
      case 'union': {
        const e = kt.enums.get(t);
        const wire = e
          ? `, { w -> ${e.name}.entries.first { it.wire == w } }, { e -> (e as ${e.name}).wire }`
          : '';
        d.print(`SchemaNode.Union(${optStr(n[1])}, ${solution(n[2])}${wire}),\n`);
        break;
      }
      case 'intake':
        d.print(`SchemaNode.Intake(${str(n[1] as string)}, ${n[2]}),\n`);
        break;
      default:
        throw new Error(`unrecognized node ${kind}`);
    }
  }
  d.dedent();
  d.print('),\n');
  d.print('mapOf(\n');
  d.indent('    ');
  for (const [id, t] of ids) d.print(`${str(id)} to ${table.visit(t)},\n`);
  d.dedent();
  d.print('),\n');
  d.print('mapOf(\n');
  d.indent('    ');
  for (const [cls, i] of classes) d.print(`${cls}::class to ${i},\n`);
  d.dedent();
  d.print('),\n');
  d.dedent();
  d.print(')\n');
}

// engines, queries, and posts ///////////////////////////////////////////////

function printEngine(d: Denter, e: PEngine): void {
  const mutations = identityOf(e.mutationType);
  const online = e.mutations.some((m) => m.online);
  const slices = e.slices.map((s) => s.name).join(', ');
  d.print('\n');
  doc(
    d,
    `The Engine of ${e.name}, syncing ${slices}, which the native host runs.  Open one with ` +
      'open, and close it to end it and close its store.',
  );
  d.print(`class ${e.name} private constructor(private val hosted: HostedEngine) :\n`);
  d.print('    QuerySource, AutoCloseable {\n');
  d.indent('    ');
  d.print('/** sends a mutation, after predicting it and saving it to the outbox */\n');
  d.print(`fun sendMutation(mutation: ${e.name}Mutation) =\n`);
  d.print(`    hosted.sendMutation(registry.encode(${str(mutations)}, mutation))\n`);
  if (online) {
    d.print("\n/** sends an @online mutation, answered with the database's outcome */\n");
    d.print(
      `suspend fun sendOnlineMutation(mutation: ${e.name}OnlineMutation): MutationResult =\n`,
    );
    d.print(`    hosted.sendOnlineMutation(registry.encode(${str(mutations)}, mutation))\n`);
  }
  d.print("\n/** the Engine's status, each time it changes */\n");
  d.print('val status: Flow<EngineStatus> get() = hosted.status\n');
  d.print('\nfun reconnectNow() = hosted.reconnectNow()\n');
  d.print('\nfun onEnded(fn: (EngineEnded) -> Unit) = hosted.onEnded(fn)\n');
  d.print('\noverride fun query(call: ByteArray): Flow<ByteArray> = hosted.query(call)\n');
  d.print('\n');
  doc(
    d,
    'ends the Engine and closes its store after the work already queued for it, returning at once',
    4,
  );
  d.print('override fun close() = hosted.close()\n');
  d.print('\n/** closes the Engine, suspending until its store is closed */\n');
  d.print('suspend fun closeAndJoin() = hosted.closeAndJoin()\n');

  // the factory, which suspends while the Engine boots
  d.print('\ncompanion object {\n');
  d.indent('    ');
  doc(
    d,
    `Opens ${e.name}, syncing as the session or as anonymous, over an LMDB store in the ` +
      "directory store, or in memory without one, and through the host's transport unless " +
      'given one of its own; it returns once the Engine has booted and loaded its store.  A ' +
      "directory holds one Engine's store, and only while that Engine runs: a new Engine may " +
      "open it only once the last one's close has completed, which closeAndJoin awaits.",
    8,
  );
  d.print('suspend fun open(\n');
  d.print('    host: EngineHost,\n');
  d.print('    session: Session?,\n');
  d.print('    store: File? = null,\n');
  d.print('    transport: Transport? = null,\n');
  d.print(`): ${e.name} =\n`);
  d.print(`    ${e.name}(host.createEngine(${str(e.name)}, session, store, transport))\n`);
  d.dedent();
  d.print('}\n');
  d.dedent();
  d.print('}\n');
}

function printQueries(d: Denter, kt: KotlinTypes, kq: PQueries): void {
  const name = kq.name!;
  const wire = `${queryStem(name)}Query`;
  d.print('\n');
  doc(d, `${name}, each answered as a Flow of its results by the Engine that serves them.`);
  d.print(`class ${name}(private val source: QuerySource) {\n`);
  d.indent('    ');
  for (const [i, q] of kq.queries.entries()) {
    const ctx = `${pascal(q.name)}`;
    const params = q.args
      .map(([an, at, opt]) => {
        const t = kt.type(at, `${ctx}${pascal(an)}`);
        return opt ? `${ident(an)}: ${t.endsWith('?') ? t : t + '?'} = null` : `${ident(an)}: ${t}`;
      })
      .join(', ');
    const call = [str(queryId(kq, q)), ...q.args.map(([an]) => ident(an))].join(', ');
    const result = kt.type(q.result, `${pascal(q.name)}Result`);
    if (i > 0) d.print('\n');
    d.print(`fun ${ident(q.name)}(${params}): Flow<${result}> =\n`);
    d.print(`    source.query(registry.encode(${str(wire)}, listOf(${call})))\n`);
    d.print(
      `        .map { registry.decode(${str(`${queryId(kq, q)}#result`)}, it) as ${result} }\n`,
    );
  }
  d.dedent();
  d.print('}\n');
}

function printPost(d: Denter, db: PDatabase, union: PType): void {
  const post = `post${db.name.replace(/(DB|Database)$/, '')}Mutation`;
  const id = identityOf(union);
  d.print('\n');
  doc(
    d,
    `Posts one of ${db.name}'s mutations outside any Engine, as the session or as anonymous, ` +
      'numbered in a series of its own so the transport may retry it.',
  );
  d.print(
    `suspend fun ${post}(transport: Transport, mutation: ${kotlinName(union)}, session: Session? = null): MutationResult =\n`,
  );
  d.print('    transport.post(\n');
  d.print(
    `        listOf(Mutation(generateUuid(), generateSeries(), 1, registry.encode(${str(id)}, mutation))),\n`,
  );
  d.print('        session,\n');
  d.print('    )[0]\n');
}

const kotlinName = (t: PType) => t.name!;

/** entrypoint: the complete generated file */
export function generateKotlin(lowered: LoweredProgram, pkg: string): string {
  const { registry, roots, engines, databases, queries } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  // the registry, every emitter's
  const mutationUnions = databaseMutationUnions(registry, databases);
  const schema = buildSchema(registry, roots, engines, databases, mutationUnions, queries);

  // every type the registry answers for, named as Kotlin
  const kt = new KotlinTypes((t) => schema.table.discriminator(t));
  for (const [id, t] of schema.ids) kt.type(t, pascal(id));

  // each engine's mutations, the outbox's and the @online ones, as sealed interfaces their
  // models implement
  for (const e of engines) {
    for (const m of e.mutations) {
      if (!(m.type instanceof PStruct)) continue;
      kt.implement(m.type, m.online ? `${e.name}OnlineMutation` : `${e.name}Mutation`);
    }
  }

  const d = new Denter();
  d.print(
    '// Generated by @phaselock/typespec-kt from the model; change the model and regenerate.\n',
  );
  d.print('\n@file:Suppress("UNCHECKED_CAST", "unused", "RedundantVisibilityModifier")\n');
  d.print(`\npackage ${pkg}\n`);
  d.print('\nimport io.phaselock.client.EngineEnded\n');
  d.print('import io.phaselock.client.EngineHost\n');
  d.print('import io.phaselock.client.EngineStatus\n');
  d.print('import io.phaselock.client.HostedEngine\n');
  d.print('import io.phaselock.client.Mutation\n');
  d.print('import io.phaselock.client.MutationResult\n');
  d.print('import io.phaselock.client.QuerySource\n');
  d.print('import io.phaselock.client.Registry\n');
  d.print('import io.phaselock.client.SchemaField\n');
  d.print('import io.phaselock.client.SchemaNode\n');
  d.print('import io.phaselock.client.Session\n');
  d.print('import io.phaselock.client.Solution\n');
  d.print('import io.phaselock.client.Transport\n');
  d.print('import io.phaselock.client.generateSeries\n');
  d.print('import io.phaselock.client.generateUuid\n');
  d.print('import java.io.File\n');
  d.print('import java.time.Instant\n');
  d.print('import kotlinx.coroutines.flow.Flow\n');
  d.print('import kotlinx.coroutines.flow.map\n');

  printTypes(d, kt, pkg);

  // each engine's mutation interfaces
  d.print('\n// engines ///////////////////////////////////////////////////////////////////////\n');
  for (const e of engines) {
    d.print(`\n/** the mutations ${e.name} predicts, saves, and resends */\n`);
    d.print(`sealed interface ${e.name}Mutation\n`);
    if (e.mutations.some((m) => m.online)) {
      d.print(`\n/** the @online mutations ${e.name} sends once, unsaved and unpredicted */\n`);
      d.print(`sealed interface ${e.name}OnlineMutation\n`);
    }
  }
  for (const e of engines) printEngine(d, e);

  if (queries.some((kq) => kq.queries.length)) {
    d.print(
      '\n// queries ///////////////////////////////////////////////////////////////////////\n',
    );
    for (const kq of queries) if (kq.queries.length) printQueries(d, kt, kq);
  }

  if (mutationUnions.size) {
    d.print(
      '\n// posts /////////////////////////////////////////////////////////////////////////\n',
    );
    for (const db of databases) {
      const union = mutationUnions.get(db);
      if (union !== undefined) printPost(d, db, union);
    }
  }

  printRegistry(d, kt, schema);
  return d.getvalue();
}
