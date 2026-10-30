/** Reporting for app-owned Drizzle pools. @module */
import { describeError } from '@setu-ts/common';

/**
 * Attach once, preserving the application's existing error handling.
 * @param database - The application-owned Drizzle instance
 * @param warn - The optional logger's reporting function
 * @returns Whether a listener was attached
 * @since 0.11.0
 */
export function attachPoolErrorListener(
  database: unknown,
  warn: (message: string, meta: Record<string, unknown>) => void,
): boolean {
  if (database === null || typeof database !== 'object') return false;
  const client = (database as { $client?: unknown }).$client;
  if (client === null || typeof client !== 'object') return false;
  const emitter = client as {
    on?: (event: string, listener: (error: unknown) => void) => unknown;
    listenerCount?: (event: string) => number;
  };
  if (
    typeof emitter.on !== 'function' ||
    typeof emitter.listenerCount !== 'function' ||
    emitter.listenerCount('error') !== 0
  )
    return false;
  emitter.on('error', (error) =>
    warn('Database pool reported an idle-connection error', { error: describeError(error) }),
  );
  return true;
}
