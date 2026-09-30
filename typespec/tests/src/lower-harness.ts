/**
 * Shared harness for the core tests: compile TypeSpec source in memory with the PhaseLock
 * vocabulary, collect the diagnostics (validation included), and lower the program.
 */

import { fileURLToPath } from 'node:url';

import { type LoweredProgram, lowerProgram, type PType } from '@phaselock/typespec-core';
import { type Program, resolvePath } from '@typespec/compiler';
import { createTester } from '@typespec/compiler/testing';

const base = fileURLToPath(new URL('..', import.meta.url));

// source compiled as written, for whole files that import the vocabulary themselves
const RawTester = createTester(resolvePath(base), { libraries: ['@phaselock/typespec-core'] });

// source compiled with the vocabulary imported and in scope, for snippets
const Tester = RawTester.import('@phaselock/typespec-core').using('PhaseLock');

export interface Diag {
  /** the code without its library prefix, e.g. 'store-collision' */
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface Lowered {
  program: Program;
  diagnostics: Diag[];
  lowered: LoweredProgram;
}

async function compile(tester: typeof RawTester, code: string): Promise<Lowered> {
  const [result, diagnostics] = await tester.compileAndDiagnose(code);
  return {
    program: result.program,
    diagnostics: diagnostics.map((d) => ({
      code: d.code.replace(/^@phaselock\/typespec-core\//, ''),
      severity: d.severity,
      message: d.message,
    })),
    lowered: lowerProgram(result.program),
  };
}

/** compile a snippet with the vocabulary in scope */
export function lower(code: string): Promise<Lowered> {
  return compile(Tester, code);
}

/** compile a whole file's source as written */
export function lowerFile(code: string): Promise<Lowered> {
  return compile(RawTester, code);
}

/** the codes of the diagnostics, in order */
export function codes(l: Lowered): string[] {
  return l.diagnostics.map((d) => d.code);
}

/** Find the named root that lowered from a declaration. */
export function root(l: LoweredProgram, name: string): PType {
  const found = l.roots.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`no root named ${name} in [${l.roots.map((t) => t.name)}]`);
  }
  return found;
}
