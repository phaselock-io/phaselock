import { fileURLToPath } from 'node:url';

import { lowerProgram } from '@phaselock/typespec-core';
import { type EmitContext, emitFile, resolvePath } from '@typespec/compiler';

import { generateTs } from './emitter.js';
import { $lib, type TsEmitterOptions } from './lib.js';

export { $lib };
export { generateTs } from './emitter.js';

/**
 * The skeleton is the runtime support code (Engine base class, store helpers, decoders'
 * shared plumbing) prepended to every generated module.  Generated code depends on it, so a
 * skeleton is always included: the packaged default unless the `skeleton` option overrides it.
 * The default ships as assets/skeleton.ts so users can copy it as the basis for an override.
 */
const DEFAULT_SKELETON = fileURLToPath(new URL('../../assets/skeleton.ts', import.meta.url));

export async function $onEmit(context: EmitContext<TsEmitterOptions>) {
  const program = context.program;

  const lowered = lowerProgram(program);
  if (program.hasError()) return;

  const skeletonOpt = context.options['skeleton'];
  const skeletonPath = skeletonOpt
    ? resolvePath(program.projectRoot, skeletonOpt)
    : DEFAULT_SKELETON;
  const skeleton = (await program.host.readFile(skeletonPath)).text;

  const content = generateTs(lowered, skeleton);

  if (!program.compilerOptions.noEmit && !program.hasError()) {
    await emitFile(program, {
      path: resolvePath(context.emitterOutputDir, context.options['out-file'] ?? 'model.gen.ts'),
      content,
    });
  }
}
