/** Standalone request/response shape schematic. @module */
import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/** Creates a new shape file without editing developer-owned schemas. */
export function generateSchema(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const dir =
    options.targetModule === undefined
      ? 'src/shared/schemas'
      : `src/modules/${options.targetModule}`;
  return [
    {
      path: `${dir}/${names.kebab}.schemas.ts`,
      contents: `import { z } from 'zod';

/** The ${names.kebab} shape. */
export const ${names.pascal} = z.object({});
export type ${names.pascal} = z.infer<typeof ${names.pascal}>;
`,
    },
  ];
}
