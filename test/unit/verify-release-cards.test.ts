import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  agentCardProblems,
  packedManifestProblems,
  REPOSITORY_URL,
} from '../../scripts/npm-release-gate.ts';

describe('release agent card backstops', () => {
  it('refuses missing or empty cards for every library and exempts only the executables', () => {
    for (const content of ['', ' \n\t'])
      expect(agentCardProblems('packages/common', content)).toEqual([
        'packages/common: AGENT_CARD.md is missing or empty',
      ]);
    expect(agentCardProblems('packages/common', '# Common')).toEqual([]);
    expect(agentCardProblems('packages/cli', '')).toEqual([]);
    expect(agentCardProblems('packages/create', '')).toEqual([]);
  });
  it('checks both the files allowlist and the actual packed tarball', () => {
    const manifest = {
      name: '@setu-ts/common',
      version: '1.0.0',
      repository: { url: REPOSITORY_URL },
      publishConfig: { access: 'public' },
      license: 'MIT',
      files: ['dist', 'src', 'AGENT_CARD.md'],
    };
    expect(packedManifestProblems(manifest, '1.0.0', false, ['package/AGENT_CARD.md'])).toEqual([]);
    expect(packedManifestProblems(manifest, '1.0.0', false, [])).toEqual([
      'packed library tarball is missing AGENT_CARD.md',
    ]);
    expect(packedManifestProblems({ ...manifest, files: ['dist', 'src'] }, '1.0.0', true)).toEqual([
      'files must contain AGENT_CARD.md',
    ]);
    for (const name of ['@setu-ts/cli', '@setu-ts/create'])
      expect(
        packedManifestProblems({ ...manifest, name, files: ['dist', 'src'] }, '1.0.0', false, []),
      ).toEqual([]);
  });
  it('invokes the card check beside the release README check, with no pending-card exemption', async () => {
    const source = await readFile('scripts/verify-release.ts', 'utf8');
    expect(source).toMatch(/\.\.\.agentCardProblems\(\s*dir,/);
    expect(source).toContain('`${dir}/AGENT_CARD.md`');
    expect(source).not.toContain('PENDING_CARDS');
  });
});
