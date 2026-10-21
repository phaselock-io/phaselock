/**
 * The vocabulary's decorators.  Each only records its target in program state; lowering reads it
 * back and does all the checking.
 */

import type { DecoratorContext, Model, Program } from '@typespec/compiler';

import { $lib } from './lib.ts';

const onlineKey = $lib.createStateSymbol('online');

function $online(context: DecoratorContext, target: Model): void {
  context.program.stateSet(onlineKey).add(target);
}

/** the implementations the compiler binds to the `extern dec` declarations in main.tsp */
export const $decorators = {
  PhaseLock: { online: $online },
};

export function isOnline(program: Program, model: Model): boolean {
  return program.stateSet(onlineKey).has(model);
}

/** every model marked `@online` */
export function onlineModels(program: Program): Model[] {
  return [...program.stateSet(onlineKey)] as Model[];
}
