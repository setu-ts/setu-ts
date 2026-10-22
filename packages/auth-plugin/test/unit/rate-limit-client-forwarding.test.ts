import { expect, it, vi } from 'vitest';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const { construct } = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(...args: unknown[]) {
      construct(...args);
    }
    incr(): Promise<number> {
      return Promise.resolve(2);
    }
    pttl(): Promise<number> {
      return Promise.resolve(1000);
    }
    quit(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
import { RedisRateLimitStore } from '../../src/index.ts';

it('forwards configured commandTimeoutMs through lazy client construction', async () => {
  construct.mockClear();
  for (const commandTimeoutMs of [undefined, 1234, 0]) {
    const store = new RedisRateLimitStore({
      url: 'redis://forward.test',
      runtime: createFakeRuntime(),
      ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
    });
    expect((await store.increment('k', 1000)).count).toBe(2);
    await store.disconnect();
  }
  expect(construct.mock.calls).toEqual([
    ['redis://forward.test', { commandTimeout: 15000 }],
    ['redis://forward.test', { commandTimeout: 1234 }],
    ['redis://forward.test'],
  ]);
});
