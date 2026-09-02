import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  buildReleaseBody,
  extractReleaseNotes,
  isPrerelease,
} from '../../scripts/release-notes.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [0.1.0-alpha.9] - 2026-08-26',
  '',
  '### Added',
  '',
  '- A thing.',
  '',
  '## [0.1.0-alpha.8] - 2026-08-14',
  '',
  '### Fixed',
  '',
  '- An older thing.',
  '',
].join('\n');

describe('extractReleaseNotes', () => {
  it('returns the section bounded by the next version heading', () => {
    expect(extractReleaseNotes(CHANGELOG, '0.1.0-alpha.9'))
      .toBe('### Added\n\n- A thing.');
  });

  it('reads a section that runs to the end of the file', () => {
    expect(extractReleaseNotes(CHANGELOG, '0.1.0-alpha.8'))
      .toBe('### Fixed\n\n- An older thing.');
  });

  it('returns null for a version the changelog does not carry', () => {
    expect(extractReleaseNotes(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('returns null for a heading with an empty section', () => {
    const empty = '## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-01\n\n- old\n';
    expect(extractReleaseNotes(empty, '1.0.0')).toBeNull();
  });

  it('does not match a version that merely starts with the same digits', () => {
    // `## [0.1.0]` must not be satisfied by `## [0.1.0-alpha.9]`, and the
    // reverse must not happen either — the bracket is part of the heading.
    const both = '## [0.1.0-alpha.9]\n\n- pre\n\n## [0.1.0]\n\n- final\n';
    expect(extractReleaseNotes(both, '0.1.0')).toBe('- final');
  });
});

describe('isPrerelease', () => {
  it('treats a semver prerelease identifier as a prerelease', () => {
    expect(isPrerelease('0.1.0-alpha.9')).toBe(true);
  });

  it('treats a plain version as a full release', () => {
    // The flag is derived rather than hardcoded, so 1.0.0 stops being marked
    // prerelease without anyone remembering to edit the workflow.
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('buildReleaseBody', () => {
  it('carries a pinned install line, the notes, and the pre-alpha.8 note', () => {
    const body = buildReleaseBody('### Added\n\n- A thing.', '0.1.0-alpha.9');
    // Pinned, because JSR never points `latest` at a prerelease — an unpinned
    // instruction in the release notes installs nothing.
    expect(body).toContain('jsr:@setu-ts/kernel@0.1.0-alpha.9');
    expect(body).toContain('- A thing.');
    expect(body).toContain('Releases before `v0.1.0-alpha.8` shipped as tags only');
  });
});

describe('the real CHANGELOG', () => {
  it('yields a body for the most recently published version', async () => {
    // Drives the actual file, not a fixture: the extraction is bounded by the
    // heading format the repo really uses, and a format change here would
    // otherwise surface only during a tag run that cannot be rehearsed.
    const changelog = await Deno.readTextFile('CHANGELOG.md');
    const notes = extractReleaseNotes(changelog, '0.1.0-alpha.8');
    expect(notes).not.toBeNull();
    expect(notes?.length ?? 0).toBeGreaterThan(200);
    expect(notes).not.toContain('## [0.1.0-alpha.7]');
  });
});

describe('release workflow wiring', () => {
  it('builds its notes with this script rather than inlined shell', async () => {
    // The Publish step's own comment records what a workflow copy of logic
    // that lives elsewhere already cost: it drifted, omitted two permission
    // flags, and failed three consecutive releases. A reimplementation of the
    // extraction inside the workflow would be exercised only by a tag run,
    // which cannot be rehearsed — so the call is pinned here.
    const workflow = await Deno.readTextFile('.github/workflows/release.yml');
    expect(workflow).toContain('scripts/release-notes.ts');
    expect(workflow).toContain('gh release create');
  });

  it('creates the release AFTER publishing, so a failure cannot cost the publish', async () => {
    const workflow = await Deno.readTextFile('.github/workflows/release.yml');
    const publish = workflow.indexOf('- name: Publish');
    const release = workflow.indexOf('- name: Create GitHub Release');
    expect(publish).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(publish);
  });

  it('verifies release consistency on the PR path, not only on a tag', async () => {
    // `release:verify` is the only gate for version agreement across all 47
    // manifests, cross-package specifier resolvability, whole-workspace
    // coverage and `@module`-first entrypoints. It ran ONLY on a tag until
    // v0.2.0 — after a release PR had already been merged — so a release
    // branch could be accepted with none of them checked. `publish:check`
    // sees none of it.
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    expect(workflow).toContain('deno task release:verify');
    // Read from the workspace, never written into the workflow: a literal
    // would have to be edited every release and would silently verify the
    // wrong version if it were not.
    expect(workflow).toContain('jq -r .version packages/kernel/deno.json');
  });

  it('flags a 0.x release as a prerelease, not only a -suffix version', async () => {
    // v0.2.0 dropped the `alpha` label without freezing the API, so matching
    // only `*-*` would publish a Release object presented as stable. The
    // `0.*` arm is dropped at 1.0 and not before.
    const workflow = await Deno.readTextFile('.github/workflows/release.yml');
    expect(workflow).toContain('case "$version" in 0.*|*-*) prerelease=\'--prerelease\' ;; esac');
  });

  it('grants the contents:write the release step needs', async () => {
    // Tokenless OIDC covers the JSR publish; creating a Release object does
    // not ride on it, and the job token is read-only by default.
    const workflow = await Deno.readTextFile('.github/workflows/release.yml');
    expect(workflow).toContain('contents: write');
  });
});
