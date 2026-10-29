/** Shared client matrix for the guarded real-Redis suites (REDIS_URL). */
import { Redis } from 'ioredis';
import { createClient } from 'redis';
import { fromNodeRedis } from '../../src/index.ts';
import type { ConnectionErrorReporter, NodeRedisAdapter } from '../../src/index.ts';

/** The protocol variants must execute exactly the same assertions. */
export const REDIS_CLIENTS = ['ioredis', 'node-redis RESP3', 'node-redis RESP2'] as const;
export type RedisClientCase = (typeof REDIS_CLIENTS)[number];

/** Builds a caller-owned node-redis adapter with a recovery-aware reporter when supplied. */
export function nodeClient(
  variant: RedisClientCase,
  url: string,
  timeoutMs = 15_000,
  reporter?: ConnectionErrorReporter,
): NodeRedisAdapter {
  const raw =
    variant === 'node-redis RESP2' ? createClient({ url, RESP: 2 }) : createClient({ url });
  if (reporter !== undefined) raw.on('ready', () => reporter.recovered());
  return fromNodeRedis(raw, {
    commandTimeoutMs: timeoutMs,
    ...(reporter === undefined ? {} : { onError: (error: unknown) => reporter.report(error) }),
  });
}

/** Leaves ioredis's built-client path intact; injects an adapter for each node-redis arm. */
export function redisOptions(
  variant: RedisClientCase,
  url: string,
  timeoutMs?: number,
  reporter?: ConnectionErrorReporter,
): { url: string; commandTimeoutMs?: number } | { client: NodeRedisAdapter } {
  return variant === 'ioredis'
    ? { url, ...(timeoutMs === undefined ? {} : { commandTimeoutMs: timeoutMs }) }
    : { client: nodeClient(variant, url, timeoutMs, reporter) };
}

/** A raw client handle for listener-ownership assertions, captured after wrapping. */
export function injectedRedis(
  variant: RedisClientCase,
  url: string,
): {
  client: Redis | NodeRedisAdapter;
  listenerCount: () => number;
  disconnect: () => void;
} {
  if (variant === 'ioredis') {
    const raw = new Redis(url, { lazyConnect: true });
    return {
      client: raw,
      listenerCount: () => raw.listenerCount('error'),
      disconnect: () => raw.disconnect(),
    };
  }
  const raw =
    variant === 'node-redis RESP2' ? createClient({ url, RESP: 2 }) : createClient({ url });
  const client = fromNodeRedis(raw);
  return {
    client,
    listenerCount: () => raw.listenerCount('error'),
    disconnect: () => {
      if (raw.isOpen) client.disconnect();
    },
  };
}
