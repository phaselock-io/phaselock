/**
 * PType and friends are intermediate representation (IR) layer that code generation consumes.
 *
 * PTypes are interned: identical types are represented by a single object, so object identity is
 * 1:1 with type equality.  The union solver and the decoder generators both rely on that.
 *
 * The 'P' prefix marks IR types, and distinguishes e.g. PUnion from @typescript/compiler's
 * Union type, as well as distinguishing PEngine from our own user-facing Engine.
 */

export type JsonType = 'null' | 'int' | 'string' | 'boolean' | 'object' | 'array' | '*';
export type LitValue = string | number | boolean;

let nextId = 0;

export abstract class PType {
  readonly id: number = nextId++;
  name: string | null = null;
  abstract readonly jsonType: JsonType;
  abstract toString(): string;
}

/** Iterate union members, or the type itself for non-unions. */
export function members(t: PType): readonly PType[] {
  return t instanceof PUnion ? t.types : [t];
}

export class PNull extends PType {
  readonly jsonType = 'null';
  toString() {
    return 'null';
  }
}

export class PInt extends PType {
  readonly jsonType = 'int';
  toString() {
    return 'int';
  }
}

export class PString extends PType {
  readonly jsonType = 'string';
  toString() {
    return 'str';
  }
}

export class PBool extends PType {
  readonly jsonType = 'boolean';
  toString() {
    return 'bool';
  }
}

export class PDate extends PType {
  readonly jsonType = 'string';
  toString() {
    return 'Date';
  }
}

export class PJson extends PType {
  readonly jsonType = '*';
  toString() {
    return 'json';
  }
}

export class PLiteral extends PType {
  readonly jsonType: JsonType;
  constructor(readonly value: LitValue) {
    super();
    if (typeof value === 'boolean') this.jsonType = 'boolean';
    else if (typeof value === 'string') this.jsonType = 'string';
    else if (Number.isInteger(value)) this.jsonType = 'int';
    else throw new Error(`illegal value for PLiteral(${value})`);
  }
  toString() {
    if (typeof this.value === 'string') return `"${this.value}"`;
    return String(this.value);
  }
}

export type PField = readonly [name: string, type: PType, optional: boolean];

export class PStruct extends PType {
  readonly jsonType = 'object';
  /** all fields, regardless of maybe status, in declaration order */
  readonly fields: Map<string, PType>;
  /** only non-maybe fields */
  readonly always: Map<string, PType>;
  /** only maybe fields */
  readonly maybes: Map<string, PType>;
  constructor(fields: readonly PField[]) {
    super();
    this.fields = new Map(fields.map(([k, t]) => [k, t]));
    this.always = new Map(fields.filter(([, , opt]) => !opt).map(([k, t]) => [k, t]));
    this.maybes = new Map(fields.filter(([, , opt]) => opt).map(([k, t]) => [k, t]));
  }
  toString() {
    if (this.name) return this.name;
    const mkfield = (k: string, v: PType) => `${k}${this.maybes.has(k) ? '?' : ''}: ${v}`;
    return '{' + [...this.fields].map(([k, v]) => mkfield(k, v)).join(', ') + '}';
  }
}

export class PObject extends PType {
  readonly jsonType = 'object';
  constructor(readonly valueType: PType) {
    super();
  }
  toString() {
    return this.name ?? `Object[${this.valueType}]`;
  }
}

export class PArray extends PType {
  readonly jsonType = 'array';
  constructor(readonly itemType: PType) {
    super();
  }
  lengthRange(): [number, number] {
    return [0, Infinity];
  }
  typeat(_i: number): PType {
    return this.itemType;
  }
  toString() {
    return this.name ?? `Array[${this.itemType}]`;
  }
}

export class PTuple extends PType {
  readonly jsonType = 'array';
  constructor(readonly itemTypes: readonly PType[]) {
    super();
  }
  lengthRange(): [number, number] {
    return [this.itemTypes.length, this.itemTypes.length];
  }
  typeat(i: number): PType {
    return this.itemTypes[i];
  }
  toString() {
    return this.name ?? 'Tuple[' + this.itemTypes.join(', ') + ']';
  }
}

export class PUnion extends PType {
  /** members in first-seen order; never contains a nested PUnion */
  readonly types: readonly PType[];
  constructor(types: readonly PType[]) {
    super();
    this.types = types;
  }
  // A union has no single json type.  Solver inputs are always flattened members (never nested
  // unions), so reaching this indicates a bug in the caller.
  get jsonType(): JsonType {
    throw new Error(`unions have no single json type: ${this}`);
  }
  toString() {
    return this.name ?? this.types.map(String).sort().join('|');
  }
}

/**
 * PTypeRegistry is the interning layer: every type is created through it, and structurally
 * identical types come back as the same object.
 *
 * Structural keys are built from child ids, which is sound because children are themselves
 * interned before the parent key is computed.  Struct keys sort their fields so that field order
 * does not affect identity (the first creation wins the display order); union keys sort member
 * ids so that member order does not affect identity either.
 */
export class PTypeRegistry {
  /** every distinct type ever created, in creation order */
  readonly all: PType[] = [];
  private interned = new Map<string, PType>();

  private intern<T extends PType>(key: string, create: () => T): T {
    const existing = this.interned.get(key);
    if (existing !== undefined) return existing as T;
    const val = create();
    this.interned.set(key, val);
    this.all.push(val);
    return val;
  }

  null_(): PNull {
    return this.intern('null', () => new PNull());
  }
  int(): PInt {
    return this.intern('int', () => new PInt());
  }
  string(): PString {
    return this.intern('string', () => new PString());
  }
  bool(): PBool {
    return this.intern('bool', () => new PBool());
  }
  date(): PDate {
    return this.intern('date', () => new PDate());
  }
  json(): PJson {
    return this.intern('json', () => new PJson());
  }

  literal(value: LitValue): PLiteral {
    return this.intern(`lit:${typeof value}:${JSON.stringify(value)}`, () => new PLiteral(value));
  }

  struct(fields: readonly PField[]): PStruct {
    const key =
      'struct:' +
      [...fields]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, t, opt]) => `${k}${opt ? '?' : ''}=${t.id}`)
        .join(',');
    return this.intern(key, () => new PStruct(fields));
  }

  object(valueType: PType): PObject {
    return this.intern(`obj:${valueType.id}`, () => new PObject(valueType));
  }

  array(itemType: PType): PArray {
    return this.intern(`arr:${itemType.id}`, () => new PArray(itemType));
  }

  tuple(itemTypes: readonly PType[]): PTuple {
    return this.intern(`tup:${itemTypes.map((t) => t.id).join(',')}`, () => new PTuple(itemTypes));
  }

  /**
   * Create a union.  Nested unions are flattened and duplicate members dropped, so union members
   * are never themselves unions.  A single-member union resolves to the member itself.
   */
  union(types: readonly PType[]): PType {
    const flat: PType[] = [];
    const seen = new Set<PType>();
    for (const t of types) {
      for (const m of members(t)) {
        if (!seen.has(m)) {
          seen.add(m);
          flat.push(m);
        }
      }
    }
    if (flat.length === 0) throw new Error('no types in union!');
    if (flat.length === 1) return flat[0];
    const key =
      'union:' +
      flat
        .map((t) => t.id)
        .sort((a, b) => a - b)
        .join(',');
    return this.intern(key, () => new PUnion(flat));
  }
}

// Store, Engine, and Queries IR

const TPL_PATTERN = /\{([^}]*)\}/g;

export class PStoreItem {
  private constructor(
    readonly tpl: string,
    readonly type: PType,
    readonly origin: PStore,
    readonly name: string,
    /** there is always one more chunk than params */
    readonly chunks: readonly string[],
    readonly params: readonly string[],
  ) {}

  static fromSpec(tpl: string, type: PType, origin: PStore): PStoreItem {
    const name = tpl.split('.')[0];
    if (name.includes('{')) {
      throw new Error(`store key template '${tpl}' does not have a name before a '.'`);
    }
    const [chunks, params] = PStoreItem.parseTpl(tpl);
    return new PStoreItem(tpl, type, origin, name, chunks, params);
  }

  static parseTpl(tpl: string): [string[], string[]] {
    const chunks: string[] = [];
    const params: string[] = [];
    let i = 0;
    for (const m of tpl.matchAll(TPL_PATTERN)) {
      chunks.push(tpl.slice(i, m.index));
      i = m.index + m[0].length;
      params.push(m[1]);
    }
    chunks.push(tpl.slice(i));
    return [chunks, params];
  }
}

export class PStore {
  name: string | null = null;
  readonly deps: readonly PStore[];
  /** all items including those of deps, sorted by name */
  readonly items: readonly PStoreItem[];

  constructor(specs: readonly (readonly [string, PType])[], deps: readonly PStore[]) {
    this.deps = deps;
    const items: PStoreItem[] = [];
    const names = new Map<string, PStoreItem>();
    const add = (si: PStoreItem) => {
      const match = names.get(si.name);
      if (match !== undefined) {
        throw new Error(
          `unable to add store template '${si.tpl}', which collides with template '${match.tpl}'`,
        );
      }
      items.push(si);
      names.set(si.name, si);
    };
    for (const dep of deps) {
      for (const si of dep.items) add(si);
    }
    for (const [tpl, type] of specs) add(PStoreItem.fromSpec(tpl, type, this));
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.items = items;
  }

  /** items declared on this store itself (not inherited from deps), in sorted order */
  get originalItems(): PStoreItem[] {
    return this.items.filter((si) => si.origin === this);
  }

  toString() {
    return 'Store(\n  ' + this.items.map((si) => `${si.tpl}: ${si.type}`).join(',\n  ') + '\n)';
  }
}

export class PEngine {
  name: string | null = null;
  constructor(
    readonly eventType: PType,
    readonly commandType: PType,
    readonly store: PStore,
  ) {}
}

/** One query declaration: its name, arguments, and result type. */
export class PQuery {
  constructor(
    readonly name: string,
    readonly args: readonly PField[],
    readonly result: PType,
  ) {}
}

export class PQueries {
  name: string | null = null;
  constructor(readonly queries: readonly PQuery[]) {}
}
