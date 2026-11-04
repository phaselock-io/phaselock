import { createTypeSpecLibrary, type JSONSchemaType } from '@typespec/compiler';

export interface KtEmitterOptions {
  /** the Kotlin package of the generated file */
  'package': string;
  /** output filename within the emitter output dir (default Model.gen.kt) */
  'out-file'?: string;
}

const EmitterOptionsSchema: JSONSchemaType<KtEmitterOptions> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    'package': {
      type: 'string',
      description: 'The Kotlin package of the generated file',
    },
    'out-file': {
      type: 'string',
      nullable: true,
      description: 'Output filename (default Model.gen.kt)',
    },
  },
  required: ['package'],
};

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-kt',
  diagnostics: {},
  emitter: { options: EmitterOptionsSchema },
} as const);
