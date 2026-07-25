/**
 * HeaderResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert';
import { HeaderResolver } from '../../src/resolvers/header-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

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
