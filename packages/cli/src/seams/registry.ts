/**
 * The seam registry — which generated families reach a registration site.
 *
 * This is the single source three layers read: `commands/generate.ts` scans the
 * declared directories, each schematic renders its own barrel from its spec, and
 * `templates/seam.ts` derives the scaffold-time files, config imports and wiring from
 * the same list. A family cannot therefore acquire a barrel no config imports, or an
 * import no barrel exports.
 *
 * Three schematics are deliberately ABSENT, and their absence is the milestone's
 * finding rather than an omission:
 *
 * - **`guard`** — a guard's positions are per route (`RouteDefinition.middleware`,
 *   `@UseGuards`), and `auth-plugin` publishes no guard list. The only barrel-shaped
 *   alternative is the global pipeline, and the emitted guard answers `401` when
 *   `ctx.request.user` is absent — registering it globally would 401 `/health`,
 *   `/metrics` and `/`, turning a generated file into an outage.
 * - **`job`** — the emitted function is transport-agnostic by design. Registering it
 *   as a queue processor starts a worker loop polling for a job name nothing
 *   enqueues; scheduling it needs a cron expression the artifact does not carry.
 *   `QueuePluginOptions` has no `processors` option either.
 * - **`migration`** — nothing in the framework reads migration files. No plugin
 *   anywhere in this repository calls `ctx.cli.register`, so `setu db:migrate` does
 *   not exist; there is no site to wire into.
 *
 * @module
 */

import type { SeamSpec } from './seam-spec.ts';
import { CONTROLLERS_SEAM } from './controllers.ts';
import { COMMAND_HANDLER_SEAM, QUERY_HANDLER_SEAM } from './cqrs.ts';
import { EVENTS_SEAM } from './events.ts';
import { HEALTH_SEAM } from './health.ts';
import { METRICS_SEAM } from './metrics.ts';
import { MIDDLEWARE_SEAM } from './middleware.ts';
import { PLUGINS_SEAM } from './plugins.ts';
import { ROUTES_SEAM } from './routes.ts';
import { SERVICES_SEAM } from './services.ts';

/**
 * Every wired family, keyed by the schematic name that emits it.
 *
 * A `Map` rather than an object literal so a lookup of an inherited property name
 * (`constructor`, `__proto__`) misses cleanly instead of returning something from
 * `Object.prototype` — the reason the schematic and template registries are Maps too.
 */
const SEAM_REGISTRY: ReadonlyMap<string, SeamSpec> = new Map<string, SeamSpec>([
  [CONTROLLERS_SEAM.schematic, CONTROLLERS_SEAM],
  [SERVICES_SEAM.schematic, SERVICES_SEAM],
  [ROUTES_SEAM.schematic, ROUTES_SEAM],
  [MIDDLEWARE_SEAM.schematic, MIDDLEWARE_SEAM],
  [PLUGINS_SEAM.schematic, PLUGINS_SEAM],
  [HEALTH_SEAM.schematic, HEALTH_SEAM],
  [METRICS_SEAM.schematic, METRICS_SEAM],
  [COMMAND_HANDLER_SEAM.schematic, COMMAND_HANDLER_SEAM],
  [QUERY_HANDLER_SEAM.schematic, QUERY_HANDLER_SEAM],
  [EVENTS_SEAM.schematic, EVENTS_SEAM],
]);

/**
 * Lists every wired family's seam, in registration order.
 *
 * The registry's only accessor. A lookup-by-name helper was deliberately NOT kept
 * alongside it: every schematic imports its own spec directly, which is type-safe and
 * needs no non-null assertion, so a by-name lookup had no reader outside the tests —
 * dead surface by the rule that every declared symbol must be read on a real code path.
 * A test needing one builds it from this list.
 *
 * @returns The seams
 */
export function listSeamSpecs(): readonly SeamSpec[] {
  return [...SEAM_REGISTRY.values()];
}
