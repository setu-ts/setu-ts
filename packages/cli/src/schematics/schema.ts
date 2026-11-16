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

/**
 * The ${names.kebab} shape. An empty strict object refuses every body with fields
 * until you add fields here.
 *
 * Functional: bind \`const body = validateBody(${names.pascal})\`, use \`body\` as route
 * middleware, and read \`body.value(ctx)\` in the handler.
 * Class-based: bind \`@ValidateBody(${names.pascal})\` on the handler.
 */
export const ${names.pascal} = z.strictObject({});
export type ${names.pascal} = z.infer<typeof ${names.pascal}>;
`,
    },
  ];
}
