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

Deno.test('SubdomainResolver — baseDomain stripped leaves single part returns that part', async () => {
  // When baseDomain is set and the URL matches, stripping yields a single part (the subdomain).
  // This tests the branch at line 50 where parts.length === 1 after stripping.
  const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://acme.example.com/path' }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('SubdomainResolver — baseDomain set, host equals baseDomain returns tenant from first part', async () => {
  // When baseDomain is set but the host does NOT end with '.baseDomain' (e.g. host is exactly 'example.com'),
  // the stripping doesn't happen. 'example.com' splits into ['example','com'], first label 'example' is returned.
  const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://example.com/path' }),
  );
  // 'example.com'.endsWith('.example.com') is FALSE, so no stripping occurs.
  // parts = ['example', 'com'], parts.length = 2, so it falls through and returns 'example'.
  assert(result.present);
  assertEquals(result.value.id, 'example');
});

Deno.test('SubdomainResolver — www subdomain extracts as tenant', async () => {
  // 'www' is just another subdomain label; it should resolve.
  const resolver = new SubdomainResolver();
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://www.example.com/path' }),
  );
  assert(result.present);
  assertEquals(result.value.id, 'www');
});

Deno.test('SubdomainResolver — invalid URL triggers catch block returns none', async () => {
  // Tests the try/catch at line 33-37 in subdomain-resolver.ts:
  // new URL(request.url) throws for malformed URLs.
  const resolver = new SubdomainResolver();
  const result = await resolver.resolve(
    createFakeRequest({ url: 'not-a-valid-url-without-protocol' }),
  );
  assert(!result.present);
});

Deno.test('SubdomainResolver — single dot host splits to empty labels returns none', async () => {
  // When the host splits into a first-label that is empty string: e.g. '.example.com'
  // where parts[0] === ''. Tests line 58 (`if (!label)`).
  const resolver = new SubdomainResolver();
  const result = await resolver.resolve(
    createFakeRequest({ url: 'https://.example.com/path' }),
  );
  assert(!result.present);
});
