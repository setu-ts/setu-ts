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
 *   That stays exactly true after D5, and the distinction is worth stating
 *   because the schematic now emits a barrel and a runner of its own. Those are
 *   **project-local**: `src/migrations/run.ts` is the generated project's file,
 *   run by its own `db:migrate` task, and no `setu.config.ts` imports it and no
 *   plugin option consumes it. A framework seam is a registration site the
 *   framework reads; this is a script the developer runs. Making `migration` a
 *   `SeamSpec` would put a barrel into `setu.config.ts` that nothing reads.
 *
 * @module
 */

import type { SeamSpec } from './seam-spec.ts';
import {
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  FUNCTIONAL_ROUTES_SEAM,
  ROUTES_SEAM,
} from './http.ts';
import { COMMAND_HANDLER_SEAM, QUERY_HANDLER_SEAM } from './cqrs.ts';
import { EVENTS_SEAM } from './events.ts';
import { FUNCTIONAL_HEALTH_SEAM, HEALTH_SEAM } from './health.ts';
import { METRICS_SEAM } from './metrics.ts';
import { MIDDLEWARE_SEAM } from './middleware.ts';
import { PLUGINS_SEAM } from './plugins.ts';
import { FUNCTIONAL_SERVICES_SEAM, SERVICES_SEAM } from './services.ts';
import type { GeneratorMode } from '../utils/generator-mode.ts';
import { generatorMode } from '../utils/generator-mode.ts';

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

/**
 * Swaps every family that a HOST scaffolds into a generator mode's shape.
 *
 * Applied by both accessors below, because each of these families has a real
 * registration site in BOTH modes — `registerGeneratedRoutes(app.router)` for
 * the HTTP pair, `HealthPlugin({ indicators })` for health — so the host
 * scaffolds the barrel either way and only the artifact shape differs.
 *
 * @param specs - The registry's specs
 * @param mode - The target's generator mode
 * @returns The specs, with each family in that mode's shape
 */
function withHostShapes(
  specs: readonly SeamSpec[],
  mode: GeneratorMode,
): readonly SeamSpec[] {
  if (mode === 'class-based') return specs;
  const functional = new Map<string, SeamSpec>([
    [FUNCTIONAL_CONTROLLERS_SEAM.schematic, FUNCTIONAL_CONTROLLERS_SEAM],
    [FUNCTIONAL_ROUTES_SEAM.schematic, FUNCTIONAL_ROUTES_SEAM],
    // `health-indicator` is here rather than in the scan-only set because its
    // barrel IS imported by `setu.config.ts` — the shape has to be right at
    // scaffold time, not only when an artifact is admitted (A2).
    [FUNCTIONAL_HEALTH_SEAM.schematic, FUNCTIONAL_HEALTH_SEAM],
  ]);
  return specs.map((spec) => functional.get(spec.schematic) ?? spec);
}

/**
 * The seams to SCAN a target project with, for its generator mode.
 *
 * The registry describes the class-based shape of each family, because that is
 * the shape whose barrel a `setu.config.ts` imports. Scanning is different: it
 * reads the files a project actually holds, and two families have two shapes.
 * `readArtifactNames` admits a file only when it exports every symbol the barrel
 * will import, so scanning a functional project with a class spec rejects every
 * artifact the CLI itself wrote and reports it as needing regeneration. It does
 * not; the regenerated file is identical.
 *
 * @param installed - The `@setu-ts` packages detected in the target project
 * @returns Every family's seam, in the project's own shape
 */
export function scanSeamSpecs(installed: ReadonlySet<string>): readonly SeamSpec[] {
  const mode = generatorMode(installed);
  const withHost = withHostShapes(listSeamSpecs(), mode);
  if (mode === 'class-based') return withHost;
  return withHost.map((spec) =>
    spec.schematic === SERVICES_SEAM.schematic ? FUNCTIONAL_SERVICES_SEAM : spec
  );
}

/**
 * The seams a HOST scaffolds and wires, in its own generator mode.
 *
 * The `service` family is deliberately NOT swapped here, which is the one place
 * this differs from {@linkcode scanSeamSpecs}. `FUNCTIONAL_SERVICES_SEAM` is a
 * convenience re-export with no registration site — M65 states it is "selected
 * explicitly, by generator mode, at the two places that need it: the schematic
 * that renders it and the scan that admits its artifacts", and a host is
 * neither. Swapping it in here would scaffold a barrel nothing imports.
 *
 * The gate then drops any seam whose backing plugin the host does not install,
 * because emitting its barrel would put an unresolvable import in the config.
 *
 * @param installed - Bare `@setu-ts` package names the host registers
 * @returns The consumable seams, in registry order
 */
export function hostSeamSpecs(installed: ReadonlySet<string>): readonly SeamSpec[] {
  return withHostShapes(listSeamSpecs(), generatorMode(installed)).filter(
    (spec) => spec.requiresPlugin === undefined || installed.has(spec.requiresPlugin),
  );
}
