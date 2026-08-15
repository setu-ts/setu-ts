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
import type { SeamSpec } from '../seams/seam-spec.ts';
import { APP_CONTROLLERS_EXPORT, REGISTER_ROUTES_EXPORT } from '../seams/http.ts';
import { APP_SERVICES_EXPORT } from '../seams/services.ts';
import { COMMAND_HANDLERS_EXPORT, QUERY_HANDLERS_EXPORT } from '../seams/cqrs.ts';
import { EVENT_HANDLERS_EXPORT } from '../seams/events.ts';
import { GENERATED_MIDDLEWARE_EXPORT } from '../seams/middleware.ts';
import { GENERATED_PLUGINS_EXPORT } from '../seams/plugins.ts';
import { HEALTH_INDICATORS_EXPORT } from '../seams/health.ts';
import { CUSTOM_METRICS_EXPORT } from '../seams/metrics.ts';
import type { LocalImport, Wiring } from './registry.ts';

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
 * @param seams - The host's consumable seams
 * @returns One file per seam, deduplicated by path
 */
export function seamFiles(seams: readonly SeamSpec[]): readonly GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const spec of seams) {
    // Deduplicated because two schematics can share one barrel: `command-handler` and
    // `query-handler` both render `src/cqrs/index.ts`, and emitting it twice would trip
    // the duplicate-path guard in `commands/new.ts`.
    if (byPath.has(spec.barrel)) continue;
    byPath.set(spec.barrel, { path: spec.barrel, contents: spec.renderBarrel({}) });
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
    calls.push(`${REGISTER_ROUTES_EXPORT}(app.router);`);
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
 * @returns The list with each seam-consuming plugin's `args` replaced
 */
export function withPluginOptionSeams(
  wirings: readonly Wiring[],
  seams: readonly SeamSpec[],
): readonly Wiring[] {
  const schematics = new Set(seams.map((spec) => spec.schematic));
  const args = new Map<string, string>();

  if (schematics.has('health-indicator')) {
    args.set('health-plugin', `{ indicators: [...${HEALTH_INDICATORS_EXPORT}] }`);
  }
  if (schematics.has('metric')) {
    args.set('metrics-plugin', `{ customMetrics: [...${CUSTOM_METRICS_EXPORT}] }`);
  }
  if (schematics.has('command-handler')) {
    args.set(
      'cqrs-plugin',
      `{ commandHandlers: ${COMMAND_HANDLERS_EXPORT}, queryHandlers: ${QUERY_HANDLERS_EXPORT} }`,
    );
  }
  if (schematics.has('event-handler')) {
    args.set('events-plugin', `{ handlers: ${EVENT_HANDLERS_EXPORT} }`);
  }

  return wirings.map((wiring) => {
    const replacement = args.get(wiring.pkg);
    return replacement === undefined ? wiring : { ...wiring, args: replacement };
  });
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
 * @returns Controller and service identifier lists, either possibly empty
 */
export function decoratorSeamExtras(
  seams: readonly SeamSpec[],
): { readonly controllers: readonly string[]; readonly services: readonly string[] } {
  const schematics = new Set(seams.map((spec) => spec.schematic));
  return {
    // Gated on the EXPORT, not the schematic name: both modes generate
    // controllers, but only the class-based barrel declares APP_CONTROLLERS —
    // spreading it in a functional project would name a symbol that is not there.
    controllers: seams.some((spec) => spec.exports.includes(APP_CONTROLLERS_EXPORT))
      ? [`...${APP_CONTROLLERS_EXPORT}`]
      : [],
    services: schematics.has('service') ? [`...${APP_SERVICES_EXPORT}`] : [],
  };
}
