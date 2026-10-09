/**
 * Unit tests for the two error classes (plan §3.17).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IdempotencyConfigurationError, IdempotencyRefusedError } from '../../src/errors.ts';

describe('IdempotencyRefusedError (M109a §3.17)', () => {
  it('carries the reason, ingress and target, and is an Error', () => {
    const error = new IdempotencyRefusedError('key-missing', 'queue', 'email.send', 'no key');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IdempotencyRefusedError);
    expect(error.name).toBe('IdempotencyRefusedError');
    expect(error.reason).toBe('key-missing');
    expect(error.ingress).toBe('queue');
    expect(error.target).toBe('email.send');
    expect(error.message).toBe('no key');
  });

  it('carries a cause when one is supplied', () => {
    const cause = new Error('inner');
    const error = new IdempotencyRefusedError('fingerprint-unavailable', 'messaging', 't', 'm', {
      cause,
    });
    expect(error.cause).toBe(cause);
  });
});

describe('IdempotencyConfigurationError (M109a §3.17)', () => {
  it('carries the option path, and is an Error', () => {
    const error = new IdempotencyConfigurationError('store.namespace', 'bad');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(IdempotencyConfigurationError);
    expect(error.name).toBe('IdempotencyConfigurationError');
    expect(error.option).toBe('store.namespace');
    expect(error.message).toBe('bad');
  });
});
