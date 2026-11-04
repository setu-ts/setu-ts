import type { ISession } from '@setu-ts/common';
import type { AppLoadContext } from '~/lib/load-context.ts';
import { csrfContext, sessionContext } from '~/server/context-keys.server.ts';

/** Requires a request value without caching any state between requests. */
function requireValue<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new Error(
      `No ${name} on this request. Set its context key in populateLoadContext in ` +
        'setu.config.ts, and call this only from a loader or action.',
    );
  }
  return value;
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
