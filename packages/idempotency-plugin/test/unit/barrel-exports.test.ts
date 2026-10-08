/**
 * Barrel-export assertions for `@setu-ts/idempotency-plugin` (plan §4).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';
import type {
  IdempotencyPluginOptions,
  IdempotencyRefusalReason,
  IdempotencyStoreConfig,
  IRedisIdempotencyClient,
} from '../../src/index.ts';

describe('@setu-ts/idempotency-plugin barrel (M109a §4)', () => {
  it('exports the factory, entry points and derived-key reader as functions', () => {
    expect(typeof barrel.IdempotencyPlugin).toBe('function');
    expect(typeof barrel.idempotent).toBe('function');
    expect(typeof barrel.idempotentIngress).toBe('function');
    expect(typeof barrel.derivedIdempotencyKey).toBe('function');
  });

  it('exports the error classes', () => {
    expect(typeof barrel.IdempotencyRefusedError).toBe('function');
    expect(typeof barrel.IdempotencyConfigurationError).toBe('function');
  });

  it('exports the two header constants', () => {
    expect(barrel.IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(barrel.IDEMPOTENT_REPLAYED_HEADER).toBe('Idempotent-Replayed');
  });

  it('exports the option and client types (declared against the barrel)', () => {
    const store: IdempotencyStoreConfig = { type: 'memory' };
    const options: IdempotencyPluginOptions = { store };
    const reason: IdempotencyRefusalReason = 'in-progress';
    const client = undefined as unknown as IRedisIdempotencyClient;
    expect(options.store).toEqual({ type: 'memory' });
    expect(reason).toBe('in-progress');
    expect(client).toBeUndefined();
  });
});
