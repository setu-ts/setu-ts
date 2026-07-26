/**
 * TenantNotResolvedError — basic verification.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TenantNotResolvedError } from '../../src/errors.ts';

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
});
