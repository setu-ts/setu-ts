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
import { CLASS_BASED_TEMPLATE } from './class-based.ts';
import { REST_TEMPLATE } from './rest.ts';

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
   * {@linkcode TemplateHost.localImports}, and the e2e drift gate
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
   *
   * Receives the selected runtime because factory composition can vary by
   * platform while the public template name stays the same.
   */
  readonly args?: (context: AppFactoryRenderContext) => string;
}

/** One configuration variable a template's generated source reads. */
export interface EnvVariable {
  /** The environment variable name, as the generated source spells it. */
  readonly name: string;
  /** One line explaining what it is, written above it in both dotenv files. */
  readonly description: string;
  /** A non-secret development value, written to the gitignored dotenv file. */
  readonly develop: string;
}

/** Inputs a template factory needs while its call is rendered. */
export interface AppFactoryRenderContext {
  /** The runtime target selected for the generated project. */
  readonly runtime: TargetRuntime;
  /** Identifier naming the workspace member's generated endpoint map, when any. */
  readonly serviceEndpoints?: string;
  /** Dotenv file passed through a config-driven starter factory. */
  readonly envFilePath?: string;
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
  /** Dotenv path emitted with a tracked example and passed to ConfigPlugin. */
  readonly envFilePath?: string;
  /**
   * Variables this template's own generated source reads.
   *
   * Declared rather than inferred: a template that emits
   * `config.getOrThrow('SESSION_SECRET')` and a dotenv file naming nothing
   * produces a project that cannot start, and the emitted example is then a
   * blank file rather than an answer to where configuration goes.
   */
  readonly envVariables?: readonly EnvVariable[];
  /** npm packages the running application needs, merged into `dependencies`. */
  readonly npmDependencies?: Readonly<Record<string, string>>;
  /** npm packages the build or tests need, merged into `devDependencies`. */
  readonly npmDevDependencies?: Readonly<Record<string, string>>;
  /**
   * The frontend build for a template with a real npm toolchain.
   *
   * Present ONLY for such a template, and it is what marks one — a Deno or
   * Workers target emits a standalone `package.json` + `tsconfig.json` only when
   * this is set.
   *
   * Declared explicitly rather than inferred from
   * {@linkcode TemplateManifest.npmDevDependencies}, which is what two sites
   * used to do. That proxy held only while exactly one template declared npm
   * packages at all: the moment a non-frontend template needed a dev dependency
   * for another reason — `@std/testing` and `@std/expect`, so the module
   * schematic's emitted test can run — it started emitting a `react-router
   * build` script into REST projects and, worse, a `package.json` into Deno
   * ones, which switches Deno to node_modules resolution.
   *
   * All three members travel together deliberately. A bare script string was
   * enough while only `package.json` read it, and that is exactly why a
   * scaffolded `full-stack` project could not be started by following its own
   * README (X5-3): the Deno target emitted the script into a manifest whose
   * runner the project never invokes, so there was no `build` task at all.
   */
  readonly npmBuild?: {
    /** The generated `package.json`'s `build` script. */
    readonly script: string;
    /**
     * The equivalent Deno task body.
     *
     * Not derivable from {@linkcode script}: that names a bin shim resolved
     * from `node_modules`, while Deno needs the npm specifier that provides it.
     */
    readonly denoCommand: string;
    /**
     * Where the build writes.
     *
     * Excluded from `fmt` and `lint`, and gitignored (D2) — `deno fmt` will
     * otherwise reformat a minified bundle, and the generated `.gitignore`
     * listed only `coverage/` and the env file.
     */
    readonly outputDir: string;
  };
  /**
   * `compilerOptions` merged into `tsconfig.json`, which the npm toolchain reads.
   *
   * Vite and `tsc` read `tsconfig.json`; Deno reads `deno.json` and ignores it
   * entirely. A template whose options must reach `deno check` sets
   * {@linkcode TemplateManifest.denoCompilerOptions} instead — the two are
   * separate because they are consumed by different toolchains, and conflating
   * them is what shipped a `full-stack` project whose every `.tsx` route failed
   * `deno check` with 79 `TS2686` errors while `vite build` succeeded.
   */
  readonly tsconfigCompilerOptions?: Readonly<Record<string, unknown>>;
  /**
   * `compilerOptions` merged into the generated `deno.json`.
   *
   * This is the set `deno check` and `deno task start` actually honor. A
   * template that emits JSX needs `jsx` and `jsxImportSource`; a template that
   * emits decorated classes needs nothing, because the decorator surface is
   * TC39 standard decorators, which Deno parses with no configuration at all.
   *
   * **A template emitting JSX must declare `jsx` whenever it declares anything
   * here at all.** Measured: a manifest with no `compilerOptions` key checks
   * JSX clean, because Deno applies its own `react-jsx` default — but declaring
   * ANY option replaces that default set, so one unrelated option silently
   * reverts JSX to the classic transform and every `.tsx` fails with
   * `TS2686 'React' refers to a UMD global`. That is why this is per template
   * rather than a fixed block: a fixed `experimentalDecorators` was itself the
   * cause of the full-stack template's 79 type errors (M63 D3), not merely a
   * redundant extra. The same trap is why a template needing no option now
   * declares none rather than an empty object.
   */
  readonly denoCompilerOptions?: Readonly<Record<string, unknown>>;
  /** Entries merged into the Deno import map, for aliases `deno check` must resolve. */
  readonly denoImports?: Readonly<Record<string, string>>;
  /**
   * Permission flags the generated Deno `start` task needs beyond the base
   * `--allow-net --allow-env`.
   *
   * The set is a property of the plugins the template wires, not of the
   * template's own code, so it is declared per template rather than defaulted:
   * anything wiring `HealthPlugin` needs `--allow-sys`, because the `self`
   * indicator reads `runtime.hostname()` on every probe and a project without it
   * scaffolds cleanly, starts, and then answers 500 on `/health` — the endpoint
   * the generated Kubernetes probes point at. A server-rendering template
   * additionally needs `--allow-read`: it loads its own compiled server build and
   * serves static assets through the runtime filesystem.
   */
  readonly denoPermissions?: readonly string[];
}

/**
 * Everything `commands/new.ts` needs to render a project, independent of
 * whether the user named a template.
 *
 * Extracted from {@linkcode TemplateDefinition} so the no-template path is a
 * HOST like any other rather than a pile of `?? []` defaults at the call site.
 * That is what lets a bare `setu new` project carry the seams that need no
 * plugin — `route`, `middleware` and `plugin` — so `setu generate route`, the
 * only HTTP handler a decorator-free project can generate, reaches a
 * registration site with no edit to a file the developer owns.
 *
 * It is deliberately NOT a fourth template: {@linkcode TemplateName} and the
 * registry below are untouched, so `new --help` still lists exactly the four
 * templates that exist and `--template minimal` is still an unknown value.
 */
export interface TemplateHost {
  /**
   * Plugins passed to `createApplication({ plugins: [...] })`, in registration
   * order, starting with the runtime provider.
   *
   * Must be empty when {@linkcode TemplateHost.appFactory} is set — the
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
  /** Additional renderer context for an app factory, supplied by a workspace overlay. */
  readonly appFactoryContext?: Omit<AppFactoryRenderContext, 'runtime'>;
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
   * Tasks merged into the generated `deno.json` beyond `start`.
   *
   * A template contributes one when its emitted source needs a command the fixed
   * set does not cover: the full-stack template's `check:app` type-checks the
   * `app/` tree, which `deno check main.ts` never reaches because those modules
   * are loaded through the compiled server build rather than imported by the
   * entry.
   *
   * Merged alongside the workspace transport's own task contributions, which is
   * why this is a record rather than a list.
   */
  readonly extraTasks?: Readonly<Record<string, string>>;
  /**
   * Extra entries appended to the `plugins: [...]` array, rendered verbatim.
   *
   * Needed because a seam barrel's contribution is a SPREAD of a local array
   * (`...GENERATED_PLUGINS`), which is not a {@linkcode Wiring} — it has no package
   * and no symbol to import from one, and its identifier comes from
   * {@linkcode TemplateHost.localImports}.
   *
   * Array position does not decide registration order: the kernel resolves plugins by
   * their declared `dependencies`.
   *
   * Must be empty when {@linkcode TemplateHost.appFactory} is set, for the same
   * reason `plugins` must: the factory owns the whole plugin set, so anything here
   * would be silently dropped. A unit test enforces it across the registry.
   *
   * Omitted → nothing appended, which is what every template did before this field
   * existed.
   */
  readonly pluginSpreads?: readonly string[];
  /**
   * Statements rendered verbatim inside `createApp()`, after the middleware block and
   * before the hello-world route.
   *
   * The seam for a generated artifact whose registration site is a CALL rather than a
   * plugin option — `registerGeneratedRoutes(app.router)`, or the loop that adds
   * generated middleware. Neither is expressible as a `Wiring` or a
   * `MiddlewareWiring`, and `IApplication` exposes no lifecycle hook that could carry
   * them instead.
   *
   * A rendered string for the same reason {@linkcode Wiring.args} is: the value is
   * authored by a template module in this repo and never taken from user input, so
   * there is no injection surface. Any identifier it names must be brought into scope
   * by {@linkcode TemplateHost.localImports}, and the e2e drift gate
   * type-checks the generated project — which is the only thing that can catch a
   * statement that does not compile.
   *
   * Must be empty when {@linkcode TemplateHost.appFactory} is set: a
   * starter-composed template's registration is the starter's business, and the
   * factory branch of the renderer does not emit these. A unit test enforces it across
   * the registry rather than leaving a silently-dropped field.
   *
   * Omitted → nothing rendered, byte-identical to before this field existed.
   */
  readonly setupCalls?: readonly string[];
  /**
   * Per-runtime replacements applied before anything is rendered.
   *
   * @see {@linkcode RuntimeSwap}
   */
  readonly runtimeSwaps?: Readonly<Partial<Record<TargetRuntime, RuntimeSwap>>>;
}

/**
 * One module export a Workers entry declares beside `fetch`.
 *
 * Cloudflare invokes a queue consumer through a **module-level export**, not
 * through `fetch`, so a template whose capabilities include consuming a queue
 * has to contribute one. The rendered export reuses the entry's memoised
 * `boot(env)`: a second application would mean a second broker with its own
 * dispatch table, and the subscriptions registered on one would be invisible to
 * the other.
 *
 * @since 0.2.0
 */
export interface WorkerExport {
  /** The module-export name, e.g. `queue`. */
  readonly name: string;
  /**
   * The type of the payload the platform passes, imported as a type from
   * {@linkcode WorkerExport.payloadPkg} — e.g. `IQueueMessageBatch`.
   *
   * Named rather than left as a placeholder: the export is part of the
   * project's public module surface, and a generated signature that does not
   * describe what the platform actually passes is a lie that type-checks
   * (nothing in the project calls it).
   */
  readonly payloadType: string;
  /** Bare `@setu-ts` package {@linkcode WorkerExport.payloadType} comes from. */
  readonly payloadPkg: string;
  /**
   * Which factory handles which queue, keyed by the queue NAME from
   * `wrangler.toml` — never the binding name.
   *
   * A list rather than one factory because **Cloudflare invokes a single
   * `queue` export for every queue a Worker consumes**, distinguished only by
   * `batch.queue`. A Worker consuming two queues that dispatches both into one
   * handler feeds each the other's messages: the messaging broker cannot read a
   * job envelope, so it retries that batch until the queue dead-letters it.
   * Emitting the routing is what lets one Worker serve messaging AND queues.
   *
   * An unlisted queue name **throws** in the generated handler rather than
   * falling through to whichever route happens to be first: a batch the project
   * has no handler for is a configuration mistake, and answering it silently is
   * how the work disappears.
   */
  readonly routes: readonly WorkerExportRoute[];
}

/**
 * One queue a {@linkcode WorkerExport} dispatches, and the factory handling it.
 *
 * @since 0.2.0
 */
export interface WorkerExportRoute {
  /**
   * The queue NAME from `wrangler.toml` (`queue = "…"`), which is what
   * `batch.queue` carries — never the binding name.
   */
  readonly queueName: string;
  /** Bare `@setu-ts` package the factory comes from, e.g. `cloudflare-plugin`. */
  readonly pkg: string;
  /** The factory symbol, called with the booted application. */
  readonly symbol: string;
}

/**
 * What a template swaps when it is scaffolded for a particular runtime.
 *
 * Declarative data rather than a callback, so `--dry-run` stays exact and the
 * swap is assertable without rendering a project.
 *
 * This exists because a capability can be genuinely available on a runtime
 * through a *different* plugin. `microservice` is the case it was built for:
 * its `messaging` and `queue` capabilities come from brokers that need raw
 * sockets everywhere except Cloudflare Workers, where the platform serves both
 * itself. Before this the whole template was refused on that target.
 *
 * @since 0.2.0
 */
export interface RuntimeSwap {
  /**
   * Bare package names dropped from the plugin list on this runtime.
   *
   * By name rather than by index, so a plugin added to the template later
   * cannot silently shift what the swap removes. A name that is not in the
   * list throws — that is a defect in this repository's own template, caught
   * by a unit test and never reachable by a user.
   */
  readonly removePackages: readonly string[];
  /** Wirings appended in their place. */
  readonly addPlugins: readonly Wiring[];
  /** Extra module exports the Workers entry declares beside `fetch`. */
  readonly workerExports?: readonly WorkerExport[];
  /** Extra source files this runtime needs, appended to the template's own. */
  readonly files?: readonly GeneratedFile[];
  /**
   * Lines appended verbatim to the Workers entry, for a Durable Object class
   * the platform requires the entry module to re-export.
   */
  readonly entryReExports?: readonly string[];
  /** TOML appended verbatim to the generated `wrangler.toml`. */
  readonly wranglerToml?: string;
}

/**
 * A named plugin set, plus the runtimes it cannot target.
 *
 * A {@linkcode TemplateHost} that `--template` can select by name, which is the
 * whole difference: the no-template host is rendered the same way and simply
 * has no name to be selected by.
 */
export interface TemplateDefinition extends TemplateHost {
  /** The `--template` value that selects this set. */
  readonly name: TemplateName;
  /** One line describing the template, shown in `new --help`. */
  readonly description: string;
}

const TEMPLATE_REGISTRY: ReadonlyMap<string, TemplateDefinition> = new Map([
  [REST_TEMPLATE.name, REST_TEMPLATE],
  [MICROSERVICE_TEMPLATE.name, MICROSERVICE_TEMPLATE],
  [CLASS_BASED_TEMPLATE.name, CLASS_BASED_TEMPLATE],
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
