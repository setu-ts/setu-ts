/**
 * The pure core of `release:verify` check 1's Node half (M111a plan §3.5).
 *
 * A member's version lives at three sites: `deno.json`, the generated
 * `package.json`, and — for a member that reads its own version — the
 * `src/version.ts` literal the npm build ships. A bump that misses either new
 * site publishes a package whose npm manifest or runtime `VERSION` disagrees
 * with the tag, and nothing else reads them. `verify-release.ts` reads the two
 * files; this module decides.
 *
 * @module
 */

/** The `VERSION` declaration every generated `src/version.ts` carries. */
const VERSION_LITERAL = /export const VERSION: string = '([^']*)'/;

/**
 * Every disagreement between `expected` and a member's two Node version sites.
 *
 * @param dir - The member directory, used only to name the problem
 * @param expected - The version being released
 * @param packageJson - The member's `package.json` text, or `null` when unreadable
 * @param versionSource - The member's `src/version.ts` text, or `null` when the
 *   member ships no constant — which is correct, since only a PRESENT constant
 *   can disagree with the tag
 * @returns One line per problem, empty when both sites agree
 */
export function versionSiteProblems(
  dir: string,
  expected: string,
  packageJson: string | null,
  versionSource: string | null,
): readonly string[] {
  const problems: string[] = [];
  let manifest: { version?: unknown } | null = null;
  if (packageJson !== null) {
    try {
      manifest = JSON.parse(packageJson) as { version?: unknown };
    } catch {
      manifest = null;
    }
  }
  if (manifest === null || typeof manifest !== 'object') {
    problems.push(`${dir}: no readable package.json (the Node build's manifest)`);
  } else if (manifest.version !== expected) {
    const found = typeof manifest.version === 'string' ? manifest.version : '(missing)';
    problems.push(`${dir}: package.json version is ${found}, expected ${expected}`);
  }
  if (versionSource !== null) {
    const match = VERSION_LITERAL.exec(versionSource);
    if (match === null) {
      problems.push(`${dir}: src/version.ts carries no recognizable VERSION literal`);
    } else if (match[1] !== expected) {
      problems.push(`${dir}: src/version.ts VERSION is ${match[1]}, expected ${expected}`);
    }
  }
  return problems;
}
