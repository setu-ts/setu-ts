/**
 * The tier-C error classes and the class-only log field (M109b §3.4): the
 * per-reason status hint, the absence of a cause, and `errorKind` never
 * returning a message.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf } from '@setu-ts/common';
import { errorKind } from '../../src/core/error-kind.ts';
import type { IdempotencyWithinErrorReason } from '../../src/errors.ts';
import { IdempotencyVerifyTimeoutError, IdempotencyWithinError } from '../../src/errors.ts';

const HINTED: readonly (readonly [IdempotencyWithinErrorReason, number])[] = [
  ['key-invalid', 400],
  ['fingerprint-invalid', 400],
  ['fingerprint-mismatch', 422],
  ['conflict', 409],
  ['store-failed', 503],
];

const UNHINTED: readonly IdempotencyWithinErrorReason[] = [
  'result-too-large',
  'result-unserializable',
  'record-invalid',
];

describe('IdempotencyWithinError status hints (M109b §3.4)', () => {
  for (const [reason, status] of HINTED) {
    it(`hints ${status} for ${reason}`, () => {
      const hint = httpStatusHintOf(new IdempotencyWithinError(reason, 'internal diagnostic'));
      expect(hint?.status).toBe(status);
      expect(hint?.detail).not.toBe('internal diagnostic');
      expect(hint?.detail).not.toContain('internal diagnostic');
    });
  }

  for (const reason of UNHINTED) {
    it(`leaves ${reason} unhinted (a masked 500)`, () => {
      expect(httpStatusHintOf(new IdempotencyWithinError(reason, 'm'))).toBeUndefined();
    });
  }

  it('carries no cause and names itself', () => {
    const error = new IdempotencyWithinError('fingerprint-mismatch', 'idempotency: refused');
    expect(error.name).toBe('IdempotencyWithinError');
    expect(error.reason).toBe('fingerprint-mismatch');
    expect(error.cause).toBeUndefined();
  });
});

describe('errorKind (M109b §3.4)', () => {
  it('reports the class name, never the message', () => {
    expect(errorKind(new TypeError('SECRET bound parameter'))).toBe('TypeError');
    const named = new Error('SECRET');
    named.name = 'DriverError';
    expect(errorKind(named)).toBe('DriverError');
  });

  it('falls back to the constructor name when the name getter throws', () => {
    const hostile = new Error('SECRET');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('getter');
      },
    });
    expect(errorKind(hostile)).toBe('Error');
  });

  it('reports a non-object by typeof, and a nameless object as Error', () => {
    expect(errorKind('SECRET')).toBe('string');
    expect(errorKind(null)).toBe('object');
    expect(errorKind(Object.create(null))).toBe('Error');
  });
});

describe('IdempotencyVerifyTimeoutError (M109b §3.4)', () => {
  it('names the bound', () => {
    const error = new IdempotencyVerifyTimeoutError(5_000);
    expect(error.name).toBe('IdempotencyVerifyTimeoutError');
    expect(error.timeoutMs).toBe(5_000);
    expect(error.message).toContain('5000');
  });
});
