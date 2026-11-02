/**
 * Builds the configured store (plan §3.5, §3.14).
 *
 * @module
 */
import type { ConnectionErrorReporter, IIdempotencyStore, ILogger } from '@setu-ts/common';
import { watchConnection } from '@setu-ts/common';
import type { IdempotencyStoreConfig } from '../interfaces/index.ts';
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS, DEFAULT_REDIS_KEY_PREFIX } from '../constants.ts';
import { createRedisIdempotencyClient, loadIoredis } from './redis-client.ts';
import { MemoryIdempotencyStore } from './memory-store.ts';
import { RedisIdempotencyStore } from './redis-store.ts';

/**
 * Builds the store described by `config`.
 *
 * @param config - The store configuration (`{ type: 'memory' }` when omitted)
 * @param reporter - Receives the connection errors of BOTH the built and an
 *   injected client (M131a X88-3): an injected node-redis client's outages must
 *   be as visible as a built ioredis client's. The attach is structural, so a
 *   client without `on` is left alone.
 * @param logger - The logger thunk
 * @returns The store
 */
export async function resolveStore(
  config: IdempotencyStoreConfig | undefined,
  reporter: ConnectionErrorReporter | undefined,
  logger: () => ILogger | undefined,
): Promise<IIdempotencyStore> {
  const resolved = config ?? { type: 'memory' as const };
  if (resolved.type === 'memory') {
    return new MemoryIdempotencyStore(resolved);
  }
  if (resolved.type === 'custom') {
    return resolved.store;
  }
  const keyPrefix = resolved.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
  if ('client' in resolved && resolved.client !== undefined) {
    // Detached on disconnect: the injected client outlives this store.
    const watch = watchConnection(resolved.client, reporter);
    return new RedisIdempotencyStore(resolved.client, {
      namespace: resolved.namespace,
      keyPrefix,
      logger,
      ownsClient: false,
      onDisconnect: () => watch.detach(),
    });
  }
  const built = resolved as Extract<IdempotencyStoreConfig, { type: 'redis'; url: string }>;
  const RedisCtor = await loadIoredis();
  const client = createRedisIdempotencyClient(
    RedisCtor,
    built.url,
    built.commandTimeoutMs ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    reporter,
  );
  return new RedisIdempotencyStore(client, {
    namespace: built.namespace,
    keyPrefix,
    logger,
    ownsClient: true,
  });
}
