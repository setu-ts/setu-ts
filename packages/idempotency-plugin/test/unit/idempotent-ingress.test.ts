/**
 * Unit tests for the ingress entry point (plan §3.7).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IIdempotencyService, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { IdempotencyConfigurationError } from '../../src/errors.ts';
import { idempotentIngress } from '../../src/ingress/idempotent-ingress.ts';

describe('idempotentIngress (M109a §3.7)', () => {
  it('validates the shape at the call', () => {
    expect(() => idempotentIngress({ topics: [] })).toThrow(IdempotencyConfigurationError);
  });

  it('returns a factory resolving the service from the registry', () => {
    const service = {
      middleware: () => () => undefined,
      behavior: () => ({ handle: (_ctx: unknown, next: () => Promise<void>) => next() }),
    } as unknown as IIdempotencyService;
    const registry = {
      get: (token: string) => {
        expect(token).toBe(CAPABILITIES.IDEMPOTENCY);
        return service;
      },
    } as unknown as IServiceRegistry;

    const factory = idempotentIngress({ topics: ['t'] });
    const behavior = factory(registry);
    expect(typeof behavior.handle).toBe('function');
    // The factory's resolution error would surface from the host plugin's
    // onInit; here we only confirm it built the behaviour.
    expect(behavior).toBeDefined();
  });

  it('surfaces a resolution error from the factory', () => {
    const registry = {
      get: () => {
        throw new Error('no provider');
      },
    } as unknown as IServiceRegistry;
    expect(() => idempotentIngress({ jobNames: ['j'] })(registry)).toThrow('no provider');
  });
});
