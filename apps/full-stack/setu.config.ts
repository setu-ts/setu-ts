import { getCsrfToken, getSession } from '@setu-ts/session-plugin';
import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';
import type { IKernelApplication } from '@setu-ts/kernel';

import { csrfContext, sessionContext } from './app/server/context-keys.server.ts';
import { registerModules } from './src/modules/index.ts';

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
 * it must NOT start the server — `main.ts` and `smoke.ts` own that.
 *
 * @returns The configured, unstarted application
 */
export async function createApp(): Promise<IKernelApplication> {
  const app = await createFullStackAppFromConfig((config) => ({
    // The SSR plugin, the session, and the database are all GATED arms of the
    // full-stack starter: a default-options full-stack app registers none of
    // them. Passing all three is what makes this example prove anything.
    reactRouter: {
      // Absolute, deliberately: the plugin does `await import(serverBuildPath)`,
      // and a relative specifier there would resolve against the PLUGIN's
      // module rather than this project.
      serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
      assetsDir: './build/client/assets',
      populateLoadContext: (ctx, context) => {
        // Only non-service values need application context keys. Module
        // services come through getService(context, TOKEN). The keys come
        // from contextKeyFor(), so the copy of
        // context-keys.server.ts that Vite inlined into the server build
        // resolves to the same key objects this module holds.
        context.set(sessionContext, getSession(ctx));
        context.set(csrfContext, getCsrfToken(ctx));
      },
    },
    session: {
      secret: config.get<string>('SESSION_SECRET', { default: DEV_SESSION_SECRET }),
      csrf: {},
    },
    // Native form posts need a same-origin Origin header for React Router's
    // action check. Keep referrers private when navigating to another origin.
    httpSecurity: { headers: { referrerPolicy: 'same-origin' } },
    database: { type: 'memory' },
  }));
  registerModules(app.router, app.services);
  return app;
}
