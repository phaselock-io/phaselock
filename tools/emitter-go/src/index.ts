import { fileURLToPath } from 'node:url';

import { lowerProgram } from '@phaselock/typespec';
import { type EmitContext, emitFile, resolvePath } from '@typespec/compiler';

import { generateGo } from './emitter.js';
import { $lib, type GoEmitterOptions } from './lib.js';

export { $lib };
export { generateGo } from './emitter.js';

/**
 * The skeleton is the runtime support code (Engine, goja glue, query plumbing) prepended to
 * every generated file.  Generated code depends on it, so a skeleton is always included: the
 * packaged default unless the `skeleton` option overrides it.  The default ships as
 * assets/skeleton.go so users can copy it as the basis for an override.
 */
const DEFAULT_SKELETON = fileURLToPath(new URL('../../assets/skeleton.go', import.meta.url));

export async function $onEmit(context: EmitContext<GoEmitterOptions>) {
  const program = context.program;

  const lowered = lowerProgram(program);
  if (program.hasError()) return;

  const skeletonOpt = context.options['skeleton'];
  const skeletonPath = skeletonOpt
    ? resolvePath(program.projectRoot, skeletonOpt)
    : DEFAULT_SKELETON;
  const skeleton = (await program.host.readFile(skeletonPath)).text;

  const content = generateGo(lowered, skeleton, context.options['package'] ?? 'model');

  if (!program.compilerOptions.noEmit && !program.hasError()) {
    await emitFile(program, {
      path: resolvePath(context.emitterOutputDir, context.options['out-file'] ?? 'model.go'),
      content,
    });
  }
}
