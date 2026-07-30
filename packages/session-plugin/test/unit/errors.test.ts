/**
 * Unit tests for the exported error types.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  CsrfTokenMismatchError,
  SessionMiddlewareMissingError,
  SessionSecretMissingError,
  SessionTooLargeError,
} from '../../src/errors.ts';

describe('session errors', () => {
  it('SessionSecretMissingError carries its message and name', () => {
    const error = new SessionSecretMissingError('no secret configured');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SessionSecretMissingError');
    expect(error.message).toBe('no secret configured');
  });

  it('SessionMiddlewareMissingError explains the priority constraint', () => {
    const error = new SessionMiddlewareMissingError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SessionMiddlewareMissingError');
    expect(error.message).toContain('SessionPlugin');
    expect(error.message).toContain('260');
  });

  it('CsrfTokenMismatchError prefixes the reason', () => {
    const error = new CsrfTokenMismatchError('the session carries no CSRF token');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CsrfTokenMismatchError');
    expect(error.message).toBe(
      'CSRF verification failed: the session carries no CSRF token',
    );
  });

  it('SessionTooLargeError reports both sizes and the way out', () => {
    const error = new SessionTooLargeError(5000, 4096);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SessionTooLargeError');
    expect(error.message).toContain('5000');
    expect(error.message).toContain('4096');
    expect(error.message).toContain('store strategy');
  });

  it('each error is distinguishable by instanceof', () => {
    const errors = [
      new SessionSecretMissingError('x'),
      new SessionMiddlewareMissingError(),
      new CsrfTokenMismatchError('x'),
      new SessionTooLargeError(1, 2),
    ];
    // Distinct constructors, so a consumer can branch on the specific failure.
    expect(new Set(errors.map((e) => e.name)).size).toBe(4);
    expect(errors[0]).not.toBeInstanceOf(CsrfTokenMismatchError);
  });
});
