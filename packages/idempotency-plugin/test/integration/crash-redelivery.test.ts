/**
 * A crashed holder and its redelivery (M109a §3.7, §3.13): a redelivery inside
 * the lease is refused, a takeover after it runs the work once, and the crashed
 * holder's late `complete` is lost.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotencyClaimRequest,
  IIdempotencyStore,
  ILogger,
  IngressContext,
} from '@setu-ts/common';
import { resolveDefaults, resolveIngressOptions } from '../../src/core/options.ts';
import { createIngressBehavior } from '../../src/ingress/ingress-behavior.ts';
import { MemoryIdempotencyStore } from '../../src/stores/memory-store.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A store recording every claim. */
function recordingStore(inner: IIdempotencyStore) {
  const claims: IdempotencyClaimRequest[] = [];
  // Explicit delegation, not a spread: `inner` is a class instance, so its
  // methods live on the prototype and a spread would drop them.
  const store: IIdempotencyStore = {
    name: inner.name,
    connect: (runtime) => inner.connect(runtime),
    claim: (request) => {
      claims.push(request);
      return inner.claim(request);
    },
    complete: (key, token, record, ttlMs) => inner.complete(key, token, record, ttlMs),
    release: (key, token) => inner.release(key, token),
  };
  return { store, claims };
}

/** Lets a pending microtask chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('crash redelivery (M109a §3.7)', () => {
  it('refuses inside the lease, takes over after it, and loses the crashed complete', async () => {
    const runtime = createClockRuntime();
    const memory = new MemoryIdempotencyStore();
    await memory.connect(runtime);
    const { store, claims } = recordingStore(memory);
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
      error: () => {},
    } as unknown as ILogger;

    const defaults = resolveDefaults(undefined);
    const behavior = createIngressBehavior(
      { store, runtime, logger: () => logger, defaults },
      resolveIngressOptions({ jobNames: ['email.send'], leaseMs: 30_000 }, defaults),
    );
    const envelope: IngressContext = {
      kind: 'queue',
      name: 'email.send',
      payload: { id: 'j1', name: 'email.send', data: {} },
      consumer: 'email.send',
    };

    let sideEffects = 0;

    // Holder A claims, then crashes before its side effect: `next` never settles.
    const holderA = behavior.handle(envelope, () => new Promise<void>(() => {}));
    void holderA;
    await flush();
    expect(claims).toHaveLength(1);
    const tokenA = claims[0].token;

    // A redelivery INSIDE the lease is refused.
    let refused: unknown;
    try {
      await behavior.handle(envelope, () => {
        sideEffects++;
        return Promise.resolve();
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { reason?: string }).reason).toBe('in-progress');
    expect(sideEffects).toBe(0);

    // After the lease lapses, a redelivery takes over and runs the work once.
    runtime.advance(30_001);
    await behavior.handle(envelope, () => {
      sideEffects++;
      return Promise.resolve();
    });
    expect(sideEffects).toBe(1);
    expect(warnings).toContain('idempotency claim took over a lapsed lease');

    // Holder A's late complete is lost: the token no longer holds the claim.
    expect(await store.complete(claims[0].key, tokenA, '', 60_000)).toBe('lost');

    // And the completed record stands.
    expect((await memory.claim({ ...claims[0], token: 'late' })).outcome).toBe('completed');
  });
});
