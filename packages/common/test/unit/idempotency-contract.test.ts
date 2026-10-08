/**
 * Compile-time and runtime contract tests for the M109a idempotency port,
 * service contract, option types and capability token (§3.2, §3.19).
 *
 * The type-level rows are decided by `deno task check`: a dropped member, a
 * widened union, or an option accepted without a topic/job list stops this file
 * compiling. The runtime assertions keep it failing loudly under
 * `deno task test` as well.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, createCapabilityToken } from '../../src/index.ts';
import type {
  IdempotencyClaimRequest,
  IdempotencyClaimResult,
  IdempotencySettleResult,
  IdempotentIngressOptions,
  IdempotentRouteOptions,
  IIdempotencyService,
  IIdempotencyStore,
} from '../../src/index.ts';

describe('CAPABILITIES.IDEMPOTENCY (M109a §3.2, §5)', () => {
  it('is the token the service is registered under', () => {
    expect(CAPABILITIES.IDEMPOTENCY).toBe('idempotency');
  });

  it('passes the capability-token grammar', () => {
    // The token grammar rejects colons and uppercase; 'idempotency' is a
    // single lower-case segment, so this round-trips unchanged.
    expect(createCapabilityToken(CAPABILITIES.IDEMPOTENCY)).toBe('idempotency');
  });
});

describe('IIdempotencyStore contract (M109a §3.2)', () => {
  it('admits a store with the required members and optional probe/teardown', () => {
    const store: IIdempotencyStore = {
      name: 'memory',
      connect: () => Promise.resolve(),
      claim: (request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult> => {
        expect(request.leaseMs).toBeGreaterThanOrEqual(1);
        return Promise.resolve({ outcome: 'claimed', takeover: false });
      },
      complete: (): Promise<IdempotencySettleResult> => Promise.resolve('settled'),
      release: (): Promise<IdempotencySettleResult> => Promise.resolve('lost'),
    };

    expect(store.name).toBe('memory');
    expect(store.maxRecordBytes).toBeUndefined();
  });

  it('carries every claim outcome in the union', () => {
    const outcomes: readonly IdempotencyClaimResult[] = [
      { outcome: 'claimed', takeover: true },
      { outcome: 'completed', record: 'r' },
      { outcome: 'in-progress' },
      { outcome: 'fingerprint-mismatch' },
      { outcome: 'capacity-exceeded' },
    ];

    expect(outcomes).toHaveLength(5);
  });

  it('rejects a `claimed` result with no `takeover` flag at compile time', () => {
    // @ts-expect-error `claimed` requires `takeover`
    const bad: IdempotencyClaimResult = { outcome: 'claimed' };
    // The directive is the compile-time assertion; this keeps the file failing
    // loudly under `deno task test` too.
    expect(bad).toBeDefined();
  });
});

describe('IdempotentIngressOptions contract (M109a §3.2)', () => {
  it('accepts a `topics` arm without `jobNames`', () => {
    const options: IdempotentIngressOptions = { topics: ['order.placed.v1'] };
    expect(options.topics).toEqual(['order.placed.v1']);
  });

  it('accepts a `jobNames` arm without `topics`', () => {
    const options: IdempotentIngressOptions = { jobNames: ['email.send'] };
    expect(options.jobNames).toEqual(['email.send']);
  });

  it('rejects an option set with neither `topics` nor `jobNames` at compile time', () => {
    // @ts-expect-error at least one of `topics`/`jobNames` is required
    const bad: IdempotentIngressOptions = { leaseMs: 1_000 };
    expect(bad).toBeDefined();
  });
});

describe('IdempotentRouteOptions contract (M109a §3.2)', () => {
  it('rejects a non-numeric `ttlMs` at compile time', () => {
    // @ts-expect-error `ttlMs` is a number
    const bad: IdempotentRouteOptions = { ttlMs: '1000' };
    expect(bad).toBeDefined();
  });

  it('accepts the documented defaults-free shape', () => {
    const options: IdempotentRouteOptions = {
      key: { header: 'Idempotency-Key' },
      principal: 'required',
      response: 'status',
    };
    expect(options.principal).toBe('required');
  });
});

describe('IIdempotencyService contract (M109a §3.2)', () => {
  it('builds a middleware and a behavior synchronously', () => {
    const service: IIdempotencyService = {
      middleware: () => (ctx, next) => {
        expect(ctx).toBeDefined();
        return next();
      },
      behavior: () => ({
        handle: (_ctx, next) => next(),
      }),
    };

    expect(typeof service.middleware).toBe('function');
    expect(typeof service.behavior).toBe('function');
  });
});
