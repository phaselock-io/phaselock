import { createTypeSpecLibrary, paramMessage } from '@typespec/compiler';

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec',
  diagnostics: {
    'invalid-key-template': {
      severity: 'error',
      messages: {
        default: paramMessage`store key template '${'tpl'}' does not have a name before a '.'`,
      },
    },
    'store-collision': {
      severity: 'error',
      messages: { default: paramMessage`${'message'}` },
    },
    'not-a-store': {
      severity: 'error',
      messages: {
        default: paramMessage`'${'name'}' is not a Store (expected an interface extending PhaseLock.Store)`,
      },
    },
    'invalid-template-args': {
      severity: 'error',
      messages: { default: paramMessage`${'message'}` },
    },
    'union-unsolvable': {
      severity: 'error',
      messages: { default: paramMessage`${'message'}` },
    },
    'duplicate-name': {
      severity: 'error',
      messages: {
        default: paramMessage`found name ${'name'} which resolves to the same type as ${'other'}`,
      },
    },
    'unsupported-type': {
      severity: 'error',
      messages: {
        default: paramMessage`unsupported type in PhaseLock model: ${'message'}`,
      },
    },
  },
} as const);

export const { reportDiagnostic } = $lib;
