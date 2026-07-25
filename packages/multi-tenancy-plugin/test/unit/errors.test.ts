/**
 * TenantNotResolvedError — basic verification.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { TenantNotResolvedError } from '../../src/errors.ts';

Deno.test('TenantNotResolvedError is an Error', () => {
  const err = new TenantNotResolvedError();
  assert(err instanceof Error);
  assert(err instanceof TenantNotResolvedError);
  assertEquals(err.name, 'TenantNotResolvedError');
});

Deno.test('TenantNotResolvedError carries a message', () => {
  const msg = 'Custom message';
  const err = new TenantNotResolvedError(msg);
  assertEquals(err.message, msg);
});

Deno.test('default message when none provided', () => {
  const err = new TenantNotResolvedError();
  assertEquals(err.message, 'Tenant not resolved');
});
