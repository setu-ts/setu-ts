/**
 * The CQRS handler seam — the one barrel two schematics share.
 *
 * `CqrsPluginOptions` carried only `behaviors` before this milestone, so a generated
 * handler's only site was an imperative `commandBus.register(type, handler)` call —
 * and `IApplication` has no `lifecycle` member, so application code has no phase in
 * which to make it. The plugin therefore gains `commandHandlers` and `queryHandlers`
 * as pure additions, shaped as `{ type, handler }` pairs because that is exactly
 * what `ICommandBus.register(type, handler)` takes.
 *
 * Both `command-handler` and `query-handler` write into `src/cqrs/`, so both specs
 * render the SAME barrel path from the SAME two name lists — which is why
 * `SeamArtifacts` is keyed by schematic rather than by directory.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderList,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import { deriveNames } from '../utils/names.ts';

/** Barrel export naming every generated command handler with its command type. */
export const COMMAND_HANDLERS_EXPORT = 'COMMAND_HANDLERS';

/** Barrel export naming every generated query handler with its query type. */
export const QUERY_HANDLERS_EXPORT = 'QUERY_HANDLERS';

/** The barrel both CQRS schematics regenerate. */
const CQRS_BARREL = 'src/cqrs/index.ts';

/**
 * Renders `src/cqrs/index.ts` from both handler kinds.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderCqrsBarrel(artifacts: SeamArtifacts): string {
  const commands = seamNames(artifacts, 'command-handler');
  const queries = seamNames(artifacts, 'query-handler');

  const header = seamHeader('setu generate command-handler / query-handler', [
    `CqrsPlugin({`,
    `  commandHandlers: ${COMMAND_HANDLERS_EXPORT},`,
    `  queryHandlers: ${QUERY_HANDLERS_EXPORT},`,
    `})`,
  ]);

  const imports = [
    `import type {\n` +
    `  CommandHandlerRegistration,\n` +
    `  QueryHandlerRegistration,\n` +
    `} from '@setu-ts/cqrs-plugin';`,
    renderSeamImports(
      commands,
      (n) => `${n.screaming}_COMMAND, ${n.pascal}CommandHandler`,
      (kebab) => `./${kebab}.command-handler.ts`,
    ),
    renderSeamImports(
      queries,
      (n) => `${n.screaming}_QUERY, ${n.pascal}QueryHandler`,
      (kebab) => `./${kebab}.query-handler.ts`,
    ),
  ].filter((line) => line !== '').join('\n\n');

  // The type constant travels with the handler because the bus routes on it and the
  // emitted module already declares it — deriving a type name from the class here
  // would invent a second source of truth for the same string.
  const commandEntries = commands.map((name) => {
    const n = deriveNames(name);
    return `{ type: ${n.screaming}_COMMAND, handler: new ${n.pascal}CommandHandler() }`;
  });
  const queryEntries = queries.map((name) => {
    const n = deriveNames(name);
    return `{ type: ${n.screaming}_QUERY, handler: new ${n.pascal}QueryHandler() }`;
  });

  return assembleSeamBarrel(header, imports, [
    `/** Every generated command handler, for \`CqrsPlugin({ commandHandlers })\`. */\n` +
    `export const ${COMMAND_HANDLERS_EXPORT}: readonly CommandHandlerRegistration[] = [${
      renderList(commandEntries)
    }];`,
    `/** Every generated query handler, for \`CqrsPlugin({ queryHandlers })\`. */\n` +
    `export const ${QUERY_HANDLERS_EXPORT}: readonly QueryHandlerRegistration[] = [${
      renderList(queryEntries)
    }];`,
  ]);
}

/** The command-handler seam. */
export const COMMAND_HANDLER_SEAM: SeamSpec = {
  schematic: 'command-handler',
  dir: 'src/cqrs',
  suffix: '.command-handler.ts',
  barrel: CQRS_BARREL,
  exports: [COMMAND_HANDLERS_EXPORT, QUERY_HANDLERS_EXPORT],
  requiresPlugin: 'cqrs-plugin',
  renderBarrel: renderCqrsBarrel,
};

/**
 * The query-handler seam.
 *
 * Same barrel and same renderer as {@linkcode COMMAND_HANDLER_SEAM}: whichever
 * schematic runs, the barrel it emits lists both kinds, so generating a query
 * handler cannot drop a command handler already present.
 */
export const QUERY_HANDLER_SEAM: SeamSpec = {
  schematic: 'query-handler',
  dir: 'src/cqrs',
  suffix: '.query-handler.ts',
  barrel: CQRS_BARREL,
  exports: [COMMAND_HANDLERS_EXPORT, QUERY_HANDLERS_EXPORT],
  requiresPlugin: 'cqrs-plugin',
  renderBarrel: renderCqrsBarrel,
};
