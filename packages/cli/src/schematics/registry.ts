/**
 * Schematic registry — maps names to schematic functions with plugin requirements.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';

// Import individual schematic factories
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

/**
 * The contract a schematic must satisfy.
 *
 * A schematic is a pure function that returns an array of GeneratedFile objects.
 * It receives the derived names (kebab, camel, pascal, etc.) and options.
 */
export type Schematic = (
  names: DerivedNames,
  options: SchematicOptions,
) => readonly GeneratedFile[];

/**
 * Options passed to every schematic. Carries runtime services and detected plugins.
 */
export interface SchematicOptions {
  /** Runtime services (for uuid, now, etc.). */
  readonly runtime: IRuntimeServices;
  /** Set of installed plugin names (e.g., "auth-plugin", "cqrs-plugin"). */
  readonly plugins: ReadonlySet<string>;
}

/**
 * Derived names — all five naming forms from the input.
 */
export interface DerivedNames {
  readonly raw: string;
  readonly kebab: string;
  readonly camel: string;
  readonly pascal: string;
  readonly screaming: string;
}

/**
 * Represents a generated file with path and contents.
 */
export interface GeneratedFile {
  /** The relative or absolute path where the file should be written. */
  readonly path: string;
  /** The file contents as a string. */
  readonly contents: string;
}

/**
 * Metadata about a schematic, including its required plugin (if any).
 */
export interface SchematicMetadata {
  /** The function implementing the schematic. */
  readonly factory: Schematic;
  /** The name of the plugin this schematic requires (or undefined if ungated). */
  readonly requiresPlugin?: string;
}

/**
 * The schematic registry — a map from name to metadata.
 */
export const SCHEMATICS_REGISTRY: ReadonlyRecord<string, SchematicMetadata> = {
  plugin: {
    factory: generatePlugin,
  },
  controller: {
    factory: generateController,
  },
  service: {
    factory: generateService,
  },
  route: {
    factory: generateRoute,
  },
  middleware: {
    factory: generateMiddleware,
  },
  guard: {
    factory: generateGuard,
    requiresPlugin: 'auth-plugin', // gated
  },
  'health-indicator': {
    factory: generateHealthIndicator,
    requiresPlugin: 'health-plugin', // gated
  },
  metric: {
    factory: generateMetric,
    requiresPlugin: 'metrics-plugin', // gated
  },
  'command-handler': {
    factory: generateCommandHandler,
    requiresPlugin: 'cqrs-plugin', // gated
  },
  'query-handler': {
    factory: generateQueryHandler,
    requiresPlugin: 'cqrs-plugin', // gated
  },
  'event-handler': {
    factory: generateEventHandler,
    requiresPlugin: 'events-plugin', // gated
  },
  job: {
    factory: generateJob,
  },
  migration: {
    factory: generateMigration,
    requiresPlugin: 'database-plugin', // gated
  },
} as const;

// Define a type alias for ReadonlyRecord (since it's not a standard TypeScript type)
type ReadonlyRecord<K extends string | symbol, T> = { readonly [P in K]: T };

/**
 * Look up a schematic by name.
 *
 * @param name - The schematic name (e.g., "controller", "service")
 * @returns The schematic metadata, or undefined if not found
 */
export function getSchematic(name: string): SchematicMetadata | undefined {
  return SCHEMATICS_REGISTRY[name];
}
