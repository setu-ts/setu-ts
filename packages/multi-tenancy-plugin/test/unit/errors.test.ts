/**
 * TenantNotResolvedError — basic verification.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TenantDataStoreNotReadyError, TenantNotResolvedError } from '../../src/errors.ts';

describe('errors', () => {
  it('TenantNotResolvedError is an Error', () => {
    const err = new TenantNotResolvedError();
    expect(err instanceof Error).toBeTruthy();
    expect(err instanceof TenantNotResolvedError).toBeTruthy();
    expect(err.name).toEqual('TenantNotResolvedError');
  });

  it('TenantNotResolvedError carries a message', () => {
    const msg = 'Custom message';
    const err = new TenantNotResolvedError(msg);
    expect(err.message).toEqual(msg);
  });

  it('default message when none provided', () => {
    const err = new TenantNotResolvedError();
    expect(err.message).toEqual('Tenant not resolved');
  });

  it('TenantDataStoreNotReadyError is an Error (M101c, V8-8)', () => {
    const err = new TenantDataStoreNotReadyError();
    expect(err instanceof Error).toBeTruthy();
    expect(err instanceof TenantDataStoreNotReadyError).toBeTruthy();
    expect(err.name).toEqual('TenantDataStoreNotReadyError');
    // The default message names the `onInit` phase and the factory arm, so a
    // `register()`-time repository call fails loudly rather than per request.
    expect(err.message).toContain('onInit');
  });

  it('TenantDataStoreNotReadyError carries a custom message', () => {
    const err = new TenantDataStoreNotReadyError('custom');
    expect(err.message).toEqual('custom');
  });
});
