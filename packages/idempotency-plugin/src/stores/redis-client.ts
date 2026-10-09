/**
 * The Redis client seam: the lazy ioredis loader, the lazy-connect factory,
 * and structural validation of an injected client (plan §3.5).
 *
 * ioredis is never a hard dependency. It is either injected through plugin
 * options or loaded lazily through a dynamic `npm:` import.
 *
 * @module
 */
import type { ConnectionErrorReporter } from '@setu-ts/common';
import { attachConnectionErrorReporter } from '@setu-ts/common';
import { IdempotencyConfigurationError } from '../errors.ts';
import type { IBuiltRedisIdempotencyClient, IRedisIdempotencyClient } from '../interfaces/index.ts';

/**
 * The constructor shape this package builds a client from.
 *
 * @since 0.9.0
 */
export type RedisCtor = new (
  url: string,
  options?: { readonly lazyConnect?: boolean; readonly commandTimeout?: number },
) => IBuiltRedisIdempotencyClient;

/**
 * Loads ioredis lazily.
 *
 * @returns The `Redis` constructor from `npm:ioredis@5.x`
 * @since 0.9.0
 */
export async function loadIoredis(): Promise<RedisCtor> {
  const module = await import('npm:ioredis@5.x');
  // Interop boundary: the module namespace is narrowed once, here, so no `any`
  // escapes into the store (AI_GUIDELINES §5.2 external-interop exception).
  return module.Redis as unknown as RedisCtor;
}

/**
 * Constructs a lazily-connected client.
 *
 * The connection-error reporter is attached HERE and only here: ioredis emits
 * `'error'` on every failed reconnect and, with no listener, writes each one to
 * the console itself, bypassing the application's logger (plan §3.5). An
 * INJECTED client never reaches this function, so the caller's own handling of
 * its events is left alone (§3.5).
 *
 * @param RedisCtor - The ioredis `Redis` constructor
 * @param url - The Redis connection URL
 * @param commandTimeoutMs - Per-command timeout; `0` omits the option
 * @param reporter - Routes `'error'`/`'ready'` events to the plugin's logger
 * @returns A client that connects only when `connect()` is called
 * @since 0.9.0
 */
export function createRedisIdempotencyClient(
  RedisCtor: RedisCtor,
  url: string,
  commandTimeoutMs: number,
  reporter?: ConnectionErrorReporter,
): IBuiltRedisIdempotencyClient {
  const client = commandTimeoutMs === 0
    ? new RedisCtor(url, { lazyConnect: true })
    : new RedisCtor(url, { lazyConnect: true, commandTimeout: commandTimeoutMs });
  if (reporter !== undefined) {
    attachConnectionErrorReporter(client, reporter);
  }
  return client;
}

/**
 * Validates an injected client structurally.
 *
 * @param client - The value supplied as `store.client`
 * @throws {IdempotencyConfigurationError} When a required member is missing
 * @since 0.9.0
 */
export function validateInjectedClient(client: unknown): asserts client is IRedisIdempotencyClient {
  const candidate = client as Partial<Record<'eval' | 'ping' | 'quit' | 'call', unknown>> | null;
  const ok = typeof client === 'object' && client !== null &&
    typeof candidate?.eval === 'function' &&
    typeof candidate?.ping === 'function' &&
    typeof candidate?.quit === 'function' &&
    typeof candidate?.call === 'function';
  if (!ok) {
    throw new IdempotencyConfigurationError(
      'store.client',
      'redis idempotency store: the injected client needs eval, ping, quit and call',
    );
  }
}
