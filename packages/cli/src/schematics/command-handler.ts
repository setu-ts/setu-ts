/**
 * CQRS command handler schematic (gated on `cqrs-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a command and its handler.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: CQRS handlers are runtime-agnostic
 * @returns One file at `src/cqrs/<kebab>.command-handler.ts`
 */
export function generateCommandHandler(
  names: DerivedNames,
  _options: SchematicOptions,
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
 * Register it with
 * \`cqrs.commandBus.register(${names.screaming}_COMMAND, new ${names.pascal}CommandHandler())\`.
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
  return [{ path: `src/cqrs/${names.kebab}.command-handler.ts`, contents }];
}
