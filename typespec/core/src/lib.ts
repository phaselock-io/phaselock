import { createTypeSpecLibrary, paramMessage } from '@typespec/compiler';

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-core',
  diagnostics: {
    'store-collision': {
      severity: 'error',
      messages: { default: paramMessage`${'message'}` },
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
    'invalid-slice-family': {
      severity: 'error',
      messages: {
        default: paramMessage`slice family '${'family'}' must be a name of A-Z a-z 0-9 _ -, then optionally :{param} and ,{param} for each further parameter`,
      },
    },
    'invalid-key-template': {
      severity: 'error',
      messages: {
        default: paramMessage`key template '${'tpl'}' in slice '${'name'}' must be a name of A-Z a-z 0-9 _ -, then optionally :{param} and ,{param} for each further parameter`,
      },
    },
    'duplicate-key-param': {
      severity: 'error',
      messages: {
        default: paramMessage`key template '${'tpl'}' in slice '${'name'}' repeats the family parameter '${'param'}'`,
      },
    },
    'not-a-slice': {
      severity: 'error',
      messages: {
        default: paramMessage`'${'name'}' is not a Slice (expected an interface extending PhaseLock.Slice)`,
      },
    },
    'not-an-engine': {
      severity: 'error',
      messages: {
        default: paramMessage`'${'name'}' is not an Engine (expected an interface extending PhaseLock.Engine)`,
      },
    },
    'not-a-mutation': {
      severity: 'error',
      messages: {
        default: paramMessage`'${'name'}' is listed as a mutation of '${'owner'}' but is not a named model`,
      },
    },
    'key-name-collision': {
      severity: 'error',
      messages: {
        default: paramMessage`key name '${'key'}' of slice '${'slice'}' collides with slice '${'other'}' in '${'owner'}'`,
      },
    },
    'family-collision': {
      severity: 'error',
      messages: {
        default: paramMessage`slices '${'slice'}' and '${'other'}' in '${'owner'}' share the family '${'family'}'`,
      },
    },
    'placement-violation': {
      severity: 'error',
      messages: {
        default: paramMessage`${'kind'} may only be a top-level field of a mutation (found in ${'where'})`,
      },
    },
    'online-required': {
      severity: 'error',
      messages: {
        default: paramMessage`mutation '${'name'}' carries ${'kind'} and so must be @online`,
      },
    },
    'result-in-mutation': {
      severity: 'error',
      messages: {
        default: paramMessage`mutation '${'name'}' carries ${'result'}, which only the database puts in a mutation, when it prepares the mutation for its decider`,
      },
    },
    'unreachable-slice': {
      severity: 'warning',
      messages: {
        default: paramMessage`slice '${'name'}' is in no Database`,
      },
    },
    'unreachable-mutation': {
      severity: 'warning',
      messages: {
        default: paramMessage`mutation '${'name'}' is in no Database`,
      },
    },
    'online-not-mutation': {
      severity: 'warning',
      messages: {
        default: paramMessage`'${'name'}' is @online, but no Engine or Database lists it as a mutation`,
      },
    },
  },
} as const);

export const { reportDiagnostic } = $lib;
