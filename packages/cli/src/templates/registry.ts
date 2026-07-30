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
import type { GeneratedFile } from '../utils/file-writer.ts';
import { MICROSERVICE_TEMPLATE } from './microservice.ts';
import { NEST_TEMPLATE } from './nest.ts';
import { REST_TEMPLATE, RUNTIME_WIRING } from './rest.ts';

/**
 * One symbol a generated `honoe.config.ts` imports and calls.
 */
export interface Wiring {
  /** Bare `@hono-enterprise` package name, e.g. `config-plugin`. */
  readonly pkg: string;
  /** The exported symbol, e.g. `ConfigPlugin`. */
  readonly symbol: string;
  /**
   * Source rendered verbatim as the call's argument list, without the enclosing
   * parentheses — e.g. `{ controllers: [GreetingController] }` produces
   * `DecoratorPlugin({ controllers: [GreetingController] })`.
   *
   * Omitted → the symbol is called with no arguments, which is what every
   * template did before this field existed.
   *
   * A rendered string rather than a structured option object: the value is
   * authored by a template module in this repo and never taken from user input,
   * so there is no injection surface, and an option-object AST would be a second
   * serializer to keep in step with TypeScript syntax for no gain. Any
   * identifier the string names must be brought into scope by the template's
   * {@linkcode TemplateDefinition.localImports}, and the e2e drift gate
   * type-checks the generated project, so an `args` string that does not compile
   * fails the build.
   */
  readonly args?: string;
}

/**
 * One import of a project-local module emitted into `honoe.config.ts`.
 *
 * Needed because a {@linkcode Wiring.args} string can name a class the template
 * also emits as a source file; without the import, the generated config would
 * reference an undeclared identifier.
 */
export interface LocalImport {
  /** Named exports to import. */
  readonly symbols: readonly string[];
  /** Module specifier, relative to the project root, e.g. `./src/greeting-controller.ts`. */
  readonly from: string;
}

/**
 * One middleware a generated `honoe.config.ts` adds to the pipeline.
 *
 * `addOptions` is **required**, deliberately. A bare `app.middleware.add(fn())`
 * lands at the pipeline default of `500`, which is silently wrong for anything
 * whose contract fixes its position — and that is how every project scaffolded
 * with `--template rest` or `--template microservice` ended up with an error
 * handler that could not catch throws from the metrics (20) or telemetry (30)
 * middleware. Requiring the field means the next middleware added to a template
 * cannot repeat the mistake: omitting it is a compile error, not a 500 in
 * production.
 */
export interface MiddlewareWiring extends Wiring {
  /** Position and diagnostic name for `app.middleware.add(...)`. */
  readonly addOptions: {
    /** Execution priority — lower runs earlier, so lower is outermost. */
    readonly priority: number;
    /** Diagnostic name shown in pipeline introspection. */
    readonly name: string;
  };
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
  readonly middleware: readonly MiddlewareWiring[];
  /**
   * Project-local imports emitted into `honoe.config.ts`, above the package
   * imports. Present only for templates whose {@linkcode Wiring.args} name a
   * class the template also emits.
   */
  readonly localImports?: readonly LocalImport[];
  /**
   * Extra source files this template emits, appended to the fixed project file
   * set. Paths are project-relative and must not collide with the fixed set —
   * the overwrite check in `commands/new.ts` reports a collision rather than
   * silently winning.
   */
  readonly files?: readonly GeneratedFile[];
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
  [NEST_TEMPLATE.name, NEST_TEMPLATE],
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
