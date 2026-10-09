/**
 * Additional ingress-behaviour cases (plan §3.7): the queue key sources, the
 * unsupported-source refusals and the settle logging paths.
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

/** A store recording its settle calls. */
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

/** Builds the behaviour. */
function behavior(
  store: IIdempotencyStore,
  options: Parameters<typeof resolveIngressOptions>[0],
  logger?: ILogger,
) {
  const defaults = resolveDefaults(undefined);
  return createIngressBehavior(
    { store, runtime: createClockRuntime(), logger: () => logger, defaults },
    resolveIngressOptions(options, defaults),
  );
}

/** A queue envelope. */
function job(name: string, payload: unknown, consumer = name): IngressContext {
  return { kind: 'queue', name, payload, consumer, attempt: 1 };
}

/** A logger capturing warns and errors. */
function captureLogger() {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    level: 'info',
    warn: (m: string) => void warnings.push(m),
    error: (m: string) => void errors.push(m),
  } as unknown as ILogger;
  return { logger, warnings, errors };
}

describe('createIngressBehavior — queue key sources (M109a §3.7 step 3)', () => {
  it('uses the job id for "auto" and "job-id"', async () => {
    for (const key of ['auto', 'job-id'] as const) {
      const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
      await behavior(store, { jobNames: ['email.send'], key }).handle(
        job('email.send', { id: 'j1', name: 'email.send', data: {} }),
        () => Promise.resolve(),
      );
      expect(calls.claim).toHaveLength(1);
    }
  });

  it('refuses a missing job id', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    await expect(
      behavior(store, { jobNames: ['email.send'] }).handle(
        job('email.send', { name: 'email.send' }),
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ reason: 'key-missing' });
  });

  it('refuses "job-id" on messaging and "deduplication-header" on queue', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    await expect(
      behavior(store, { topics: ['t'], key: 'job-id' }).handle(
        { kind: 'messaging', name: 't', payload: {}, consumer: 'c', headers: {} },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ reason: 'unsupported-key-source' });

    const { store: other } = recordingStore({ outcome: 'claimed', takeover: false });
    await expect(
      behavior(other, { jobNames: ['j'], key: 'deduplication-header' }).handle(
        job('j', { id: 'x' }),
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ reason: 'unsupported-key-source' });
  });

  it('uses a function key source and a scope segment', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    await behavior(store, {
      jobNames: ['j'],
      key: (ctx) => ctx.headers?.['x-order'],
      scope: (ctx) => (ctx.kind === 'queue' ? 'tenant-1' : undefined),
    }).handle(
      {
        kind: 'queue',
        name: 'j',
        payload: { id: 'x' },
        consumer: 'j',
        headers: { 'x-order': 'o1' },
      },
      () => Promise.resolve(),
    );
    expect(calls.claim).toHaveLength(1);
  });
});

describe('createIngressBehavior — settle logging (M109a §3.7 step 6)', () => {
  it('warns on a lost complete and a lost release, and logs a release rejection', async () => {
    const { logger, warnings, errors } = captureLogger();

    const completed = recordingStore({ outcome: 'claimed', takeover: false }, 'lost');
    await behavior(completed.store, { jobNames: ['j'], key: () => 'k' }, logger).handle(
      job('j', { id: 'x' }),
      () => Promise.resolve(),
    );
    expect(warnings.some((m) => m.includes('lease lapsed'))).toBe(true);

    const released = recordingStore({ outcome: 'claimed', takeover: false }, 'lost');
    const boom = new Error('handler failed');
    let thrown: unknown;
    try {
      await behavior(released.store, { jobNames: ['j'], key: () => 'k' }, logger).handle(
        job('j', { id: 'x' }),
        () => Promise.reject(boom),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);

    const base = recordingStore({ outcome: 'claimed', takeover: false });
    const rejecting: IIdempotencyStore = {
      ...base.store,
      release: () => Promise.reject(new Error('release down')),
    };
    let second: unknown;
    try {
      await behavior(rejecting, { jobNames: ['j'], key: () => 'k' }, logger).handle(
        job('j', { id: 'x' }),
        () => Promise.reject(boom),
      );
    } catch (error) {
      second = error;
    }
    expect(second).toBe(boom);
    expect(errors).toContain('idempotency release failed');
  });

  it('refuses an invalid key', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    await expect(
      behavior(store, { topics: ['t'], key: () => 'has space' }).handle(
        { kind: 'messaging', name: 't', payload: {}, consumer: 'c', headers: {} },
        () => Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRefusedError);
  });

  it('defaults the messaging key from the deduplication header', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    await behavior(store, { topics: ['t'] }).handle(
      {
        kind: 'messaging',
        name: 't',
        payload: {},
        consumer: 'c',
        headers: { [DEDUPLICATION_ID_HEADER]: 'evt-1' },
      },
      () => Promise.resolve(),
    );
    expect(calls.claim).toHaveLength(1);
  });
});
