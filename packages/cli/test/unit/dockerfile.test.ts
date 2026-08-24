/**
 * X10-5: the generated Dockerfile folds the `chown` into the cache layer.
 *
 * A standalone `RUN chown -R` rewrites metadata on every file the cache layer
 * created, so overlayfs copies the ENTIRE module cache into a second layer —
 * measured at 563 MB vs 362 MB with the fold, paid on every push and every
 * node pull. These assertions pin the emitted text, the only level this
 * repository can gate (the plan does not claim a cluster re-measurement).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DOCKERFILE, workspaceContainerFiles } from '../../src/workspace/compose.ts';
import { WORKSPACE_VERSION, type WorkspaceManifest } from '../../src/workspace/manifest.ts';
import { transportSpec } from '../../src/workspace/transport.ts';

/** The Deno-profile Dockerfile for a one-member workspace. */
function dockerfile(): string {
  const manifest: WorkspaceManifest = {
    version: WORKSPACE_VERSION,
    runtime: 'deno',
    basePort: 3000,
    transport: 'http',
    members: [{ name: 'orders', port: 3000 }],
  };
  const files = workspaceContainerFiles(manifest, transportSpec('http'));
  const file = files.find((candidate) => candidate.path === DOCKERFILE);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('generated Dockerfile chown fold (X10-5)', () => {
  it('one RUN carries both the cache and the ownership fixup', () => {
    const contents = dockerfile();
    const runLines = contents
      .split('\n')
      .filter((line) => line.startsWith('RUN '));

    const cacheRun = runLines.find((line) => line.includes('deno cache main.ts'));
    expect(cacheRun).toBeDefined();
    // Same line, same layer: `&&`, not two instructions. DENO_UID interpolates
    // to its numeric value in the emitted text.
    expect(cacheRun).toContain('&& chown -R 1000:1000 /srv /deno-dir');
  });

  it('no standalone chown line remains', () => {
    const contents = dockerfile();
    const standalone = contents
      .split('\n')
      .filter((line) => /^RUN chown\b/.test(line.trim()));
    expect(standalone).toEqual([]);
  });

  it('keeps the numeric-UID comment intact', () => {
    const contents = dockerfile();
    expect(contents).toContain('NUMERIC, not `USER deno`');
    expect(contents).toContain('cannot verify user is non-root');
  });
});
