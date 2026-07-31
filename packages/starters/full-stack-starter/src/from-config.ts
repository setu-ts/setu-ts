/**
 * Config-driven composition — building the plugin set from values that are
 * only known at runtime.
 *
 * @module
 */

import type { IConfig } from '@hono-enterprise/common';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { createRuntimeServices } from '@hono-enterprise/runtime';
import type { ConfigPluginOptions } from '@hono-enterprise/config-plugin';
import { loadConfig } from '@hono-enterprise/config-plugin';

import type { FullStackStarterOptions } from './options.ts';
import { createFullStackApp } from './app.ts';

/**
 * Options for {@linkcode createFullStackAppFromConfig}.
 *
 * @since 0.2.0
 */
export interface FromConfigOptions {
  /**
   * Loading options — `.env` paths, variable expansion, validation schema.
   *
   * Forwarded to the loader and carried into the application's own `config`
   * arm, so one options object governs both.
   */
  readonly config?: ConfigPluginOptions;

  /**
   * The environment to read configuration from, instead of the platform's.
   *
   * **Required on Cloudflare Workers**, and the only way this factory works
   * there: Workers bindings arrive as the `env` argument of the `fetch`
   * handler, never as a process-wide global, so runtime services built outside
   * a request report an EMPTY environment. Without this the application
   * composes from no configuration at all — and a resolver calling
   * `getOrThrow` then fails on the first request and, because the boot promise
   * is memoised, on every request after it.
   *
   * Omit it on Node, Deno, and Bun: those expose the environment
   * process-wide, and the detected runtime already reads it.
   *
   * Non-string values are ignored, so a Workers `env` carrying KV, D1, or R2
   * bindings alongside its string variables can be passed verbatim.
   *
   * Explicitly `| undefined` under `exactOptionalPropertyTypes`: callers
   * forward an optional binding straight through (`{ env }` where `env` may be
   * undefined), which would not otherwise type-check against an optional
   * property. The generated Workers entry does exactly that on all four
   * targets.
   *
   * @example A Cloudflare Workers entry
   * ```typescript
   * export default {
   *   async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
   *     const app = await createFullStackAppFromConfig(build, { env });
   *     await app.start();
   *     return await app.fetch(request);
   *   },
   * };
   * ```
   */
  readonly env?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Narrows a platform environment to its string-valued entries.
 *
 * A Cloudflare `env` mixes configuration strings with binding objects (KV, D1,
 * R2, Durable Object namespaces); only the strings are configuration, and
 * `IConfig` is documented over string values.
 *
 * @param env - The raw environment
 * @returns Its string entries
 */
function toStringEnv(
  env: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | undefined>> {
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      strings[key] = value;
    }
  }
  return strings;
}

/**
 * Creates a full-stack application whose options are derived from
 * configuration.
 *
 * Plugin options must be decided before the plugins are constructed, which is
 * before `ConfigPlugin` has registered anything — so an application that needs
 * a database URL from the environment cannot get it from
 * `ctx.services.get(CAPABILITIES.CONFIG)`. This factory closes that ordering
 * gap: it builds runtime services, loads configuration once, hands the
 * snapshot to `build`, and passes that same snapshot into the application, so
 * the configuration the composition branched on is the configuration handlers
 * read.
 *
 * It applies to **every** option uniformly, which is why no plugin option
 * carries a `urlFromConfig`-style config-key field: a per-option shorthand
 * would need the value at the same impossible moment.
 *
 * Secrets are a different problem and this does not solve it: they are served
 * by `secrets-plugin` under `CAPABILITIES.SECRETS`, which exists only after
 * registration, so a plugin needing one resolves it lazily at use time.
 *
 * @example Choosing a database and a mail provider from the environment
 * ```typescript
 * import { createFullStackAppFromConfig } from '@hono-enterprise/full-stack-starter';
 *
 * const app = await createFullStackAppFromConfig((config) => ({
 *   database: { adapter: 'prisma', url: config.getOrThrow<string>('DATABASE_URL') },
 *   mail: { provider: 'sendgrid', apiKey: config.getOrThrow<string>('SENDGRID_KEY') },
 * }), { config: { envFilePath: ['.env.local', '.env'] } });
 *
 * app.router.get('/health', (ctx) => ctx.response.text('ok'));
 * await app.start({ port: 3000 });
 * ```
 * @param build - Derives the starter options from the loaded configuration.
 * Called exactly once, before any plugin is constructed.
 * @param options - Loading options and, on Cloudflare Workers, the request's
 * `env` bindings. See {@linkcode FromConfigOptions.env} — omitting it there
 * yields an empty configuration.
 * @returns The configured, un-started application
 * @throws {Error} If configuration cannot be loaded (unreadable `.env` file,
 * failed validation) or if `build` throws — in both cases before any plugin is
 * constructed, so no partially-composed application is returned
 * @since 0.2.0
 */
export async function createFullStackAppFromConfig(
  build: (config: IConfig) => FullStackStarterOptions,
  options?: FromConfigOptions,
): Promise<IKernelApplication> {
  const configOptions = options?.config;

  // Runtime services before the application: the same platform resolution
  // RuntimePlugin performs, so the environment read here is the one the app
  // will run against — except on Workers, where the environment is per-request
  // and must be handed in.
  const detected = createRuntimeServices();
  const runtime = options?.env === undefined
    ? detected
    : { ...detected, env: toStringEnv(options.env) };

  const config = await loadConfig(runtime, configOptions);

  const built = build(config);

  return createFullStackApp({
    ...built,
    // `instance` last so the snapshot always wins: without it the plugin would
    // load configuration a second time, and an application could branch on one
    // snapshot while serving another.
    config: { ...configOptions, ...built.config, instance: config },
  });
}
