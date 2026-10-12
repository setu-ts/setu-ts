/**
 * The changelog PR-coverage check's own controls.
 *
 * The three cases that motivated it are replayed as fixtures: a merged
 * milestone PR with no entry (alpha.10's #195, v0.4.0's #233), a milestone's
 * entry filed under an already-published heading (v0.3.0's M86), and a `fix/`
 * PR that changed published source with no entry naming it. Each is shown to
 * be reported, and its corrected changelog shown to pass — a check that cannot
 * fail is not a check.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  checkChangelogPrs,
  describeFindings,
  type MergedPullRequest,
  mergedPullRequests,
  parseMergeSubject,
  requiredToken,
  runGit,
  splitSections,
} from '../../scripts/changelog-prs.ts';

const pr = (
  number: number,
  branch: string,
  changedPaths: readonly string[] = [],
): MergedPullRequest => ({ number, branch, changedPaths });

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- **Localization (M103).** A new package.',
  '- **Bounded health (M101a).** Every call bounded.',
  '',
  '### Fixed',
  '',
  '- **The SDK retries (#412).** A `fix/` entry naming its PR.',
  '',
  '## [0.8.0] — 2026-10-03',
  '',
  '- **Diagnostics (M98o).** Shipped in 0.8.0.',
  '- **An older note** that says M103 is planned — prose, not an entry lead.',
  '',
].join('\n');

describe('parseMergeSubject', () => {
  it('reads the PR number and branch from a GitHub merge subject', () => {
    expect(parseMergeSubject('Merge pull request #405 from setu-ts/feat/m103-localization-plugin'))
      .toEqual({ number: 405, branch: 'feat/m103-localization-plugin' });
  });

  it('ignores a merge that is not a pull request', () => {
    expect(parseMergeSubject("Merge remote-tracking branch 'origin/develop' into feat/x"))
      .toBeNull();
    expect(parseMergeSubject('chore: merge develop into m101d')).toBeNull();
  });
});

describe('splitSections', () => {
  it('splits on every `## [version]` heading, keeping file order', () => {
    const sections = splitSections(CHANGELOG);
    expect(sections.map((section) => section.version)).toEqual(['Unreleased', '0.8.0']);
    expect(sections[0].body).toContain('(M103)');
    expect(sections[1].body).toContain('(M98o)');
    expect(sections[1].body).not.toContain('(M101a)');
  });
});

describe('requiredToken', () => {
  it('maps a milestone branch to its M-id, letter suffix and case included', () => {
    expect(requiredToken(pr(1, 'feat/m103-localization-plugin'))).toBe('M103');
    expect(requiredToken(pr(2, 'feat/m101d-call-sides-agree'))).toBe('M101d');
    expect(requiredToken(pr(3, 'feat/M70h-cli-scaffolds'))).toBe('M70h');
  });

  it('requires a PR number from any other branch that changed published source', () => {
    expect(requiredToken(pr(412, 'fix/sdk-retry', ['packages/sdk/src/http/client.ts']))).toBe(
      '#412',
    );
    expect(requiredToken(pr(7, 'chore/x', ['packages/starters/rest-starter/src/index.ts']))).toBe(
      '#7',
    );
  });

  it('exempts a branch that touched no published src tree', () => {
    expect(requiredToken(pr(9, 'fix/398-review-findings', ['CLAUDE.md']))).toBeNull();
    expect(requiredToken(pr(10, 'docs/roadmap', ['ROADMAP.md', 'plans/x.md']))).toBeNull();
    // A test file is not what ships.
    expect(requiredToken(pr(11, 'chore/tests', ['packages/sdk/test/unit/a.test.ts']))).toBeNull();
    // Nor is a script or a workflow.
    expect(
      requiredToken(pr(12, 'chore/ci', ['scripts/verify-release.ts', '.github/workflows/ci.yml'])),
    )
      .toBeNull();
  });
});

describe('checkChangelogPrs', () => {
  it('passes a changelog that represents every merged PR', () => {
    const result = checkChangelogPrs(CHANGELOG, '0.9.0', [
      pr(405, 'feat/m103-localization-plugin', ['packages/localization-plugin/src/index.ts']),
      pr(401, 'feat/m101a-bounded-health'),
      pr(412, 'fix/sdk-retry', ['packages/sdk/src/http/client.ts']),
      pr(399, 'fix/398-review-findings', ['CLAUDE.md']),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.shippingSection).toBe('## [Unreleased]');
    expect(result.represented).toBe(3);
    expect(result.exempt).toBe(1);
  });

  it('reports a milestone PR with no entry in the shipping section (the #195 / #233 case)', () => {
    const result = checkChangelogPrs(CHANGELOG, '0.9.0', [pr(233, 'feat/m88-response-path')]);
    expect(result.findings).toEqual([
      { pr: pr(233, 'feat/m88-response-path'), expectedToken: 'M88', kind: 'missing' },
    ]);
    expect(describeFindings(result)[0]).toContain('PR #233 (feat/m88-response-path)');
    expect(describeFindings(result)[0]).toContain('`M88`');
  });

  it('does not let `M101` satisfy `M101a`, nor `#41` satisfy `#412`', () => {
    const changelog = CHANGELOG.replace('(M101a)', '(M101)').replace('(#412)', '(#41)');
    const result = checkChangelogPrs(changelog, '0.9.0', [
      pr(401, 'feat/m101a-bounded-health'),
      pr(412, 'fix/sdk-retry', ['packages/sdk/src/a.ts']),
    ]);
    expect(result.findings.map((finding) => finding.expectedToken)).toEqual(['M101a', '#412']);
  });

  it('reports a fix PR that changed published source and names no PR number', () => {
    const changelog = CHANGELOG.replace(' (#412)', '');
    const result = checkChangelogPrs(changelog, '0.9.0', [
      pr(412, 'fix/sdk-retry', ['packages/sdk/src/http/client.ts']),
    ]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].expectedToken).toBe('#412');
  });

  it('reports a milestone entry filed under a published heading (the v0.3.0 M86 case)', () => {
    const misfiled = CHANGELOG.replace(
      '- **Diagnostics (M98o).** Shipped in 0.8.0.',
      '- **Diagnostics (M98o).** Shipped in 0.8.0.\n- **Ingress behaviours (M86).** Filed late.',
    );
    const result = checkChangelogPrs(misfiled, '0.9.0', [pr(228, 'feat/m86-ingress')]);
    expect(result.findings.map((finding) => finding.kind)).toEqual(['missing', 'misfiled']);
    expect(result.findings[1].foundIn).toBe('## [0.8.0] — 2026-10-03');
    expect(describeFindings(result)[1]).toContain('published before this PR merged');
  });

  it('does not read a prose mention of a milestone in an old entry as a misfiled entry', () => {
    // The 0.8.0 section says "M103 is planned" inside an entry body; only an
    // entry LEAD's `(M103)` tag is an entry.
    const result = checkChangelogPrs(CHANGELOG, '0.9.0', [
      pr(405, 'feat/m103-localization-plugin'),
    ]);
    expect(result.findings).toEqual([]);
  });

  it('checks the version section once `[Unreleased]` is empty (a release branch after the bump)', () => {
    const released = CHANGELOG.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n## [0.9.0] — 2026-10-05\n',
    );
    const result = checkChangelogPrs(released, '0.9.0', [pr(405, 'feat/m103-localization-plugin')]);
    expect(result.shippingSection).toBe('## [0.9.0] — 2026-10-05');
    expect(result.findings).toEqual([]);
  });

  it('throws when neither a non-empty `[Unreleased]` nor the version section exists', () => {
    const bare = '# Changelog\n\n## [Unreleased]\n\n## [0.8.0] — 2026-10-03\n\n- x\n';
    expect(() => checkChangelogPrs(bare, '0.9.0', [])).toThrow("'## [0.9.0]'");
  });
});

describe('mergedPullRequests (git seam)', () => {
  it('lists PRs merged since the previous tag with their changed paths', async () => {
    const calls: string[][] = [];
    const git = (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'tag') return Promise.resolve('');
      if (args[0] === 'describe') return Promise.resolve('v0.8.0\n');
      if (args[0] === 'log') {
        return Promise.resolve(
          [
            'aaa\x1fMerge pull request #405 from setu-ts/feat/m103-localization-plugin',
            "bbb\x1fMerge remote-tracking branch 'origin/develop' into feat/m103-localization-plugin",
            'ccc\x1fMerge pull request #399 from setu-ts/fix/398-review-findings',
            '',
          ].join('\n'),
        );
      }
      if (args[0] === 'diff') {
        return Promise.resolve(
          args[3] === 'aaa' ? 'packages/common/src/tokens.ts\nCHANGELOG.md\n' : 'CLAUDE.md\n',
        );
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const { previousTag, merged } = await mergedPullRequests(git);
    expect(previousTag).toBe('v0.8.0');
    expect(merged).toEqual([
      pr(405, 'feat/m103-localization-plugin', ['packages/common/src/tokens.ts', 'CHANGELOG.md']),
      pr(399, 'fix/398-review-findings', ['CLAUDE.md']),
    ]);
    expect(calls[0]).toEqual(['tag', '--points-at', 'HEAD', '--list', 'v*']);
    expect(calls[1]).toEqual(['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD']);
    expect(calls[2]).toEqual(['log', '--merges', '--format=%H%x1f%s', 'v0.8.0..HEAD']);
    expect(calls[3]).toEqual(['diff', '--name-only', 'aaa^1', 'aaa']);
  });

  it('describes from the parent when the release tag sits on HEAD (a tag-triggered run)', async () => {
    // Describing HEAD would return v0.9.0 itself, an empty range, and the check
    // would pass while checking nothing.
    const calls: string[][] = [];
    const git = (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'tag') return Promise.resolve('v0.9.0\n');
      if (args[0] === 'describe') {
        return Promise.resolve(args.at(-1) === 'HEAD^' ? 'v0.8.0\n' : 'v0.9.0\n');
      }
      if (args[0] === 'log') return Promise.resolve('');
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const { previousTag } = await mergedPullRequests(git);
    expect(previousTag).toBe('v0.8.0');
    expect(calls[1]).toEqual(['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^']);
    expect(calls[2]).toEqual(['log', '--merges', '--format=%H%x1f%s', 'v0.8.0..HEAD']);
  });

  it('fails loudly when no tag is reachable, naming the shallow-checkout remedy', async () => {
    const git = (): Promise<string> => Promise.reject(new Error('fatal: No names found'));
    await expect(mergedPullRequests(git)).rejects.toThrow('fetch-depth: 0');
  });
});

describe('runGit (real subprocess)', () => {
  it('returns stdout on success and throws with stderr on failure', async () => {
    expect((await runGit(['--version'])).startsWith('git version')).toBe(true);
    await expect(runGit(['rev-parse', '--verify', 'refs/heads/no-such-branch-ever']))
      .rejects.toThrow('git rev-parse --verify refs/heads/no-such-branch-ever failed');
  });
});
