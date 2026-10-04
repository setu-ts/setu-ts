import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { activeHolds, publicationHoldRefusal } from '../../scripts/publication-hold.ts';
import {
  PUBLICATION_HOLDS,
  PUBLISHED_PACKAGES,
  UNPUBLISHED_PACKAGES,
} from '../../scripts/release-packages.ts';

const ROOT = new URL('../../', import.meta.url);
const HOLD = { packageDir: 'packages/held', reason: 'waiting on M1' };
const OTHER = { packageDir: 'packages/also-held', reason: 'waiting on M2' };

/** Runs a release script from the repo root with the release task's grants. */
async function run(args: readonly string[]): Promise<{ code: number; out: string }> {
  const { code, stdout, stderr } = await new Deno.Command('deno', {
    args: [...args],
    cwd: ROOT,
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  const decode = new TextDecoder();
  return { code, out: decode.decode(stdout) + decode.decode(stderr) };
}

describe('activeHolds', () => {
  it('keeps only holds on a package the release publishes, in listed order', () => {
    expect(activeHolds([OTHER, HOLD], ['packages/held', 'packages/also-held']))
      .toEqual([OTHER, HOLD]);
    expect(activeHolds([OTHER, HOLD], ['packages/held'])).toEqual([HOLD]);
  });

  it('is empty when nothing is held', () => {
    expect(activeHolds([], ['packages/held'])).toEqual([]);
  });
});

describe('publicationHoldRefusal', () => {
  it('allows a release no hold applies to', () => {
    expect(publicationHoldRefusal([], ['packages/held'])).toBeNull();
    expect(publicationHoldRefusal([HOLD], ['packages/other'])).toBeNull();
  });

  it('refuses the whole release, naming every held package and its reason', () => {
    const refusal = publicationHoldRefusal([HOLD, OTHER], [
      'packages/other',
      'packages/held',
      'packages/also-held',
    ]);
    expect(refusal).toContain('Refusing to publish: 2 package(s)');
    expect(refusal).toContain('blocks the whole release');
    expect(refusal).toContain('  - packages/held: waiting on M1');
    expect(refusal).toContain('  - packages/also-held: waiting on M2');
    expect(refusal).toContain('PUBLICATION_HOLDS in scripts/release-packages.ts');
  });
});

describe('the completed M98o hold', () => {
  it('removes the diagnostics-plugin hold while keeping it published', () => {
    const hold = PUBLICATION_HOLDS.find((h) => h.packageDir === 'packages/diagnostics-plugin');
    expect(hold).toBeUndefined();
    // Kept in the publish list on purpose: moving it to UNPUBLISHED_PACKAGES
    // would let a release skip it silently.
    expect(PUBLISHED_PACKAGES).toContain('packages/diagnostics-plugin');
    expect(UNPUBLISHED_PACKAGES).not.toContain('packages/diagnostics-plugin');
  });

  it('every hold names a package the release actually publishes', () => {
    expect(activeHolds(PUBLICATION_HOLDS, PUBLISHED_PACKAGES)).toEqual(PUBLICATION_HOLDS);
  });
});

describe('the release scripts after M98o', () => {
  it('has no active publication hold', () => {
    expect(publicationHoldRefusal(PUBLICATION_HOLDS, PUBLISHED_PACKAGES)).toBeNull();
  });

  it('release:verify no longer reports the completed hold', async () => {
    const version = (JSON.parse(
      await Deno.readTextFile(new URL('packages/kernel/deno.json', ROOT)),
    ) as { version: string }).version;
    // The same grants as the `release:verify` task: check 9 reads the merge
    // log through git, and a narrower copy here would fail that check rather
    // than this test's subject.
    const { code, out } = await run([
      'run',
      '--allow-read',
      '--allow-run=git',
      'scripts/verify-release.ts',
      version,
    ]);
    expect(out).not.toContain('publication hold — packages/diagnostics-plugin');
    expect(out).not.toMatch(/✗ .*hold/);
    expect(code).toBe(0);
  });
});
