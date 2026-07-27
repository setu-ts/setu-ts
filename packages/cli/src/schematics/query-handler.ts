/**
 * Query handler schematic — generates CQRS query handler (gated on cqrs-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a query handler file.
 */
export function generateQueryHandler(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const queryName = names.pascal + 'Query';
  const handlerName = names.pascal + 'QueryHandler';
  const fileName = `src/cqrs/${names.kebab}.query-handler.ts`;
  const contents =
    `import { IQueryHandler } from '@hono-enterprise/common';\n\nexport class ${handlerName} implements IQueryHandler<${queryName}, ${queryName}> {\n  async handle(query: ${queryName}) {\n    // Query handler\n    return {};\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
