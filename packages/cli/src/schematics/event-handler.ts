/**
 * Domain event handler schematic (gated on `events-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';

/**
 * Generates an event handler.
 *
 * @param names - Naming forms derived from the user's input
 * @param _options - Unused: event handlers are runtime-agnostic
 * @returns One file at `src/events/<kebab>.event-handler.ts`
 */
export function generateEventHandler(
  names: DerivedNames,
  _options: SchematicOptions,
): readonly GeneratedFile[] {
  const contents = `import type { IDomainEvent } from '@setu-ts/common';
import type { IEventHandler } from '@setu-ts/events-plugin';

/** Event type name the bus routes on. */
export const ${names.screaming}_EVENT = '${names.kebab}';

/** Payload carried by the ${names.kebab} event. */
export interface ${names.pascal}Payload {
  /** Replace with the event's real payload. */
  readonly id: string;
}

/**
 * Handles the ${names.kebab} event.
 *
 * Subscribe it with
 * \`subscribeHandler(bus, ${names.screaming}_EVENT, new ${names.pascal}EventHandler())\`.
 */
export class ${names.pascal}EventHandler implements IEventHandler<${names.pascal}Payload> {
  /**
   * Reacts to the event.
   *
   * @param event - The published domain event
   */
  async handle(event: IDomainEvent<${names.pascal}Payload>): Promise<void> {
    // Replace with the real reaction.
    await Promise.resolve(event.data.id);
  }
}
`;
  return [{ path: `src/events/${names.kebab}.event-handler.ts`, contents }];
}
