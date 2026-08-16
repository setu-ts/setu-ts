/**
 * Unit tests for target-runtime detection.
 *
 * Found by review: `setu generate` defaulted `runtime` to `'deno'` whenever
 * `--runtime` was absent, which nobody passes — so a Bun project's generated
 * test imported `@std/testing/bdd`, whose `describe()` reaches `Deno.test` and
 * dies with `ReferenceError: Deno is not defined` before any assertion runs.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { detectTargetRuntime } from '../../../src/utils/runtime-detector.ts';

/** A `package.json` carrying the `start` script a target scaffolds with. */
function pkg(start: string): string {
  return JSON.stringify({ name: 'svc', scripts: { start } }, null, 2);
}

describe('detectTargetRuntime', () => {
  it('reads bun from the start script the scaffold wrote', async () => {
    const fs = createFakeFs({ '/app/package.json': pkg('bun run main.ts') });
    expect(await detectTargetRuntime(fs, '/app')).toBe('bun');
  });

  it('reads node from its loader-based start script', async () => {
    const fs = createFakeFs({ '/app/package.json': pkg('tsx main.ts') });
    expect(await detectTargetRuntime(fs, '/app')).toBe('node');
  });

  it('recognises Workers by wrangler.toml, before the package.json', async () => {
    // Load-bearing ordering: a Workers project carries BOTH manifests — the
    // `deno.json` that `setu generate` reads for plugin gating and the
    // `package.json` wrangler needs — so checking `package.json` first would
    // misread every Workers project as Node.
    const fs = createFakeFs({
      '/app/wrangler.toml': 'name = "svc"',
      '/app/deno.json': '{}',
      '/app/package.json': pkg('wrangler dev'),
    });
    expect(await detectTargetRuntime(fs, '/app')).toBe('cloudflare-workers');
  });

  it('reads deno when there is no package.json at all', async () => {
    // Deno is the only target with no second marker: it deliberately has no
    // `package.json`, since one switches Deno to node_modules resolution.
    const fs = createFakeFs({ '/app/deno.json': '{}' });
    expect(await detectTargetRuntime(fs, '/app')).toBe('deno');
  });

  it('falls back to deno for an empty directory', async () => {
    expect(await detectTargetRuntime(createFakeFs({}), '/app')).toBe('deno');
  });

  it('falls back to deno for an unparseable package.json', async () => {
    // The plugin detector reports a malformed manifest; this one must not throw
    // on the way there.
    const fs = createFakeFs({ '/app/package.json': '{ not json' });
    expect(await detectTargetRuntime(fs, '/app')).toBe('deno');
  });

  it('falls back to deno for a package.json this CLI did not write', async () => {
    const fs = createFakeFs({ '/app/package.json': JSON.stringify({ name: 'x' }) });
    expect(await detectTargetRuntime(fs, '/app')).toBe('deno');
  });
});
