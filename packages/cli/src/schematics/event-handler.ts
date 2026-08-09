/**
 * Domain event handler schematic (gated on `events-plugin`).
 *
 * @module
 */

import type { DerivedNames, GeneratedFile, SchematicOptions } from './registry.ts';
import { EVENT_HANDLERS_EXPORT, EVENTS_SEAM } from '../seams/events.ts';
import { seamNames } from '../seams/seam-spec.ts';

/**
 * Generates an event handler and regenerates the seam barrel that subscribes it.
 *
 * @param names - Naming forms derived from the user's input
 * @param options - Supplies the handlers already present, for the barrel
 * @returns The handler at `src/events/<kebab>.event-handler.ts`, plus the managed
 *   `src/events/index.ts` barrel
 */
export function generateEventHandler(
  names: DerivedNames,
  options: SchematicOptions,
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
 * Subscribed through the \`${EVENT_HANDLERS_EXPORT}\` barrel in \`src/events/index.ts\`,
 * which \`setu.config.ts\` passes to \`EventsPlugin\` — so this class needs no further
 * wiring, and any \`bus.publish\` of \`${names.screaming}_EVENT\` reaches it. The plugin
 * subscribes each entry through the exported \`subscribeHandler\`, which is also how to
 * subscribe one by hand.
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
  return [
    { path: `src/events/${names.kebab}.event-handler.ts`, contents },
    {
      path: EVENTS_SEAM.barrel,
      contents: EVENTS_SEAM.renderBarrel({
        'event-handler': seamNames(options.artifacts, 'event-handler', names.kebab),
      }),
      managed: true,
    },
  ];
}
