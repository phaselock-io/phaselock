import { fileURLToPath } from 'node:url';

import { lowerProgram } from '@phaselock/typespec';
import { type EmitContext, emitFile, resolvePath } from '@typespec/compiler';

import { generatePy } from './emitter.js';
import { $lib, type PyEmitterOptions } from './lib.js';

export { $lib };
export { generatePy } from './emitter.js';

/**
 * The skeleton is the runtime support code (Engine base class, store helpers, JSON type)
 * prepended to every generated module.  Generated code depends on it, so a skeleton is always
 * included: the packaged default unless the `skeleton` option overrides it.  The default ships
 * as assets/skeleton.py so users can copy it as the basis for an override.
 */
const DEFAULT_SKELETON = fileURLToPath(new URL('../../assets/skeleton.py', import.meta.url));

export async function $onEmit(context: EmitContext<PyEmitterOptions>) {
  const program = context.program;

  const lowered = lowerProgram(program);
  if (program.hasError()) return;

  const skeletonOpt = context.options['skeleton'];
  const skeletonPath = skeletonOpt
    ? resolvePath(program.projectRoot, skeletonOpt)
    : DEFAULT_SKELETON;
  const skeleton = (await program.host.readFile(skeletonPath)).text;

  const content = generatePy(lowered, skeleton);

  if (!program.compilerOptions.noEmit && !program.hasError()) {
    await emitFile(program, {
      path: resolvePath(context.emitterOutputDir, context.options['out-file'] ?? 'model.py'),
      content,
    });
  }
}
