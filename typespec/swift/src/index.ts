import { lowerProgram } from '@phaselock/typespec-core';
import { type EmitContext, emitFile, resolvePath } from '@typespec/compiler';

import { generateSwift } from './emitter.ts';
import { $lib, type SwiftEmitterOptions } from './lib.ts';

export { $lib };
export { generateSwift } from './emitter.ts';

export async function $onEmit(context: EmitContext<SwiftEmitterOptions>) {
  const program = context.program;

  const lowered = lowerProgram(program);
  if (program.hasError()) return;

  const content = generateSwift(lowered, context.options['module']);

  if (!program.compilerOptions.noEmit && !program.hasError()) {
    await emitFile(program, {
      path: resolvePath(context.emitterOutputDir, context.options['out-file'] ?? 'Model.gen.swift'),
      content,
    });
  }
}
