/**
 * Command handler schematic — generates CQRS command handler (gated on cqrs-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates a command handler file.
 */
export function generateCommandHandler(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const commandName = names.pascal + 'Command';
  const handlerName = names.pascal + 'CommandHandler';
  const fileName = `src/cqrs/${names.kebab}.command-handler.ts`;
  const contents =
    `import { ICommandHandler } from '@hono-enterprise/common';\n\nexport class ${handlerName} implements ICommandHandler<${commandName}> {\n  async handle(command: ${commandName}) {\n    // Handle command\n    return {};\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
