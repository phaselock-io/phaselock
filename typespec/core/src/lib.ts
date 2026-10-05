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
        default: paramMessage`slice family '${'family'}' must be a name of A-Z a-z 0-9 _ -, followed only by .{param} segments`,
      },
    },
    'invalid-key-template': {
      severity: 'error',
      messages: {
        default: paramMessage`key template '${'tpl'}' in slice '${'name'}' must be a name of A-Z a-z 0-9 _ -, followed only by .{param} segments`,
      },
    },
    'slice-events-not-named': {
      severity: 'error',
      messages: {
        default: paramMessage`the events of slice '${'name'}' must be a named union`,
      },
    },
    'slice-event-not-model': {
      severity: 'error',
      messages: {
        default: paramMessage`every event of slice '${'name'}' must be a named model (found ${'found'})`,
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
    'not-a-command': {
      severity: 'error',
      messages: {
        default: paramMessage`'${'name'}' is listed as a command of '${'owner'}' but has no @command`,
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
    'invalid-command-output': {
      severity: 'error',
      messages: {
        default: paramMessage`the @command output of '${'name'}' may only combine event models, Death, unions, tuples, and arrays (found ${'found'})`,
      },
    },
    'command-output-not-event': {
      severity: 'error',
      messages: {
        default: paramMessage`the @command output of '${'name'}' names '${'event'}', which no slice folds`,
      },
    },
    'command-output-outside-db': {
      severity: 'error',
      messages: {
        default: paramMessage`command '${'name'}' of '${'db'}' emits '${'event'}', which no slice of '${'db'}' folds`,
      },
    },
    'death-placement': {
      severity: 'error',
      messages: {
        default: `Death may only appear in a @command output`,
      },
    },
    'placement-violation': {
      severity: 'error',
      messages: {
        default: paramMessage`${'kind'} may only be a top-level field of a command (found in ${'where'})`,
      },
    },
    'online-required': {
      severity: 'error',
      messages: {
        default: paramMessage`command '${'name'}' carries ${'kind'} and so must be @online`,
      },
    },
    'result-in-command': {
      severity: 'error',
      messages: {
        default: paramMessage`command '${'name'}' carries ${'result'}, which only the database puts in a command, when it prepares the command for precommit`,
      },
    },
    'unreachable-slice': {
      severity: 'warning',
      messages: {
        default: paramMessage`slice '${'name'}' is in no Database`,
      },
    },
    'unreachable-command': {
      severity: 'warning',
      messages: {
        default: paramMessage`command '${'name'}' is in no Database`,
      },
    },
  },
} as const);

export const { reportDiagnostic } = $lib;
