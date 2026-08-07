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
import { FULL_STACK_TEMPLATE } from './full-stack.ts';
import { MICROSERVICE_TEMPLATE } from './microservice.ts';
import { NEST_TEMPLATE } from './nest.ts';
import { REST_TEMPLATE, RUNTIME_WIRING } from './rest.ts';

/**
 * One symbol a generated `setu.config.ts` imports and calls.
 */
export interface Wiring {
  /** Bare `@setu-ts` package name, e.g. `config-plugin`. */
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
  /**
   * Replaces {@linkcode Wiring.args} when the target is `cloudflare-workers`.
   *
   * Workers has no ambient environment: bindings and variables arrive as the
   * `env` argument of the `fetch` handler, so a plugin that reads the
   * environment has to be handed it explicitly. The generated `createApp`
   * takes an `env` parameter on that target only, and this string may name it.
   *
   * Omitted → `args` is used on every target, which is what every wiring did
   * before this field existed.
   */
  readonly workersArgs?: string;
}

/**
 * One import of a project-local module emitted into `setu.config.ts`.
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
 * One middleware a generated `setu.config.ts` adds to the pipeline.
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
 * The starter factory a template composes through, instead of listing plugins.
 *
 * Separate from {@linkcode Wiring} because the two are rendered differently and
 * one field genuinely differs: a plugin's arguments are fixed text, while a
 * factory's can depend on the runtime target — whether the framework serves
 * static assets itself is a platform question, and a fixed string cannot ask
 * it.
 */
export interface AppFactoryWiring {
  /** Bare `@setu-ts` package name, e.g. `full-stack-starter`. */
  readonly pkg: string;
  /** The exported factory, e.g. `createFullStackAppFromConfig`. */
  readonly symbol: string;
  /**
   * Renders the call's argument list for a runtime target, without the
   * enclosing parentheses. Omitted → the factory is called with no arguments.
   *
   * The rendered call is always `await`ed, so a factory may be sync or async.
   */
  readonly args?: (runtime: TargetRuntime) => string;
}

/**
 * One `@setu-ts` package a template needs beyond its wirings.
 *
 * Two things are declared at once, deliberately: the symbols (if any) the
 * generated `setu.config.ts` imports, and the fact that the project depends on
 * the package. A template whose emitted source files import a package that no
 * wiring names — a type from the SSR plugin, say — would otherwise produce a
 * project whose own imports cannot resolve.
 */
export interface PackageImport {
  /** Bare `@setu-ts` package name. */
  readonly pkg: string;
  /**
   * Named exports the config module imports. Omitted → the package is added to
   * the manifest but nothing is imported into `setu.config.ts`, which is what
   * a package used only by the template's own source files needs.
   */
  readonly symbols?: readonly string[];
}

/**
 * Additions a template makes to the project's manifests.
 *
 * A template cannot simply emit its own `package.json` or `tsconfig.json`: on
 * the Node and Bun targets the fixed file set already writes both, so a second
 * copy would collide. Declaring the additions instead means one source of truth
 * produces both the merged file (Node, Bun) and the standalone one (Deno,
 * Cloudflare Workers, which otherwise have no npm manifest at all).
 */
export interface TemplateManifest {
  /** npm packages the running application needs, merged into `dependencies`. */
  readonly npmDependencies?: Readonly<Record<string, string>>;
  /** npm packages the build needs, merged into `devDependencies`. */
  readonly npmDevDependencies?: Readonly<Record<string, string>>;
  /** `compilerOptions` merged into `tsconfig.json`. */
  readonly tsconfigCompilerOptions?: Readonly<Record<string, unknown>>;
  /** Entries merged into the Deno import map, for aliases `deno check` must resolve. */
  readonly denoImports?: Readonly<Record<string, string>>;
  /**
   * Permission flags the generated Deno `start` task needs beyond the default
   * `--allow-net --allow-env`.
   *
   * A server-rendering template needs `--allow-read`: it loads its own compiled
   * server build and serves static assets through the runtime filesystem, so
   * without it the scaffolded project scaffolds cleanly and then fails on its
   * first request.
   */
  readonly denoPermissions?: readonly string[];
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
   *
   * Must be empty when {@linkcode TemplateDefinition.appFactory} is set — the
   * factory owns the whole plugin set, so anything listed here would be
   * dropped. A unit test enforces it across the registry rather than a runtime
   * check that no user input could ever reach.
   */
  readonly plugins: readonly Wiring[];
  /**
   * Compose through a starter factory instead of listing plugins.
   *
   * Present → the generated module awaits `<symbol>(<args>)` and imports it
   * from its package; absent → it calls `createApplication({ plugins })`,
   * rendering byte-identically to before this field existed.
   *
   * Reserved for a set large enough that listing it is worse than naming it:
   * the full-stack composition is twenty-two plugins, and a generated file a
   * human is meant to edit should not open with twenty-two imports they did not
   * choose.
   */
  readonly appFactory?: AppFactoryWiring;
  /**
   * Packages the template needs beyond those its wirings name.
   *
   * @see {@linkcode PackageImport}
   */
  readonly packageImports?: readonly PackageImport[];
  /**
   * Additions to the project's npm and TypeScript manifests.
   *
   * @see {@linkcode TemplateManifest}
   */
  readonly manifest?: TemplateManifest;
  /** Middleware added with `app.middleware.add(...)` after construction. */
  readonly middleware: readonly MiddlewareWiring[];
  /**
   * Project-local imports emitted into `setu.config.ts`, above the package
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
 * Still emitted through the same `setu.config.ts` seam as every template, so
 * plugin-command discovery has one shape to read.
 */
export const MINIMAL_PLUGINS: readonly Wiring[] = [RUNTIME_WIRING];

const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateDefinition> = new Map([
  [REST_TEMPLATE.name, REST_TEMPLATE],
  [MICROSERVICE_TEMPLATE.name, MICROSERVICE_TEMPLATE],
  [NEST_TEMPLATE.name, NEST_TEMPLATE],
  [FULL_STACK_TEMPLATE.name, FULL_STACK_TEMPLATE],
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
 * Consumed by `setu new --help`, so the documented list cannot drift from the
 * templates that actually exist.
 *
 * @returns Each template definition
 */
export function listTemplates(): readonly TemplateDefinition[] {
  return [...TEMPLATE_REGISTRY.values()];
}

/**
 * Collects the distinct `@setu-ts` packages a set of wirings imports.
 *
 * Consumed by the manifest writer, so a scaffolded project always declares an
 * import for every package its `setu.config.ts` references — the two cannot
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
