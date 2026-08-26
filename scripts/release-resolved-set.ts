// deno-lint-ignore-file no-console -- this release script reports its output path.
/**
 * Captures the complete lockfile resolved set attached to a GitHub Release.
 *
 * A release's `deno.lock` is the reproducibility authority. This artifact
 * records it with the release version so a consumer can recover the exact set
 * without inferring which repository commit a tag named.
 */

/** The lockfile fields preserved verbatim in a release resolved-set artifact. */
export interface LockfileContents {
  readonly version: string;
  readonly specifiers: Readonly<Record<string, string>>;
  readonly jsr?: Readonly<Record<string, unknown>>;
  readonly npm?: Readonly<Record<string, unknown>>;
  readonly remote?: Readonly<Record<string, unknown>>;
  readonly redirects?: Readonly<Record<string, string>>;
  readonly workspace?: Readonly<Record<string, unknown>>;
}

/** The versioned, self-describing artifact attached to each GitHub Release. */
export interface ReleaseResolvedSet {
  readonly schemaVersion: 1;
  readonly release: string;
  readonly lockfile: LockfileContents;
}

/**
 * Converts a parsed Deno lockfile to its release artifact form.
 *
 * @param release - Release version, without the leading `v` tag prefix.
 * @param lockfile - Parsed `deno.lock` contents.
 * @returns Stable release artifact content.
 * @throws {TypeError} If the release or lockfile lacks its required identity.
 */
export function createReleaseResolvedSet(
  release: string,
  lockfile: LockfileContents,
): ReleaseResolvedSet {
  if (release === '') throw new TypeError('release version must not be empty');
  if (lockfile.version === '') throw new TypeError('deno.lock version must not be empty');

  return {
    schemaVersion: 1,
    release,
    lockfile,
  };
}

/**
 * Serializes a resolved set deterministically for artifact upload.
 *
 * @param resolvedSet - Artifact content to serialize.
 * @returns Indented JSON ending in one newline.
 */
export function serializeReleaseResolvedSet(resolvedSet: ReleaseResolvedSet): string {
  return `${JSON.stringify(resolvedSet, null, 2)}\n`;
}

async function main(): Promise<number> {
  const [release, output] = Deno.args;
  if (release === undefined || output === undefined || release === '' || output === '') {
    console.error('usage: release-resolved-set.ts <version> <output-path>');
    return 2;
  }

  const parsed = JSON.parse(await Deno.readTextFile('deno.lock')) as LockfileContents;
  const artifact = createReleaseResolvedSet(release, parsed);
  await Deno.writeTextFile(output, serializeReleaseResolvedSet(artifact));
  console.log(`Wrote resolved dependency set for ${release} to ${output}.`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
