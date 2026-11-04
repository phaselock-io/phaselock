import { lowerProgram } from '@phaselock/typespec-core';
import { type EmitContext, emitFile, resolvePath } from '@typespec/compiler';

import { generateKotlin } from './emitter.ts';
import { $lib, type KtEmitterOptions } from './lib.ts';

export { $lib };
export { generateKotlin } from './emitter.ts';

export async function $onEmit(context: EmitContext<KtEmitterOptions>) {
  const program = context.program;

  const lowered = lowerProgram(program);
  if (program.hasError()) return;

  const content = generateKotlin(lowered, context.options['package']);

  if (!program.compilerOptions.noEmit && !program.hasError()) {
    await emitFile(program, {
      path: resolvePath(context.emitterOutputDir, context.options['out-file'] ?? 'Model.gen.kt'),
      content,
    });
  }
}
