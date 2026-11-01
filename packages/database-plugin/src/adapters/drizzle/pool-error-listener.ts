/** Reporting for app-owned Drizzle pools. @module */
import { describeError } from '@setu-ts/common';

/** A structural Node `EventEmitter`, read without importing `node:events`. */
type Emitter = {
  on?: (event: string, listener: (value: unknown, second?: unknown) => void) => unknown;
  listenerCount?: (event: string) => number;
};

/** Pools whose checkouts are already instrumented, so a second attach adds nothing. */
const instrumentedPools = new WeakSet<object>();

/** The listener each checked-out client carries, removed again when it is released. */
const checkedOutListeners = new WeakMap<object, (error: unknown) => void>();

/**
 * Attach once, preserving the application's existing error handling.
 *
 * Two listeners, because node-postgres covers the two states differently.
 * An IDLE client's error reaches the pool's `'error'` event, which is
 * attached only when the application has none. A CHECKED-OUT client has no
 * listener at all: pg-pool removes its idle listener on checkout, and
 * `pool.query()` adds a temporary one that a Drizzle transaction never gets,
 * because the transaction holds the client from `pool.connect()`. So a
 * connection lost while a transaction is open was an unhandled `'error'`
 * event, which exits the process (X94-1). Every client the pool hands out —
 * observed through pg-pool's public `'acquire'` event, which fires for every
 * checkout, including clients created before this ran — gets a listener
 * until pg-pool's `'release'` event, which fires after the pool's own idle
 * listener is back on the client, so the client is never without one and an
 * idle error is reported once, by the pool listener. The statement in flight
 * still rejects through the driver, so the request answers through the
 * classifier.
 *
 * @param database - The application-owned Drizzle instance
 * @param warn - The optional logger's reporting function
 * @returns Whether the pool-level listener was attached
 * @since 0.11.0
 */
export function attachPoolErrorListener(
  database: unknown,
  warn: (message: string, meta: Record<string, unknown>) => void,
): boolean {
  if (database === null || typeof database !== 'object') return false;
  const client = (database as { $client?: unknown }).$client;
  if (client === null || typeof client !== 'object') return false;
  const emitter = client as Emitter;
  if (typeof emitter.on !== 'function' || typeof emitter.listenerCount !== 'function') {
    return false;
  }
  if (!instrumentedPools.has(client)) {
    instrumentedPools.add(client);
    emitter.on('acquire', (checkedOut) => instrumentCheckedOutClient(checkedOut, warn));
    // pg-pool emits `release(err, client)`; mysql2's pool emits `release(connection)`.
    emitter.on('release', (first, second) => releaseCheckedOutClient(second ?? first));
  }
  if (emitter.listenerCount('error') !== 0) return false;
  emitter.on('error', (error) =>
    warn('Database pool reported an idle-connection error', { error: describeError(error) }),
  );
  return true;
}

/** Gives one checked-out client its `'error'` listener, once per checkout. */
function instrumentCheckedOutClient(
  checkedOut: unknown,
  warn: (message: string, meta: Record<string, unknown>) => void,
): void {
  if (checkedOut === null || typeof checkedOut !== 'object') return;
  if (checkedOutListeners.has(checkedOut)) return;
  const emitter = checkedOut as Emitter;
  if (typeof emitter.on !== 'function') return;
  const listener = (error: unknown): void =>
    warn('Database pool reported a checked-out-connection error', {
      error: describeError(error),
    });
  checkedOutListeners.set(checkedOut, listener);
  emitter.on('error', listener);
}

/** Removes the checkout listener; the pool's idle listener is already back. */
function releaseCheckedOutClient(released: unknown): void {
  if (released === null || typeof released !== 'object') return;
  const listener = checkedOutListeners.get(released);
  if (listener === undefined) return;
  checkedOutListeners.delete(released);
  (
    released as { removeListener?: (event: string, fn: (error: unknown) => void) => unknown }
  ).removeListener?.('error', listener);
}
