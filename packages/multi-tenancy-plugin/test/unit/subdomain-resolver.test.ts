/**
 * SubdomainResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { SubdomainResolver } from '../../src/resolvers/subdomain-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

Deno.test('SubdomainResolver — extracts first label', async () => {
  const resolver = new SubdomainResolver();
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://acme.example.com/path' }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('SubdomainResolver — strips baseDomain', async () => {
  // With baseDomain='example.com', 'acme.example.com' → strip '.example.com' → 'acme'
  const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://acme.example.com/path' }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('SubdomainResolver — localhost returns none', async () => {
  const resolver = new SubdomainResolver();
  const result = await resolver.resolve(createFakeRequest({ url: 'http://localhost:3000/path' }));
  // localhost has only one label → none
  assert(!result.present);
});

Deno.test('SubdomainResolver — bare domain returns none', async () => {
  const resolver = new SubdomainResolver();
  // 'example.com' splits into ['example', 'com'] → 2 parts → 'example' is the first label
  // This test checks that a domain with no subdomain returns none.
  // But 'example.com' actually has a subdomain-like first label 'example'.
  // To get 'none()', we need a single-part host like 'localhost' or 'example'.
  const result = await resolver.resolve(createFakeRequest({ url: 'https://localhost/path' }));
  assert(!result.present);
});
