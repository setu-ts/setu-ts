// deno-lint-ignore-file no-console -- this CI script emits a human-readable drift report.
/**
 * Compares the committed and freshly resolved Deno lockfiles.
 *
 * The comparison is deliberately on `specifiers`, not raw lockfile text: a
 * reviewer needs the package and old/new resolved version, while integrity or
 * transitive-object reordering is supporting evidence rather than attribution.
 */

/** The lockfile subset needed to attribute a range resolution. */
export interface IDriftLockfile {
  readonly specifiers: Readonly<Record<string, string>>;
}

/** One changed direct resolution, identified by its original specifier. */
export interface IDependencyDrift {
  readonly specifier: string;
  readonly packageName: string;
  readonly previous: string | null;
  readonly current: string | null;
}

/**
 * Extracts a displayable registry package name from a Deno specifier.
 *
 * @param specifier - `npm:` or `jsr:` specifier carrying a version range.
 * @returns Package name, or the original specifier for non-registry imports.
 */
export function packageNameOf(specifier: string): string {
  const match = /^(?:npm|jsr):((?:@[^/]+\/)?[^@/]+)@/.exec(specifier);
  return match?.[1] ?? specifier;
}

/**
 * Finds changes between a committed and a fresh range resolution.
 *
 * @param committed - The lockfile reviewed with the repository commit.
 * @param fresh - A lockfile resolved with `--reload` and no frozen lock.
 * @returns Deterministically ordered changed and newly resolved ranges.
 */
export function findDependencyDrift(
  committed: IDriftLockfile,
  fresh: IDriftLockfile,
): readonly IDependencyDrift[] {
  const specifiers = new Set([
    ...Object.keys(committed.specifiers),
    ...Object.keys(fresh.specifiers),
  ]);

  return [...specifiers]
    .sort()
    .flatMap((specifier): IDependencyDrift[] => {
      const previous = committed.specifiers[specifier] ?? null;
      const current = fresh.specifiers[specifier] ?? null;
      // Deno lockfiles are additive. A specifier present only in the committed
      // lockfile may simply be stale, so its absence from a fresh graph is not
      // upstream drift and must not bury the real moved-package report.
      if (current === null || previous === current) return [];
      return [{ specifier, packageName: packageNameOf(specifier), previous, current }];
    });
}

/**
 * Produces Markdown suitable for a GitHub Actions summary or drift issue.
 *
 * @param changes - Attributed resolution changes.
 * @returns Complete Markdown report.
 */
export function formatDependencyDrift(changes: readonly IDependencyDrift[]): string {
  if (changes.length === 0) {
    return '## Dependency drift\n\nNo direct dependency resolution changed.\n';
  }

  const rows = changes.map((change) =>
    `| \`${change.packageName}\` | \`${change.specifier}\` | ` +
    `\`${change.previous ?? 'not locked'}\` | \`${change.current ?? 'removed'}\` |`
  );
  return [
    '## Dependency drift',
    '',
    '| Package | Specifier | Committed | Fresh resolution |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function readLockfile(path: string): Promise<IDriftLockfile> {
  return JSON.parse(await Deno.readTextFile(path)) as IDriftLockfile;
}

async function main(): Promise<number> {
  const [committedPath, freshPath] = Deno.args;
  if (committedPath === undefined || freshPath === undefined) {
    console.error('usage: dependency-drift.ts <committed-lock> <fresh-lock>');
    return 2;
  }
  const changes = findDependencyDrift(
    await readLockfile(committedPath),
    await readLockfile(freshPath),
  );
  console.log(formatDependencyDrift(changes));
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
