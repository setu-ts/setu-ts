// deno-lint-ignore-file require-await -- test fixture mirrors async ioredis signatures
/**
 * Fake ioredis client for testing RedisStore without a real Redis server.
 *
 * Records all calls so that tests can assert exactly what commands were
 * issued. Honors the structural `IRedisClient` shape (get/set/del/exists/
 * scan/quit) that RedisStore validates against.
 *
 * @module
 */
import type { IRedisClient } from '../../src/interfaces/index.ts';

/** A single recorded call to the fake Redis client. */
export interface FakeCall {
  /** Method name (`'get'`, `'set'`, `'del'`, `'exists'`, `'scan'`, `'quit'`). */
  method: string;
  /** Arguments passed to the method. */
  args: unknown[];
}

/** Options for the fake client. */
export interface FakeIoredisOptions {
  /** Pre-populated key-value pairs (stored as JSON strings). */
  initialData?: Record<string, unknown>;
  /** Whether `connect()` should succeed (default `true`). */
  connectSucceeds?: boolean;
}

/**
 * Create a fake ioredis client that records calls and supports basic GET/
 * SET/DEL/EXISTS/SCAN operations.
 *
 * @param opts - Optional pre-populated data and behavior flags
 * @returns A fake client and helper to inspect recorded calls
 */
export function createFakeIoredis(opts?: FakeIoredisOptions): {
  client: IRedisClient;
  calls: FakeCall[];
  data: Map<string, string>;
  resetCalls(): void;
} {
  const calls: FakeCall[] = [];
  const data = new Map<string, string>();

  if (opts?.initialData) {
    for (const [key, value] of Object.entries(opts.initialData)) {
      data.set(key, JSON.stringify(value));
    }
  }

  const client: IRedisClient = {
    async get(key: string): Promise<string | null> {
      calls.push({ method: 'get', args: [key] });
      const val = data.get(key);
      return val === undefined ? null : val;
    },

    async set(
      key: string,
      value: string,
      ttlMode?: 'EX',
      ttlSeconds?: number,
    ): Promise<string | null> {
      calls.push({ method: 'set', args: [key, value, ttlMode, ttlSeconds] });
      data.set(key, value);
      return 'OK';
    },

    async del(...keys: string[]): Promise<number> {
      calls.push({ method: 'del', args: keys });
      let removed = 0;
      for (const key of keys) {
        if (data.delete(key)) {
          removed++;
        }
      }
      return removed;
    },

    async exists(key: string): Promise<number> {
      calls.push({ method: 'exists', args: [key] });
      return data.has(key) ? 1 : 0;
    },

    async scan(
      cursor: string,
      matcher: string,
      matchValue?: string,
    ): Promise<[string, string[]]> {
      calls.push({ method: 'scan', args: [cursor, matcher, matchValue] });
      const pattern = matchValue ?? '*';
      const regex = new RegExp(
        `^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
      );
      const matched: string[] = [];
      for (const key of data.keys()) {
        if (regex.test(key)) {
          matched.push(key);
        }
      }
      return ['0', matched];
    },

    async quit(): Promise<void> {
      calls.push({ method: 'quit', args: [] });
    },

    async connect(): Promise<void> {
      calls.push({ method: 'connect', args: [] });
      if (opts?.connectSucceeds === false) {
        throw new Error('Fake Redis connection refused');
      }
    },
  };

  return {
    client,
    calls,
    data,
    resetCalls(): void {
      calls.length = 0;
    },
  };
}
