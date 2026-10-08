/**
 * Compile-time proof that a real ioredis `Redis` is assignable to
 * `IRedisIdempotencyClient` with NO cast (plan §3.5, §6).
 *
 * Never executed: `deno task check` is the assertion. A change to either the
 * facade or ioredis's surface that breaks the seam stops this file compiling.
 *
 * @module
 */
import type { Redis } from 'npm:ioredis@5.x';
import type { IRedisIdempotencyClient } from '../../src/interfaces/index.ts';

declare const redis: Redis;

/** A real `Redis` widens into the store's facade with no cast. */
export const client: IRedisIdempotencyClient = redis;
