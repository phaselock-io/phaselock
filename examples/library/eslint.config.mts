import type { Linter } from 'eslint';

import pluginJs from '@eslint/js';
import parserTs from '@typescript-eslint/parser';
import pluginTs from '@typescript-eslint/eslint-plugin';
import configPrettier from 'eslint-config-prettier/flat';
import pluginImport from 'eslint-plugin-import';
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import pluginReactRefresh from 'eslint-plugin-react-refresh';

export default [
  pluginJs.configs.recommended,
  pluginTs.configs['flat/eslint-recommended'],
  pluginImport.flatConfigs.recommended,
  pluginReactRefresh.configs.recommended,
  { ignores: ['**/dist/', 'model/*.gen.ts', 'model/bundle.js', '**/*.mts'] },
  {
    ...pluginReact.configs.flat.recommended,
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: parserTs,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        projectService: {
          allowDefaultProject: ['ui/vite.config.ts'],
        },
      },
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': pluginTs,
      'react': pluginReact,
      'react-hooks': pluginReactHooks,
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
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'eqeqeq': ['error', 'smart'],
      'import/extensions': ['warn', { ts: 'never', tsx: 'never' }],
      'import/order': [
        'error',
        {
          'alphabetize': { caseInsensitive: true, order: 'asc' },
          'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          'pathGroups': [{ group: 'external', pattern: '@/**', position: 'after' }],
        },
      ],
      'import/no-duplicates': 'error',
      'no-constant-condition': 'off',
      'no-throw-literal': 'error',
      'no-unused-vars': 'off',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/self-closing-comp': 'error',
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
      'react': { version: 'detect' },
    },
  },
  configPrettier,
] satisfies Linter.Config[];
