/**
 * The Durable Object side of the lock.
 *
 * The eviction test is the load-bearing one: a Durable Object is dropped from
 * memory after 70–140 seconds of inactivity, and a lock TTL routinely outlives
 * that. A deadline held in a field would evaporate and hand the same lock to a
 * second holder — precisely the failure a distributed lock exists to prevent —
 * so the test rebuilds the core over the same storage.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DistributedLockObjectCore } from '../../../src/durable-objects/distributed-lock-object.ts';
import { FakeDurableObjectState } from '../../do-fakes.ts';

/** Drives one lock operation the way `DurableObjectLock` does. */
async function call(
  core: DistributedLockObjectCore,
  path: string,
  payload: unknown,
): Promise<Response> {
  return await core.fetch(
    new Request(`https://lock.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

/** Reads the `token` an `/acquire` answered. */
async function acquire(
  core: DistributedLockObjectCore,
  token: string,
  ttlMs: number,
): Promise<string | null> {
  const response = await call(core, '/acquire', { token, ttlMs });
  return ((await response.json()) as { token: string | null }).token;
}

describe('DistributedLockObjectCore', () => {
  it('grants a free lock and persists the holder to storage', async () => {
    const state = new FakeDurableObjectState();
    const core = new DistributedLockObjectCore(state, { now: () => 1_000 });

    expect(await acquire(core, 'token-a', 30_000)).toBe('token-a');
    expect(state.storage.entries.get('lock:holder')).toEqual({
      token: 'token-a',
      expiresAt: 31_000,
    });
  });

  it('refuses a second acquire while the lock is held', async () => {
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => 1_000 });

    expect(await acquire(core, 'token-a', 30_000)).toBe('token-a');
    expect(await acquire(core, 'token-b', 30_000)).toBeNull();
  });

  it('displaces a holder whose deadline has passed', async () => {
    let now = 1_000;
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => now });

    await acquire(core, 'token-a', 5_000);
    now = 6_000; // exactly the deadline — an expiry is not "still held"
    expect(await acquire(core, 'token-b', 5_000)).toBe('token-b');
  });

  it('still refuses one millisecond before the deadline', async () => {
    let now = 1_000;
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => now });

    await acquire(core, 'token-a', 5_000);
    now = 5_999;
    expect(await acquire(core, 'token-b', 5_000)).toBeNull();
  });

  it('releases only for the holder that owns the lock', async () => {
    const state = new FakeDurableObjectState();
    const core = new DistributedLockObjectCore(state, { now: () => 1_000 });
    await acquire(core, 'token-a', 30_000);

    // A caller whose claim already expired must not release its successor's.
    await call(core, '/release', { token: 'token-b' });
    expect(state.storage.entries.has('lock:holder')).toBe(true);

    await call(core, '/release', { token: 'token-a' });
    expect(state.storage.entries.has('lock:holder')).toBe(false);
  });

  it('tolerates releasing a lock nobody holds', async () => {
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => 1_000 });
    const response = await call(core, '/release', { token: 'token-a' });
    expect(response.ok).toBe(true);
  });

  it('makes the lock re-acquirable after release', async () => {
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => 1_000 });

    await acquire(core, 'token-a', 30_000);
    await call(core, '/release', { token: 'token-a' });

    expect(await acquire(core, 'token-b', 30_000)).toBe('token-b');
  });

  it('survives eviction: a fresh core over the same storage still sees the holder', async () => {
    const state = new FakeDurableObjectState();
    const first = new DistributedLockObjectCore(state, { now: () => 1_000 });
    await acquire(first, 'token-a', 30_000);

    // The object was evicted and reconstructed; only storage survived.
    const woken = new DistributedLockObjectCore(state, { now: () => 2_000 });

    expect(await acquire(woken, 'token-b', 30_000)).toBeNull();
  });

  it('answers 404 for an unknown path rather than silently succeeding', async () => {
    const core = new DistributedLockObjectCore(new FakeDurableObjectState(), { now: () => 0 });
    const response = await core.fetch(
      new Request('https://lock.internal/renew', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(response.status).toBe(404);
  });

  it('defaults its clock to wall time when no seam is injected', async () => {
    const state = new FakeDurableObjectState();
    const core = new DistributedLockObjectCore(state);

    const before = Date.now();
    await acquire(core, 'token-a', 30_000);
    const held = state.storage.entries.get('lock:holder') as { expiresAt: number };

    expect(held.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
  });
});
