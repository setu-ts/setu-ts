/**
 * The CHANGELOG link-definition gate's own controls.
 *
 * X93-4 shipped `[0.11.0]` with no definition and left `[unreleased]`
 * comparing from `v0.10.0`; both were hand edits. These cases assert the two
 * rules from `scripts/lib/changelog-links.ts` in both directions, plus the
 * edit `scripts/bump-version.ts` applies so the next cut cannot repeat them.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  changelogDefinitions,
  changelogHeadings,
  changelogLinkProblems,
  recordReleaseDefinition,
} from '../../scripts/lib/changelog-links.ts';

const RELEASES = 'https://github.com/setu-ts/setu-ts/releases/tag';

function changelog(over: { headings?: string; definitions?: string } = {}): string {
  const headings =
    over.headings ??
    ['## [Unreleased]', '', '- New.', '', '## [0.11.0] — 2026-10-30', '', '- Old.'].join('\n');
  const definitions =
    over.definitions ??
    [
      `[unreleased]: https://github.com/setu-ts/setu-ts/compare/v0.11.0...HEAD`,
      `[0.11.0]: ${RELEASES}/v0.11.0`,
    ].join('\n');
  return `# Changelog\n\n${headings}\n\n${definitions}\n`;
}

describe('changelogHeadings / changelogDefinitions', () => {
  it('reads headings and definitions in file order', () => {
    expect(changelogHeadings(changelog()).map((heading) => heading.label)).toEqual([
      'Unreleased',
      '0.11.0',
    ]);
    expect(changelogDefinitions(changelog()).map((definition) => definition.label)).toEqual([
      'unreleased',
      '0.11.0',
    ]);
  });

  it('ignores both shapes inside a fenced code block', () => {
    const text = [
      '# Changelog',
      '',
      '```md',
      '## [0.0.1] — example',
      '[0.0.1]: https://example.test/v0.0.1',
      '```',
      '',
      '## [0.1.0] — 2026-01-01',
      '',
      '[0.1.0]: https://example.test/v0.1.0',
    ].join('\n');
    expect(changelogHeadings(text).map((heading) => heading.label)).toEqual(['0.1.0']);
    expect(changelogDefinitions(text).map((definition) => definition.label)).toEqual(['0.1.0']);
  });
});

describe('changelogLinkProblems', () => {
  it('passes when every heading is defined and unreleased compares from the newest', () => {
    expect(changelogLinkProblems(changelog())).toEqual([]);
  });

  it('fails naming a released heading that has no definition', () => {
    const problems = changelogLinkProblems(
      changelog({ definitions: '[unreleased]: https://example.test/compare/v0.11.0...HEAD' }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("'## [0.11.0]' has no link definition");
    expect(problems[0]).toContain("'[0.11.0]: …'");
  });

  it('fails a stale unreleased compare base, naming both versions', () => {
    const problems = changelogLinkProblems(
      changelog({
        definitions: [
          '[unreleased]: https://example.test/compare/v0.10.0...HEAD',
          `[0.11.0]: ${RELEASES}/v0.11.0`,
        ].join('\n'),
      }),
    );
    expect(problems).toEqual([
      "CHANGELOG.md: '[unreleased]' compares from v0.10.0, but the newest release heading is " +
        "'## [0.11.0]' — expected '…/compare/v0.11.0...HEAD'.",
    ]);
  });

  it('matches labels case-insensitively', () => {
    const problems = changelogLinkProblems(
      changelog({
        headings: '## [Unreleased]\n\n- New.\n\n## [0.11.0] — 2026-10-30\n\n- Old.',
        definitions: [
          '[Unreleased]: https://example.test/compare/v0.11.0...HEAD',
          `[0.11.0]: ${RELEASES}/v0.11.0`,
        ].join('\n'),
      }),
    );
    expect(problems).toEqual([]);
  });

  it('fails an unreleased definition that compares from no release at all', () => {
    const problems = changelogLinkProblems(
      changelog({
        definitions: [
          '[unreleased]: https://example.test/HEAD',
          `[0.11.0]: ${RELEASES}/v0.11.0`,
        ].join('\n'),
      }),
    );
    expect(problems).toEqual([
      "CHANGELOG.md: '[unreleased]' does not compare from a release — expected " +
        "'…/compare/v0.11.0...HEAD'.",
    ]);
  });

  it('passes the repository CHANGELOG after the 0.11.0 definition was added', async () => {
    const text = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelogLinkProblems(text)).toEqual([]);
  });

  it('fails the shape develop carried: 0.11.0 heading, no definition, stale base', () => {
    const develop = changelog({
      definitions:
        `[unreleased]: https://github.com/setu-ts/setu-ts/compare/v0.10.0...HEAD\n` +
        `[0.10.0]: ${RELEASES}/v0.10.0`,
    });
    const problems = changelogLinkProblems(develop);
    expect(
      problems.some((problem) => problem.includes("'## [0.11.0]' has no link definition")),
    ).toBe(true);
    expect(problems.some((problem) => problem.includes('compares from v0.10.0'))).toBe(true);
  });
});

describe('recordReleaseDefinition', () => {
  it('inserts the new definition above the previous one and rebases unreleased', () => {
    // The bump renames the heading first, then records the definition.
    const renamed = changelog({
      headings: [
        '## [Unreleased]',
        '',
        '## [0.12.0] — 2026-11-10',
        '',
        '- New.',
        '',
        '## [0.11.0] — 2026-10-30',
        '',
        '- Old.',
      ].join('\n'),
    });
    const { content, changed } = recordReleaseDefinition(renamed, '0.12.0');
    expect(changed).toBe(true);
    expect(content).toContain(
      '[unreleased]: https://github.com/setu-ts/setu-ts/compare/v0.12.0...HEAD',
    );
    expect(content).toContain(`[0.12.0]: ${RELEASES}/v0.12.0\n[0.11.0]: ${RELEASES}/v0.11.0`);
    expect(changelogLinkProblems(content)).toEqual([]);
  });

  it('does not duplicate an existing definition, and still rebases', () => {
    const existing = changelog({
      definitions: [
        '[unreleased]: https://example.test/compare/v0.10.0...HEAD',
        `[0.11.0]: ${RELEASES}/v0.11.0`,
        `[0.10.0]: ${RELEASES}/v0.10.0`,
      ].join('\n'),
    });
    const { content } = recordReleaseDefinition(existing, '0.11.0');
    expect(content.match(/^\[0\.11\.0\]:/gm)).toHaveLength(1);
    expect(content).toContain('compare/v0.11.0...HEAD');
  });

  it('is a no-op on a file that already records the release', () => {
    const before = changelog();
    const { content, changed } = recordReleaseDefinition(before, '0.11.0');
    expect(changed).toBe(false);
    expect(content).toBe(before);
  });

  it('falls back to after [unreleased] when no previous definition exists', () => {
    const bare =
      '# Changelog\n\n## [Unreleased]\n\n- New.\n\n[unreleased]: https://x.test/compare/v0.1.0...HEAD\n';
    const { content } = recordReleaseDefinition(bare, '0.2.0');
    expect(content).toContain(
      `[unreleased]: https://x.test/compare/v0.2.0...HEAD\n[0.2.0]: ${RELEASES}/v0.2.0\n`,
    );
  });
  it('inserts above the next definition when the old base has none of its own', () => {
    const file =
      '# Changelog\n\n[unreleased]: https://x.test/compare/v0.1.0...HEAD\n[0.0.9]: https://x.test/v0.0.9\n';
    const { content } = recordReleaseDefinition(file, '0.2.0');
    expect(content).toBe(
      '# Changelog\n\n[unreleased]: https://x.test/compare/v0.2.0...HEAD\n' +
        `[0.2.0]: ${RELEASES}/v0.2.0\n[0.0.9]: https://x.test/v0.0.9\n`,
    );
  });

  it('adds both definitions before the trailing newline when the file has none', () => {
    const { content, changed } = recordReleaseDefinition('# Changelog\n\n## [1.0.0]\n', '1.0.0');
    expect(changed).toBe(true);
    expect(content).toBe(
      '# Changelog\n\n## [1.0.0]\n' +
        '[unreleased]: https://github.com/setu-ts/setu-ts/compare/v1.0.0...HEAD\n' +
        `[1.0.0]: ${RELEASES}/v1.0.0\n`,
    );
    expect(changelogLinkProblems(content)).toEqual([]);
  });

  it('adds only [unreleased] when the release is already defined', () => {
    const { content } = recordReleaseDefinition(
      `# Changelog\n\n[0.3.0]: ${RELEASES}/v0.3.0\n`,
      '0.3.0',
    );
    expect(content).toBe(
      '# Changelog\n\n[unreleased]: https://github.com/setu-ts/setu-ts/compare/v0.3.0...HEAD\n' +
        `[0.3.0]: ${RELEASES}/v0.3.0\n`,
    );
  });

  it('leaves an [unreleased] that is not a compare URL alone', () => {
    const file = '# Changelog\n\n[unreleased]: https://x.test/main\n';
    const { content } = recordReleaseDefinition(file, '0.2.0');
    expect(content).toBe(
      `# Changelog\n\n[unreleased]: https://x.test/main\n[0.2.0]: ${RELEASES}/v0.2.0\n`,
    );
  });
});

describe('changelogLinkProblems edge shapes', () => {
  it('reports an Unreleased heading with no [unreleased] definition, and nothing more', () => {
    const file = changelog({ definitions: `[0.11.0]: ${RELEASES}/v0.11.0` });
    expect(changelogLinkProblems(file)).toEqual([
      expect.stringContaining("'## [Unreleased]' has no link definition"),
    ]);
  });

  it('has no base rule to apply when no release heading follows Unreleased', () => {
    const file = changelog({
      headings: '## [Unreleased]\n\n- New.',
      definitions: '[unreleased]: https://x.test/compare/v0.1.0...HEAD',
    });
    expect(changelogLinkProblems(file)).toEqual([]);
  });

  it('accepts CommonMark definition forms: indent, angle brackets and a title', () => {
    const file = changelog({
      definitions: [
        '   [unreleased]: <https://x.test/compare/v0.11.0...HEAD>',
        `[0.11.0]: ${RELEASES}/v0.11.0 "0.11.0"`,
      ].join('\n'),
    });
    expect(changelogLinkProblems(file)).toEqual([]);
  });
});
