/**
 * CQRS query handler schematic (gated on `cqrs-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a query and its handler.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: CQRS handlers are runtime-agnostic
 * @returns One file at `src/cqrs/<kebab>.query-handler.ts`
 */
export function generateQueryHandler(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { CqrsQuery, IQueryHandler } from '@hono-enterprise/common';

/** Type name the query bus routes on. */
export const ${names.screaming}_QUERY = '${names.pascal}';

/** Criteria the ${names.pascal} query accepts. */
export interface ${names.pascal}Criteria {
  /** Replace with the query's real criteria. */
  readonly id: string;
}

/** Result the ${names.pascal} handler returns. */
export interface ${names.pascal}View {
  /** Replace with the query's real projection. */
  readonly id: string;
}

/** The ${names.pascal} query. */
export interface ${names.pascal}Query extends CqrsQuery<${names.pascal}Criteria> {
  readonly type: typeof ${names.screaming}_QUERY;
}

/**
 * Handles {@linkcode ${names.pascal}Query}.
 *
 * Register it with
 * \`cqrs.queryBus.register(${names.screaming}_QUERY, new ${names.pascal}QueryHandler())\`.
 */
export class ${names.pascal}QueryHandler
  implements IQueryHandler<${names.pascal}Query, ${names.pascal}View> {
  /**
   * Executes the query.
   *
   * @param query - The query to handle
   * @returns The projected view
   */
  handle(query: ${names.pascal}Query): Promise<${names.pascal}View> {
    // Replace with the real read. Queries must not mutate state.
    return Promise.resolve({ id: query.data.id });
  }
}
`;
  return [{ path: `src/cqrs/${names.kebab}.query-handler.ts`, contents }];
}
