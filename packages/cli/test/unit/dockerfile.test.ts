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

describe('generated Dockerfile lockfile verification', () => {
  it('completes the lockfile and then VERIFIES it, in one build layer', () => {
    const contents = dockerfile();
    const buildRun = contents
      .split('\n')
      .find((line) => line.startsWith('RUN ') && line.includes('deno cache main.ts'));
    expect(buildRun).toBeDefined();

    // Deno records a jsr package's npm edge list nondeterministically on a cold
    // cache: four `--no-cache` builds of one unchanged workspace left
    // `@setu-ts/messaging-plugin` missing its `npm:amqplib`/`npm:ioredis` edges
    // twice and complete twice, while both packages were recorded in the
    // lockfile's package section every time. Runtime `--frozen` does not write
    // the lockfile, so against an incomplete one it refuses and every container
    // dies at registration from an image that built green.
    //
    // `deno install` completes the lockfile from the manifests and
    // `deno install --frozen` verifies it, so a still-missing edge fails the
    // BUILD rather than every container. The verify is the load-bearing half:
    // without it the repair is one more nondeterministic pass.
    expect(buildRun).toContain(
      'deno cache main.ts && deno install && deno install --frozen',
    );
  });

  it('pairs that verification with a `--frozen` runtime', () => {
    // One decision in two halves: the build proves the lockfile complete and the
    // runtime refuses to write it. Dropping either silently restores a failure —
    // without `--frozen` a container updates the shipped lockfile, and without
    // the verify an incomplete one reaches production and never serves.
    expect(dockerfile()).toContain('CMD ["run", "--frozen"');
  });
});
