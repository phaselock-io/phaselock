import { createTypeSpecLibrary, type JSONSchemaType } from '@typespec/compiler';

export interface SwiftEmitterOptions {
  /** the Swift module the generated file compiles into, which qualifies a shadowed type */
  'module': string;
  /** output filename within the emitter output dir (default Model.gen.swift) */
  'out-file'?: string;
}

const EmitterOptionsSchema: JSONSchemaType<SwiftEmitterOptions> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    'module': {
      type: 'string',
      description: 'The Swift module the generated file compiles into',
    },
    'out-file': {
      type: 'string',
      nullable: true,
      description: 'Output filename (default Model.gen.swift)',
    },
  },
  required: ['module'],
};

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-swift',
  diagnostics: {},
  emitter: { options: EmitterOptionsSchema },
} as const);
