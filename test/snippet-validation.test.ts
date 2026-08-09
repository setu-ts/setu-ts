/**
 * Mechanical validation of documentation snippet fixtures.
 *
 * Each fixture is a self-contained TypeScript snippet extracted from the nine
 * M38 guides. The test type-checks them against the current workspace so that
 * any API drift (wrong method names, wrong context shape, missing await) is
 * caught immediately rather than silently shipping incorrect documentation.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const FIXTURES = [
  'minimal-app.ts',
  'plugin-registration.ts',
  'testing-injection.ts',
  'decorator-flow.ts',
  'runtime-workers.ts',
  'migration-nestjs.ts',
  'migration-fastify.ts',
  'middleware.ts',
  'lifecycle-hooks.ts',
];

describe('Documentation snippet validation', () => {
  for (const fixture of FIXTURES) {
    it(`type-checks .tmp/snippet-fixtures/${fixture}`, async () => {
      const path = `.tmp/snippet-fixtures/${fixture}`;
      const proc = new Deno.Command('deno', {
        args: ['check', path],
        stdout: 'piped',
        stderr: 'piped',
      });
      const { code, stderr } = await proc.output();
      if (code !== 0) {
        throw new Error(
          `Type-check failed for ${fixture}:\n${new TextDecoder().decode(stderr)}`,
        );
      }
    });
  }

  it('verifies no app.get() calls in guides (must use app.router.get)', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/plugin-architecture.md',
      'docs/examples.md',
      'docs/decorators.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      // Match app.get/post/put/patch/delete but NOT app.router.get etc.
      const badMatches = [...content.matchAll(/app\.(get|post|put|patch|delete|head|options)\(/g)]
        .filter((m) => !m[0].startsWith('app.router.'));
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies no ctx.json() calls in guides (must use ctx.response.json)', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/plugin-architecture.md',
      'docs/examples.md',
      'docs/decorators.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      const badMatches = [...content.matchAll(/ctx\.json\(/g)]
        .filter((m) => !m[0].startsWith('ctx.response.json'));
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies response uses statusCode not status', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/examples.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      // Check for response.status (wrong) vs response.statusCode (correct)
      const badMatches = [...content.matchAll(/response\.status(?![a-zA-Z])/g)];
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies createTestApp is awaited', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/examples.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      // Check that createTestApp is used with await
      const matches = [...content.matchAll(/createTestApp\(/g)];
      for (const match of matches) {
        const idx = match.index!;
        const preceding = content.slice(Math.max(0, idx - 20), idx);
        // Should have await before it (or be in an async context)
        const hasAwait = preceding.includes('await');
        expect(hasAwait).toBe(true);
      }
    }
  });

  it('verifies plugin factories are invoked', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/custom-plugins.md',
      'docs/plugin-architecture.md',
      'docs/examples.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      // Check for app.register(PluginName) without () - should be app.register(PluginName())
      const badMatches = [...content.matchAll(/app\.register\((?!.*\(\))\w+Plugin\)/g)];
      expect(badMatches.length).toBe(0);
    }
  });
});
