/**
 * Unit tests for the route schematic.
 *
 * @module
 */

import { deriveNames } from '../../../src/utils/names.ts';
import { generateRoute } from '../../../src/schematics/route.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices, RuntimePlatform } from '@hono-enterprise/common';

// Minimal runtime services mock for tests - methods are never invoked by schematics
const mockRuntime: IRuntimeServices = {
  platform: () => 'deno' as unknown as RuntimePlatform,
  version: () => '0.1.0',
  hostname: () => 'localhost',
  uuid: () => 'test-uuid-123',
  randomBytes: () => new Uint8Array(0),
  subtle: {} as unknown as SubtleCrypto,
  now: () => Date.now(),
  hrtime: () => performance?.now() || Date.now(),
  setTimeout: () => (0 as unknown),
  clearTimeout: () => {},
  setInterval: () => (0 as unknown),
  clearInterval: () => {},
  env: {},
  exit: (_code?: number) => {
    throw new Error('should not call');
  },
};

describe('generateRoute', () => {
  it('emits a routes file with registration function', () => {
    const names = deriveNames('user');
    const options = { runtime: mockRuntime, plugins: new Set<string>() };
    const files = generateRoute(names, options);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/routes/user.routes.ts');
    expect(files[0].contents).toContain('registerUserRoutes');
    expect(files[0].contents).toContain('ctx.router.get');
  });

  it('registers route at the kebab path', () => {
    const names = deriveNames('post-article');
    const options = { runtime: mockRuntime, plugins: new Set<string>() };
    const files = generateRoute(names, options);

    expect(files[0].contents).toContain('/post-article');
  });
});
