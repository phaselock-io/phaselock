/**
 * The vocabulary's decorators.  Each only records its arguments in program state; lowering reads
 * them back and does all the checking.
 */

import type { DecoratorContext, Model, Program, Type } from '@typespec/compiler';

import { $lib } from './lib.ts';

const commandKey = $lib.createStateSymbol('command');
const onlineKey = $lib.createStateSymbol('online');

function $command(context: DecoratorContext, target: Model, output: Type): void {
  context.program.stateMap(commandKey).set(target, output);
}

function $online(context: DecoratorContext, target: Model): void {
  context.program.stateSet(onlineKey).add(target);
}

/** the implementations the compiler binds to the `extern dec` declarations in main.tsp */
export const $decorators = {
  PhaseLock: { command: $command, online: $online },
};

/** the output a `@command` declared, or undefined for a model that is not a command */
export function getCommandOutput(program: Program, model: Model): Type | undefined {
  return program.stateMap(commandKey).get(model) as Type | undefined;
}

export function isOnline(program: Program, model: Model): boolean {
  return program.stateSet(onlineKey).has(model);
}
