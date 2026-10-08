/**
 * The Redis client seam: the lazy ioredis loader, the lazy-connect factory,
 * and structural validation of an injected client (plan §3.5).
 *
 * ioredis is never a hard dependency. It is either injected through plugin
 * options or loaded lazily through a dynamic `npm:` import.
 *
 * @module
 */
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
 * @param RedisCtor - The ioredis `Redis` constructor
 * @param url - The Redis connection URL
 * @param commandTimeoutMs - Per-command timeout; `0` omits the option
 * @returns A client that connects only when `connect()` is called
 * @since 0.9.0
 */
export function createRedisIdempotencyClient(
  RedisCtor: RedisCtor,
  url: string,
  commandTimeoutMs: number,
): IBuiltRedisIdempotencyClient {
  if (commandTimeoutMs === 0) {
    return new RedisCtor(url, { lazyConnect: true });
  }
  return new RedisCtor(url, { lazyConnect: true, commandTimeout: commandTimeoutMs });
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
