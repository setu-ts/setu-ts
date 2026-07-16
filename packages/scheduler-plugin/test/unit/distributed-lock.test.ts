/**
 * Tests for resolveLock factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDistributedLock } from '../../src/interfaces/index.ts';
import { resolveLock } from '../../src/lock/distributed-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';

describe('resolveLock', () => {
  it('returns MemoryLock when distributedLock disabled', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock(undefined, runtime);
    expect(lock).toBeDefined();
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });

  it('returns injected custom lock when provided', async () => {
    const runtime = new FakeRuntime();
    const custom: IDistributedLock = {
      acquire() {
        return Promise.resolve('custom');
      },
      release() {
        return Promise.resolve();
      },
    };
    const lock = await resolveLock(
      { distributedLock: { lock: custom } },
      runtime,
    );
    expect(lock).toBe(custom);
  });

  it('returns MemoryLock when enabled is false', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock(
      { distributedLock: { enabled: false } },
      runtime,
    );
    expect(lock).toBeDefined();
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });
});
