/**
 * Unit tests for the free-function entry point and derived key (plan §3.9, §3.12).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIdempotencyService,
  ILogger,
  IRequestContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { derivedIdempotencyKey, idempotent } from '../../src/middleware/idempotent.ts';
import { IdempotencyConfigurationError } from '../../src/errors.ts';

/** A fake context whose registry answers one service and one logger. */
function context(service: IIdempotencyService | undefined, logger?: ILogger): IRequestContext {
  const services = {
    has: (token: string): boolean =>
      token === CAPABILITIES.IDEMPOTENCY
        ? service !== undefined
        : token === CAPABILITIES.LOGGER
        ? logger !== undefined
        : false,
    get: <T>(token: string): T => (token === CAPABILITIES.IDEMPOTENCY ? service : logger) as T,
  };
  return { services, state: new Map<string, unknown>() } as unknown as IRequestContext;
}

/** A service recording its `middleware` calls. */
function serviceReturning(
  middleware: MiddlewareFunction,
  onCall?: () => void,
): IIdempotencyService {
  return {
    middleware: () => {
      onCall?.();
      return middleware;
    },
    behavior: () => ({ handle: (_ctx, next) => next() }),
  };
}

const noop: MiddlewareFunction = (_ctx, next) => next();

describe('idempotent (M109a §3.9)', () => {
  it('validates the option shape at the call', () => {
    expect(() => idempotent({ leaseMs: 0 })).toThrow(IdempotencyConfigurationError);
  });

  it('throws when no provider is registered', async () => {
    const middleware = idempotent();
    await expect(middleware(context(undefined), () => Promise.resolve())).rejects.toBeInstanceOf(
      IdempotencyConfigurationError,
    );
  });

  it('builds the middleware once per service', async () => {
    let calls = 0;
    const service = serviceReturning(noop, () => void calls++);
    const middleware = idempotent();
    const ctx = context(service);
    await middleware(ctx, () => Promise.resolve());
    await middleware(ctx, () => Promise.resolve());
    await middleware(ctx, () => Promise.resolve());
    expect(calls).toBe(1);
  });

  it('logs a resolution error once and rethrows it on every request', async () => {
    const messages: string[] = [];
    const logger = {
      level: 'info',
      error: (m: string) => void messages.push(m),
    } as unknown as ILogger;
    const error = new IdempotencyConfigurationError('ttlMs', 'ttlMs must be at least leaseMs');
    const service: IIdempotencyService = {
      middleware: () => {
        throw error;
      },
      behavior: () => ({ handle: (_ctx, next) => next() }),
    };
    const middleware = idempotent({ leaseMs: 10_000, ttlMs: 1_000 });
    const ctx = context(service, logger);
    for (let i = 0; i < 3; i++) {
      await expect(middleware(ctx, () => Promise.resolve())).rejects.toBe(error);
    }
    expect(messages).toHaveLength(1);
  });

  it('rejects with the configuration error even when the logger throws (audit round 4)', () => {
    // A direct logger call here replaced the configuration error with the
    // logger's, and turned the promised rejection into a synchronous throw.
    const throwing = {
      level: 'info',
      error: () => {
        throw new Error('log transport down');
      },
    } as unknown as ILogger;
    const error = new IdempotencyConfigurationError('ttlMs', 'ttlMs must be at least leaseMs');
    const service: IIdempotencyService = {
      middleware: () => {
        throw error;
      },
      behavior: () => ({ handle: (_ctx, next) => next() }),
    };
    const middleware = idempotent({ leaseMs: 10_000, ttlMs: 1_000 });
    let result: unknown;
    expect(() => {
      result = middleware(context(service, throwing), () => Promise.resolve());
    }).not.toThrow();
    return expect(result).rejects.toBe(error);
  });

  it('keeps a separate cache per call, so two routes see their own options', async () => {
    let calls = 0;
    const service = serviceReturning(noop, () => void calls++);
    const ctx = context(service);
    await idempotent({ namespace: 'a' })(ctx, () => Promise.resolve());
    await idempotent({ namespace: 'b' })(ctx, () => Promise.resolve());
    expect(calls).toBe(2);
  });

  it('rethrows a non-configuration error without caching it', async () => {
    const boom = new Error('bad');
    const service: IIdempotencyService = {
      middleware: () => {
        throw boom;
      },
      behavior: () => ({ handle: (_ctx, next) => next() }),
    };
    const middleware = idempotent();
    await expect(middleware(context(service), () => Promise.resolve())).rejects.toBe(boom);
  });
});

describe('derivedIdempotencyKey (M109a §3.12)', () => {
  it('returns the recorded string and ignores a non-string', () => {
    const ctx = { state: new Map<string, unknown>() } as unknown as IRequestContext;
    expect(derivedIdempotencyKey(ctx)).toBeUndefined();
    ctx.state.set('idempotency-plugin:derived-key', 'a'.repeat(64));
    expect(derivedIdempotencyKey(ctx)).toBe('a'.repeat(64));
    ctx.state.set('idempotency-plugin:derived-key', 5);
    expect(derivedIdempotencyKey(ctx)).toBeUndefined();
  });
});
