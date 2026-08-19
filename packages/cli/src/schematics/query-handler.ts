/**
 * CQRS query handler schematic (gated on `cqrs-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { QUERY_HANDLER_SEAM, QUERY_HANDLERS_EXPORT } from '../seams/cqrs.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a query and its handler, and regenerates the seam barrel.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the handlers already present, for the barrel
 * @returns The handler at `src/cqrs/<kebab>.query-handler.ts`, plus the managed
 *   `src/cqrs/index.ts` barrel, which lists command handlers too
 */
export function generateQueryHandler(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { CqrsQuery, IQueryHandler } from '@setu-ts/common';

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
 * Registered through the \`${QUERY_HANDLERS_EXPORT}\` barrel in \`src/cqrs/index.ts\`,
 * which \`setu.config.ts\` passes to \`CqrsPlugin\` — so this class needs no further
 * wiring, and \`queryBus.execute({ type: ${names.screaming}_QUERY, … })\` reaches it.
 * The barrel references the factory below by name, so the factory is the single
 * construction site.
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

/**
 * Builds the handler. The barrel references this factory by name, so it is the
 * single construction site — and the place to wire a dependency in.
 * \`CqrsPluginOptions.queryHandlers\` accepts a factory that builds a handler
 * from the service registry, called at the \`onInit\` phase, after every plugin
 * has registered, so to take a dependency change the one line to:
 *
 * \`\`\`ts
 * export function create${names.pascal}QueryHandler(services: IServiceRegistry): ${names.pascal}QueryHandler {
 *   // resolve a capability from services and build with it
 * }
 * \`\`\`
 */
export function create${names.pascal}QueryHandler(): ${names.pascal}QueryHandler {
  return new ${names.pascal}QueryHandler();
}
`;
  return [
    { path: `src/cqrs/${names.kebab}.query-handler.ts`, contents },
    {
      path: QUERY_HANDLER_SEAM.barrel,
      contents: QUERY_HANDLER_SEAM.renderBarrel({
        'command-handler': seamNames(options.artifacts, 'command-handler'),
        'query-handler': seamNames(options.artifacts, 'query-handler', names.kebab),
      }),
      managed: true,
    },
  ];
}
