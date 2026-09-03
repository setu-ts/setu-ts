// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Residual-version gate for the sites the other release gates cannot see.
 *
 * A version bump has to move every `@setu-ts/*` reference in the tree, and the
 * existing gates cover two of the three kinds. This module covers the third,
 * and the split is deliberate rather than incidental — duplicating either of
 * the others would be a second classifier that can disagree with the first:
 *
 * | Site                                   | Owner                         |
 * | -------------------------------------- | ----------------------------- |
 * | Manifest specifiers and `version`      | `scripts/verify-release.ts`   |
 * | Markdown install snippets and claims   | `scripts/check-docs.ts`       |
 * | **TypeScript `src` trees and lockfiles** | **this module**              |
 *
 * The gap was measured, not assumed. Reverting one `packages/sdk/src`
 * specifier to the previous release leaves `deno check`, the full suite,
 * `publish:check` and `release:verify` **all green** — the range still
 * resolves, because the previous version is really on JSR. The published
 * package then depends on the release before the one being cut, which is the
 * exact failure `docs/releasing.md` warns about in prose and nothing enforced.
 * `packages/sdk` is the standing example because it writes its `jsr:`
 * specifier inline in four `src/**` files rather than through an import-map
 * alias, but the rule is not sdk-specific.
 *
 * **Range shorthand is not staleness.** A lockfile writes a caret range as
 * `@setu-ts/common@0.3` while a link key reads `@setu-ts/common@0.3.0`; both
 * name the shipping version. {@linkcode referenceMatches} accepts a NUMERIC
 * `major.minor` prefix, so `0.3` matches `0.3.0` while `0.30` does not, and
 * neither a bare major (`0`) nor a prefix reaching into a prerelease
 * identifier (`0.3.0-alpha` against `0.3.0-alpha.1`) is accepted.
 *
 * **Heuristic limits.** This is a regex over text, not a parser. It reads only
 * `@setu-ts/<pkg>@<version>` references and deliberately never bare version
 * numbers: `packages/cli/src` legitimately stamps `version: '0.1.0'` into the
 * projects it scaffolds, which has nothing to do with this framework's own
 * version, and a bare-number sweep would report every one of them. A genuinely
 * historical reference — naming a version on purpose, as a deprecation note
 * does — is exempted by a `version:history` marker on the same line or the one
 * above, the same convention `check-docs.ts` uses for prose.
 *
 * The decidable half is the pure {@linkcode findStaleReferences}; the thin
 * {@linkcode sweepTrackedFiles} walker is the I/O seam. The pure core is what
 * carries the 90% coverage bar via `SCRIPT_TARGETS`.
 *
 * @module
 */

/** A `@setu-ts/*` reference naming a version other than the shipping one. */
export interface StaleReference {
  /** Repository-relative path of the file the reference sits in. */
  readonly file: string;
  /** The 1-based line the reference sits on. */
  readonly line: number;
  /** The referenced package, without the `@setu-ts/` scope. */
  readonly pkg: string;
  /** The version as written, with any leading `^` or `~` stripped. */
  readonly version: string;
}

/** What a sweep found, plus the guards that keep a clean result meaningful. */
export interface SweepResult {
  /** References naming a version other than the shipping one. */
  readonly findings: readonly StaleReference[];
  /** Files the walker actually read. */
  readonly filesScanned: number;
  /**
   * Total `@setu-ts/*` references seen, stale or not.
   *
   * This is the vacuity guard, and it is the reason the gate can be trusted
   * when it passes. A sweep whose pattern stops matching — a scope rename, a
   * lockfile format change — reports zero findings and looks identical to a
   * clean tree. Zero references across a whole repository means the sweep is
   * broken, not that the tree is tidy, so `main()` fails on it.
   */
  readonly referencesSeen: number;
}

/** The in-source escape hatch for a deliberately historical reference. */
const HISTORY_MARKER = 'version:history';

/**
 * Every `@setu-ts/<pkg>@<version>` reference, with an optional range operator.
 *
 * The operator class carries the comparators as well as `^`/`~`: a specifier
 * written `@setu-ts/common@>=0.2.0` is a real, resolvable, and stale pin, and a
 * pattern that simply failed to match it would leave it uncounted AND
 * unreported — invisible, because the repository-wide vacuity guard stays
 * non-zero on everything else.
 *
 * The version class stops at a quote, whitespace, comma, closing brace **or
 * slash**. The slash is load-bearing: JSR entrypoints are real and in use
 * (`jsr:@setu-ts/cli@^0.3.0/main`, `jsr:@setu-ts/runtime@^0.3.0/worker`), and
 * without it the capture reads `0.3.0/worker`, which equals no version and
 * would report a correct import as stale.
 */
const REFERENCE = /@setu-ts\/([a-z0-9-]+)@(>=|<=|[~^><=]?)([0-9][^"'`\s,}/]*)/g;

/**
 * Reports whether a written reference names the shipping version.
 *
 * Accepts an exact match and a dot-bounded prefix, which is how a lockfile
 * abbreviates a caret range (`0.3` for `0.3.0`). The boundary check is what
 * keeps `0.3` from matching `0.30.0`.
 *
 * @param reference - Version as written, without a range operator
 * @param current - The version being shipped
 * @returns `true` when the reference names the shipping version
 */
export function referenceMatches(reference: string, current: string): boolean {
  if (reference === current) return true;
  // Only the shorthand a lockfile actually writes: `major.minor`, all digits
  // and dots, at least two components. Measured across the swept files, the
  // only forms present are `0.3`, `0.3.0` and `^0.3.0`.
  //
  // The two exclusions are the point. A bare major (`@setu-ts/common@^0`)
  // resolves against 0.3.0 and so would slip through a plain prefix test while
  // naming no release. And a prefix that reaches into a prerelease identifier
  // (`0.3.0-alpha` against `0.3.0-alpha.1`) is a DIFFERENT version, which
  // matters on any prerelease line — this project shipped ten of them.
  if (!/^\d+(?:\.\d+)+$/.test(reference)) return false;
  if (!current.startsWith(reference)) return false;
  return current[reference.length] === '.';
}

/**
 * Reports whether a line is exempt because it is deliberate history.
 *
 * @param lines - The file's lines
 * @param index - 0-based index of the line carrying the reference
 * @returns `true` when this line or the one above carries the marker
 */
function isExempt(lines: readonly string[], index: number): boolean {
  if (lines[index]?.includes(HISTORY_MARKER)) return true;
  return index > 0 && (lines[index - 1]?.includes(HISTORY_MARKER) ?? false);
}

/**
 * Finds every `@setu-ts/*` reference in one file that is not the shipping
 * version.
 *
 * @param file - Repository-relative path, used only in the findings
 * @param source - The file's full text
 * @param current - The version being shipped
 * @returns The stale references, and how many references were seen in total
 */
export function findStaleReferences(
  file: string,
  source: string,
  current: string,
): { readonly findings: readonly StaleReference[]; readonly seen: number } {
  const findings: StaleReference[] = [];
  const lines = source.split('\n');
  let seen = 0;

  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(REFERENCE)) {
      // Both groups are mandatory in REFERENCE, so a match always carries
      // them; there is no undefined arm to guard.
      const [, pkg, , version] = match;
      seen += 1;
      if (referenceMatches(version, current)) continue;
      if (isExempt(lines, index)) continue;
      findings.push({ file, line: index + 1, pkg, version });
    }
  }

  return { findings, seen };
}

/**
 * Reports whether a tracked path is this gate's business.
 *
 * Two inclusions, and everything else is somebody else's rule:
 *
 * - **A `.ts` file under a `src` tree.** This is the consequential case — a
 *   published package's own source, where a stale specifier becomes a stale
 *   dependency of the artifact.
 * - **Any `deno.lock`.** Both the root and each app's, since a lockfile
 *   records resolved member versions and nothing else checks them.
 *
 * **Test files are deliberately excluded, and that is not an oversight.** A
 * fixture's version is DATA, not a dependency: `plugin-detector.test.ts`
 * builds a synthetic scaffolded manifest whose version is arbitrary, and
 * `add.test.ts` hard-codes `@^1` precisely to prove `setu add` PRESERVES an
 * existing pin — a bump that rewrote it would destroy what the test asserts.
 * Sweeping tests reported 23 such fixtures across five files and not one real
 * staleness, so including them would train the reader to add exemptions rather
 * than to read findings.
 *
 * Markdown belongs to `check-docs.ts` and manifests to `verify-release.ts`;
 * taking either here would create a second classifier for one rule.
 *
 * @param path - A repository-relative tracked path
 * @returns `true` when the sweep should read the file
 */
export function isSweptPath(path: string): boolean {
  if (path.endsWith('deno.lock')) return true;
  if (!path.endsWith('.ts')) return false;
  return path.includes('/src/');
}

/** What {@linkcode trackedFiles} needs back from `git ls-files`. */
export interface ListOutput {
  readonly success: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** The injectable seam that runs `git ls-files`. */
export type ListRunner = () => Promise<ListOutput>;

/** Spawns the real `git ls-files`. The one external-I/O line in this module. */
const runGitLsFiles: ListRunner = () =>
  new Deno.Command('git', { args: ['ls-files'], stdout: 'piped', stderr: 'piped' }).output();

/**
 * Lists the repository's tracked files.
 *
 * `git ls-files` rather than a filesystem walk, because the distinction is
 * load-bearing: `apps/full-stack/deno.lock` is gitignored and legitimately
 * carries whatever version its last local build resolved, so a walk would
 * report it on every run.
 *
 * @param run - The lister to use; defaults to the real `git ls-files`
 * @returns Repository-relative tracked paths
 */
export async function trackedFiles(run: ListRunner = runGitLsFiles): Promise<readonly string[]> {
  const listed = await run();
  if (!listed.success) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(listed.stderr)}`);
  }
  return new TextDecoder().decode(listed.stdout).split('\n').filter(Boolean);
}

/**
 * Sweeps every tracked file this gate owns.
 *
 * @param current - The version being shipped
 * @param paths - Tracked paths to consider; defaults to the repository's
 * @returns The findings and both vacuity guards
 */
export async function sweepTrackedFiles(
  current: string,
  paths?: readonly string[],
): Promise<SweepResult> {
  const candidates = (paths ?? await trackedFiles()).filter(isSweptPath);
  const findings: StaleReference[] = [];
  let filesScanned = 0;
  let referencesSeen = 0;

  for (const path of candidates) {
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch (error) {
      // A path git lists but the working tree does not have is ordinary — a
      // deleted-but-staged file, or a `paths` argument naming one. Anything
      // else is not: an unreadable file is a file this gate did not inspect,
      // and since a healthy tree keeps the reference count in the thousands,
      // the vacuity guard would stay green while a stale reference sat in the
      // file that failed to open. This gate's whole failure mode is a silent
      // pass, so a read it cannot perform must be loud.
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    filesScanned += 1;
    const result = findStaleReferences(path, source, current);
    findings.push(...result.findings);
    referencesSeen += result.seen;
  }

  return { findings, filesScanned, referencesSeen };
}

/**
 * Turns a sweep result into the lines to print and a pass/fail verdict.
 *
 * Pure, and separate from {@linkcode main} so every reporting branch is
 * reachable from a unit test without a repository in a particular state — the
 * vacuity branch especially, which by definition cannot be produced by a
 * healthy tree.
 *
 * @param result - What the sweep found
 * @param current - The version being shipped
 * @returns The verdict and the lines to print, in order
 */
export function reportSweep(
  result: SweepResult,
  current: string,
): { readonly failed: boolean; readonly lines: readonly string[] } {
  const { findings, filesScanned, referencesSeen } = result;

  if (referencesSeen === 0) {
    return {
      failed: true,
      lines: [
        `version-sweep FAILED: scanned ${filesScanned} file(s) and found NO @setu-ts ` +
        'references at all. The sweep pattern is broken — a scope rename or a lockfile ' +
        'format change would look exactly like this, and so would a clean tree.',
      ],
    };
  }

  if (findings.length > 0) {
    return {
      failed: true,
      lines: [
        `version-sweep FAILED: ${findings.length} reference(s) name a version other than ${current}.`,
        ...findings.map((f) => `  ${f.file}:${f.line}  @setu-ts/${f.pkg}@${f.version}`),
        '\nThese sites are invisible to release:verify (which reads manifests) and to ' +
        'check:docs (which reads Markdown). A stale source specifier still RESOLVES, so ' +
        'it publishes green and makes the package depend on the previous release. ' +
        'Mark a deliberately historical reference with a `version:history` comment.',
      ],
    };
  }

  return {
    failed: false,
    lines: [
      `version-sweep passed: ${referencesSeen} @setu-ts reference(s) across ` +
      `${filesScanned} file(s), all naming ${current}.`,
    ],
  };
}

/**
 * Runs the sweep and reports.
 *
 * @param current - The version being shipped
 * @returns `true` when the gate fails
 */
export async function main(current: string): Promise<boolean> {
  const { failed, lines } = reportSweep(await sweepTrackedFiles(current), current);
  for (const line of lines) {
    if (failed) console.error(line);
    else console.log(line);
  }
  return failed;
}

/**
 * Reads the version the workspace is on.
 *
 * One manifest rather than all 47, for the reason `check-docs.ts` gives at the
 * same decision: `release:verify` already proves they agree, so reading more
 * would be a second answer to a settled question.
 *
 * @returns The `version` field of the kernel manifest
 */
export async function workspaceVersion(): Promise<string> {
  const manifest = JSON.parse(
    await Deno.readTextFile('packages/kernel/deno.json'),
  ) as { version?: string };
  if (manifest.version === undefined || manifest.version.length === 0) {
    throw new Error('packages/kernel/deno.json has no version field to sweep against.');
  }
  return manifest.version;
}

if (import.meta.main) {
  const version = Deno.args[0] ?? await workspaceVersion();
  Deno.exit(await main(version) ? 1 : 0);
}
