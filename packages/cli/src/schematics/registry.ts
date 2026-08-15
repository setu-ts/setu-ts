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
import { generateModule } from './module.ts';

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
  /**
   * The domain modules already present under `src/modules/`, sorted.
   *
   * Gathered by the command layer (`utils/module-scanner.ts`) so the `module`
   * schematic can render an aggregate barrel listing every module while staying
   * a pure function — the same route {@linkcode SchematicOptions.plugins} takes
   * for the detected plugin set.
   *
   * Read by the `module` schematic only, exactly as `now` is read only by
   * `migration` and `plugins` only by the gated schematics.
   *
   * OPTIONAL purely for backward compatibility: `setu generate` always supplies
   * it, but this interface is published, and a custom schematic's own test
   * constructs one — making it required would break that test's compile with no
   * deprecation path available (§9.2 assumes a replacement API, and there is
   * none for an added field). Treat an absent value as "no modules yet".
   *
   * @since 0.1.0
   */
  readonly modules?: readonly string[];
  /**
   * The generated artifacts already present in the project, keyed by the schematic
   * name that emits them (`{ 'health-indicator': ['external-api'] }`).
   *
   * Gathered by the command layer (`utils/artifact-scanner.ts`) so a wired schematic
   * can render a barrel listing every artifact of its family while staying a pure
   * function — the same route {@linkcode SchematicOptions.modules} takes for domain
   * modules.
   *
   * Kept separate from `modules` rather than folded into it because the two admission
   * rules genuinely differ: a module is a DIRECTORY that must hold both a controller
   * and a service, while these families are FILES identified by a suffix.
   *
   * OPTIONAL for the same reason `modules` is: this interface is published, a custom
   * schematic's own test constructs one, and there is no deprecation path for making
   * an added field required. Treat an absent value as "no artifacts yet".
   *
   * @since 0.1.0
   */
  readonly artifacts?: Readonly<Record<string, readonly string[]>>;
  /**
   * The migrations already present, oldest first.
   *
   * Optional on the M58 `modules` precedent — a required field would break a
   * custom schematic's own test with no deprecation path.
   */
  readonly migrations?: readonly string[];
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
 * Another schematic to reach for when a gated one is refused.
 *
 * Declared beside the gate it qualifies rather than built inside
 * `commands/generate.ts`, so schematic knowledge lives in this one registry and
 * a rename cannot leave a refusal pointing at a command that no longer exists.
 */
export interface SchematicAlternative {
  /** The schematic name to suggest, e.g. `route`. */
  readonly schematic: string;
  /** One clause explaining what the alternative gives up and what it keeps. */
  readonly why: string;
}

/**
 * A registry entry: the schematic plus the plugin it requires, if any.
 */
export interface SchematicMetadata {
  /** The schematic's implementation. */
  readonly factory: Schematic;
  /** The `@setu-ts` package that must be installed, when gated. */
  readonly requiresPlugin?: string;
  /**
   * A decorator-free (or otherwise ungated) schematic to suggest when this one
   * is refused.
   *
   * AI_GUIDELINES' "5 Optional Rules" promise that "everything has a
   * programmatic API — no feature requires decorators or reflection", and for
   * an HTTP handler that API is `setu generate route`. Refusing `controller`
   * with only "install the decorator plugin" told a developer to adopt
   * decorators to get a route, which is the opposite of the promise. Present
   * only where a genuine alternative exists: `guard`, `metric` and the rest
   * have none, and inventing one would be worse than silence.
   */
  readonly alternative?: SchematicAlternative;
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
  // Mode-aware: the functional default emits routes and functions, while the
  // class-based composition emits the decorated controller/service aggregate.
  ['module', { factory: generateModule }],
  // UNGATED since M70h, and mode-aware like `service`. It used to require
  // `decorator-plugin` and redirect to `g route` in a second directory; with
  // both kinds sharing `src/controllers/` there is nowhere to redirect TO, and
  // the functional shape resolves its own imports in a bare project.
  ['controller', { factory: generateController }],
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
