/**
 * HeaderResolver tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assertSome } from '../fixtures/option.ts';
import { HeaderResolver, normalizeHeaderTenant } from '../../src/resolvers/header-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

// ---------------------------------------------------------------------------
// Direct unit tests for the extracted pure helper
// ---------------------------------------------------------------------------

describe('header resolver', () => {
  it('normalizeHeaderTenant — null input not possible (string only)', () => {
    // The function takes a non-null string; null is handled in resolve() before calling.
    expect(normalizeHeaderTenant('acme')).toEqual('acme');
  });

  it('normalizeHeaderTenant — empty string returns null', () => {
    expect(normalizeHeaderTenant('')).toEqual(null);
  });

  it('normalizeHeaderTenant — whitespace-only string returns null', () => {
    expect(normalizeHeaderTenant('   ')).toEqual(null);
    expect(normalizeHeaderTenant('\t\n')).toEqual(null);
  });

  it('normalizeHeaderTenant — valid value trimmed', () => {
    expect(normalizeHeaderTenant('  acme  ')).toEqual('acme');
    expect(normalizeHeaderTenant('\tacme\t')).toEqual('acme');
  });

  it('normalizeHeaderTenant — single character', () => {
    expect(normalizeHeaderTenant('x')).toEqual('x');
  });

  it('HeaderResolver — reads default header', async () => {
    const resolver = new HeaderResolver();
    const result = await resolver.resolve(
      createFakeRequest({ headers: { 'x-tenant-id': 'acme' } }),
    );
    assertSome(result);
    expect(result.value.id).toEqual('acme');
  });

  it('HeaderResolver — custom header name', async () => {
    const resolver = new HeaderResolver({ name: 'x-org' });
    const result = await resolver.resolve(createFakeRequest({ headers: { 'x-org': 'globex' } }));
    assertSome(result);
    expect(result.value.id).toEqual('globex');
  });

  it('HeaderResolver — absent header returns none', async () => {
    const resolver = new HeaderResolver();
    const result = await resolver.resolve(createFakeRequest());
    expect(!result.present).toBeTruthy();
  });

  it('HeaderResolver — empty header returns none', async () => {
    const resolver = new HeaderResolver();
    const result = await resolver.resolve(createFakeRequest({ headers: { 'x-tenant-id': '  ' } }));
    expect(!result.present).toBeTruthy();
  });

  it('HeaderResolver — whitespace-only header value reaches normalize and returns none', async () => {
    // The Web API Headers normalizes '  ' → '', which triggers the early !raw check.
    // To exercise the normalizeHeaderTenant→null path inside resolve(), we must bypass
    // the Headers constructor and supply a raw value that is truthy but normalizes to
    // null (whitespace-only).  This covers the otherwise-invisible branch at line 50.
    const resolver = new HeaderResolver();
    const fakeHeaders = { get: (_name: string) => '   ' };
    const request = { method: 'GET', url: 'https://example.com/', path: '/', headers: fakeHeaders };
    const result = await resolver.resolve(request as import('@hono-enterprise/common').IRequest);
    expect(!result.present).toBeTruthy();
  });
});
