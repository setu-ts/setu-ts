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

/**
 * Returns one job's block from a workflow, by indentation.
 *
 * A workflow-wide substring says nothing about WHERE a command runs, and the
 * distinction is the whole point of the assertion using this: a step in a
 * tag-only job is not a step on the pull-request path. Slicing beats parsing
 * here only because it needs no YAML dependency for a two-level lookup; it is
 * anchored to `\n  <name>:\n` and ends at the next key of the same depth, so a
 * job whose name is a prefix of another cannot be confused for it.
 *
 * @param workflow - The workflow file's contents
 * @param name - The job key to extract
 * @returns That job's block, including its own key line
 */
function jobBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start === -1) throw new Error(`No job '${name}' in the workflow.`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Escapes a literal for embedding in a `RegExp`.
 *
 * @param value - Literal text
 * @returns The same text, safe as a pattern
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Asserts a workflow declares `text` as an ACTIVE line, not merely somewhere.
 *
 * A `toContain` is satisfied by a commented-out declaration — the `#` sits
 * before the key, so the substring survives commenting out the line that gives
 * it effect. Anchoring to the start of a line, after indentation only, is what
 * tells an active mapping entry from a disabled one.
 *
 * @param block - The workflow or job text to search
 * @param text - The `key: value` pair that must be live
 * @returns A pattern matching only the active form
 */
function activeLine(text: string): RegExp {
  return new RegExp(`^ +${escapeRegExp(text)}$`, 'm');
}

/**
 * Extracts one named step's block from a job, by indentation.
 *
 * Starts at the step's own `- name:` line, so the comment block above it is
 * excluded: prose may legitimately differ between two workflows while the step
 * they run must not. Throws when the step is absent, so a comparison against a
 * renamed or deleted step fails loudly instead of comparing nothing.
 *
 * @param job - A job block from `jobBlock`
 * @param name - The step's `name` value
 * @returns That step's lines, `- name:` included
 */
function stepBlock(job: string, name: string): string {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`No step '${name}' in the job.`);
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    const isSibling = line.trimStart().startsWith('- ') &&
      line.length - line.trimStart().length === indent;
    if (isSibling) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

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
    //
    // Asserted INSIDE the job and against the trigger, not as a substring of
    // the file: a bare `toContain` passes just as well when the command sits
    // in a comment, or is moved to a tag-only job, which is precisely the
    // arrangement this pins against.
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    expect(workflow).toMatch(/^on:\n(?:.*\n)*? {2}pull_request:/m);

    // One assertion, pinning the whole command as a real `run:` step: a
    // `toContain` is satisfied by a commented-out line, and the version source
    // is read from the workspace rather than written here, because a literal
    // would need editing every release and would silently verify the wrong
    // version if it were missed.
    const job = jobBlock(workflow, 'publish-dry-run');
    expect(job).toMatch(
      /^ +run: deno task release:verify "\$\(jq -r \.version packages\/kernel\/deno\.json\)"$/m,
    );
  });

  it('starts every backend the PR job starts, so a tag run is no weaker a gate', async () => {
    // The tag run re-runs the whole suite as the last gate before an immutable
    // publish, so a backend it does not start is a guarded suite that skips
    // there while passing on every PR. That is invisible: only `REDIS_URL` has
    // a CI-reachability assertion, so the rest degrade to a silent skip and the
    // job stays green. v0.2.0 shipped with DynamoDB Local and the Bigtable
    // emulator missing here for exactly that reason.
    //
    // Derived from ci.yml rather than listed by hand, because a hand-written
    // list is what drifted: a backend added to the PR job is now automatically
    // required here too.
    const ci = await Deno.readTextFile('.github/workflows/ci.yml');
    const release = await Deno.readTextFile('.github/workflows/release.yml');
    const prJob = jobBlock(ci, 'deno');
    const tagJob = jobBlock(release, 'release');

    // Matched as ACTIVE lines rather than substrings: commenting a declaration
    // out leaves the `key: value` text intact, so a `toContain` passes while
    // the backend is gone — the same weakness this file already pins against
    // for the release-verify step.
    const images = [...prJob.matchAll(/^ +image: (\S+)$/gm)].map((match) => match[1]);
    expect(images.length).toBeGreaterThan(5);
    for (const image of images) {
      expect(tagJob).toMatch(activeLine(`image: ${image}`));
    }

    // Endpoints too: a started container the suite cannot address is no gate.
    const endpoints = [...prJob.matchAll(/^ +([A-Z0-9_]+(?:_URL|_URI|_ENDPOINT)): (\S+)$/gm)];
    expect(endpoints.length).toBeGreaterThan(5);
    for (const [, name, value] of endpoints) {
      expect(tagJob).toMatch(activeLine(`${name}: ${value}`));
    }

    // The Bigtable emulator cannot be a service container — its image's default
    // command is a shell, and `options` reaches `docker create` BEFORE the image
    // while the command comes after — so it is a step that no image or endpoint
    // pin above reaches. Compared byte-for-byte against ci.yml's own step rather
    // than pinned as a literal, so changing the image, the published port, the
    // emulator command or the readiness probe on the PR side requires the same
    // change here; a hand-written literal is what let these two drift already.
    const emulator = 'Start the Cloud Bigtable emulator';
    expect(stepBlock(tagJob, emulator)).toBe(stepBlock(prJob, emulator));
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
