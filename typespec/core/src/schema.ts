/* The type registry as data, which every emitter emits and every host walks: a table of nodes,
   each type once, referring to each other by index, with the union solver's decision tree inside
   each union node; and for each engine and database a Schema naming that table, the identities a
   Registry answers for, and its mutations union.  A node is plain data, nested arrays of strings,
   numbers, booleans, and nulls, which an emitter prints in its own language. */

import {
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
  type PQuery,
  PResult,
  type PSlice,
  type PStoreItem,
  PString,
  PStruct,
  PTuple,
  type PType,
  type PTypeRegistry,
  PUnion,
} from './ptypes.ts';
import {
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  GetField,
  GetIndex,
  HasField,
  Match,
  type Solution,
  solveUnion,
} from './solver.ts';

/** a node or a solution as data */
export type NodeData = string | number | boolean | null | readonly NodeData[];

/** the type identities a Schema answers for, each to its type */
export type Identities = Map<string, PType>;

/** the identity of a store item's type: its name, a result's vocabulary name, or, for an unnamed
    type, `family/name` */
export function storeTypeName(slice: PSlice, item: PStoreItem): string {
  const t = item.type;
  if (t.name !== null) return t.name;
  if (t instanceof PResult) return t.kind;
  return `${slice.family}/${item.name}`;
}

/** a queries interface's name without its `Queries` suffix */
export function queryStem(name: string): string {
  return name.endsWith('Queries') ? name.slice(0, -'Queries'.length) : name;
}

/** the wire id of one query: unique across all interfaces a connection may carry */
export function queryId(kq: PQueries, q: PQuery): string {
  return `${kq.name}.${q.name}`;
}

/**
 * Build the wire message type for a queries interface: a union of `[id, ...args]` tuples,
 * discriminated by the id literal.  Optional arguments are nullable on the wire (a JSON array
 * has no way to omit an element).  Naming the union routes it through the same annotation,
 * decoder, and checker generation as any declared type, which is what gives the serving side
 * `check<Stem>Query` for ingress and `decode<Stem>Query` for typed dispatch.
 */
export function queryWireType(registry: PTypeRegistry, kq: PQueries): PType {
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

/** Each database's mutations union, which its bundle checks and dispatches on, named
    `{Database}Mutation` when the model leaves it unnamed; a database without mutations has
    none. */
export function databaseMutationUnions(
  registry: PTypeRegistry,
  databases: readonly PDatabase[],
): Map<PDatabase, PType> {
  const unions = new Map<PDatabase, PType>();
  for (const db of databases) {
    if (db.mutations.length === 0) continue;
    const union = registry.union(db.mutations.map((m) => m.type));
    if (union.name === null) union.name = `${db.name}Mutation`;
    unions.set(db, union);
  }
  return unions;
}

/** the node table being built: each type's index, in visiting order */
export class NodeTable {
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

  /** the field a struct writes first, the one a union tells it apart by, if any */
  discriminator(t: PType): string | undefined {
    return this.#discriminators.get(t);
  }

  /** a solution as data */
  solution(sln: Solution): NodeData {
    if (sln instanceof Match) return ['match', this.visit(sln.typ)];
    if (sln instanceof CheckJsonType) {
      return ['jsontype', [...sln.options].map(([jt, sub]) => [jt, this.solution(sub)])];
    }
    if (sln instanceof CheckLiteral) {
      return ['literal', [...sln.options].map(([lit, sub]) => [lit, this.solution(sub)])];
    }
    if (sln instanceof CheckLength) {
      const opts = [...sln.options].map(([n, sub]) => [n, this.solution(sub)]);
      return ['length', opts, sln.default === null ? null : this.solution(sln.default)];
    }
    if (sln instanceof GetIndex) return ['index', sln.i, this.solution(sln.solution)];
    if (sln instanceof GetField) return ['field', sln.key, this.solution(sln.solution)];
    if (sln instanceof HasField) {
      return ['hasfield', sln.solutions.map(([k, sub]) => [k, this.solution(sub)])];
    }
    throw new Error(`unrecognized solution type: ${(sln as Solution).constructor.name}`);
  }

  /** one node as data; children were visited when the type was */
  node(t: PType): NodeData {
    const at = (c: PType) => this.index.get(c instanceof PResult ? c.base : c)!;
    if (t instanceof PNull) return ['null'];
    if (t instanceof PInt) return ['int'];
    if (t instanceof PString) return ['str'];
    if (t instanceof PBool) return ['bool'];
    if (t instanceof PDate) return ['date'];
    if (t instanceof PJson) return ['json'];
    if (t instanceof PLiteral) return ['lit', t.value];
    if (t instanceof PStruct) {
      const fields = [...t.fields].map(([k, ft]) => [k, at(ft), t.maybes.has(k)]);
      const key = this.#discriminators.get(t);
      const disc = key === undefined ? -1 : [...t.fields.keys()].indexOf(key);
      return ['struct', t.name, fields, disc];
    }
    if (t instanceof PObject) return ['record', t.name, at(t.valueType)];
    if (t instanceof PArray) return ['array', t.name, at(t.itemType)];
    if (t instanceof PTuple) return ['tuple', t.name, t.itemTypes.map(at)];
    if (t instanceof PUnion) return ['union', t.name, this.solution(this.#solutions.get(t)!)];
    if (t instanceof PIntake) return ['intake', t.kind, at(t.wire)];
    throw new Error(`unhandled type in the registry: ${t.constructor.name}`);
  }
}

/** the type identity of a type: its name, or a result's vocabulary name */
export function identityOf(t: PType): string {
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

/** The registry of a model: its node table, every identity it answers for, and each engine's
    and database's name with its mutations union's identity, or null for none. */
export type SchemaData = {
  table: NodeTable;
  ids: Identities;
  audiences: [name: string, mutations: string | null][];
};

/** builds the registry of the model's named types, engines, databases, and queries */
export function buildSchema(
  registry: PTypeRegistry,
  roots: readonly PType[],
  engines: readonly PEngine[],
  databases: readonly PDatabase[],
  mutationUnions: Map<PDatabase, PType>,
  queries: readonly PQueries[],
): SchemaData {
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
  return { table, ids, audiences };
}
