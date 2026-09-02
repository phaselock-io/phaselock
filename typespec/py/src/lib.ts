import { createTypeSpecLibrary, type JSONSchemaType } from '@typespec/compiler';

export interface PyEmitterOptions {
  'skeleton'?: string;
  'out-file'?: string;
}

const EmitterOptionsSchema: JSONSchemaType<PyEmitterOptions> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    'skeleton': {
      type: 'string',
      nullable: true,
      description:
        'Path (relative to the project root) to a skeleton .py file prepended to the output, ' +
        "overriding the packaged default.  Copy the emitter's assets/skeleton.py as a starting point.",
    },
    'out-file': {
      type: 'string',
      nullable: true,
      description: 'Output filename (default model.py)',
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-py',
  diagnostics: {},
  emitter: { options: EmitterOptionsSchema },
} as const);
