// deno-lint-ignore-file no-console -- this CI script prints the notes it builds.
/**
 * Builds the body of a GitHub Release object from `CHANGELOG.md`.
 *
 * The release workflow creates the Release object after publishing to JSR (see
 * `.github/workflows/release.yml`). The extraction lives here rather than as
 * inlined workflow shell for the reason the Publish step already documents in
 * its own comment: a copy inside the workflow drifted from the task it
 * duplicated and broke three consecutive releases. One definition, one place to
 * keep correct — and here it is unit-tested, which inline shell in a workflow
 * that runs only on a tag can never be.
 */

/** A version carrying a prerelease identifier (`0.1.0-alpha.9`) per semver. */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/**
 * Returns the `CHANGELOG.md` section for `version`, or `null` when absent.
 *
 * Bounded by the NEXT `## [` heading rather than by the previous version's
 * number, so the caller never has to know what shipped before this one — the
 * release workflow knows only the tag it was triggered by.
 */
export function extractReleaseNotes(
  changelog: string,
  version: string,
): string | null {
  const lines = changelog.split('\n');
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ['));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

/**
 * Wraps the changelog section in the two things a Releases-tab reader needs and
 * the changelog does not carry: a PINNED install line (JSR never points
 * `latest` at a prerelease, so an unpinned instruction installs nothing), and a
 * note that the earlier tags carry no Release object — without it a reader
 * lands on a near-empty Releases tab and takes the first entry for the first
 * release.
 */
export function buildReleaseBody(notes: string, version: string): string {
  const install = `deno add jsr:@setu-ts/kernel@${version} jsr:@setu-ts/runtime@${version}`;
  return [
    '```bash',
    install,
    '```',
    '',
    notes,
    '',
    '---',
    '',
    'Releases before `v0.1.0-alpha.8` shipped as tags only; their notes live in',
    '[`CHANGELOG.md`](https://github.com/setu-ts/setu-ts/blob/main/CHANGELOG.md).',
    '',
  ].join('\n');
}

async function main(): Promise<number> {
  const version = Deno.args[0];
  if (version === undefined || version === '') {
    console.error('usage: release-notes.ts <version>   (e.g. 0.1.0-alpha.9)');
    return 2;
  }

  const changelog = await Deno.readTextFile('CHANGELOG.md');
  const notes = extractReleaseNotes(changelog, version);
  if (notes === null) {
    console.error(`CHANGELOG.md has no '## [${version}]' section.`);
    return 1;
  }

  console.log(buildReleaseBody(notes, version));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
