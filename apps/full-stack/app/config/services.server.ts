import type { ILogger, ISession } from '@hono-enterprise/common';
import type { IDatabaseService } from '@hono-enterprise/database-plugin';
import type { AppLoadContext } from '~/lib/load-context.ts';
import {
  csrfContext,
  databaseContext,
  loggerContext,
  sessionContext,
} from '~/lib/context-keys.server.ts';

/**
 * Typed access to the framework services available on an SSR request.
 *
 * A conventional React Router app keeps a module-level `Map` here, caching one
 * database client, one HTTP client and one secret lookup for the life of the
 * process. That cache is exactly what the kernel's service registry already is,
 * so this module holds NO state: every value comes from the request context
 * that `honoe.config.ts` populated, and nothing is memoised here.
 * `test/removal.test.ts` asserts that, because "holds no state" is a claim, and
 * a claim nothing executes is a comment.
 *
 * @param value - The value read from the request context
 * @param name - The service name, for the error message
 * @returns The value, once known to be present
 * @throws {Error} If the value is absent, which means either that the plugin is
 * not registered, that its context key is not set in populateLoadContext, or
 * that this ran outside a loader or action
 */
function requireValue<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(
      `No ${name} on this request. Register its plugin in honoe.config.ts and set its ` +
        'context key in populateLoadContext, and call this only from a loader or action.',
    );
  }
  return value;
}

/** Resolves the application logger. */
export function getLogger(context: AppLoadContext): ILogger {
  return requireValue(context.get(loggerContext), 'logger');
}

/** Resolves the database service. */
export function getDatabase(context: AppLoadContext): IDatabaseService {
  return requireValue(context.get(databaseContext), 'database');
}

/** Resolves the session for the current request. */
export function getSession(context: AppLoadContext): ISession {
  return requireValue(context.get(sessionContext), 'session');
}

/**
 * Resolves the CSRF token to embed in a form.
 *
 * Read through this accessor rather than the key directly, so route components
 * — which ship to the browser — never import a server-only module.
 */
export function getCsrfToken(context: AppLoadContext): string {
  return requireValue(context.get(csrfContext), 'CSRF token');
}
