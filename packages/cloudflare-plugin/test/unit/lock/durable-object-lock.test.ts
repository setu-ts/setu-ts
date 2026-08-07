/**
 * The replica side of the lock.
 *
 * These drive the REAL `DistributedLockObjectCore` behind the fake namespace,
 * so an acquisition is genuinely arbitrated rather than scripted — which is
 * what makes "the second caller is refused" evidence instead of an assertion
 * about which methods were called.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRuntimeServices } from '@setu-ts/common';
import { DurableObjectLock } from '../../../src/lock/durable-object-lock.ts';
import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';

/** A runtime whose uuids are predictable, so a token is nameable. */
function fakeRuntime(): IRuntimeServices {
  let next = 0;
  return { uuid: () => `token-${++next}` } as unknown as IRuntimeServices;
}

describe('DurableObjectLock', () => {
  it('acquires a free lock and returns the minted token', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const lock = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    expect(await lock.acquire('reports', 30_000)).toBe('token-1');
  });

  it('mints the token from runtime.uuid(), never from its own counter', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const runtime = fakeRuntime();
    const lock = new DurableObjectLock(namespace, { runtime });

    const first = await lock.acquire('a', 30_000);
    const second = await lock.acquire('b', 30_000);

    expect([first, second]).toEqual(['token-1', 'token-2']);
  });

  it('refuses a second holder while the lock is live', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const a = new DurableObjectLock(namespace, { runtime: fakeRuntime() });
    const b = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    expect(await a.acquire('reports', 30_000)).toBe('token-1');
    expect(await b.acquire('reports', 30_000)).toBeNull();
  });

  it('hands the lock over after the holder releases', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const a = new DurableObjectLock(namespace, { runtime: fakeRuntime() });
    const b = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    const token = await a.acquire('reports', 30_000);
    await a.release('reports', token!);

    expect(await b.acquire('reports', 30_000)).toBe('token-1');
  });

  it('keys each lock to its own object, so two keys do not contend', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const lock = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    expect(await lock.acquire('reports', 30_000)).not.toBeNull();
    expect(await lock.acquire('invoices', 30_000)).not.toBeNull();
  });

  it('namespaces the object name with keyPrefix', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const lock = new DurableObjectLock(namespace, {
      runtime: fakeRuntime(),
      keyPrefix: 'app-a:',
    });

    await lock.acquire('reports', 30_000);

    expect(namespace.requestedNames).toEqual(['app-a:reports']);
  });

  it('does not release a lock held under a different token', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const a = new DurableObjectLock(namespace, { runtime: fakeRuntime() });
    const b = new DurableObjectLock(namespace, { runtime: fakeRuntime() });
    await a.acquire('reports', 30_000);

    // b never held it; releasing must not steal the lock from a.
    await b.release('reports', 'token-999');

    expect(await b.acquire('reports', 30_000)).toBeNull();
  });

  it('throws on a non-2xx rather than reporting it as contention', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    // A binding whose class_name is not the lock object answers 404. Folding
    // that into "someone else holds it" would silently disable every scheduled
    // job instead of failing loudly.
    namespace.lockStatus = 404;
    const lock = new DurableObjectLock(namespace, {
      runtime: fakeRuntime(),
      binding: 'LOCKS',
    });

    await expect(lock.acquire('reports', 30_000)).rejects.toThrow(CloudflareUnsupportedError);
    await expect(lock.acquire('reports', 30_000)).rejects.toThrow(/'LOCKS'/);
    await expect(lock.acquire('reports', 30_000)).rejects.toThrow(/404/);
  });

  it('throws from release on a non-2xx too', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    namespace.lockStatus = 500;
    const lock = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    await expect(lock.release('reports', 'token-1')).rejects.toThrow(CloudflareUnsupportedError);
  });

  it('names the binding generically when none was configured', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    namespace.lockStatus = 404;
    const lock = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    await expect(lock.acquire('reports', 30_000)).rejects.toThrow(/the durable object/);
  });

  it('expires a claim so a later caller can take it', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    namespace.now = () => 0;
    const a = new DurableObjectLock(namespace, { runtime: fakeRuntime() });
    const b = new DurableObjectLock(namespace, { runtime: fakeRuntime() });

    await a.acquire('reports', 5_000);
    namespace.now = () => 6_000;

    expect(await b.acquire('reports', 5_000)).toBe('token-1');
  });
});
