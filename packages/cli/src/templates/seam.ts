/**
 * What a host template must emit and consume for the generated-artifact seams.
 *
 * Everything here is DERIVED from `seams/registry.ts`, so a template cannot acquire a
 * barrel file without the config import that reads it, or an import naming a symbol the
 * barrel does not export. Adding a seam is one entry in that registry, not four edits
 * spread over three template modules.
 *
 * Emitted from scaffold time, deliberately: a project that gained a seam only when its
 * first artifact was generated would need `setu.config.ts` edited at that moment, which
 * is the write this whole design exists to avoid.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';
import { hostSeamSpecs } from '../seams/registry.ts';
import type { SeamArtifacts, SeamSpec } from '../seams/seam-spec.ts';
import { APP_CONTROLLERS_EXPORT, REGISTER_ROUTES_EXPORT } from '../seams/http.ts';
import { APP_SERVICES_EXPORT } from '../seams/services.ts';
import { COMMAND_HANDLERS_EXPORT, QUERY_HANDLERS_EXPORT } from '../seams/cqrs.ts';
import { EVENT_HANDLERS_EXPORT } from '../seams/events.ts';
import { INGRESS_HANDLERS_EXPORT } from '../seams/ingress.ts';
import { GENERATED_MIDDLEWARE_EXPORT } from '../seams/middleware.ts';
import { GENERATED_PLUGINS_EXPORT } from '../seams/plugins.ts';
import { HEALTH_INDICATORS_EXPORT } from '../seams/health.ts';
import { CUSTOM_METRICS_EXPORT } from '../seams/metrics.ts';
import { QUEUE_PROCESSORS_EXPORT } from '../seams/jobs.ts';
import { mergeObjectArgs, wrapPluginArgs } from './plugin-args.ts';
import type { LocalImport, Wiring } from './registry.ts';

/** One internal starter arm and the generated handlers it consumes. */
export interface IStarterSeam {
  readonly plugin: string;
  readonly arm: 'events' | 'cqrs' | 'queue';
  readonly barrel: string;
  readonly schematic: string;
  readonly entries: readonly (readonly [string, string])[];
}

/** Shared starter-arm entries: advice, automatic edits and inline plugin options agree. */
export const STARTER_SEAMS: readonly IStarterSeam[] = [
  {
    plugin: 'events-plugin',
    arm: 'events',
    barrel: 'src/events/index.ts',
    schematic: 'event-handler',
    entries: [['handlers', EVENT_HANDLERS_EXPORT]],
  },
  {
    plugin: 'cqrs-plugin',
    arm: 'cqrs',
    barrel: 'src/cqrs/index.ts',
    schematic: 'command-handler',
    entries: [
      ['commandHandlers', COMMAND_HANDLERS_EXPORT],
      ['queryHandlers', QUERY_HANDLERS_EXPORT],
    ],
  },
  {
    plugin: 'queue-plugin',
    arm: 'queue',
    barrel: 'src/jobs/index.ts',
    schematic: 'job',
    entries: [['processors', `[...${QUEUE_PROCESSORS_EXPORT}]`]],
  },
];

/** Renders the shared property table as a plugin/starter option literal. */
export function starterSeamLiteral(seam: IStarterSeam): string {
  return `{ ${seam.entries.map(([key, value]) => `${key}: ${value}`).join(', ')} }`;
}

/**
 * Selects the seams a host can actually consume.
 *
 * A seam gated on a package the host does not install is omitted entirely — emitting
 * its barrel would put an unresolvable import in the generated config. That is why the
 * CQRS and events seams appear only on `microservice`, the one template that registers
 * their plugins.
 *
 * @param installed - Bare `@setu-ts` package names the host template registers
 * @returns The consumable seams, in registry order
 */
export function seamsFor(installed: ReadonlySet<string>): readonly SeamSpec[] {
  return hostSeamSpecs(installed);
}

/**
 * The empty barrels a fresh project starts with.
 *
 * Rendered by the same functions `setu generate` uses, so the scaffolded file and every
 * regeneration of it can never drift apart in shape.
 *
 * A host that ships example artifacts of its own seeds them, so the SCAFFOLDED
 * barrel already lists them. Without that the class-based showcase would sit in
 * a seam directory registered by nothing until the first `setu generate`
 * regenerated the barrel around it (E4).
 *
 * @param seams - The host's consumable seams
 * @param seeded - Artifact names the host itself emits, by schematic name
 * @returns One file per seam, deduplicated by path
 */
export function seamFiles(
  seams: readonly SeamSpec[],
  seeded: SeamArtifacts = {},
): readonly GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const spec of seams) {
    // Deduplicated because two schematics can share one barrel: `command-handler` and
    // `query-handler` both render `src/cqrs/index.ts`, and emitting it twice would trip
    // the duplicate-path guard in `commands/new.ts`.
    if (byPath.has(spec.barrel)) continue;
    byPath.set(spec.barrel, { path: spec.barrel, contents: spec.renderBarrel(seeded) });
  }
  return [...byPath.values()];
}

/**
 * The `setu.config.ts` imports that bring the barrel symbols into scope.
 *
 * @param seams - The host's consumable seams
 * @returns One import per barrel, deduplicated by path
 */
export function seamLocalImports(seams: readonly SeamSpec[]): readonly LocalImport[] {
  const byPath = new Map<string, LocalImport>();
  for (const spec of seams) {
    if (byPath.has(spec.barrel)) continue;
    byPath.set(spec.barrel, { symbols: [...spec.exports], from: `./${spec.barrel}` });
  }
  return [...byPath.values()];
}

/**
 * Statements the config runs inside `createApp()` for the seams whose registration
 * site is a call rather than a plugin option.
 *
 * @param seams - The host's consumable seams
 * @returns The statements, in a fixed order
 */
export function seamSetupCalls(seams: readonly SeamSpec[]): readonly string[] {
  const schematics = new Set(seams.map((spec) => spec.schematic));
  const calls: string[] = [];
  // Either kind reaches the router through this one call: in a functional
  // project a `.controller.ts` registers imperatively exactly as a `.routes.ts`
  // does, so gating on `route` alone would leave a functional project's
  // controllers wired by nothing.
  if (schematics.has('route') || schematics.has('controller')) {
    calls.push(`${REGISTER_ROUTES_EXPORT}(app.router, app.services);`);
  }
  if (schematics.has('middleware')) {
    // The priority comes from the artifact's OWN module, not from a default here: a
    // middleware's pipeline position is never incidental, and a bare `add()` would land
    // at 500 inside every framework middleware.
    //
    // Indentation is relative: the renderer prefixes every statement with the function
    // body's two spaces, so a continuation line carries only its own nesting on top.
    calls.push(
      `for (const generated of ${GENERATED_MIDDLEWARE_EXPORT}) {`,
      `  app.middleware.add(generated.middleware, {`,
      `    priority: generated.priority,`,
      `    name: generated.name,`,
      `  });`,
      `}`,
    );
  }
  return calls;
}

/**
 * Entries appended to the config's `plugins: [...]` array.
 *
 * @param seams - The host's consumable seams
 * @returns The spread expressions
 */
export function seamPluginSpreads(seams: readonly SeamSpec[]): readonly string[] {
  return seams.some((spec) => spec.schematic === 'plugin')
    ? [`...${GENERATED_PLUGINS_EXPORT}`]
    : [];
}

/**
 * The plugin seam's registration for a host that has no plugin ARRAY to spread
 * into.
 *
 * A starter-composed host builds the plugin list itself, and no starter accepts
 * extra plugins — so `full-stack` could not consume this seam through
 * {@linkcode seamPluginSpreads}. `IApplication.register` is the equivalent and
 * is public: the kernel resolves plugins at `start()`, and the generated factory
 * deliberately does not start, so a plugin registered here is picked up exactly
 * as a spread one would be.
 *
 * @param seams - The host's consumable seams
 * @returns The statements, empty when the host has no plugin seam
 */
export function seamPluginRegistrations(seams: readonly SeamSpec[]): readonly string[] {
  return seams.some((spec) => spec.schematic === 'plugin')
    ? [`for (const generated of ${GENERATED_PLUGINS_EXPORT}) app.register(generated);`]
    : [];
}

/**
 * Rewrites a wiring list so each plugin whose options carry a seam receives it.
 *
 * Takes the list rather than mutating a shared constant so every template applies it to
 * its own set — the technique `withModuleSeam` already uses for the decorator wiring.
 *
 * The decorator wiring is deliberately NOT touched here: it is owned by
 * `withModuleSeam`, which composes the module barrel with a template's own example
 * classes, and two functions rewriting the same `args` would silently overwrite one
 * another. {@linkcode decoratorSeamExtras} is how this module contributes to it instead.
 *
 * @param wirings - The template's plugin wirings
 * @param seams - The host's consumable seams
 * @returns Rewritten wirings, preserving existing queue options alongside its processors
 */
export function withPluginOptionSeams(
  wirings: readonly Wiring[],
  seams: readonly SeamSpec[],
): readonly Wiring[] {
  const schematics = new Set(seams.map((spec) => spec.schematic));
  const args = new Map<string, string>();
  for (const seam of STARTER_SEAMS) {
    if (schematics.has(seam.schematic)) args.set(seam.plugin, starterSeamLiteral(seam));
  }

  if (schematics.has('health-indicator')) {
    args.set('health-plugin', `{ indicators: [...${HEALTH_INDICATORS_EXPORT}] }`);
  }
  if (schematics.has('metric')) {
    args.set('metrics-plugin', `{ customMetrics: [...${CUSTOM_METRICS_EXPORT}] }`);
  }

  return wirings.map((wiring) => {
    const replacement = args.get(wiring.pkg);
    return replacement === undefined
      ? wiring
      : {
          ...wiring,
          args:
            wiring.pkg === 'queue-plugin'
              ? wrapPluginArgs(mergeObjectArgs(wiring.args ?? '{}', replacement))
              : replacement,
        };
  });
}

/**
 * Each `DecoratorPlugin` option and the barrel export that feeds it.
 *
 * One table, shared by {@linkcode decoratorKeyFor} and
 * {@linkcode decoratorExportFor}, so a new decorator seam cannot map to a key
 * whose export the report names differently.
 */
const DECORATOR_ARMS = [
  ['controllers', APP_CONTROLLERS_EXPORT],
  ['services', APP_SERVICES_EXPORT],
  ['ingress', INGRESS_HANDLERS_EXPORT],
] as const;

/**
 * The `DecoratorPlugin` option key a seam's barrel feeds, if any.
 *
 * Keyed on the barrel's EXPORT rather than its schematic name, so the same
 * family in its functional shape (which exports nothing for the plugin) maps to
 * nothing, and controller and class-based route — two schematics sharing one
 * barrel — map to one key. This is the single table both
 * {@linkcode decoratorSeamExtras} and `setu generate`'s unwired-barrel report
 * read.
 *
 * @param spec - The seam
 * @returns The decorator key, or `undefined` when the barrel feeds no plugin arm
 */
export function decoratorKeyFor(
  spec: SeamSpec,
): 'controllers' | 'services' | 'ingress' | undefined {
  return DECORATOR_ARMS.find(([, symbol]) => spec.exports.includes(symbol))?.[0];
}

/**
 * The barrel export that feeds a seam's `DecoratorPlugin` option.
 *
 * The companion of {@linkcode decoratorKeyFor}, from the same table: the key
 * alone is not enough to render the line a developer must add, because the
 * option spreads the named export.
 *
 * @param spec - The seam
 * @returns The exported identifier, or `undefined` when the barrel feeds no plugin arm
 */
export function decoratorExportFor(spec: SeamSpec): string | undefined {
  return DECORATOR_ARMS.find(([, symbol]) => spec.exports.includes(symbol))?.[1];
}

/**
 * The extra controller and service identifiers the decorator wiring must name, beyond
 * the module barrel.
 *
 * Returned as a pair for `withModuleSeam`'s two positional lists, so the standalone
 * controller and service barrels are spread alongside the module ones rather than
 * replacing them.
 *
 * @param seams - The host's consumable seams
 * @returns Controller, service, and ingress identifier lists, either possibly empty
 */
export function decoratorSeamExtras(seams: readonly SeamSpec[]): {
  readonly controllers: readonly string[];
  readonly services: readonly string[];
  readonly ingress: readonly string[];
} {
  const keys = new Set(seams.map(decoratorKeyFor));
  return {
    // Gated on the EXPORT, not the schematic name: both modes generate
    // controllers, but only the class-based barrel declares APP_CONTROLLERS —
    // spreading it in a functional project would name a symbol that is not there.
    controllers: keys.has('controllers') ? [`...${APP_CONTROLLERS_EXPORT}`] : [],
    services: keys.has('services') ? [`...${APP_SERVICES_EXPORT}`] : [],
    ingress: keys.has('ingress') ? [`...${INGRESS_HANDLERS_EXPORT}`] : [],
  };
}
