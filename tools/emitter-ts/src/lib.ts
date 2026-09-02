import { createTypeSpecLibrary, type JSONSchemaType } from '@typespec/compiler';

export interface TsEmitterOptions {
  /** path to a skeleton file to prepend verbatim, relative to the tsp project root */
  'skeleton'?: string;
  /** output filename within the emitter output dir (default model.gen.ts) */
  'out-file'?: string;
}

const EmitterOptionsSchema: JSONSchemaType<TsEmitterOptions> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    'skeleton': {
      type: 'string',
      nullable: true,
      description:
        'Path (relative to the project root) to a skeleton .ts file prepended to the output, ' +
        "overriding the packaged default.  Copy the emitter's assets/skeleton.ts as a starting point.",
    },
    'out-file': {
      type: 'string',
      nullable: true,
      description: 'Output filename (default model.gen.ts)',
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-ts',
  diagnostics: {},
  emitter: { options: EmitterOptionsSchema },
} as const);
