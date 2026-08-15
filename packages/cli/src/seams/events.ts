/**
 * The domain-event-handler seam.
 *
 * `EventsPluginOptions` carried only `async` and `errorHandler`, so a generated
 * handler's only site was an imperative `subscribeHandler(bus, type, handler)` call
 * that application code had no phase to make. The plugin gains a `handlers` option
 * as a pure addition, and registers each entry through that same exported
 * `subscribeHandler` — one implementation behind two entry points.
 *
 * @module
 */

import type { SeamArtifacts, SeamSpec } from './seam-spec.ts';
import {
  assembleSeamBarrel,
  renderExportedArray,
  renderSeamImports,
  seamHeader,
  seamNames,
} from './seam-spec.ts';
import type { DerivedNames } from '../utils/names.ts';
import { deriveNames } from '../utils/names.ts';

/** Barrel export naming every generated event handler with its event type. */
export const EVENT_HANDLERS_EXPORT = 'EVENT_HANDLERS';

/**
 * Symbols the barrel imports from one event-handler module.
 *
 * @param names - The artifact's derived naming forms
 * @returns The symbols to import
 */
function importSymbols(names: DerivedNames): readonly string[] {
  return [`${names.screaming}_EVENT`, `${names.pascal}EventHandler`];
}

/**
 * Renders `src/events/index.ts`.
 *
 * @param artifacts - Artifact names by schematic name
 * @returns The barrel file contents
 */
function renderEventsBarrel(artifacts: SeamArtifacts): string {
  const names = seamNames(artifacts, 'event-handler');
  const header = seamHeader('setu generate event-handler', [
    `EventsPlugin({ handlers: ${EVENT_HANDLERS_EXPORT} })`,
  ]);
  const imports = [
    `import type { EventHandlerRegistration } from '@setu-ts/events-plugin';`,
    renderSeamImports(names, importSymbols, (kebab) => `./${kebab}.event-handler.ts`),
  ].filter((line) => line !== '').join('\n\n');

  const entries = names.map((name) => {
    const n = deriveNames(name);
    return `{ type: ${n.screaming}_EVENT, handler: new ${n.pascal}EventHandler() }`;
  });

  return assembleSeamBarrel(header, imports, [
    `/** Every generated event handler, for \`EventsPlugin({ handlers })\`. */\n` +
    renderExportedArray(EVENT_HANDLERS_EXPORT, 'EventHandlerRegistration', entries),
  ]);
}

/** The domain-event-handler seam. */
export const EVENTS_SEAM: SeamSpec = {
  schematic: 'event-handler',
  dir: 'src/events',
  suffix: '.event-handler.ts',
  importSymbols,
  barrel: 'src/events/index.ts',
  exports: [EVENT_HANDLERS_EXPORT],
  requiresPlugin: 'events-plugin',
  renderBarrel: renderEventsBarrel,
};
