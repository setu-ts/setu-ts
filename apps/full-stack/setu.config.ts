import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';
import type { IKernelApplication, KernelDiagnosticsOptions } from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import type { FullStackStarterOptions } from '@setu-ts/full-stack-starter';
import { getCsrfToken, getSession } from '@setu-ts/session-plugin';
import type { ReactRouterPluginOptions } from '@setu-ts/react-router-plugin';
import { csrfContext, requestIdContext, sessionContext } from './app/server/context-keys.server.ts';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_MIDDLEWARE } from './src/middleware/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';

/**
 * Development session secret.
 *
 * A real deployment uses `config.getOrThrow<string>('SESSION_SECRET')` and
 * fails to boot without one — which is what `setu new --template full-stack`
 * emits. This example falls back so that `pnpm --dir apps/full-stack run smoke` runs with no
 * environment at all; the value is public, in a public repository, and is
 * therefore worth exactly nothing.
 */
const DEV_SESSION_SECRET = 'example-only-session-secret-do-not-deploy';

/**
 * Builds the application.
 *
 * `setu` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — `main.ts`, `dev.ts` and `smoke.ts` own that.
 *
 * @param env - The discovery environment `setu commands` passes positionally
 * on every target; the starter reads configuration itself, so this is
 * forwarded through unchanged.
 * @param _devtool - Accepted for one signature on every target. The starter
 * owns its construction, so a devtool composition cannot be honored here —
 * the CLI refuses the devtool opt-in on this template by name.
 * @param ssr - Supplied by the entry: the compiled server build in production, the Vite runtime in local development.
 * @returns The configured, unstarted application
 */
export async function createApp(
  env?: Readonly<Record<string, unknown>>,
  _devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
  ssr?: { serverBuild: unknown } | Pick<ReactRouterPluginOptions, 'loadRequestHandler' | 'mode'>,
): Promise<IKernelApplication> {
  const app = await createFullStackAppFromConfig(
    (config): FullStackStarterOptions => {
      const trustedProxies = config
        .get<string>('TRUSTED_PROXIES', { default: '' })
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const forwardedHost = config.get<string>('TRUST_FORWARDED_HOST', { default: '' });
      if (forwardedHost !== '' && forwardedHost !== 'false' && forwardedHost !== 'true') {
        throw new Error("TRUST_FORWARDED_HOST must be 'true', 'false' or empty");
      }
      const trustForwardedHost = forwardedHost === 'true';
      if (trustForwardedHost && trustedProxies.length === 0) {
        throw new Error(
          'TRUST_FORWARDED_HOST=true needs TRUSTED_PROXIES: list the proxies that overwrite X-Forwarded-Host',
        );
      }
      return {
        reactRouter: {
          // Production entries pass the compiled server build as a MODULE so
          // bundling cannot relocate a path relative to import.meta.url.
          // Config callers without the entry (tests and setu commands) keep
          // the absolute path fallback; development supplies the Vite runtime.
          ...(ssr !== undefined && 'serverBuild' in ssr
            ? { serverBuild: ssr.serverBuild }
            : {
                // Absolute, deliberately: the plugin does `await import(serverBuildPath)`,
                // and a relative specifier there would resolve against the PLUGIN's
                // module rather than this project.
                serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
                ...(ssr === undefined ? { assetsDir: './build/client/assets' } : ssr),
              }),
          // The production entry passes the module, and the socket server then
          // serves the client bundle the page loads itself (M120).
          ...('serverBuild' in (ssr ?? {}) ? { assetsDir: './build/client/assets' } : {}),
          populateLoadContext: (ctx, context) => {
            // The values a page reads that are not services. Services — a
            // module's, or the logger — come through getService(context, TOKEN),
            // which the plugin binds to this request. The keys come from
            // contextKeyFor(), so the copy of context-keys.server.ts inlined into
            // the server build resolves to the same key objects this module holds.
            context.set(requestIdContext, ctx.id);
            context.set(sessionContext, getSession(ctx));
            context.set(csrfContext, getCsrfToken(ctx));
          },
        },
        session: {
          secret: config.get<string>('SESSION_SECRET', { default: DEV_SESSION_SECRET }),
          csrf: {},
        },
        // The products module reads the database capability; memory keeps the
        // example runnable with no backend. `main.ts`, `dev.ts` and `smoke.ts` seed it
        // after start().
        database: { type: 'memory' },
        // Opted in by the scaffold, with the probe and scrape paths excluded so a
        // kubelet does not write a log line per poll. The plugin's own default
        // (off) is unchanged.
        logger: {
          transport: 'pino',
          requestLogging: true,
          excludePaths: ['/live', '/ready', '/health', '/metrics'],
        },
        // Preserve Origin on native form posts; send no cross-origin referrer.
        httpSecurity: {
          headers: { referrerPolicy: 'same-origin' },
          ...(trustedProxies.length > 0
            ? { ipSecurity: { trustProxy: true, trustedProxies, trustForwardedHost } }
            : {}),
        },
      };
    },
    { env, config: { envFilePath: '.env', envFileOptional: true } },
  );

  registerModules(app.router, app.services);
  for (const generated of GENERATED_MIDDLEWARE) {
    app.middleware.add(generated.middleware, {
      priority: generated.priority,
      name: generated.name,
    });
  }
  for (const generated of GENERATED_PLUGINS) app.register(generated);

  return app;
}
