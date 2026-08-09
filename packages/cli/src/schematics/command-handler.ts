/**
 * CQRS command handler schematic (gated on `cqrs-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { COMMAND_HANDLER_SEAM, COMMAND_HANDLERS_EXPORT } from '../seams/cqrs.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates a command and its handler, and regenerates the seam barrel.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the handlers already present, for the barrel
 * @returns The handler at `src/cqrs/<kebab>.command-handler.ts`, plus the managed
 *   `src/cqrs/index.ts` barrel, which lists query handlers too
 */
export function generateCommandHandler(
  names: DerivedNames,
  options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { CqrsCommand, ICommandHandler } from '@setu-ts/common';

/** Type name the command bus routes on. */
export const ${names.screaming}_COMMAND = '${names.pascal}';

/** Payload of the ${names.pascal} command. */
export interface ${names.pascal}Payload {
  /** Replace with the command's real payload. */
  readonly id: string;
}

/** Result the ${names.pascal} handler returns. */
export interface ${names.pascal}Result {
  /** Replace with the command's real result. */
  readonly id: string;
}

/** The ${names.pascal} command. */
export interface ${names.pascal}Command extends CqrsCommand<${names.pascal}Payload> {
  readonly type: typeof ${names.screaming}_COMMAND;
}

/**
 * Handles {@linkcode ${names.pascal}Command}.
 *
 * Registered through the \`${COMMAND_HANDLERS_EXPORT}\` barrel in \`src/cqrs/index.ts\`,
 * which \`setu.config.ts\` passes to \`CqrsPlugin\` — so this class needs no further
 * wiring, and \`commandBus.execute({ type: ${names.screaming}_COMMAND, … })\` reaches it.
 */
export class ${names.pascal}CommandHandler
  implements ICommandHandler<${names.pascal}Command, ${names.pascal}Result> {
  /**
   * Executes the command.
   *
   * @param command - The command to handle
   * @returns The command result
   */
  handle(command: ${names.pascal}Command): Promise<${names.pascal}Result> {
    // Replace with the real write.
    return Promise.resolve({ id: command.data.id });
  }
}
`;
  return [
    { path: `src/cqrs/${names.kebab}.command-handler.ts`, contents },
    {
      path: COMMAND_HANDLER_SEAM.barrel,
      // Both kinds are passed: the barrel lists commands AND queries, so generating a
      // command handler must not drop a query handler already present.
      contents: COMMAND_HANDLER_SEAM.renderBarrel({
        'command-handler': seamNames(options.artifacts, 'command-handler', names.kebab),
        'query-handler': seamNames(options.artifacts, 'query-handler'),
      }),
      managed: true,
    },
  ];
}
