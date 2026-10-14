import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  distTagFor,
  npmSupportsTrustedPublishing,
  packedManifestProblems,
  packumentHasVersion,
  REPOSITORY_URL,
} from '../../scripts/npm-release-gate.ts';
import { runNpmPublish } from '../../scripts/npm-publish.ts';
import { PUBLISHED_PACKAGES } from '../../scripts/release-packages.ts';

/**
 * The version pnpm writes into a packed `workspace:^` range. Read from the
 * manifest, never written as a literal: the release bump leaves test trees
 * alone, so a literal here goes stale at every cut (it did at v0.9.0).
 */
const WORKSPACE_VERSION = (JSON.parse(
  await Deno.readTextFile(new URL('../../packages/kernel/package.json', import.meta.url)),
) as { version: string }).version;

const valid = {
  name: '@setu-ts/kernel',
  version: '0.8.0',
  repository: { url: REPOSITORY_URL },
  publishConfig: { access: 'public' },
  license: 'MIT',
  files: ['dist', 'src'],
  dependencies: { '@setu-ts/common': '^0.8.0' },
};
describe('npm release rules', () => {
  it('accepts a valid packed manifest and source workspace ranges', () => {
    expect(packedManifestProblems(valid, '0.8.0')).toEqual([]);
    expect(
      packedManifestProblems(
        { ...valid, dependencies: { '@setu-ts/common': 'workspace:^' } },
        '0.8.0',
        true,
      ),
    ).toEqual([]);
  });
  it('refuses each broken field, including every shipped dependency field', () => {
    for (
      const bad of [
        null,
        [],
        { ...valid, name: 'outside' },
        { ...valid, version: '0.7.0' },
        { ...valid, repository: null },
        { ...valid, publishConfig: {} },
        { ...valid, license: '' },
        { ...valid, license: 1 },
        { ...valid, files: ['dist'] },
        { ...valid, files: undefined },
        ...['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) => [
          { ...valid, [field]: { '@setu-ts/common': '^0.7.0' } },
          { ...valid, [field]: { external: 'workspace:^' } },
        ]),
      ]
    ) expect(packedManifestProblems(bad, '0.8.0').length).toBeGreaterThan(0);
    expect(packedManifestProblems({ ...valid, dependencies: null }, '0.8.0')).toEqual([]);
    expect(packedManifestProblems(valid, '0.8.0', true)).toContain(
      'dependencies: @setu-ts/common must equal workspace:^',
    );
  });
  it('uses own registry versions and explicit release tags', () => {
    expect(packumentHasVersion({ versions: { '0.8.0': {} } }, '0.8.0')).toBe(true);
    for (
      const packument of [null, {}, { versions: [] }, { versions: Object.create({ '0.8.0': {} }) }]
    ) expect(packumentHasVersion(packument, '0.8.0')).toBe(false);
    expect(distTagFor('0.8.0')).toBe('latest');
    expect(distTagFor('0.9.0-beta.1')).toBe('next');
    expect(distTagFor('0.9.0+build-test')).toBe('latest');
  });
  it('enforces the trusted publishing CLI floor', () => {
    for (const v of ['11.5.1', '11.16.0\n', '12.0.0']) {
      expect(npmSupportsTrustedPublishing(v)).toBe(true);
    }
    for (const v of ['11.5.0', '11.4.9', '10.99.0', 'bad', '11.5.1-beta']) {
      expect(npmSupportsTrustedPublishing(v)).toBe(false);
    }
  });
  it('dry-runs every package only after packing, checking and looking up its version', async () => {
    const events: string[] = [];
    let dir = '';
    await runNpmPublish({
      dryRun: true,
      inCi: true,
      command: async (cmd, args, cwd) => {
        if (args[0] === '--version') return '11.16.0';
        if (args[0] === 'pack') {
          dir = cwd!;
          events.push(`pack:${dir}`);
          return 'packed.tgz';
        }
        if (cmd === 'tar') {
          const source = JSON.parse(await Deno.readTextFile(`${dir}/package.json`));
          for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
            for (const name of Object.keys(source[field] ?? {})) {
              if (name.startsWith('@setu-ts/')) source[field][name] = `^${WORKSPACE_VERSION}`;
            }
          }
          events.push(`check:${dir}`);
          return JSON.stringify(source);
        }
        if (args[0] === 'publish') {
          expect(args).toContain('--dry-run');
          expect(args).toContain('--provenance');
          expect(args).toContain('--ignore-scripts');
          events.push(`publish:${dir}`);
        }
        return '';
      },
      fetchImpl: () => {
        events.push(`lookup:${dir}`);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    expect(events).toEqual(
      PUBLISHED_PACKAGES.flatMap((dir) =>
        ['pack', 'check', 'lookup', 'publish'].map((step) => `${step}:${dir}`)
      ),
    );
  });
});
