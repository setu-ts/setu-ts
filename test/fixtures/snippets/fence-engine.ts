/**
 * Shared fence-classification and compilation engine for the M38 guide-fence
 * and decorator-fence compilers.
 *
 * The prior guide-fence compiler classified a fence as `exclude` whenever it
 * referenced a "fragment global" (`app`, `ctx`, `RuntimePlugin`, …) with NO
 * mechanical validation of the block's own `@setu-ts/` API calls. A controlled
 * break proved the gate stayed green over a provably-broken copyable Setu-TS
 * block (adding `NONEXISTENT_BROKEN_OPTION` to `CloudflarePlugin(...)` kept the
 * classification `exclude` while glue-compile failed). This engine replaces
 * that false-green rule with an enforceable compilation policy.
 *
 * Every TypeScript/TSX fence across the curated guides receives exactly ONE
 * explicit classification:
 *
 *   - **compile-complete** — standalone Setu-TS code, extracted and
 *     `deno check`ed directly.
 *   - **compile-fragment** — a Setu-TS fragment compiled using a deterministic,
 *     committed prelude that supplies only surrounding declarations/types and
 *     never masks API errors. The prelude imports real exported types and uses
 *     minimal `declare const`/`declare class` for runtime values and app-
 *     defined names the fence assumes but does not itself declare.
 *   - **external-source** — a NestJS/Fastify/Cloudflare platform source-side
 *     example, accepted only under an explicit labelled heading and a checked
 *     import/source policy (it must NOT import `@setu-ts/`).
 *   - **non-runnable-pseudocode** — allowed only when nearby prose labels it
 *     pseudocode and a committed allow-list records the exact guide/fence
 *     line/heading/reason.
 *
 * No fence importing `@setu-ts/` may be external-source or
 * non-runnable-pseudocode (except a narrowly justified, explicitly labelled
 * comparison); it must be compile-complete or compile-fragment. The
 * controlled mutation adding `NONEXISTENT_BROKEN_OPTION` to a compile-fragment
 * CloudflarePlugin block makes the gate fail.
 *
 * The engine reuses [`scanFences`](../../scripts/check-docs.ts) so fence
 * tracking is CommonMark-faithful, and compiles from a committed-only clean
 * checkout (the snippet import map at `test/fixtures/snippets/deno.json`).
 *
 * @module
 */
import { scanFences } from '../../../scripts/check-docs.ts';

/** Language aliases that map to TypeScript for compilation purposes. */
export const TS_ALIASES = new Set(['typescript', 'ts', 'tsx']);

/** The nine curated guides whose copyable fences must compile or be classified. */
export const GUIDES = [
  'docs/getting-started.md',
  'docs/programmatic-api.md',
  'docs/custom-plugins.md',
  'docs/plugin-architecture.md',
  'docs/examples.md',
  'docs/decorators.md',
  'docs/migration-fastify.md',
  'docs/migration-nestjs.md',
  'docs/runtime-deployment.md',
] as const;

/** The committed snippet import map used for all fence compilation. */
export const SNIPPET_CONFIG = 'test/fixtures/snippets/deno.json';

/** The four explicit classifications a TypeScript/TSX fence may receive. */
export type Classification =
  | 'compile-complete'
  | 'compile-fragment'
  | 'external-source'
  | 'non-runnable-pseudocode';

/** The classification of a non-TypeScript fence (not subject to compilation). */
export type SkipClassification = 'skip';

/** Any classification outcome, including skip for non-TS fences. */
export type AnyClassification = Classification | SkipClassification;

/**
 * A fenced code block extracted from a guide, with its opening line, nearest
 * heading, language, and body.
 */
export interface Fence {
  readonly guide: string;
  readonly index: number;
  readonly line: number;
  readonly heading: string;
  readonly lang: string;
  readonly code: string;
}

/**
 * The result of classifying a fence: its kind, a human-readable reason, and —
 * for compile-fragment fences — the identifier of the deterministic prelude
 * that wraps it.
 */
export interface ClassifiedFence {
  readonly fence: Fence;
  readonly kind: AnyClassification;
  readonly reason: string;
  readonly wrapperId: string | null;
}

/**
 * Identifiers a fence may reference that are NOT imported and NOT built-in —
 * the markers of a fragment that assumes an outer module context. A guide's
 * "Logger Plugin" block writes `app.register(LoggerPlugin())` after a single
 * `import { LoggerPlugin } ...` line, expecting the `app` from an earlier
 * block to still be in scope; a testing block uses `describe`/`it`/`expect`
 * without importing them.
 *
 * IMPORTANT: a reference to a fragment global no longer auto-excludes a fence.
 * It selects the compile-fragment classification, which compiles the block
 * WITH a deterministic prelude supplying the surrounding scope. A broken
 * `@setu-ts/` API call inside the block still fails compilation.
 *
 * Setu-TS type names that interface-sketch blocks reference without importing
 * are listed too: a block whose body is `interface RouteHandlerContext { … }`
 * documents a shape and needs the real type imported by the prelude to compile.
 */
export const FRAGMENT_GLOBALS = new Set([
  // Runtime/application globals assumed from an earlier block.
  'app',
  'ctx',
  'createApplication',
  'inject',
  'createTestApp',
  'platform',
  'content',
  // Test-harness globals a guide block uses without importing.
  'describe',
  'it',
  'expect',
  // Plugin factories referenced without their import line.
  'RuntimePlugin',
  'LoggerPlugin',
  'ConfigPlugin',
  'DatabasePlugin',
  'AuthPlugin',
  'SsePlugin',
  'MyPlugin',
  'mockMyService',
  'reportUsage',
  // Setu-TS type names interface-sketch blocks reference without importing.
  'IRequest',
  'IResponse',
  'IRequestContext',
  'IRuntimeServices',
  'IServiceRegistry',
  'ServiceRegistry',
  'RuntimePlatform',
  'HandlerResult',
  'ResponseSnapshot',
  'IFileSystem',
  'IWorkerHost',
  'IDnsResolver',
  'ICacheService',
  'IDatabaseService',
  'IMessageBroker',
  'ICqrsFacade',
  'IPrincipal',
  'ILogger',
  'IMetadataStore',
  'IMiddlewareApi',
  'IContainer',
  'IApplication',
  'IPlugin',
  'IPluginContext',
  'IConfig',
  'MiddlewareFunction',
  'ICacheStore',
  // Migration-guide source-side class names assumed from the NestJS side.
  'UserService',
  'CreateUserDto',
  // App-defined names used in guide fragments (must match APP_DECLARATIONS keys).
  'MyService',
  'MyPluginOptions',
  'CachePluginOptions',
  'IMyService',
  'IValidator',
  'MyValidator',
  'handler',
  'data',
  'UserRepository',
  'verifyToken',
  'HttpException',
  'loggerMiddleware',
  'CustomLoggerPlugin',
  'myMiddleware',
  'defaultConfig',
  'readableStream',
  'userRepository',
  'createCache',
]);

/**
 * The Setu-TS type-only exports the prelude may import to satisfy an
 * unimported type reference. Each entry maps a fragment-global type name to
 * the `@setu-ts/` package that exports it. The prelude imports these as
 * `import type { … }` so they never produce runtime code and never mask a bad
 * option name (a wrong object-literal property still fails).
 */
const TYPE_EXPORTS: Readonly<Record<string, string>> = {
  IRequest: '@setu-ts/common',
  IResponse: '@setu-ts/common',
  IRequestContext: '@setu-ts/common',
  IRuntimeServices: '@setu-ts/common',
  IServiceRegistry: '@setu-ts/common',
  IApplication: '@setu-ts/common',
  RuntimePlatform: '@setu-ts/common',
  HandlerResult: '@setu-ts/common',
  ResponseSnapshot: '@setu-ts/common',
  IFileSystem: '@setu-ts/common',
  IWorkerHost: '@setu-ts/common',
  IDnsResolver: '@setu-ts/common',
  IMessageBroker: '@setu-ts/common',
  ICqrsFacade: '@setu-ts/common',
  IPrincipal: '@setu-ts/common',
  ILogger: '@setu-ts/common',
  IMetadataStore: '@setu-ts/common',
  IContainer: '@setu-ts/common',
  IPlugin: '@setu-ts/common',
  IPluginContext: '@setu-ts/common',
  IConfig: '@setu-ts/common',
  MiddlewareFunction: '@setu-ts/common',
  ICacheStore: '@setu-ts/common',
  RouteHandler: '@setu-ts/common',
  IMiddlewareApi: '@setu-ts/common',
  IHealthApi: '@setu-ts/common',
  IMetricsApi: '@setu-ts/common',
  HealthCheckResult: '@setu-ts/common',
  IKernelApplication: '@setu-ts/kernel',
  IRouterApi: '@setu-ts/common',
  ILifecycleApi: '@setu-ts/common',
  ICliApi: '@setu-ts/common',
  IEnvironmentApi: '@setu-ts/common',
  IOpenApiApi: '@setu-ts/common',
  IDecoratorApi: '@setu-ts/common',
  StartOptions: '@setu-ts/common',
};

/**
 * Type names that fences reference as unimported documentation shorthand but
 * that are NOT exported from `@setu-ts/common` (`ServiceRegistry` is only an
 * `IServiceRegistry` interface — the class is not a public export;
 * `ICacheService`/`IDatabaseService` live as plugin-internal interfaces, not
 * public exports). The prelude declares these as minimal local structural
 * types so a fence using them as a generic type argument
 * (`ctx.services.get<ICacheService>('cache')`) compiles, while the fence's
 * OWN `@setu-ts/` option calls are still checked against the real imported
 * interfaces. The shapes are deliberately narrow and permissive — they exist
 * to satisfy a type-argument reference, not to validate the service surface
 * (that is the plugin's job).
 */
const LOCAL_TYPE_DECLS: Readonly<Record<string, string>> = {
  // Deliberately self-contained structural types (no reference to unimported names).
  // These satisfy a generic type-argument reference without masking option-name errors.
  ServiceRegistry:
    'declare class ServiceRegistry { get<T = unknown>(token: string): T | undefined; register<T>(token: string, service: T, options?: { singleton?: boolean; lazy?: boolean }): void; }',
  ICacheService:
    'declare interface ICacheService { get<T = unknown>(key: string): Promise<T | null>; set<T = unknown>(key: string, value: T, options?: { ttl?: number }): Promise<void>; del(key: string): Promise<void>; has(key: string): Promise<boolean>; }',
  IDatabaseService:
    'declare interface IDatabaseService { findAll<T = unknown>(entity: string, options?: unknown): Promise<T[]>; findById<T = unknown>(entity: string, id: string): Promise<T | null>; create<T = unknown>(entity: string, data: Partial<T>): Promise<T>; update<T = unknown>(entity: string, id: string, data: Partial<T>): Promise<T>; delete(entity: string, id: string): Promise<boolean>; }',
  // Additional local types for guides
  HealthIndicatorFn: 'declare type HealthIndicatorFn = () => Promise<{ status: "healthy" | "unhealthy"; detail?: Record<string, unknown>; }>',
};

/**
 * Plugin factories the prelude may import when a fragment references them
 * without their import line. Each maps a factory name to its package. The
 * prelude imports these as values so a `RuntimePlugin()` call type-checks.
 */
const VALUE_EXPORTS: Readonly<Record<string, string>> = {
  RuntimePlugin: '@setu-ts/runtime',
  LoggerPlugin: '@setu-ts/logger-plugin',
  ConfigPlugin: '@setu-ts/config-plugin',
  DatabasePlugin: '@setu-ts/database-plugin',
  AuthPlugin: '@setu-ts/auth-plugin',
  SsePlugin: '@setu-ts/sse-plugin',
  ValidationPlugin: '@setu-ts/validation-plugin',
  CAPABILITIES: '@setu-ts/common',
  createApplication: '@setu-ts/kernel',
  createTestApp: '@setu-ts/testing',
  inject: '@setu-ts/testing',
};

/**
 * App-defined names a fragment may assume without defining them. The prelude
 * declares these as `declare class`/`declare const`/`declare function` so the
 * block compiles, but ONLY when the fence body does NOT itself declare the
 * name (to avoid duplicate-declaration errors that could mask a real defect).
 * These are deliberately narrow: the real shape is unknown to the prelude, so
 * the declaration is the minimum the block's usage requires.
 */
const APP_DECLARATIONS: Readonly<Record<string, string>> = {
  UserService: 'declare class UserService { findAll(): Promise<{ id: string; name: string }[]>; findById(id: string): Promise<{ id: string; name: string } | null>; create(dto: unknown): Promise<{ id: string }> }',
  CreateUserDto: 'declare class CreateUserDto {}',
  MyPlugin: 'declare function MyPlugin(options: unknown): IPlugin',
  mockMyService: 'declare const mockMyService: { findAll(): Promise<unknown[]> }',
  reportUsage: 'declare function reportUsage(value: string | null): Promise<void>',
  MyService: 'declare class MyService { doSomething(): void }',
  MyPluginOptions: 'declare type MyPluginOptions = Record<string, unknown>',
  CachePluginOptions: 'declare type CachePluginOptions = Record<string, unknown>',
  IMyService: 'declare type IMyService = { doSomething(): void }',
  IValidator: 'declare type IValidator = { validate(data: unknown): unknown }',
  MyValidator: 'declare class MyValidator { validate(data: unknown): unknown }',
  handler: 'declare const handler: (ctx: IRequestContext) => Promise<void>',
  data: 'declare const data: unknown',
  userRepository: 'declare const userRepository: { findByName(name: string): Promise<unknown | null>; save(entity: unknown): Promise<unknown> }',
  UserRepository: 'declare class UserRepository { findByName(name: string): Promise<unknown | null>; save(entity: unknown): Promise<unknown> }',
  verifyToken: 'declare function verifyToken(token: string): unknown',
  HttpException: 'declare class HttpException extends Error { status: number; constructor(message: string, status?: number) }',
  loggerMiddleware: 'declare const loggerMiddleware: MiddlewareFunction',
  CustomLoggerPlugin: 'declare function CustomLoggerPlugin(options?: unknown): IPlugin',
  myMiddleware: 'declare const myMiddleware: MiddlewareFunction',
  defaultConfig: 'declare const defaultConfig: Record<string, unknown>',
  readableStream: 'declare const readableStream: ReadableStream<Uint8Array>',
  createCache: 'declare function createCache(config: Record<string, unknown>): { get(key: string): unknown; set(key: string, value: unknown): void; close(): Promise<void> }',
};

/**
 * Reports whether a fence imports from a `@setu-ts/` package.
 */
export function importsFromSetuTs(code: string): boolean {
  return /from\s+['"]@setu-ts\//.test(code) ||
    /import\s+['"]@setu-ts\//.test(code);
}

/**
 * Reports whether a fence imports a given identifier (so a reference to it is
 * NOT a fragment marker). Checks both `import { X }` and `import type { X }`
 * forms.
 */
export function importsIdentifier(code: string, name: string): boolean {
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  for (const match of code.matchAll(importBlockRe)) {
    if ((match[1] as string).includes(name)) return true;
  }
  return false;
}

/**
 * Reports whether a fence references a fragment global — an identifier that is
 * neither imported nor a TypeScript built-in. The check matches word-boundary
 * occurrences of each fragment global.
 */
export function referencesFragmentGlobal(code: string): string[] {
  const found: string[] = [];
  for (const name of FRAGMENT_GLOBALS) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(code) && !importsIdentifier(code, name)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Reports whether a fence declares a given name itself (as a class, function,
 * const, type, or interface). Used to decide whether the prelude may safely
 * `declare` the name without producing a duplicate-declaration error.
 */
function declaresName(code: string, name: string): boolean {
  const patterns = [
    new RegExp(`\\bclass\\s+${name}\\b`),
    new RegExp(`\\bfunction\\s+${name}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\btype\\s+${name}\\b`),
    new RegExp(`\\binterface\\s+${name}\\b`),
    new RegExp(`\\benum\\s+${name}\\b`),
  ];
  return patterns.some((re) => re.test(code));
}

/**
 * Extracts every fenced code block from a markdown document, pairing each with
 * its 1-based opening-fence line and the nearest preceding heading. Reuses
 * {@linkcode scanFences} for CommonMark-faithful fence tracking.
 */
export function extractFences(guide: string, markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const { blocks } = scanFences(lines);
  const headings = headingBefore(lines);
  const fences: Fence[] = [];
  for (const [i, block] of blocks.entries()) {
    const body = lines.slice(block.bodyStart, block.bodyEnd).join('\n');
    fences.push({
      guide,
      index: i,
      line: block.line,
      heading: headings.get(block.line) ?? '<no heading>',
      lang: block.info,
      code: body,
    });
  }
  return fences;
}

/**
 * Builds a map of fence-opening line → nearest preceding heading text.
 */
function headingBefore(lines: readonly string[]): Map<number, string> {
  const out = new Map<number, string>();
  let h = '<no heading>';
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] as string)) {
      h = (lines[i] as string).trim();
    }
    if (/ {0,3}(`{3,}|~{3,})/.test(lines[i] as string)) {
      out.set(i + 1, h);
    }
  }
  return out;
}

/**
 * The committed allow-list of non-runnable-pseudocode fences. Each entry names
 * the guide, the 1-based opening-fence line, the nearest heading, and the
 * reason the block is pseudocode rather than compilable code. A fence matches
 * by guide + opening line. Prefer rewriting as compilable code; this class is
 * the last resort and every entry is reviewed against source.
 *
 * Currently empty: every Setu-TS fence is compile-complete or compile-fragment.
 */
export const PSEUDOCODE_ALLOWLIST: readonly {
  readonly guide: string;
  readonly line: number;
  readonly heading: string;
  readonly reason: string;
}[] = [];

/**
 * Reports whether a fence is on the pseudocode allow-list (by guide + line).
 */
function isPseudocodeAllowed(guide: string, line: number): boolean {
  return PSEUDOCODE_ALLOWLIST.some((e) => e.guide === guide && e.line === line);
}

/**
 * Headings that label an external-source (platform-side) example. A TS fence
 * under one of these headings that does NOT import `@setu-ts/` is classified
 * external-source. The migration guides pair every `### NestJS`/`### Fastify`
 * heading with a `### Setu-TS` counterpart; the Setu-TS side is compiled.
 */
const EXTERNAL_HEADINGS = new Set([
  '### NestJS',
  '### NestJS (TypeORM)',
  '### Fastify',
]);

/**
 * Classifies a fence per the explicit policy. See the module doc for the four
 * classes and the no-auto-exclusion rule.
 */
export function classify(fence: Fence): ClassifiedFence {
  if (!TS_ALIASES.has(fence.lang)) {
    return { fence, kind: 'skip', reason: `non-TS language "${fence.lang}"`, wrapperId: null };
  }

  const setu = importsFromSetuTs(fence.code);
  const hasRelativeImport = /from\s+['"]\.{1,2}\//.test(fence.code);
  const globals = referencesFragmentGlobal(fence.code);

  // 1. A fence importing @setu-ts/ MUST be compile-complete or compile-fragment.
  //    It can never be external-source or non-runnable-pseudocode (the policy
  //    closes the false-green: a broken @setu-ts/ call must fail compilation).
  if (setu) {
    if (globals.length === 0 && !hasRelativeImport) {
      return {
        fence,
        kind: 'compile-complete',
        reason: 'imports @setu-ts/ with no fragment globals',
        wrapperId: null,
      };
    }
    const wrapperId = wrapperIdFor(globals, hasRelativeImport);
    return {
      fence,
      kind: 'compile-fragment',
      reason:
        `imports @setu-ts/ and references fragment globals [${globals.join(', ')}]${
          hasRelativeImport ? '; relative import' : ''
        } — compiled with prelude "${wrapperId}"`,
      wrapperId,
    };
  }

  // 2. A TS fence that does NOT import @setu-ts/.
  //    Pseudocode allow-list (last resort, reviewed against source).
  if (isPseudocodeAllowed(fence.guide, fence.line)) {
    const entry = PSEUDOCODE_ALLOWLIST.find((e) =>
      e.guide === fence.guide && e.line === fence.line
    )!;
    return {
      fence,
      kind: 'non-runnable-pseudocode',
      reason: `pseudocode (allow-listed: ${entry.reason}; heading: "${fence.heading}")`,
      wrapperId: null,
    };
  }

  //    External-source: a platform-side example under a labelled heading that
  //    does not import @setu-ts/. Checked import policy: no @setu-ts/ import.
  if (EXTERNAL_HEADINGS.has(fence.heading)) {
    return {
      fence,
      kind: 'external-source',
      reason: `platform source-side example (heading: "${fence.heading}")`,
      wrapperId: null,
    };
  }

  //    A Setu-TS-fragment fence with no @setu-ts/ import but using documented
  //    Setu APIs (globals like app/ctx, or Setu type names). Compile it with a
  //    prelude so a wrong type still fails — missing imports do not evade
  //    checks. This is the "do not let missing imports evade checks" rule.
  if (globals.length > 0 || hasRelativeImport) {
    const wrapperId = wrapperIdFor(globals, hasRelativeImport);
    return {
      fence,
      kind: 'compile-fragment',
      reason:
        `Setu-TS fragment (globals [${globals.join(', ')}]${
          hasRelativeImport ? '; relative import' : ''
        }) — compiled with prelude "${wrapperId}"`,
      wrapperId,
    };
  }

  //    A TS block with no @setu-ts/ import and no fragment globals: a type
  //    sketch or interface declaration. Compile it directly so a wrong type
  //    still fails.
  return {
    fence,
    kind: 'compile-complete',
    reason: 'TypeScript block with no fragment globals',
    wrapperId: null,
  };
}

/**
 * Computes a deterministic wrapper/prelude id from the fragment globals a fence
 * references and whether it has a relative import. Two fences with the same
 * globals get the same prelude, so the prelude is committed-by-construction
 * (the function is pure and the set of globals is closed). The id is the sorted
 * globals joined by `+`, with a `rel` suffix when a relative import is present.
 */
function wrapperIdFor(globals: readonly string[], hasRelativeImport: boolean): string {
  const sorted = [...globals].sort();
  const base = sorted.length === 0 ? 'none' : sorted.join('+');
  return hasRelativeImport ? `${base}+rel` : base;
}

/**
 * Builds the deterministic prelude for a compile-fragment fence. The prelude:
 *   - imports real exported Setu-TS types the fence references unimported
 *     (`import type { … }`), so a wrong object-literal property still fails;
 *   - imports real plugin factories / `createApplication` the fence references
 *     unimported, so a `RuntimePlugin()` call type-checks;
 *   - declares `app` as the real `IApplication`, `ctx` as `IRequestContext`,
 *     `platform` as `RuntimePlatform`, and runtime values via `declare const`;
 *   - declares app-defined names (`UserService`, `CreateUserDto`, …) ONLY when
 *     the fence body does NOT itself declare them, to avoid duplicate-
 *     declaration errors.
 *
 * The prelude never uses `any`, `@ts-ignore`, broad fake APIs, or duplicate
 * declarations that could conceal a bad option name.
 */
export function buildPrelude(globals: readonly string[], code: string): string {
  const present = new Set(globals);
  const lines: string[] = [
    '// ===== DETERMINISTIC PRELUDE (generated by test/fixtures/snippets/fence-engine.ts) =====',
    '// Supplies only the surrounding scope a fragment assumes; never masks a bad',
    '// @setu-ts/ option name. A wrong property on a Setu-TS options object still',
    '// fails compilation because the real exported interfaces are imported.',
    '',
  ];

  // Names the fence declares itself (class/function/const/type/interface/enum).
  // The prelude must NOT redeclare these, or "Duplicate identifier" masks the
  // real API check. This also covers `const app = createApplication(...)` blocks
  // that define their own `app`.
  const fenceDeclares = (name: string): boolean => declaresName(code, name);

  // Type imports grouped by package. Skip names the fence already imports, and
  // always include the types backing a declared `app`/`ctx`/`platform` so the
  // `declare const` below resolves even when the fence references the value but
  // not the type name.
  const typeNames = new Set<string>();
  for (const name of present) {
    // Skip names the fence already imports OR declares itself (a type-sketch
    // fence that defines `interface IRequest { … }` must not get a competing
    // import — that would be "Import declaration conflicts with local
    // declaration").
    if (TYPE_EXPORTS[name] !== undefined && !importsIdentifier(code, name) && !fenceDeclares(name)) {
      typeNames.add(name);
    }
  }
  // Also scan the code body for any TYPE_EXPORTS names that are referenced but
  // not imported or declared by the fence. This catches types like `IPlugin`,
  // `MiddlewareFunction`, etc. that appear in the code but aren't fragment
  // globals (they're not in FRAGMENT_GLOBALS but are still real type imports).
  for (const name of Object.keys(TYPE_EXPORTS)) {
    const wordRe = new RegExp(`\\b${name}\\b`);
    if (wordRe.test(code) && !importsIdentifier(code, name) && !fenceDeclares(name)) {
      typeNames.add(name);
    }
  }
  // Backing types for declared runtime globals (only when the fence does NOT
  // declare the global itself — a fence that declares `const app` provides its
  // own type and needs no prelude `app`).
  if (present.has('app') && !fenceDeclares('app') && !importsIdentifier(code, 'IApplication')) {
    typeNames.add('IApplication');
  }
  if (present.has('ctx') && !fenceDeclares('ctx')) {
    // The guides use `ctx` ambiguously for both the request context (route
    // handlers) and the plugin context (register(ctx)). Declare it as the
    // intersection so both `ctx.response` (IRequestContext) and
    // `ctx.lifecycle`/`ctx.health`/`ctx.router` (IPluginContext) resolve.
    // A wrong @setu-ts/ option name still fails — those are checked against
    // the real imported option interfaces, independent of `ctx`.
    if (!importsIdentifier(code, 'IRequestContext')) typeNames.add('IRequestContext');
    if (!importsIdentifier(code, 'IPluginContext')) typeNames.add('IPluginContext');
  }
  if (present.has('platform') && !fenceDeclares('platform') && !importsIdentifier(code, 'RuntimePlatform')) {
    typeNames.add('RuntimePlatform');
  }
  const typeByPkg = new Map<string, string[]>();
  for (const name of typeNames) {
    const pkg = TYPE_EXPORTS[name]!;
    const list = typeByPkg.get(pkg) ?? [];
    list.push(name);
    typeByPkg.set(pkg, list);
  }
  for (const [pkg, names] of typeByPkg) {
    lines.push(`import type { ${names.sort().join(', ')} } from '${pkg}';`);
  }

  // Value imports grouped by package (plugin factories, createApplication, …).
  // Skip names the fence already imports, to avoid "Import declaration
  // conflicts with local declaration" errors.
  const valByPkg = new Map<string, string[]>();
  for (const name of present) {
    const pkg = VALUE_EXPORTS[name];
    if (pkg !== undefined && !importsIdentifier(code, name)) {
      const list = valByPkg.get(pkg) ?? [];
      list.push(name);
      valByPkg.set(pkg, list);
    }
  }
  // Also scan code body for VALUE_EXPORTS names referenced but not imported.
  // This catches CAPABILITIES, ValidationPlugin, etc. that appear in code
  // without being in FRAGMENT_GLOBALS. Skip names already in valByPkg (from
  // present globals) to avoid duplicate imports.
  for (const name of Object.keys(VALUE_EXPORTS)) {
    // Avoid a second import if already added from the 'present' pass.
    let dominated = false;
    for (const [, names] of valByPkg) {
      if (names.includes(name)) { dominated = true; break; }
    }
    if (dominated) continue;
    const wordRe = new RegExp(`\\b${name}\\b`);
    if (wordRe.test(code) && !importsIdentifier(code, name) && !fenceDeclares(name)) {
      const pkg = VALUE_EXPORTS[name]!;
      const list = valByPkg.get(pkg) ?? [];
      list.push(name);
      valByPkg.set(pkg, list);
    }
  }
  for (const [pkg, names] of valByPkg) {
    lines.push(`import { ${names.sort().join(', ')} } from '${pkg}';`);
  }

  if (typeByPkg.size > 0 || valByPkg.size > 0) lines.push('');

  // Local type declarations for documentation-shorthand type names that are
  // NOT public exports (ServiceRegistry, ICacheService, IDatabaseService).
  // These satisfy a generic type-argument reference without masking the
  // fence's own @setu-ts/ option checks.
  // Also scan the code body for local-type names referenced directly.
  const localDecls: string[] = [];
  for (const [name, decl] of Object.entries(LOCAL_TYPE_DECLS)) {
    if (present.has(name) || /\b${name}\b/.test(code)) localDecls.push(decl + ';');
  }
  if (localDecls.length > 0) {
    lines.push(...localDecls);
    lines.push('');
  }

  // `app` — the real IApplication. Only declared when the fence does NOT
  // declare its own `app` (a fence with `const app = createApplication()`
  // provides its own and would otherwise hit "Cannot redeclare").
  if (present.has('app') && !fenceDeclares('app')) {
    lines.push('declare const app: IApplication;');
  }
  // `ctx` — the request/plugin context intersection (see backing-type note).
  if (present.has('ctx') && !fenceDeclares('ctx')) {
    lines.push('declare const ctx: IRequestContext & IPluginContext;');
  }
  // `platform` — a RuntimePlatform value.
  if (present.has('platform') && !fenceDeclares('platform')) {
    lines.push('declare const platform: RuntimePlatform;');
  }
  // `content` — a runtime value used by a streaming snippet; minimal string.
  if (present.has('content')) {
    lines.push('declare const content: string;');
  }
  // Test-harness globals (describe/it/expect) — the snippet import map does
  // not resolve @std/testing, so declare minimal signatures.
  if (present.has('describe')) {
    lines.push('declare function describe(name: string, fn: () => void | Promise<void>): void;');
  }
  if (present.has('it')) {
    lines.push('declare function it(name: string, fn: () => void | Promise<void>): void;');
  }
  if (present.has('expect')) {
    lines.push(
      'declare function expect<T>(actual: T): { toBe(expected: T): void; toEqual(expected: T): void; toBeGreaterThan(n: number): void; toBeLessThan(n: number): void; toContain(s: string): void; toBeNull(): void; toBeDefined(): void; toBeUndefined(): void; not: { toBe(expected: T): void; toEqual(expected: T): void; } };',
    );
  }

  // App-defined names the fence assumes but does not declare. Declare ONLY
  // those the fence body does NOT itself declare, to avoid duplicate-
  // declaration errors that would mask the real API check.
  for (const [name, decl] of Object.entries(APP_DECLARATIONS)) {
    if (present.has(name) && !fenceDeclares(name)) {
      lines.push(decl + ';');
    }
  }

  lines.push('');
  lines.push('// ===== END PRELUDE =====');
  lines.push('');
  return lines.join('\n');
}

/**
 * Assembles the compilable source for a fence: compile-complete fences compile
 * as-is; compile-fragment fences get the deterministic prelude prepended. The
 * prelude is built from the fence's own fragment globals and code, so it never
 * redeclares a name the fence defines and never re-imports a symbol the fence
 * already imports.
 */
export function assembleSource(fence: Fence, classified: ClassifiedFence): string {
  if (classified.kind === 'compile-complete') return fence.code;
  if (classified.kind !== 'compile-fragment') return fence.code;
  const globals = referencesFragmentGlobal(fence.code);
  const prelude = buildPrelude(globals, fence.code);
  return prelude + fence.code;
}

/**
 * Invokes `deno check --config <config> <file>` and returns exit code + stderr.
 */
export async function denoCheck(
  filePath: string,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command('deno', {
    args: ['check', '--config', SNIPPET_CONFIG, filePath],
    stdout: 'null',
    stderr: 'piped',
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Reads every guide and returns all fences with their classifications.
 */
export async function allFences(): Promise<readonly ClassifiedFence[]> {
  const out: ClassifiedFence[] = [];
  for (const guide of GUIDES) {
    const markdown = await Deno.readTextFile(guide);
    for (const fence of extractFences(guide, markdown)) {
      out.push(classify(fence));
    }
  }
  return out;
}
