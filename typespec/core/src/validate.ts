/**
 * $onValidate: run the lowering pass (whose diagnostics — store collisions, invalid template
 * args, unsupported types, ... — otherwise only fire at emit time), then check what only the whole
 * program shows, plus a solver pass over every union, so problems surface as compiler/IDE
 * diagnostics instead of emitter crashes.
 */

import { NoTarget, type Program, type Type } from '@typespec/compiler';

import { reportDiagnostic } from './lib.ts';
import { type LoweredProgram, lowerProgram } from './lower.ts';
import {
  PArray,
  type PCommand,
  PIntake,
  PObject,
  type POutput,
  PResult,
  type PSlice,
  PStruct,
  PTuple,
  type PType,
  PUnion,
} from './ptypes.ts';
import { solveUnion } from './solver.ts';

export function $onValidate(program: Program): void {
  // checker errors (unknown identifiers etc.) produce error types that would only cascade into
  // noise here; let the user fix those first
  if (program.hasError()) return;

  const lowered = lowerProgram(program);
  checkCompositions(program, lowered);
  checkDatabaseOutputs(program, lowered);
  checkIntake(program, lowered);
  checkReachability(program, lowered);

  // Try solving every union so decoder/checker generation can't fail later.  Checkers must
  // discriminate every union they encounter, so every union in the model has to be mechanically
  // distinguishable.  (Snapshot registry.all first: the arrays path of the solver can intern
  // new unions while we iterate.)
  for (const ct of [...lowered.registry.all]) {
    if (!(ct instanceof PUnion)) continue;
    try {
      solveUnion(lowered.registry, ct.types);
    } catch (e) {
      reportDiagnostic(program, {
        code: 'union-unsolvable',
        format: { message: (e as Error).message },
        target: lowered.targets.get(ct) ?? NoTarget,
      });
    }
  }
}

/**
 * Slices composed into one engine or one database share its reducer table and its global
 * context, so their families must differ and so must their local key names.
 */
function checkCompositions(program: Program, lowered: LoweredProgram): void {
  const contexts = [...lowered.engines, ...lowered.databases];
  for (const ctx of contexts) {
    const target = lowered.sources.get(ctx) ?? NoTarget;
    const families = new Map<string, PSlice>();
    const keys = new Map<string, PSlice>();
    for (const slice of ctx.slices) {
      // one reducer per family
      const other = families.get(slice.family);
      if (other !== undefined && other !== slice) {
        reportDiagnostic(program, {
          code: 'family-collision',
          format: { slice: slice.name, other: other.name, owner: ctx.name, family: slice.family },
          target,
        });
      }
      families.set(slice.family, slice);

      // one global accessor per local key name
      for (const item of slice.store.items) {
        const owner = keys.get(item.name);
        if (owner !== undefined && owner !== slice) {
          reportDiagnostic(program, {
            code: 'key-name-collision',
            format: { key: item.name, slice: slice.name, other: owner.name, owner: ctx.name },
            target,
          });
        }
        keys.set(item.name, slice);
      }
    }
  }
}

/** the events an output names, each with the slices that fold it */
function outputEvents(o: POutput): { type: PType; slices: readonly PSlice[] }[] {
  switch (o.kind) {
    case 'event':
      return [o];
    case 'death':
      return [];
    case 'oneOf':
      return o.options.flatMap(outputEvents);
    case 'all':
      return o.items.flatMap(outputEvents);
    case 'many':
      return outputEvents(o.item);
  }
}

/** every event a database's command emits must land in a slice of that database */
function checkDatabaseOutputs(program: Program, lowered: LoweredProgram): void {
  for (const db of lowered.databases) {
    for (const cmd of db.commands) {
      for (const ev of outputEvents(cmd.output)) {
        if (ev.slices.length === 0 || ev.slices.some((s) => db.slices.includes(s))) continue;
        reportDiagnostic(program, {
          code: 'command-output-outside-db',
          format: { name: cmd.name, db: db.name, event: ev.type.name ?? String(ev.type) },
          target: lowered.sources.get(db) ?? NoTarget,
        });
      }
    }
  }
}

/** the kind of the first intake type a type holds, looking through containers but not into
    structs, or undefined */
function intakeKind(t: PType): string | undefined {
  if (t instanceof PIntake) return t.kind;
  if (t instanceof PArray) return intakeKind(t.itemType);
  if (t instanceof PObject) return intakeKind(t.valueType);
  if (t instanceof PTuple) return t.itemTypes.map(intakeKind).find((k) => k !== undefined);
  if (t instanceof PUnion) return t.types.map(intakeKind).find((k) => k !== undefined);
  return undefined;
}

/** the first intake result a type holds, anywhere inside it, or undefined */
function findResult(t: PType, seen = new Set<PType>()): PResult | undefined {
  if (seen.has(t)) return undefined;
  seen.add(t);
  if (t instanceof PResult) return t;
  if (t instanceof PIntake) return undefined; // an intake's result is intake's own business
  if (t instanceof PArray) return findResult(t.itemType, seen);
  if (t instanceof PObject) return findResult(t.valueType, seen);
  if (t instanceof PTuple) return t.itemTypes.map((x) => findResult(x, seen)).find((b) => b);
  if (t instanceof PUnion) return t.types.map((x) => findResult(x, seen)).find((b) => b);
  if (t instanceof PStruct)
    return [...t.fields.values()].map((x) => findResult(x, seen)).find((b) => b);
  return undefined;
}

/**
 * Intake types are transformed by the database before precommit runs, so they may only be
 * top-level fields of commands, which then must be @online; their results come only from
 * intake, so no command may carry one, where a client could forge it.
 */
function checkIntake(program: Program, lowered: LoweredProgram): void {
  const commandOf = new Map<PType, PCommand>();
  for (const cmd of lowered.commands) commandOf.set(cmd.type, cmd);
  const events = new Set(lowered.slices.flatMap((s) => s.eventTypes));
  const placement = (kind: string, where: string, target: Type | typeof NoTarget) =>
    reportDiagnostic(program, { code: 'placement-violation', format: { kind, where }, target });

  // every struct: an intake type is fine only as a command's own top-level field
  for (const t of lowered.registry.all) {
    if (!(t instanceof PStruct)) continue;
    const cmd = commandOf.get(t);
    const target = lowered.targets.get(t) ?? NoTarget;
    const where = t.name ?? String(t);
    for (const [, ft] of t.fields) {
      const kind = intakeKind(ft);
      if (ft instanceof PIntake) {
        if (cmd === undefined) placement(ft.kind, where, target);
        else if (events.has(t)) placement(ft.kind, `event ${where}`, target);
      } else if (kind !== undefined) {
        placement(kind, where, target);
      }
    }
  }

  // store values and queries hold no intake type at all
  for (const slice of lowered.slices) {
    for (const item of slice.store.items) {
      const kind = intakeKind(item.type);
      if (kind === undefined) continue;
      placement(
        kind,
        `slice ${slice.name} key ${item.tpl}`,
        lowered.sources.get(slice) ?? NoTarget,
      );
    }
  }
  for (const kq of lowered.queries) {
    for (const q of kq.queries) {
      const types = [q.result, ...q.args.map(([, t]) => t)];
      const kind = types.map(intakeKind).find((k) => k !== undefined);
      if (kind === undefined) continue;
      placement(kind, `query ${kq.name}.${q.name}`, NoTarget);
    }
  }

  // commands: intake types require @online, and results are never accepted from a client
  for (const cmd of lowered.commands) {
    const target = lowered.sources.get(cmd) ?? NoTarget;
    const struct = cmd.type instanceof PStruct ? cmd.type : undefined;
    const intake = struct && [...struct.fields.values()].find((ft) => ft instanceof PIntake);
    if (intake !== undefined && !cmd.online) {
      reportDiagnostic(program, {
        code: 'online-required',
        format: { name: cmd.name, kind: (intake as PIntake).kind },
        target,
      });
    }
    const result = findResult(cmd.type);
    if (result !== undefined) {
      reportDiagnostic(program, {
        code: 'result-in-command',
        format: { name: cmd.name, result: result.kind },
        target,
      });
    }
  }
}

/** with a database present, warn about slices and commands no database holds */
function checkReachability(program: Program, lowered: LoweredProgram): void {
  if (lowered.databases.length === 0) return;
  const slices = new Set(lowered.databases.flatMap((db) => db.slices));
  const commands = new Set(lowered.databases.flatMap((db) => db.commands));
  for (const slice of lowered.slices) {
    if (slices.has(slice)) continue;
    reportDiagnostic(program, {
      code: 'unreachable-slice',
      format: { name: slice.name },
      target: lowered.sources.get(slice) ?? NoTarget,
    });
  }
  for (const cmd of lowered.commands) {
    if (commands.has(cmd)) continue;
    reportDiagnostic(program, {
      code: 'unreachable-command',
      format: { name: cmd.name },
      target: lowered.sources.get(cmd) ?? NoTarget,
    });
  }
}
