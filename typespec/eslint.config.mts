import type { Linter } from 'eslint';

import pluginJs from '@eslint/js';
import parserTs from '@typescript-eslint/parser';
import pluginTs from '@typescript-eslint/eslint-plugin';
import pluginViTest from '@vitest/eslint-plugin';
import configPrettier from 'eslint-config-prettier/flat';
import pluginImport from 'eslint-plugin-import';

export default [
  pluginJs.configs.recommended,
  pluginTs.configs['flat/eslint-recommended'],
  pluginImport.flatConfigs.recommended,
  { ignores: ['**/dist/', 'tests/tsp-output/', '**/*.mts'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: parserTs,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['ts/assets/skeleton.ts'],
        },
      },
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': pluginTs,
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-nocheck': 'allow-with-description' }],
      '@typescript-eslint/no-redeclare': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      'eqeqeq': ['error', 'smart'],
      'import/extensions': ['warn', { ts: 'never' }],
      'import/order': [
        'error',
        {
          'alphabetize': { caseInsensitive: true, order: 'asc' },
          'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
        },
      ],
      'import/no-duplicates': 'error',
      'no-console': 'error',
      'no-constant-condition': 'off',
      'no-throw-literal': 'error',
      'no-unused-vars': 'off',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'require-await': 'error',
      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
        },
      ],
    },
    settings: {
      'import/resolver': { typescript: { project: '**/tsconfig.json' } },
    },
  },
  {
    files: ['tests/src/**/*.test.ts'],
    plugins: { vitest: pluginViTest },
    rules: {
      ...pluginViTest.configs.recommended.rules,
      // generated fixtures are imported straight from tsp-output with their .ts extension
      'import/extensions': 'off',
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'ok', 'fails'] }],
    },
  },
  configPrettier,
] satisfies Linter.Config[];
