/**
 * PathResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { PathResolver } from '../../src/resolvers/path-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

Deno.test('PathResolver — segment 0', async () => {
  const resolver = new PathResolver({ segment: 0 });
  const result = await resolver.resolve(createFakeRequest({ path: '/acme/users' }));
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('PathResolver — custom segment index', async () => {
  const resolver = new PathResolver({ segment: 1 });
  const result = await resolver.resolve(createFakeRequest({ path: '/api/acme/users' }));
  assert(result.present);
  assertEquals(result.value.id, 'acme');
});

Deno.test('PathResolver — out of range returns none', async () => {
  const resolver = new PathResolver({ segment: 10 });
  const result = await resolver.resolve(createFakeRequest({ path: '/short' }));
  assert(!result.present);
});

Deno.test('PathResolver — empty path returns none', async () => {
  const resolver = new PathResolver();
  const result = await resolver.resolve(createFakeRequest({ path: '/' }));
  assert(!result.present);
});
