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
 * }), { envFilePath: ['.env.local', '.env'] });
 *
 * app.router.get('/health', (ctx) => ctx.response.text('ok'));
 * await app.start({ port: 3000 });
 * ```
 * @param build - Derives the starter options from the loaded configuration.
 * Called exactly once, before any plugin is constructed.
 * @param configOptions - Loading options (`.env` paths, expansion, validation
 * schema). Forwarded to the loader and carried into the application's own
 * config arm, so one options object governs both.
 * @returns The configured, un-started application
 * @throws {Error} If configuration cannot be loaded (unreadable `.env` file,
 * failed validation) or if `build` throws — in both cases before any plugin is
 * constructed, so no partially-composed application is returned
 * @since 0.2.0
 */
export async function createFullStackAppFromConfig(
  build: (config: IConfig) => FullStackStarterOptions,
  configOptions?: ConfigPluginOptions,
): Promise<IKernelApplication> {
  // Runtime services before the application: the same platform resolution
  // RuntimePlugin performs, so the environment read here is the one the app
  // will run against.
  const config = await loadConfig(createRuntimeServices(), configOptions);

  const options = build(config);

  return createFullStackApp({
    ...options,
    // `instance` last so the snapshot always wins: without it the plugin would
    // load configuration a second time, and an application could branch on one
    // snapshot while serving another.
    config: { ...configOptions, ...options.config, instance: config },
  });
}
