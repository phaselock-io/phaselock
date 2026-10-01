/**
 * Shared harness for the emitter tests: compile TypeSpec source in memory, generate the
 * TypeScript module with the real skeleton, and write it under tsp-output/, where a test can
 * import it or type-check snippets of user code against it with the TypeScript compiler.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lowerProgram } from '@phaselock/typespec-core';
import { generateTs } from '@phaselock/typespec-ts';
import { resolvePath } from '@typespec/compiler';
import { createTester } from '@typespec/compiler/testing';
import ts from 'typescript';

const base = fileURLToPath(new URL('../..', import.meta.url));
const SKELETON = readFileSync(resolvePath(base, '../ts/assets/skeleton.ts'), 'utf8');

const Tester = createTester(resolvePath(base), { libraries: ['@phaselock/typespec-core'] })
  .import('@phaselock/typespec-core')
  .using('PhaseLock');

/** where a test's generated module and snippets live */
export function outDir(name: string): string {
  const dir = resolvePath(base, `tsp-output/.${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Generate the module for a snippet of TypeSpec with the vocabulary in scope, failing on any
    diagnostic, and write it to dir as model.gen.ts.  Returns the generated text and its path. */
export async function emit(source: string, dir: string): Promise<{ text: string; file: string }> {
  const [result, diagnostics] = await Tester.compileAndDiagnose(source);
  if (diagnostics.length > 0) {
    throw new Error(`compile diagnostics:\n${diagnostics.map((d) => d.message).join('\n')}`);
  }
  const text = generateTs(lowerProgram(result.program), SKELETON);
  const file = resolvePath(dir, 'model.gen.ts');
  writeFileSync(file, text);
  return { text, file };
}

/** Type-check each snippet as its own file beside model.gen.ts in dir, which it imports as
    './model.gen.ts', all in one program.  Returns each snippet's diagnostics by name, so a
    snippet asserts its compile errors with `// @ts-expect-error` and expects none left over. */
export function typecheck(dir: string, snippets: Record<string, string>): Record<string, string[]> {
  // one file per snippet
  const files = new Map<string, string>();
  for (const [name, source] of Object.entries(snippets)) {
    const file = resolvePath(dir, `${name}.ts`);
    writeFileSync(file, source);
    files.set(file, name);
  }

  // the tests' own compiler options
  const program = ts.createProgram([...files.keys()], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: ['node'],
    typeRoots: [resolvePath(base, 'node_modules/@types')],
  });

  // each snippet's diagnostics, the generated module's own included under every name
  const out: Record<string, string[]> = {};
  for (const name of files.values()) out[name] = [];
  const general: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const name = d.file === undefined ? undefined : files.get(d.file.fileName);
    if (name === undefined) {
      const where = d.file === undefined ? '' : `${d.file.fileName}: `;
      general.push(`${where}${text}`);
      continue;
    }
    const line = d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    out[name].push(`line ${line}: ${text}`);
  }
  for (const name of files.values()) out[name].push(...general);
  return out;
}
