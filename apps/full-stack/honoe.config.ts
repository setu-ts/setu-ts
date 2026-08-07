import { CAPABILITIES, type ILogger } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { getCsrfToken, getSession } from '@setu-ts/session-plugin';
import { createFullStackAppFromConfig } from '@setu-ts/full-stack-starter';
import type { IKernelApplication } from '@setu-ts/kernel';

import {
  csrfContext,
  databaseContext,
  loggerContext,
  sessionContext,
} from '~/lib/context-keys.server.ts';

/**
 * Development session secret.
 *
 * A real deployment uses `config.getOrThrow<string>('SESSION_SECRET')` and
 * fails to boot without one — which is what `setu new --template full-stack`
 * emits. This example falls back so that `deno task smoke` runs with no
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
export function createApp(): Promise<IKernelApplication> {
  return createFullStackAppFromConfig((config) => ({
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
        // The bridge between the kernel request context and a React Router
        // loader: getSession() needs the kernel context, which a loader never
        // sees. The keys come from contextKeyFor(), so the copy of
        // context-keys.server.ts that Vite inlined into the server build
        // resolves to the same key objects this module holds.
        context.set(sessionContext, getSession(ctx));
        context.set(csrfContext, getCsrfToken(ctx));
        context.set(loggerContext, ctx.services.get<ILogger>(CAPABILITIES.LOGGER));
        context.set(
          databaseContext,
          ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE),
        );
      },
    },
    session: {
      secret: config.get<string>('SESSION_SECRET', { default: DEV_SESSION_SECRET }),
      csrf: {},
    },
    database: { type: 'memory' },
  }));
}
