/**
 * Unit tests for the ingress behaviour (plan §3.7).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotencyClaimResult,
  IdempotencySettleResult,
  IIdempotencyStore,
  ILogger,
  IngressContext,
} from '@setu-ts/common';
import { DEDUPLICATION_ID_HEADER } from '@setu-ts/common';
import { resolveDefaults, resolveIngressOptions } from '../../src/core/options.ts';
import { createIngressBehavior } from '../../src/ingress/ingress-behavior.ts';
import { IdempotencyRefusedError } from '../../src/errors.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A store recording its calls and answering a configured outcome. */
function recordingStore(
  outcome: IdempotencyClaimResult,
  settle: IdempotencySettleResult = 'settled',
) {
  const calls = { claim: [] as unknown[], complete: [] as unknown[], release: [] as unknown[] };
  const store: IIdempotencyStore = {
    name: 'recording',
    connect: () => Promise.resolve(),
    claim: (request) => {
      calls.claim.push(request);
      return Promise.resolve(outcome);
    },
    complete: (key, token, record, ttl) => {
      calls.complete.push([key, token, record, ttl]);
      return Promise.resolve(settle);
    },
    release: (key, token) => {
      calls.release.push([key, token]);
      return Promise.resolve(settle);
    },
  };
  return { store, calls };
}

/** Builds the behaviour over a store. */
function behavior(
  store: IIdempotencyStore,
  options: Parameters<typeof resolveIngressOptions>[0],
  logger?: ILogger,
) {
  return createIngressBehavior(
    {
      store,
      runtime: createClockRuntime(),
      logger: () => logger,
      defaults: resolveDefaults(undefined),
    },
    resolveIngressOptions(options, resolveDefaults(undefined)),
  );
}

/** A messaging envelope. */
function message(name: string, over: Partial<IngressContext> = {}): IngressContext {
  return { kind: 'messaging', name, payload: { amount: 1 }, consumer: 'c1', headers: {}, ...over };
}

describe('createIngressBehavior (M109a §3.7)', () => {
  it('passes an unlisted topic, a scheduler and a websocket through untouched', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    const run = behavior(store, { topics: ['listed'] });
    let next = 0;
    await run.handle(message('other'), () => {
      next++;
      return Promise.resolve();
    });
    await run.handle({ kind: 'scheduler', name: 'tick', payload: null }, () => {
      next++;
      return Promise.resolve();
    });
    await run.handle({ kind: 'websocket', name: '/ws', payload: null }, () => {
      next++;
      return Promise.resolve();
    });
    expect(next).toBe(3);
    expect(calls.claim).toHaveLength(0);
  });

  it('refuses a listed topic with no consumer identity', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const run = behavior(store, { topics: ['listed'] });
    const noConsumer: IngressContext = {
      kind: 'messaging',
      name: 'listed',
      payload: {},
      headers: {},
    };
    await expect(run.handle(noConsumer, () => Promise.resolve())).rejects.toMatchObject({
      reason: 'consumer-missing',
    });
  });

  it('refuses an unsupported key source, a missing key and an invalid key', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const unsupported = behavior(store, { topics: ['t'], key: 'job-id' });
    await expect(unsupported.handle(message('t'), () => Promise.resolve())).rejects.toMatchObject({
      reason: 'unsupported-key-source',
    });
    const missing = behavior(store, { topics: ['t'] });
    await expect(missing.handle(message('t', { headers: {} }), () => Promise.resolve())).rejects
      .toMatchObject({
        reason: 'key-missing',
      });
    const invalid = behavior(store, { topics: ['t'] });
    await expect(
      invalid.handle(
        message('t', { headers: { [DEDUPLICATION_ID_HEADER]: 'has space' } }),
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ reason: 'key-invalid' });
  });

  it('defaults the messaging key to the deduplication header', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    const run = behavior(store, { topics: ['t'] });
    await run.handle(
      message('t', { headers: { [DEDUPLICATION_ID_HEADER]: 'evt-1' } }),
      () => Promise.resolve(),
    );
    expect(calls.claim).toHaveLength(1);
  });

  it('refuses an uncanonicalisable payload with cause', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const run = behavior(store, { topics: ['t'], key: () => 'k' });
    let error: unknown;
    try {
      await run.handle(message('t', { payload: { when: new Map() } }), () => Promise.resolve());
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(IdempotencyRefusedError);
    expect((error as IdempotencyRefusedError).reason).toBe('fingerprint-unavailable');
    expect((error as IdempotencyRefusedError).cause).toBeDefined();
  });

  it('returns without next on a completed claim', async () => {
    const { store } = recordingStore({ outcome: 'completed', record: '' });
    const run = behavior(store, { topics: ['t'], key: () => 'k' });
    let ran = false;
    await run.handle(message('t'), () => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(false);
  });

  it('refuses in-progress, fingerprint-mismatch and capacity-exceeded', async () => {
    for (const outcome of ['in-progress', 'fingerprint-mismatch', 'capacity-exceeded'] as const) {
      const { store } = recordingStore({ outcome } as IdempotencyClaimResult);
      const run = behavior(store, { topics: ['t'], key: () => 'k' });
      await expect(run.handle(message('t'), () => Promise.resolve())).rejects.toMatchObject({
        reason: outcome,
      });
    }
  });

  it('releases and rethrows the ORIGINAL error when the handler fails', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    const run = behavior(store, { topics: ['t'], key: () => 'k' });
    const boom = new Error('handler failed');
    let thrown: unknown;
    try {
      await run.handle(message('t'), () => Promise.reject(boom));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(calls.release).toHaveLength(1);
  });

  it('completes with the empty record on success and logs a lost settle', async () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as unknown as ILogger;
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: true }, 'lost');
    const run = behavior(store, { topics: ['t'], key: () => 'k' }, logger);
    await run.handle(message('t'), () => Promise.resolve());
    expect(calls.complete).toHaveLength(1);
    expect((calls.complete[0] as unknown[])[2]).toBe('');
    expect(warnings).toContain(
      'idempotency lease lapsed before completion; the work may have run twice',
    );
    expect(warnings).toContain('idempotency claim took over a lapsed lease');
  });

  it('logs a release rejection without replacing the original error', async () => {
    const errors: string[] = [];
    const logger = {
      level: 'info',
      error: (m: string) => void errors.push(m),
    } as unknown as ILogger;
    const base = recordingStore({ outcome: 'claimed', takeover: false });
    const store: IIdempotencyStore = {
      ...base.store,
      release: () => Promise.reject(new Error('release down')),
    };
    const run = behavior(store, { topics: ['t'], key: () => 'k' }, logger);
    const boom = new Error('handler failed');
    let thrown: unknown;
    try {
      await run.handle(message('t'), () => Promise.reject(boom));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(errors).toContain('idempotency release failed');
  });

  it('changes the key when the consumer or the scope segment differs', async () => {
    const one = recordingStore({ outcome: 'claimed', takeover: false });
    const two = recordingStore({ outcome: 'claimed', takeover: false });
    const a = behavior(one.store, { topics: ['t'], key: () => 'k' });
    const b = behavior(two.store, { topics: ['t'], key: () => 'k' });
    await a.handle(message('t', { consumer: 'c1' }), () => Promise.resolve());
    await b.handle(message('t', { consumer: 'c2' }), () => Promise.resolve());
    const keyA = (one.calls.claim[0] as { key: string }).key;
    const keyB = (two.calls.claim[0] as { key: string }).key;
    expect(keyA).not.toBe(keyB);

    const withScope = recordingStore({ outcome: 'claimed', takeover: false });
    const scoped = behavior(withScope.store, {
      topics: ['t'],
      key: () => 'k',
      scope: () => 'tenant-1',
    });
    await scoped.handle(message('t'), () => Promise.resolve());
    expect((withScope.calls.claim[0] as { key: string }).key).not.toBe(keyA);
  });
});
