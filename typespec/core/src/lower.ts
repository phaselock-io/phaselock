/**
 * Lowering: TypeSpec Program → PhaseLock IR.
 *
 * Lowering consumes the checker's fully resolved type graph and translates it into the interned
 * IR, plus:
 *   - names: top-level declarations name the IR types they lower to (first name wins; a second
 *     declaration that resolves to the same structural type is a diagnostic)
 *   - slices: interfaces extending `PhaseLock.Slice<Family, Events, Spec>` become PSlice; the
 *     Spec model's property names are the key templates
 *   - commands: models carrying `@command` become PCommand, with the output it declares
 *   - engines: interfaces extending `PhaseLock.Engine<Slices, Commands>` become PEngine
 *   - databases: interfaces extending `PhaseLock.Database<Engines, Slices, Commands>` become
 *     PDatabase
 *   - queries: interfaces extending `PhaseLock.Queries` become PQueries; each operation
 *     becomes a PQuery carrying its name, arguments, and result type
 *   - intake types: the vocabulary's NewPassword, CommandAuth, and the rest lower by identity to
 *     PIntake, and their results to PResult
 *
 * Interfaces are deliberately the carrier for slices, engines, databases, and queries: they are
 * not data types, so they can't leak into the model space the way decorated models could.
 *
 * Lowering reports what one declaration shows on its own; validate.ts checks what only the whole
 * program shows.
 *
 * Ordering: `roots` follows IR creation order, which is a depth-first walk of declarations in
 * source order — children precede parents (e.g. union members appear before the union itself).
 * Slices, commands, engines, databases, and queries are each in source order.
 */

import {
  getNamespaceFullName,
  getSourceLocation,
  isArrayModelType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  walkPropertiesInherited,
} from '@typespec/compiler';
import type {
  Entity,
  Enum,
  Interface,
  Model,
  Program,
  Scalar,
  Type,
  Union,
} from '@typespec/compiler';

import { getCommandOutput, isOnline } from './decorators.ts';
import { reportDiagnostic } from './lib.ts';
import {
  PCommand,
  PDatabase,
  PEngine,
  type PField,
  type POutput,
  PQueries,
  PQuery,
  PResult,
  PSlice,
  PStore,
  PType,
  PTypeRegistry,
} from './ptypes.ts';

export interface LoweredProgram {
  registry: PTypeRegistry;
  /** all named data types, in creation (resolution) order */
  roots: PType[];
  /** all slices, in declaration order */
  slices: PSlice[];
  /** all `@command` models, in declaration order */
  commands: PCommand[];
  /** all engines, in declaration order */
  engines: PEngine[];
  /** all databases, in declaration order */
  databases: PDatabase[];
  /** all queries interfaces, in declaration order */
  queries: PQueries[];
  /** the first TypeSpec type that lowered to each IR type, for diagnostic targeting */
  targets: Map<PType, Type>;
  /** the declaration each slice, command, engine, and database came from */
  sources: Map<PSlice | PCommand | PEngine | PDatabase, Type>;
}

// a name, then optionally `:{param}` and `,{param}` for each further parameter: the shape of a
// family template and of a key template
const TEMPLATE_PATTERN =
  /^[A-Za-z0-9_-]+(:\{[A-Za-z_][A-Za-z0-9_]*\}(,\{[A-Za-z_][A-Za-z0-9_]*\})*)?$/;

/**
 * A template argument may arrive as an IndeterminateEntity (an entity the checker hasn't
 * committed to being a type or a value, e.g. a model expression or tuple literal); unwrap to the
 * underlying type.
 */
function argType(arg: Entity | undefined): Type | undefined {
  if (arg === undefined) return undefined;
  if (arg.entityKind === 'Indeterminate') return arg.type;
  if (arg.entityKind === 'Type') return arg;
  return undefined; // a Value; callers diagnose
}

/**
 * Find PhaseLock.<name> among an interface's extends list — the template instantiation for
 * templates (Slice, Engine, Database), or the interface itself for plain ones (Queries).
 */
function vocabSource(iface: Interface, name: string): Interface | undefined {
  for (const src of iface.sourceInterfaces) {
    if (
      src.name === name &&
      src.namespace !== undefined &&
      getNamespaceFullName(src.namespace) === 'PhaseLock'
    ) {
      return src;
    }
  }
  return undefined;
}

/** the name of a declaration in the PhaseLock namespace, or undefined for anything else */
function vocabName(type: Type): string | undefined {
  if (!('namespace' in type) || type.namespace === undefined) return undefined;
  if (getNamespaceFullName(type.namespace) !== 'PhaseLock') return undefined;
  return 'name' in type && typeof type.name === 'string' ? type.name : undefined;
}

/** a type's name for a diagnostic */
function nameOf(type: Type): string {
  return 'name' in type && typeof type.name === 'string' && type.name !== ''
    ? type.name
    : type.kind;
}

/** the models a union lists, through nested unions */
function unionModels(union: Union): Type[] {
  return [...union.variants.values()].flatMap((v) =>
    v.type.kind === 'Union' ? unionModels(v.type) : [v.type],
  );
}

export function lowerProgram(program: Program): LoweredProgram {
  const registry = new PTypeRegistry();
  const typeCache = new Map<Type, PType>();
  const targets = new Map<PType, Type>();
  const sources = new Map<PSlice | PCommand | PEngine | PDatabase, Type>();
  const sliceCache = new Map<Interface, PSlice | undefined>();
  const engineCache = new Map<Interface, PEngine | undefined>();
  const commandCache = new Map<Model, PCommand>();

  function unsupported(target: Type, message: string): PType {
    reportDiagnostic(program, {
      code: 'unsupported-type',
      format: { message },
      target,
    });
    return registry.json();
  }

  function invalidArgs(target: Type, message: string): void {
    reportDiagnostic(program, {
      code: 'invalid-template-args',
      format: { message },
      target,
    });
  }

  /** a model or union the vocabulary declares, by name */
  function vocabType(name: string): Model | Union {
    const ns = program.getGlobalNamespaceType().namespaces.get('PhaseLock')!;
    return (ns.models.get(name) ?? ns.unions.get(name))!;
  }

  // the intake results, each named for its vocabulary type over its vocabulary shape
  function resultType(name: string): PResult {
    if (name === 'PasswordHash') return registry.result(name, registry.string());
    return registry.result(name, lowerModel(vocabType(name) as Model));
  }

  /** lower a vocabulary type by identity, or undefined for one that lowers like any other */
  function lowerVocab(name: string, type: Type): PType | undefined {
    switch (name) {
      case 'NewPassword':
        return registry.intake(name, registry.string(), resultType('PasswordHash'));
      case 'CaptchaToken':
        return registry.intake(name, registry.string(), resultType('CaptchaResult'));
      case 'IdentityProof':
        return registry.intake(name, registry.string(), resultType('IdentityResult'));
      case 'CommandAuth':
        return registry.intake(name, lowerUnion(type as Union), resultType('CommandAuthResult'));
      case 'PasswordHash':
      case 'CaptchaResult':
      case 'CommandAuthResult':
      case 'IdentityResult':
        return resultType(name);
      case 'Death':
      case 'Erasure':
        reportDiagnostic(program, { code: 'death-placement', target: type });
        return registry.json();
      default:
        return undefined;
    }
  }

  function lowerScalar(scalar: Scalar): PType {
    // walk the extends chain up to a vocabulary scalar or a TypeSpec standard scalar
    for (let s: Scalar | undefined = scalar; s !== undefined; s = s.baseScalar) {
      const vocab = vocabName(s);
      if (vocab !== undefined) {
        const lowered = lowerVocab(vocab, s);
        if (lowered !== undefined) return lowered;
      }
      if (s.namespace === undefined || !isStdNamespace(s.namespace)) continue;
      switch (s.name) {
        case 'string':
        case 'url':
          return registry.string();
        case 'boolean':
          return registry.bool();
        case 'integer':
        case 'safeint':
        case 'int8':
        case 'int16':
        case 'int32':
        case 'int64':
        case 'uint8':
        case 'uint16':
        case 'uint32':
        case 'uint64':
          return registry.int();
        case 'utcDateTime':
        case 'offsetDateTime':
        case 'plainDate':
        case 'plainTime':
          return registry.date();
        default:
          return unsupported(scalar, `scalar ${s.name}`);
      }
    }
    return unsupported(scalar, `scalar ${scalar.name}`);
  }

  function lowerModel(model: Model): PType {
    if (isArrayModelType(model)) {
      return registry.array(lowerType(model.indexer.value));
    }
    if (isRecordModelType(model)) {
      return registry.object(lowerType(model.indexer.value));
    }
    const fields: PField[] = [];
    for (const prop of walkPropertiesInherited(model)) {
      fields.push([prop.name, lowerType(prop.type), prop.optional]);
    }
    return registry.struct(fields);
  }

  function lowerUnion(union: Union): PType {
    return registry.union([...union.variants.values()].map((v) => lowerType(v.type)));
  }

  function lowerEnum(en: Enum): PType {
    // an enum is sugar for a union of literals
    const literals = [...en.members.values()].map((m) => registry.literal(m.value ?? m.name));
    return registry.union(literals);
  }

  function lowerType(type: Type): PType {
    const cached = typeCache.get(type);
    if (cached !== undefined) return cached;
    const ct = lowerTypeUncached(type);
    typeCache.set(type, ct);
    if (!targets.has(ct)) targets.set(ct, type);
    return ct;
  }

  function lowerTypeUncached(type: Type): PType {
    // the vocabulary's own types lower by identity, not by shape
    const vocab = vocabName(type);
    if (vocab !== undefined && type.kind !== 'Scalar') {
      const lowered = lowerVocab(vocab, type);
      if (lowered !== undefined) return lowered;
    }

    switch (type.kind) {
      case 'Model':
        return lowerModel(type);
      case 'Union':
        return lowerUnion(type);
      case 'Scalar':
        return lowerScalar(type);
      case 'String':
        return registry.literal(type.value);
      case 'Boolean':
        return registry.literal(type.value);
      case 'Number':
        if (!Number.isInteger(type.value)) {
          return unsupported(type, `non-integer numeric literal ${type.value}`);
        }
        return registry.literal(type.value);
      case 'Tuple':
        return registry.tuple(type.values.map((v) => lowerType(v)));
      case 'Enum':
        return lowerEnum(type);
      case 'Intrinsic':
        if (type.name === 'null') return registry.null_();
        if (type.name === 'unknown') return registry.json();
        return unsupported(type, `intrinsic ${type.name}`);
      default:
        return unsupported(type, type.kind);
    }
  }

  /** Lower an interface extending PhaseLock.Slice into a PSlice. */
  function lowerSlice(iface: Interface): PSlice | undefined {
    if (sliceCache.has(iface)) return sliceCache.get(iface);
    sliceCache.set(iface, undefined);

    const instance = vocabSource(iface, 'Slice')!;
    const [familyArg, eventsArg, specArg] = (instance.templateMapper?.args ?? []).map(argType);

    // the family template: a name, then its parameters
    if (familyArg?.kind !== 'String') {
      invalidArgs(iface, `Slice 'Family' argument of '${iface.name}' must be a string`);
      return undefined;
    }
    const tpl = familyArg.value;
    if (!TEMPLATE_PATTERN.test(tpl)) {
      reportDiagnostic(program, {
        code: 'invalid-slice-family',
        format: { family: tpl },
        target: iface,
      });
      return undefined;
    }
    const family = tpl.split(':')[0];
    const params = [...tpl.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);

    // the events: a named union of named models, or a single named model
    const named =
      (eventsArg?.kind === 'Union' || eventsArg?.kind === 'Model') &&
      eventsArg.name !== undefined &&
      eventsArg.name !== '';
    if (!named) {
      reportDiagnostic(program, {
        code: 'slice-events-not-named',
        format: { name: iface.name },
        target: iface,
      });
      return undefined;
    }
    const eventModels = eventsArg.kind === 'Union' ? unionModels(eventsArg) : [eventsArg];
    for (const ev of eventModels) {
      const isNamedModel =
        ev.kind === 'Model' && ev.name !== '' && !isArrayModelType(ev) && !isRecordModelType(ev);
      if (!isNamedModel) {
        reportDiagnostic(program, {
          code: 'slice-event-not-model',
          format: { name: iface.name, found: nameOf(ev) },
          target: iface,
        });
        return undefined;
      }
    }
    const events = lowerType(eventsArg);

    // the key layout: the Spec model's property names are the key templates
    if (specArg?.kind !== 'Model') {
      invalidArgs(iface, `Slice 'Spec' argument of '${iface.name}' must be a model`);
      return undefined;
    }
    for (const tpl of specArg.properties.keys()) {
      if (!TEMPLATE_PATTERN.test(tpl)) {
        reportDiagnostic(program, {
          code: 'invalid-key-template',
          format: { tpl, name: iface.name },
          target: iface,
        });
        return undefined;
      }
    }
    let store: PStore;
    try {
      store = new PStore([...specArg.properties.values()].map((p) => [p.name, lowerType(p.type)]));
    } catch (e) {
      reportDiagnostic(program, {
        code: 'store-collision',
        format: { message: (e as Error).message },
        target: iface,
      });
      return undefined;
    }

    // a global accessor takes the family's parameters, then the key's, so no name may repeat
    for (const item of store.items) {
      for (const param of item.params) {
        if (params.includes(param)) {
          reportDiagnostic(program, {
            code: 'duplicate-key-param',
            format: { tpl: item.tpl, name: iface.name, param },
            target: iface,
          });
        }
      }
    }

    const slice = new PSlice(iface.name, family, params, events, store);
    sliceCache.set(iface, slice);
    sources.set(slice, iface);
    return slice;
  }

  /** the slices a tuple of Slice interfaces names, reporting any member that is not one */
  function sliceList(owner: Interface, arg: Type | undefined, what: string): PSlice[] {
    if (arg?.kind !== 'Tuple') {
      invalidArgs(owner, `${what} of '${owner.name}' must be a tuple of Slices`);
      return [];
    }
    const out: PSlice[] = [];
    for (const member of arg.values) {
      if (member.kind !== 'Interface' || vocabSource(member, 'Slice') === undefined) {
        reportDiagnostic(program, {
          code: 'not-a-slice',
          format: { name: nameOf(member) },
          target: owner,
        });
        continue;
      }
      const slice = lowerSlice(member);
      if (slice !== undefined) out.push(slice);
    }
    return out;
  }

  // which slices fold each event type, for labelling command outputs
  const eventSlices = new Map<PType, PSlice[]>();

  /** Lower a `@command` output, reporting anything that is not a combination of events. */
  function lowerOutput(cmd: Model, type: Type): POutput {
    const invalid = (found: string): POutput => {
      reportDiagnostic(program, {
        code: 'invalid-command-output',
        format: { name: cmd.name, found },
        target: cmd,
      });
      return { kind: 'all', items: [] };
    };

    switch (type.kind) {
      case 'Model': {
        if (vocabName(type) === 'Death') return { kind: 'death', erase: false };
        if (vocabName(type) === 'Erasure') return { kind: 'death', erase: true };
        if (isArrayModelType(type)) {
          return { kind: 'many', item: lowerOutput(cmd, type.indexer.value) };
        }
        if (isRecordModelType(type) || type.name === '') return invalid(nameOf(type));
        const event = lowerType(type);
        const slices = eventSlices.get(event) ?? [];
        if (slices.length === 0) {
          reportDiagnostic(program, {
            code: 'command-output-not-event',
            format: { name: cmd.name, event: type.name },
            target: cmd,
          });
        }
        return { kind: 'event', type: event, slices };
      }
      case 'Union':
        return {
          kind: 'oneOf',
          options: [...type.variants.values()].map((v) => lowerOutput(cmd, v.type)),
        };
      case 'Tuple':
        return { kind: 'all', items: type.values.map((v) => lowerOutput(cmd, v)) };
      case 'String':
        return invalid(`"${type.value}"`);
      default:
        return invalid(nameOf(type));
    }
  }

  function lowerCommand(model: Model, output: Type): PCommand {
    const cached = commandCache.get(model);
    if (cached !== undefined) return cached;
    const cmd = new PCommand(
      model.name,
      lowerType(model),
      lowerOutput(model, output),
      isOnline(program, model),
    );
    commandCache.set(model, cmd);
    sources.set(cmd, model);
    return cmd;
  }

  /**
   * the commands a commands argument names, a union of `@command` models or a single one,
   * reporting any member that has no `@command`
   */
  function commandList(owner: Interface, arg: Type): PCommand[] {
    const models = arg.kind === 'Union' ? unionModels(arg) : [arg];
    const out: PCommand[] = [];
    for (const m of models) {
      const output = m.kind === 'Model' ? getCommandOutput(program, m) : undefined;
      if (output === undefined) {
        reportDiagnostic(program, {
          code: 'not-a-command',
          format: { name: nameOf(m), owner: owner.name },
          target: owner,
        });
        continue;
      }
      out.push(lowerCommand(m as Model, output));
    }
    return out;
  }

  /** Lower an interface extending PhaseLock.Engine into a PEngine. */
  function lowerEngine(iface: Interface): PEngine | undefined {
    if (engineCache.has(iface)) return engineCache.get(iface);
    engineCache.set(iface, undefined);

    const instance = vocabSource(iface, 'Engine')!;
    const [slicesArg, commandsArg] = (instance.templateMapper?.args ?? []).map(argType);
    const slices = sliceList(iface, slicesArg, "Engine 'Slices'");

    // the commands: a named union, or a single named command; decoders are looked up by name
    const named =
      (commandsArg?.kind === 'Union' || commandsArg?.kind === 'Model') &&
      commandsArg.name !== undefined &&
      commandsArg.name !== '';
    if (!named) {
      invalidArgs(
        iface,
        `Engine '${iface.name}' Commands must be a named union of commands, or one named command`,
      );
      return undefined;
    }
    const commands = commandList(iface, commandsArg);

    const eng = new PEngine(iface.name, slices, lowerType(commandsArg), commands);
    engineCache.set(iface, eng);
    sources.set(eng, iface);
    return eng;
  }

  /** Lower an interface extending PhaseLock.Database into a PDatabase. */
  function lowerDatabase(iface: Interface): PDatabase | undefined {
    const instance = vocabSource(iface, 'Database')!;
    const [enginesArg, slicesArg, commandsArg] = (instance.templateMapper?.args ?? []).map(argType);

    // its engines
    if (enginesArg?.kind !== 'Tuple') {
      invalidArgs(iface, `Database 'Engines' of '${iface.name}' must be a tuple of Engines`);
      return undefined;
    }
    const engines: PEngine[] = [];
    for (const member of enginesArg.values) {
      if (member.kind !== 'Interface' || vocabSource(member, 'Engine') === undefined) {
        reportDiagnostic(program, {
          code: 'not-an-engine',
          format: { name: nameOf(member) },
          target: iface,
        });
        continue;
      }
      const eng = lowerEngine(member);
      if (eng !== undefined) engines.push(eng);
    }

    // its own slices and commands; `never` is none
    const slices = sliceList(iface, slicesArg, "Database 'Slices'");
    const noCommands =
      commandsArg === undefined ||
      (commandsArg.kind === 'Intrinsic' && commandsArg.name === 'never');
    const commands = noCommands ? [] : commandList(iface, commandsArg);

    const db = new PDatabase(iface.name, engines, slices, commands);
    sources.set(db, iface);
    return db;
  }

  function assignName(ct: PType, declName: string, target: Type): void {
    if (ct.name === null) {
      ct.name = declName;
    } else if (ct.name !== declName) {
      // two declarations resolved to the same structural type under different names
      reportDiagnostic(program, {
        code: 'duplicate-name',
        format: { name: declName, other: ct.name },
        target,
      });
    }
  }

  /** sort declarations by their position in the source */
  function sourceOrder<T extends Type>(types: T[]): T[] {
    return types
      .map((t, i) => {
        const loc = getSourceLocation(t);
        return { t, i, file: loc?.file?.path ?? '', pos: loc?.pos ?? 0 };
      })
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos || a.i - b.i))
      .map((x) => x.t);
  }

  const globalNs = program.getGlobalNamespaceType();

  // named data types: models, unions, and enums, in source order
  const models = sourceOrder(
    [...globalNs.models.values()].filter((m) => !isTemplateDeclaration(m)),
  );
  const namedDecls: (Model | Union | Enum)[] = sourceOrder([
    ...models,
    ...[...globalNs.unions.values()].filter((u) => u.name !== undefined),
    ...globalNs.enums.values(),
  ]);
  for (const decl of namedDecls) {
    assignName(lowerType(decl), decl.name!, decl);
  }

  // slices first, so that command outputs can name the slices that fold each event
  const userInterfaces = sourceOrder(
    [...globalNs.interfaces.values()].filter((i) => !isTemplateDeclaration(i)),
  );
  const slices: PSlice[] = [];
  for (const iface of userInterfaces) {
    if (vocabSource(iface, 'Slice') === undefined) continue;
    const slice = lowerSlice(iface);
    if (slice === undefined) continue;
    slices.push(slice);
    for (const ev of slice.eventTypes) {
      const folds = eventSlices.get(ev) ?? [];
      if (!folds.includes(slice)) folds.push(slice);
      eventSlices.set(ev, folds);
    }
  }

  // every @command model, whether or not anything lists it
  const commands: PCommand[] = [];
  for (const model of models) {
    const output = getCommandOutput(program, model);
    if (output !== undefined) commands.push(lowerCommand(model, output));
  }

  // engines, databases, and queries, in source order
  const engines: PEngine[] = [];
  const databases: PDatabase[] = [];
  const queries: PQueries[] = [];
  for (const iface of userInterfaces) {
    if (vocabSource(iface, 'Engine') !== undefined) {
      const eng = lowerEngine(iface);
      if (eng !== undefined) engines.push(eng);
    } else if (vocabSource(iface, 'Database') !== undefined) {
      const db = lowerDatabase(iface);
      if (db !== undefined) databases.push(db);
    } else if (vocabSource(iface, 'Queries') !== undefined) {
      const ops: PQuery[] = [];
      for (const op of iface.operations.values()) {
        const args: PField[] = [];
        for (const param of op.parameters.properties.values()) {
          args.push([param.name, lowerType(param.type), param.optional]);
        }
        ops.push(new PQuery(op.name, args, lowerType(op.returnType)));
      }
      const kq = new PQueries(ops);
      kq.name = iface.name;
      queries.push(kq);
    }
  }

  const roots = registry.all.filter((t) => t.name !== null);
  return { registry, roots, slices, commands, engines, databases, queries, targets, sources };
}
