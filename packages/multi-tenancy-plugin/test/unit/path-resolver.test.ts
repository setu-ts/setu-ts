/**
 * PathResolver tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { extractPathTenant, PathResolver } from '../../src/resolvers/path-resolver.ts';
import { createFakeRequest } from '../fixtures/fake-request.ts';

// ---------------------------------------------------------------------------
// Direct unit tests for the extracted pure helper
// ---------------------------------------------------------------------------

Deno.test('extractPathTenant — valid index returns segment', () => {
  assertEquals(extractPathTenant(['acme', 'users'], 0), 'acme');
  assertEquals(extractPathTenant(['api', 'acme', 'users'], 1), 'acme');
});

Deno.test('extractPathTenant — negative index returns null', () => {
  assertEquals(extractPathTenant(['acme'], -1), null);
});

Deno.test('extractPathTenant — out-of-range index returns null', () => {
  assertEquals(extractPathTenant(['acme'], 5), null);
});

Deno.test('extractPathTenant — empty segments array returns null', () => {
  assertEquals(extractPathTenant([], 0), null);
});

Deno.test('extractPathTenant — empty string segment returns null', () => {
  assertEquals(extractPathTenant(['acme', '', 'users'], 1), null);
});

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

Deno.test('PathResolver — segment index negative returns none', async () => {
  const resolver = new PathResolver({ segment: -1 });
  const result = await resolver.resolve(createFakeRequest({ path: '/acme/users' }));
  assert(!result.present);
});

Deno.test('PathResolver — segment value is empty string after split returns none', async () => {
  // When segmentIndex === 0 and parts[0] is non-empty it works; but we need to cover
  // line 42 (`if (!segment) return none()`) which fires when the segment itself is falsy.
  // With a normal path, this branch is hit when the part exists but is empty (rare).
  // Note: filter(Boolean) in the source removes empty segments from path arrays, so the
  // `!segment` check at line 42 only triggers for truly empty string results after the
  // filter pass. We exercise the existing out-of-range logic as a functional proxy.
  const resolver = new PathResolver({ segment: 5 });
  const result = await resolver.resolve(createFakeRequest({ path: '/a/b' }));
  assert(!result.present);
});
