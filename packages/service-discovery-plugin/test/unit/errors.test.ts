/**
 * Unit tests for the exported error types.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { DiscoveryUnavailableError, SelfRegistrationNotSupportedError } from '../../src/errors.ts';

describe('service discovery errors', () => {
  it('DiscoveryUnavailableError carries its name and message', () => {
    const error = new DiscoveryUnavailableError('no backend');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DiscoveryUnavailableError');
    expect(error.message).toBe('no backend');
  });

  it('DiscoveryUnavailableError preserves cause', () => {
    const cause = new Error('connection refused');
    const error = new DiscoveryUnavailableError('cold read failed', { cause });
    expect(error.cause).toBe(cause);
  });

  it('SelfRegistrationNotSupportedError names the offending provider', () => {
    const error = new SelfRegistrationNotSupportedError('static');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SelfRegistrationNotSupportedError');
    expect(error.message).toContain("'static'");
    expect(error.message).toContain('consul');
  });
});
