import { createTypeSpecLibrary, type JSONSchemaType } from '@typespec/compiler';

export interface GoEmitterOptions {
  /** Go package name for the generated file (default "model") */
  'package'?: string;
  'skeleton'?: string;
  'out-file'?: string;
}

const EmitterOptionsSchema: JSONSchemaType<GoEmitterOptions> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    'package': {
      type: 'string',
      nullable: true,
      description: 'Go package name for the generated file (default "model")',
    },
    'skeleton': {
      type: 'string',
      nullable: true,
      description:
        'Path (relative to the project root) to a skeleton .go file prepended to the output, ' +
        "overriding the packaged default.  Copy the emitter's assets/skeleton.go as a starting point.",
    },
    'out-file': {
      type: 'string',
      nullable: true,
      description: 'Output filename (default model.go)',
    },
  },
  required: [],
};

export const $lib = createTypeSpecLibrary({
  name: '@phaselock/typespec-go',
  diagnostics: {},
  emitter: { options: EmitterOptionsSchema },
} as const);
