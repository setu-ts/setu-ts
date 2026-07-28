/**
 * The template contract and the built-in template registry.
 *
 * A template is DATA — a list of packages and the symbols to import from them —
 * never a pre-rendered string. `commands/new.ts` owns the single renderer, so
 * every template produces the same file shape and a change to that shape lands
 * in exactly one place.
 *
 * @module
 */

import type { TargetRuntime, TemplateName } from '../constants.ts';
import { MICROSERVICE_TEMPLATE } from './microservice.ts';
import { REST_TEMPLATE, RUNTIME_WIRING } from './rest.ts';

/**
 * One symbol a generated `honoe.config.ts` imports and calls.
 */
export interface Wiring {
  /** Bare `@hono-enterprise` package name, e.g. `config-plugin`. */
  readonly pkg: string;
  /** The exported symbol, e.g. `ConfigPlugin`. */
  readonly symbol: string;
}

/**
 * A named plugin set, plus the runtimes it cannot target.
 */
export interface TemplateDefinition {
  /** The `--template` value that selects this set. */
  readonly name: TemplateName;
  /** One line describing the template, shown in `new --help`. */
  readonly description: string;
  /**
   * Plugins passed to `createApplication({ plugins: [...] })`, in registration
   * order, starting with the runtime provider.
   */
  readonly plugins: readonly Wiring[];
  /** Middleware added with `app.middleware.add(...)` after construction. */
  readonly middleware: readonly Wiring[];
  /**
   * Runtime targets this template refuses, mapped to the reason shown to the
   * user. Refusing at scaffold time beats a project that deploys and then
   * fails at first use.
   */
  readonly unsupported: Readonly<Partial<Record<TargetRuntime, string>>>;
}

/**
 * The plugin set used when no `--template` is given: a runtime provider alone.
 *
 * Still emitted through the same `honoe.config.ts` seam as every template, so
 * plugin-command discovery has one shape to read.
 */
export const MINIMAL_PLUGINS: readonly Wiring[] = [RUNTIME_WIRING];

const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateDefinition> = new Map([
  [REST_TEMPLATE.name, REST_TEMPLATE],
  [MICROSERVICE_TEMPLATE.name, MICROSERVICE_TEMPLATE],
]);

/**
 * Looks up a template by name.
 *
 * A `Map` rather than an object literal so a lookup of an inherited property
 * name (`constructor`, `__proto__`) misses cleanly.
 *
 * @param name - The `--template` value
 * @returns Its definition, or undefined when no such template exists
 */
export function getTemplate(name: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY.get(name);
}

/**
 * Lists every template in registration order.
 *
 * Consumed by `honoe new --help`, so the documented list cannot drift from the
 * templates that actually exist.
 *
 * @returns Each template definition
 */
export function listTemplates(): readonly TemplateDefinition[] {
  return [...TEMPLATE_REGISTRY.values()];
}

/**
 * Collects the distinct `@hono-enterprise` packages a set of wirings imports.
 *
 * Consumed by the manifest writer, so a scaffolded project always declares an
 * import for every package its `honoe.config.ts` references — the two cannot
 * disagree, because both read this one list.
 *
 * @param wirings - Wiring lists, in any order
 * @returns The bare package names, deduplicated, in first-seen order
 */
export function packagesOf(...wirings: readonly (readonly Wiring[])[]): readonly string[] {
  const seen = new Set<string>();
  for (const list of wirings) {
    for (const wiring of list) seen.add(wiring.pkg);
  }
  return [...seen];
}
