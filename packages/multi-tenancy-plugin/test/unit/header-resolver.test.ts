/**
 * HeaderResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { HeaderResolver, normalizeHeaderTenant } from '../../src/resolvers/header-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

// ---------------------------------------------------------------------------
// Direct unit tests for the extracted pure helper
// ---------------------------------------------------------------------------

Deno.test('normalizeHeaderTenant — null input not possible (string only)', () => {
  // The function takes a non-null string; null is handled in resolve() before calling.
  assertEquals(normalizeHeaderTenant('acme'), 'acme');
});

Deno.test('normalizeHeaderTenant — empty string returns null', () => {
  assertEquals(normalizeHeaderTenant(''), null);
});

Deno.test('normalizeHeaderTenant — whitespace-only string returns null', () => {
  assertEquals(normalizeHeaderTenant('   '), null);
  assertEquals(normalizeHeaderTenant('\t\n'), null);
});

Deno.test('normalizeHeaderTenant — valid value trimmed', () => {
  assertEquals(normalizeHeaderTenant('  acme  '), 'acme');
  assertEquals(normalizeHeaderTenant('\tacme\t'), 'acme');
});

Deno.test('normalizeHeaderTenant — single character', () => {
  assertEquals(normalizeHeaderTenant('x'), 'x');
});

Deno.test('HeaderResolver — reads default header', async () => {
  const resolver = new HeaderResolver();
  const result = await resolver.resolve(createFakeRequest({ headers: { 'x-tenant-id': 'acme' } }));
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('HeaderResolver — custom header name', async () => {
  const resolver = new HeaderResolver({ name: 'x-org' });
  const result = await resolver.resolve(createFakeRequest({ headers: { 'x-org': 'globex' } }));
  assert(result.present);
  assertEquals(result.value.id, 'globex');
});

Deno.test('HeaderResolver — absent header returns none', async () => {
  const resolver = new HeaderResolver();
  const result = await resolver.resolve(createFakeRequest());
  assert(!result.present);
});

Deno.test('HeaderResolver — empty header returns none', async () => {
  const resolver = new HeaderResolver();
  const result = await resolver.resolve(createFakeRequest({ headers: { 'x-tenant-id': '  ' } }));
  assert(!result.present);
});
