/**
 * The schematic contract and the built-in schematic registry.
 *
 * This module is the single source `setu generate` and the help text read —
 * schematic names, their factories, and their plugin gates are declared here
 * and nowhere else.
 *
 * @module
 */

import type { TargetRuntime } from '../constants.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import type { DerivedNames } from '../utils/names.ts';

import { generatePlugin } from './plugin.ts';
import { generateController } from './controller.ts';
import { generateService } from './service.ts';
import { generateRoute } from './route.ts';
import { generateMiddleware } from './middleware.ts';
import { generateGuard } from './guard.ts';
import { generateHealthIndicator } from './health-indicator.ts';
import { generateMetric } from './metric.ts';
import { generateCommandHandler } from './command-handler.ts';
import { generateQueryHandler } from './query-handler.ts';
import { generateEventHandler } from './event-handler.ts';
import { generateJob } from './job.ts';
import { generateMigration } from './migration.ts';

export type { GeneratedFile } from '../utils/file-writer.ts';
export type { DerivedNames } from '../utils/names.ts';

/**
 * Options handed to every schematic.
 */
export interface SchematicOptions {
  /** The project's runtime target, so a schematic can shape platform-specific output. */
  readonly runtime: TargetRuntime;
  /** The `@setu-ts` packages detected in the target project. */
  readonly plugins: ReadonlySet<string>;
  /**
   * Wall-clock milliseconds, injected so timestamped output (the migration
   * schematic) is deterministic under test.
   */
  readonly now: () => number;
}

/**
 * The contract every schematic satisfies — a pure function from a name to the
 * files to create. Schematics perform no I/O; the command layer writes.
 *
 * @param names - The naming forms derived from the user's input
 * @param options - Runtime target, detected plugins, and the clock
 * @returns The files to create
 */
export type Schematic = (
  names: DerivedNames,
  options: SchematicOptions,
) => readonly GeneratedFile[];

/**
 * A registry entry: the schematic plus the plugin it requires, if any.
 */
export interface SchematicMetadata {
  /** The schematic's implementation. */
  readonly factory: Schematic;
  /** The `@setu-ts` package that must be installed, when gated. */
  readonly requiresPlugin?: string;
}

/**
 * The built-in schematics, keyed by the name `setu generate` accepts.
 *
 * A `Map` rather than an object literal so that a lookup of an inherited
 * property name (`constructor`, `__proto__`, `toString`) misses cleanly
 * instead of returning something from `Object.prototype`.
 */
const REGISTRY: ReadonlyMap<string, SchematicMetadata> = new Map<string, SchematicMetadata>([
  ['plugin', { factory: generatePlugin }],
  // Gated: the emitted class uses @Controller/@Get/@Post, so a project without
  // the decorator plugin gets source that cannot resolve its own import.
  ['controller', { factory: generateController, requiresPlugin: 'decorator-plugin' }],
  ['service', { factory: generateService }],
  ['route', { factory: generateRoute }],
  ['middleware', { factory: generateMiddleware }],
  ['guard', { factory: generateGuard, requiresPlugin: 'auth-plugin' }],
  ['health-indicator', { factory: generateHealthIndicator, requiresPlugin: 'health-plugin' }],
  ['metric', { factory: generateMetric, requiresPlugin: 'metrics-plugin' }],
  ['command-handler', { factory: generateCommandHandler, requiresPlugin: 'cqrs-plugin' }],
  ['query-handler', { factory: generateQueryHandler, requiresPlugin: 'cqrs-plugin' }],
  ['event-handler', { factory: generateEventHandler, requiresPlugin: 'events-plugin' }],
  ['job', { factory: generateJob }],
  ['migration', { factory: generateMigration, requiresPlugin: 'database-plugin' }],
]);

/** The name of the pseudo-schematic that loads a user-authored module. */
export const CUSTOM_SCHEMATIC = 'custom';

/**
 * Looks up a built-in schematic.
 *
 * @param name - The schematic name (e.g. `controller`)
 * @returns Its metadata, or undefined when no such schematic exists
 */
export function getSchematic(name: string): SchematicMetadata | undefined {
  return REGISTRY.get(name);
}

/**
 * Lists the built-in schematics in registration order.
 *
 * Consumed by the help text so the documented list can never drift from the
 * registry, and by `generate --help` to show only the available ones.
 *
 * @returns Each schematic's name and the plugin it requires, if any
 */
export function listSchematics(): readonly {
  readonly name: string;
  readonly requiresPlugin?: string;
}[] {
  return [...REGISTRY].map(([name, meta]) =>
    meta.requiresPlugin === undefined ? { name } : { name, requiresPlugin: meta.requiresPlugin }
  );
}
