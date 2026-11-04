/**
 * Swift code generator: emits the model's types as Swift values; the type registry as data, the
 * same node table every emitter emits, with each struct's initializer and getter and each enum's
 * wrapping beside its node, for the Swift walk in PhaseLock; each engine's class over the native
 * host, taking its mutations as the model's types; each queries interface's struct, answering
 * each query as an async sequence of results; and each database's post function.  Predictors and
 * query bodies stay in TypeScript, in the model's native bundle.
 *
 * Types map one to one where Swift has the shape: a struct is a struct (its literal fields left
 * to the schema), Sendable and Hashable so that a UI compares results by value; a union of string
 * literals is an enum with the literals as raw values; a union of structs is an enum with an
 * associated value per member, its unnamed members nested in it; a union with null is optional.
 * Mutations are sent, never switched on, so a mutations union, and each engine's outbox and
 * `@online` mutations, is a protocol its models conform to.  An unnamed type takes its name from
 * where it is first used: `Book.status` gives `BookStatus`.  Integers are Int, dates Date, lists
 * arrays, records dictionaries, and json JSON.  A tuple has no Swift type: tuples carry only query
 * calls, which the generated query functions build.
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
    'associatedtype class deinit enum extension fileprivate func import init inout internal let ' +
    'open operator private precedencegroup protocol public rethrows static struct subscript ' +
    'typealias var break case catch continue default defer do else fallthrough for guard if in ' +
    'repeat return throw switch where while Any as await false is nil self Self super throws ' +
    'true try Type Protocol'
  ).split(' '),
);

/** a name as a Swift identifier, backticked when it is a keyword or holds other characters */
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

/** a name as a case or a function: `email-code` gives `emailCode`, `TryHold` gives `tryHold` */
function camel(name: string): string {
  const p = pascal(name);
  const c = p.length ? p[0].toLowerCase() + p.slice(1) : '_';
  return /^[0-9]/.test(c) ? `_${c}` : c;
}

/** a Swift string literal */
function str(s: string): string {
  return JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
}

/** a literal as the walk's Literal */
function literal(v: NodeData): string {
  if (typeof v === 'string') return `.str(${str(v)})`;
  if (typeof v === 'number') return `.int(${v})`;
  return `.bool(${String(v)})`;
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

// the Swift types ///////////////////////////////////////////////////////////

/** A struct's declaration, top-level or nested in its union's enum. */
type StructDecl = { kind: 'struct'; name: string; struct: PStruct; nested: boolean };
/** A union of string literals' enum. */
type LiteralEnum = { kind: 'literals'; name: string; union: PUnion; values: string[] };
/** A union of structs' enum: a case per member, its unnamed members nested in it. */
type MemberEnum = {
  kind: 'members';
  name: string;
  union: PUnion;
  cases: { name: string; member: PStruct }[];
  nested: StructDecl[];
};
/** A mutations union's protocol, which its models conform to. */
type Protocol = { kind: 'protocol'; name: string; union: PUnion };

type Decl = StructDecl | LiteralEnum | MemberEnum | Protocol;

/** Names each type of the model as Swift, declaring a struct, enum, or protocol the first time a
    type needs one. */
class SwiftTypes {
  readonly decls: Decl[] = [];
  // each declared type's name, qualified by its enum when nested
  readonly names = new Map<PType, string>();
  // each enum's declaration, by its union
  readonly enums = new Map<PType, LiteralEnum | MemberEnum>();
  // the protocols each top-level struct conforms to
  readonly conforms = new Map<PStruct, Set<string>>();
  readonly #discriminator: (t: PType) => string | undefined;
  // the unions declared as protocols
  readonly #protocols: Set<PType>;

  constructor(discriminator: (t: PType) => string | undefined, protocols: Set<PType>) {
    this.#discriminator = discriminator;
    this.#protocols = protocols;
  }

  /** adds a protocol to those a struct conforms to */
  conform(t: PStruct, proto: string): void {
    let s = this.conforms.get(t);
    if (s === undefined) this.conforms.set(t, (s = new Set()));
    s.add(proto);
  }

  /** the Swift type of a type, naming it after ctx when it has no name of its own */
  type(t: PType, ctx: string): string {
    if (t instanceof PResult) return this.type(t.base, ctx);
    if (t instanceof PIntake) return this.type(t.wire, t.kind);
    if (t instanceof PNull) return 'Never?';
    if (t instanceof PInt) return 'Int';
    if (t instanceof PString) return 'String';
    if (t instanceof PBool) return 'Bool';
    if (t instanceof PDate) return 'Date';
    if (t instanceof PJson) return 'JSON';
    if (t instanceof PLiteral) {
      return typeof t.value === 'string' ? 'String' : typeof t.value === 'number' ? 'Int' : 'Bool';
    }
    if (t instanceof PArray) return `[${this.type(t.itemType, `${ctx}Item`)}]`;
    if (t instanceof PObject) return `[String: ${this.type(t.valueType, `${ctx}Value`)}]`;
    if (t instanceof PTuple) {
      for (const [i, it] of t.itemTypes.entries()) this.type(it, `${ctx}${i}`);
      return '[Any?]';
    }
    if (t instanceof PStruct) return this.#struct(t, t.name ?? ctx, false);
    if (t instanceof PUnion) return this.#union(t, ctx);
    throw new Error(`unhandled type: ${t.constructor.name}`);
  }

  // a struct's declaration, made once
  #struct(t: PStruct, name: string, nested: boolean): string {
    const seen = this.names.get(t);
    if (seen !== undefined) return seen;
    this.names.set(t, name);
    const decl: StructDecl = { kind: 'struct', name, struct: t, nested };
    if (!nested) this.decls.push(decl);
    const base = name.replace(/\./g, '');
    for (const [k, ft] of t.fields) this.type(ft, `${base}${pascal(k)}`);
    return name;
  }

  // a union's type: optional when it holds null, a protocol for a mutations union, an enum of
  // literals or of structs, and an array for tuples
  #union(t: PUnion, ctx: string): string {
    const others = t.types.filter((m) => !(m instanceof PNull));
    const opt = (s: string) => (others.length < t.types.length && !s.endsWith('?') ? `${s}?` : s);
    if (others.length === 0) return 'Never?';
    if (others.length === 1) return opt(this.type(others[0], ctx));
    const seen = this.names.get(t);
    if (seen !== undefined) return opt(this.#protocols.has(t) ? `any ${seen}` : seen);
    const name = t.name ?? ctx;

    // a mutations union, whose models conform to its protocol
    if (this.#protocols.has(t)) {
      this.names.set(t, name);
      this.decls.push({ kind: 'protocol', name, union: t });
      for (const m of others) {
        if (!(m instanceof PStruct) || m.name === null) {
          throw new Error(`a member of the mutations union ${name} is no named model`);
        }
        this.#struct(m, m.name, false);
        this.conform(m, name);
      }
      return opt(`any ${name}`);
    }

    // a union of string literals
    if (others.every((m) => m instanceof PLiteral && typeof m.value === 'string')) {
      const values = others.map((m) => (m as PLiteral).value as string);
      const decl: LiteralEnum = { kind: 'literals', name, union: t, values };
      this.names.set(t, name);
      this.enums.set(t, decl);
      this.decls.push(decl);
      return opt(name);
    }

    // a union of structs, a case for each
    if (others.every((m) => m instanceof PStruct)) {
      const decl: MemberEnum = { kind: 'members', name, union: t, cases: [], nested: [] };
      this.names.set(t, name);
      this.enums.set(t, decl);
      this.decls.push(decl);
      const taken = new Set<string>();
      for (const [i, m] of (others as PStruct[]).entries()) {
        if (m.name !== null) {
          this.#struct(m, m.name, false);
          decl.cases.push({ name: camel(m.name), member: m });
          continue;
        }
        let simple = this.names.get(m)?.split('.').pop() ?? this.#memberName(m, i);
        if (taken.has(simple)) simple = `${simple}${i}`;
        taken.add(simple);
        decl.cases.push({ name: camel(simple), member: m });
        if (this.names.has(m)) continue;
        this.#struct(m, `${name}.${simple}`, true);
        decl.nested.push({ kind: 'struct', name: `${name}.${simple}`, struct: m, nested: true });
      }
      return opt(name);
    }

    // a union of tuples, which only query calls are
    for (const [i, m] of others.entries()) this.type(m, `${ctx}${i}`);
    if (others.every((m) => m instanceof PTuple)) return opt('[Any?]');
    throw new Error(`the union ${name} mixes kinds the Swift emitter cannot declare`);
  }

  // an unnamed member's name in its enum: its discriminating literal, or its one field, or its
  // place
  #memberName(m: PStruct, i: number): string {
    const key = this.#discriminator(m);
    const lit = key === undefined ? undefined : m.fields.get(key);
    if (lit instanceof PLiteral && typeof lit.value === 'string') return pascal(lit.value);
    if (m.fields.size === 1) return pascal([...m.fields.keys()][0]);
    return `Member${i}`;
  }

  /** a struct's fields that its type holds: every field but a literal */
  static props(t: PStruct): [string, PType, boolean][] {
    return [...t.fields]
      .filter(([, ft]) => !(ft instanceof PLiteral))
      .map(([k, ft]) => [k, ft, t.maybes.has(k)]);
  }

  /** a field's Swift type as its struct holds it: optional when it may be left out */
  fieldType(t: PStruct, k: string, ft: PType): string {
    const base = this.type(ft, `${this.names.get(t)!.replace(/\./g, '')}${pascal(k)}`);
    const full = t.maybes.has(k) && !base.endsWith('?') ? `${base}?` : base;
    if (full.includes('[Any?]')) {
      throw new Error(`${this.names.get(t)}.${k}: the Swift emitter has no type for a tuple`);
    }
    return full;
  }
}

// printing //////////////////////////////////////////////////////////////////

/* A type as written inside an enum, where a nested struct's name hides a top-level type of the
   same name, which is written with its module. */
function qualified(t: string, module: string, siblings: Set<string>): string {
  return t.replace(/(?<![.\w])[A-Z][A-Za-z0-9_]*/g, (n) =>
    siblings.has(n) ? `${module}.${n}` : n,
  );
}

/* Prints a struct: its fields, and an initializer taking them in declaration order, an optional
   one defaulting to nil. */
function printStruct(
  d: Denter,
  st: SwiftTypes,
  c: StructDecl,
  module: string,
  siblings: Set<string> = new Set(),
): void {
  const simple = c.nested ? c.name.slice(c.name.lastIndexOf('.') + 1) : c.name;
  const props = SwiftTypes.props(c.struct).map(
    ([k, ft, opt]) => [k, qualified(st.fieldType(c.struct, k, ft), module, siblings), opt] as const,
  );
  d.print(`public struct ${simple}: Sendable, Hashable {\n`);
  d.indent('    ');
  for (const [k, t] of props) d.print(`public let ${ident(k)}: ${t}\n`);
  if (props.length) d.print('\n');
  const params = props.map(([k, t, opt]) => `${ident(k)}: ${t}${opt ? ' = nil' : ''}`);
  d.print(`public init(${params.join(', ')}) {\n`);
  d.indent('    ');
  for (const [k] of props) d.print(`self.${ident(k)} = ${ident(k)}\n`);
  d.dedent();
  d.print('}\n');
  d.dedent();
  d.print('}\n');
}

function printTypes(d: Denter, st: SwiftTypes, module: string): void {
  d.print('\n// types ///////////////////////////////////////////////////////////////////////\n');
  for (const decl of st.decls) {
    d.print('\n');
    if (decl.kind === 'struct') {
      printStruct(d, st, decl, module);
    } else if (decl.kind === 'protocol') {
      d.print(`/** the mutations of ${decl.name} */\n`);
      d.print(`public protocol ${decl.name}: Sendable {}\n`);
    } else if (decl.kind === 'literals') {
      d.print(`public enum ${decl.name}: String, Sendable, Hashable, CaseIterable {\n`);
      d.indent('    ');
      for (const v of decl.values) d.print(`case ${ident(camel(v))} = ${str(v)}\n`);
      d.dedent();
      d.print('}\n');
    } else {
      const siblings = new Set(decl.nested.map((c) => c.name.slice(c.name.lastIndexOf('.') + 1)));
      d.print(`public enum ${decl.name}: Sendable, Hashable {\n`);
      d.indent('    ');
      for (const c of decl.cases) {
        // a nested member by its own name, and a top-level one with its module when hidden
        const t = st.names.get(c.member)!;
        const nested = t.startsWith(`${decl.name}.`);
        const payload = nested ? t.slice(decl.name.length + 1) : qualified(t, module, siblings);
        d.print(`case ${ident(c.name)}(${payload})\n`);
      }
      for (const c of decl.nested) {
        d.print('\n');
        printStruct(d, st, c, module, siblings);
      }
      d.dedent();
      d.print('}\n');
    }
  }

  // each struct's conformance to the protocols of the mutations it is
  const conforming = [...st.conforms].filter(([, s]) => s.size > 0);
  if (conforming.length) d.print('\n');
  for (const [t, protos] of conforming) {
    d.print(`extension ${st.names.get(t)}: ${[...protos].join(', ')} {}\n`);
  }
}

// a solution as Swift
function solution(s: NodeData): string {
  const [kind, ...rest] = s as NodeData[];
  const pairs = (opts: NodeData, key: (k: NodeData) => string) =>
    `[${(opts as NodeData[][]).map(([k, sub]) => `(${key(k)}, ${solution(sub)})`).join(', ')}]`;
  switch (kind) {
    case 'match':
      return `.match(${rest[0]})`;
    case 'jsontype':
      return `.jsonType(${pairs(rest[0], (k) => str(k as string))})`;
    case 'literal':
      return `.literal(${pairs(rest[0], literal)})`;
    case 'length':
      return `.length(${pairs(rest[0], (k) => String(k))}, ${rest[1] === null ? 'nil' : solution(rest[1])})`;
    case 'index':
      return `.index(${rest[0]}, ${solution(rest[1])})`;
    case 'field':
      return `.field(${str(rest[0] as string)}, ${solution(rest[1])})`;
    case 'hasfield':
      return `.hasField(${pairs(rest[0], (k) => str(k as string))})`;
    default:
      throw new Error(`unrecognized solution ${String(kind)}`);
  }
}

// a name as Swift, or nil
const optStr = (v: NodeData) => (v === null ? 'nil' : str(v as string));

/* A field's value as the walk hands it to an initializer: cast to the field's type, or for a
   field that may be nil, cast where it is not. */
function castTo(v: string, t: string): string {
  return t.endsWith('?') ? `${v} as? ${t.slice(0, -1)}` : `${v} as! ${t}`;
}

/* An enum's wrapping: wrap makes the enum's value of a member's, by the member's node, and
   unwrap answers the member a value of the enum holds. */
function wrapping(
  st: SwiftTypes,
  e: LiteralEnum | MemberEnum,
  nodeOf: (t: PType) => number,
): string {
  if (e.kind === 'literals') {
    const members = e.union.types.filter((m) => m instanceof PLiteral);
    const cases = members
      .map((m) => {
        const v = (m as PLiteral).value as string;
        return `case .${ident(camel(v))}: (${nodeOf(m)}, ${str(v)})`;
      })
      .join('; ');
    return (
      `, wrap: { _, v in ${e.name}(rawValue: v as! String)! }` +
      `, unwrap: { v in (v as? ${e.name}).map { e in switch e { ${cases} } } }`
    );
  }
  const wrap = e.cases
    .map((c, i) => {
      const t = st.names.get(c.member)!;
      const head = i === e.cases.length - 1 ? 'default' : `case ${nodeOf(c.member)}`;
      return `${head}: ${e.name}.${ident(c.name)}(v as! ${t})`;
    })
    .join('; ');
  const unwrap = e.cases
    .map((c) => `case .${ident(c.name)}(let m): (${nodeOf(c.member)}, m)`)
    .join('; ');
  return (
    `, wrap: { n, v in switch n { ${wrap} } }` +
    `, unwrap: { v in (v as? ${e.name}).map { e in switch e { ${unwrap} } } }`
  );
}

/** the registry: every node, each struct's with its initializer and getter and each enum's with
    its wrapping, built one node a statement, and the identities */
function printRegistry(d: Denter, st: SwiftTypes, schema: ReturnType<typeof buildSchema>): void {
  const { table, ids } = schema;
  const nodeOf = (t: PType) => table.visit(t);

  d.print('\n// the type registry ///////////////////////////////////////////////////////////\n');
  d.print('\nlet registry: Registry = {\n');
  d.indent('    ');
  d.print('var n: [SchemaNode] = []\n');
  d.print(`n.reserveCapacity(${table.order.length})\n`);
  for (const [i, t] of table.order.entries()) {
    const node = table.node(t) as NodeData[];
    const kind = node[0] as string;
    let s: string;
    switch (kind) {
      case 'null':
      case 'int':
      case 'str':
      case 'bool':
      case 'date':
      case 'json':
        s = `.${kind}`;
        break;
      case 'lit':
        s = `.lit(${literal(node[1])})`;
        break;
      case 'struct': {
        const struct = t as PStruct;
        const name = st.names.get(struct);
        if (name === undefined) throw new Error(`a struct with no declaration: ${struct}`);
        const fields = (node[2] as NodeData[][])
          .map(([k, ft, opt]) => `SchemaField(${str(k as string)}, ${ft}, ${opt})`)
          .join(', ');
        const props = SwiftTypes.props(struct);
        const make = props.length
          ? `{ a in ${name}(${props
              .map(([k, ft], j) => `${ident(k)}: ${castTo(`a[${j}]`, st.fieldType(struct, k, ft))}`)
              .join(', ')}) }`
          : `{ _ in ${name}() }`;
        const get = props.length
          ? `{ v in let s = v as! ${name}; return [${props.map(([k]) => `s.${ident(k)}`).join(', ')}] }`
          : '{ _ in [] }';
        s =
          `.structure(StructNode(${optStr(node[1])}, [${fields}], ${node[3]}, ${name}.self, ` +
          `make: ${make}, get: ${get}))`;
        break;
      }
      case 'record':
        s = `.record(${optStr(node[1])}, ${node[2]})`;
        break;
      case 'array':
        s = `.array(${optStr(node[1])}, ${node[2]})`;
        break;
      case 'tuple':
        s = `.tuple(${optStr(node[1])}, [${(node[2] as number[]).join(', ')}])`;
        break;
      case 'union': {
        const e = st.enums.get(t);
        const wrap = e ? wrapping(st, e, nodeOf) : '';
        s = `.union(UnionNode(${optStr(node[1])}, ${solution(node[2])}${wrap}))`;
        break;
      }
      case 'intake':
        s = `.intake(${str(node[1] as string)}, ${node[2]})`;
        break;
      default:
        throw new Error(`unrecognized node ${kind}`);
    }
    d.print(`n.append(${s}) // ${i}\n`);
  }
  d.print('let ids: [String: Int] = [\n');
  d.indent('    ');
  for (const [id, t] of ids) d.print(`${str(id)}: ${table.visit(t)},\n`);
  d.dedent();
  d.print(']\n');
  d.print('return Registry(n, ids)\n');
  d.dedent();
  d.print('}()\n');
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
  d.print(`public final class ${e.name}: QuerySource, Sendable {\n`);
  d.indent('    ');
  d.print('private let hosted: HostedEngine\n');
  d.print('\nprivate init(_ hosted: HostedEngine) {\n');
  d.print('    self.hosted = hosted\n');
  d.print('}\n');

  // the factory, which waits while the Engine boots
  d.print('\n');
  doc(
    d,
    `Opens ${e.name}, syncing as the session or as anonymous, over an LMDB store in the ` +
      "directory store, or in memory without one, and through the host's transport unless " +
      'given one of its own; it returns once the Engine has booted and loaded its store.  A ' +
      "directory holds one Engine's store, and only while that Engine runs: a new Engine may " +
      "open it only once the last one's close has completed, which closeAndJoin awaits.",
    4,
  );
  d.print('public static func open(\n');
  d.print('    host: EngineHost,\n');
  d.print('    session: Session?,\n');
  d.print('    store: URL? = nil,\n');
  d.print('    transport: (any Transport)? = nil\n');
  d.print(`) async throws -> ${e.name} {\n`);
  d.print(
    `    ${e.name}(try await host.createEngine(${str(e.name)}, session: session, store: store, transport: transport))\n`,
  );
  d.print('}\n');

  d.print('\n/** sends a mutation, after predicting it and saving it to the outbox */\n');
  d.print(`public func sendMutation(_ mutation: some ${e.name}Mutation) throws {\n`);
  d.print(`    try hosted.sendMutation(try registry.encode(${str(mutations)}, mutation))\n`);
  d.print('}\n');
  if (online) {
    d.print("\n/** sends an @online mutation, answered with the database's outcome */\n");
    d.print(
      `public func sendOnlineMutation(_ mutation: some ${e.name}OnlineMutation) async throws -> MutationResult {\n`,
    );
    d.print(
      `    try await hosted.sendOnlineMutation(try registry.encode(${str(mutations)}, mutation))\n`,
    );
    d.print('}\n');
  }
  d.print("\n/** the Engine's status, each time it changes */\n");
  d.print('public var status: QueryResults<EngineStatus> { hosted.status }\n');
  d.print('\n/** connect now rather than when the backoff timer fires */\n');
  d.print('public func reconnectNow() throws {\n');
  d.print('    try hosted.reconnectNow()\n');
  d.print('}\n');
  d.print('\n');
  doc(d, 'calls fn, on the engine thread, if the Engine ends with an error or its host ends', 4);
  d.print('public func onEnded(_ fn: @escaping @Sendable (EngineEnded) -> Void) throws {\n');
  d.print('    try hosted.onEnded(fn)\n');
  d.print('}\n');
  d.print('\npublic func query(_ call: [UInt8]) -> AsyncThrowingStream<[UInt8], any Error> {\n');
  d.print('    hosted.query(call)\n');
  d.print('}\n');
  d.print('\n');
  doc(
    d,
    'ends the Engine and closes its store after the work already queued for it, returning at once',
    4,
  );
  d.print('public func close() {\n');
  d.print('    hosted.close()\n');
  d.print('}\n');
  d.print('\n/** closes the Engine, waiting until its store is closed */\n');
  d.print('public func closeAndJoin() async {\n');
  d.print('    await hosted.closeAndJoin()\n');
  d.print('}\n');
  d.dedent();
  d.print('}\n');
}

function printQueries(d: Denter, st: SwiftTypes, kq: PQueries): void {
  const name = kq.name!;
  const wire = `${queryStem(name)}Query`;
  d.print('\n');
  doc(
    d,
    `${name}, each answered as an async sequence of its results by the Engine that serves them.`,
  );
  d.print(`public struct ${name}: Sendable {\n`);
  d.indent('    ');
  d.print('private let source: any QuerySource\n');
  d.print('\npublic init(_ source: any QuerySource) {\n');
  d.print('    self.source = source\n');
  d.print('}\n');
  for (const q of kq.queries) {
    const ctx = pascal(q.name);
    const params = q.args
      .map(([an, at, opt]) => {
        const t = st.type(at, `${ctx}${pascal(an)}`);
        return opt ? `${ident(an)}: ${t.endsWith('?') ? t : `${t}?`} = nil` : `${ident(an)}: ${t}`;
      })
      .join(', ');
    const call = [str(queryId(kq, q)), ...q.args.map(([an]) => ident(an))].join(', ');
    const result = st.type(q.result, `${ctx}Result`);
    d.print(`\npublic func ${ident(q.name)}(${params}) -> QueryResults<${result}> {\n`);
    d.print(
      `    QueryResults(source, call: { try registry.encode(${str(wire)}, [${call}] as [Any?]) }) {\n`,
    );
    d.print(
      `        try registry.decode(${str(`${queryId(kq, q)}#result`)}, $0, as: ${result}.self)\n`,
    );
    d.print('    }\n');
    d.print('}\n');
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
  d.print(`public func ${post}(\n`);
  d.print('    _ transport: any Transport,\n');
  d.print(`    _ mutation: ${union instanceof PUnion ? 'some ' : ''}${union.name!},\n`);
  d.print('    session: Session? = nil\n');
  d.print(') async throws -> MutationResult {\n');
  d.print(`    let data = try registry.encode(${str(id)}, mutation)\n`);
  d.print('    let m = Mutation(id: generateUuid(), series: generateSeries(), n: 1, data: data)\n');
  d.print('    return try await transport.post([m], session: session)[0]\n');
  d.print('}\n');
}

/** entrypoint: the complete generated file */
export function generateSwift(lowered: LoweredProgram, module: string): string {
  const { registry, roots, engines, databases, queries } = lowered;
  if (!roots.length) throw new Error('no named types found to generate code for');

  // the registry, every emitter's
  const mutationUnions = databaseMutationUnions(registry, databases);
  const schema = buildSchema(registry, roots, engines, databases, mutationUnions, queries);

  // the mutations unions, declared as protocols
  const protocols = new Set<PType>();
  for (const e of engines) if (e.mutationType instanceof PUnion) protocols.add(e.mutationType);
  for (const u of mutationUnions.values()) if (u instanceof PUnion) protocols.add(u);

  // every type the registry answers for, named as Swift
  const st = new SwiftTypes((t) => schema.table.discriminator(t), protocols);
  for (const [id, t] of schema.ids) st.type(t, pascal(id));

  // each engine's mutations, the outbox's and the @online ones, as protocols their models
  // conform to
  for (const e of engines) {
    for (const m of e.mutations) {
      if (!(m.type instanceof PStruct)) continue;
      st.conform(m.type, m.online ? `${e.name}OnlineMutation` : `${e.name}Mutation`);
    }
  }

  const d = new Denter();
  d.print(
    '// Generated by @phaselock/typespec-swift from the model; change the model and regenerate.\n',
  );
  d.print('\nimport Foundation\n');
  d.print('import PhaseLock\n');

  printTypes(d, st, module);

  // each engine's mutation protocols
  d.print('\n// engines ///////////////////////////////////////////////////////////////////////\n');
  for (const e of engines) {
    d.print(`\n/** the mutations ${e.name} predicts, saves, and resends */\n`);
    d.print(`public protocol ${e.name}Mutation: Sendable {}\n`);
    if (e.mutations.some((m) => m.online)) {
      d.print(`\n/** the @online mutations ${e.name} sends once, unsaved and unpredicted */\n`);
      d.print(`public protocol ${e.name}OnlineMutation: Sendable {}\n`);
    }
  }
  for (const e of engines) printEngine(d, e);

  if (queries.some((kq) => kq.queries.length)) {
    d.print(
      '\n// queries ///////////////////////////////////////////////////////////////////////\n',
    );
    for (const kq of queries) if (kq.queries.length) printQueries(d, st, kq);
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

  printRegistry(d, st, schema);
  return d.getvalue();
}
