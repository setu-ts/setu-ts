/**
 * A client the broker BUILT is force-closed when its first connect fails
 * (CodeRabbit #543): ioredis keeps retrying after a failed `connect()`, and
 * once the broker's listener comes off every retry would print
 * `[ioredis] Unhandled error event` to the console. Real ioredis against a
 * closed port; no Redis server is needed.
 *
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('RedisStreamsBroker built client, failed connect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the client, so no retry reaches the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broker = new RedisStreamsBroker(createFakeRuntime(), new JsonSerializer(), {
      url: 'redis://127.0.0.1:1',
    });
    await expect(broker.connect()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const unhandled = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes('Unhandled error event'),
    );
    expect(unhandled).toEqual([]);
  });
});
