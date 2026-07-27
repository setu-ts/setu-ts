/**
 * Event handler schematic — generates event handler (gated on events-plugin).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates an event handler file.
 */
export function generateEventHandler(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const eventName = names.pascal + 'Event';
  const handlerName = names.pascal + 'EventHandler';
  const fileName = `src/events/${names.kebab}.event-handler.ts`;
  const contents =
    `import { IEventHandler } from '@hono-enterprise/common';\n\nexport class ${handlerName} implements IEventHandler<${eventName}> {\n  async handle(event: ${eventName}) {\n    // Handle event\n  }\n}\n`;
  return [{ path: fileName, contents }];
}
