/**
 * $onValidate: run the lowering pass (whose diagnostics — store collisions, invalid template
 * args, unsupported types, ... — otherwise only fire at emit time) plus a solver pass over
 * every union, so problems surface as compiler/IDE diagnostics instead of emitter crashes.
 */

import { NoTarget, type Program } from '@typespec/compiler';

import { PUnion } from './ptypes.js';
import { reportDiagnostic } from './lib.js';
import { lowerProgram } from './lower.js';
import { solveUnion } from './solver.js';

export function $onValidate(program: Program): void {
  // checker errors (unknown identifiers etc.) produce error types that would only cascade into
  // noise here; let the user fix those first
  if (program.hasError()) return;

  const lowered = lowerProgram(program);

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
