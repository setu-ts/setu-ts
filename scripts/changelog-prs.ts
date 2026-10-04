/**
 * @module
 *
 * Checks that every pull request merged since the previous release is
 * represented in the changelog section that will ship, and that none of them
 * was filed into a section that has already been published.
 *
 * This is `verify-release.ts` check 9, and it automates the three manual
 * checks `docs/releasing.md` has carried since they each saved a release:
 * every merged PR is represented (`alpha.10` shipped without PR #195's entry;
 * `v0.4.0` nearly shipped without #233's; `v0.5.0` without #248's), and
 * nothing is filed into an already-published section (`v0.3.0`'s M86 entries
 * were written into `[0.2.0]` after that tag, so the release notes would have
 * omitted them while `0.2.0`'s advertised features it does not contain). Each
 * was caught by a human reading the merged PR list at cut time; this is that
 * reading.
 *
 * **How a PR is matched to an entry.** Entries are prose and carry no PR
 * number, which is the blocker recorded when this gate was first proposed. The
 * stable identifier they DO carry is the milestone tag every entry's bold lead
 * ends with — `- **Service-call agreement (M101d).**` — and a milestone PR's
 * branch name carries the same id: `feat/m101d-call-sides-agree`. So a
 * `feat/m<id>-…` PR is represented when its `M<id>` appears anywhere in the
 * shipping section. Every other branch kind (`fix/`, `chore/`, `docs/`,
 * `claude/`, `release/`) needs an entry only when the merge changed a
 * published package's `src/` tree — the rule CLAUDE.md states for a
 * `packages/*\/src` change that alters released behaviour — and is then
 * represented by its PR number, `#<n>`, which the entry must name. A PR that
 * touched no `src/` is exempt: a documentation, CI or plan change carries no
 * release note.
 *
 * **Misfiling** is checked for milestone PRs only, because that is the shape
 * that has actually happened and the only one with an identifier that can be
 * located: an entry LEAD carrying `(M<id>…)` in a section below the shipping
 * one, for a milestone whose PR merged after the previous tag. A prose
 * mention of a later milestone inside an older entry ("corrected in M90h") is
 * not an entry lead and is not reported.
 *
 * The shipping section is `[Unreleased]` when it is non-empty — on `develop`,
 * and on a release branch before the rename — and the version's own section
 * otherwise, which is what a release branch looks like after the bump script
 * has renamed the heading and left a fresh empty `[Unreleased]` above it.
 *
 * The decidable half is {@linkcode checkChangelogPrs}, pure over the changelog
 * text and a list of merged PRs; {@linkcode mergedPullRequests} is the git
 * seam. The pure core carries the 90% bar via `SCRIPT_TARGETS`.
 */

/** One pull request merged since the previous release tag. */
export interface MergedPullRequest {
  /** The PR number from the merge commit subject. */
  readonly number: number;
  /** The head branch, as the merge subject names it (`feat/m103-…`). */
  readonly branch: string;
  /** Every path the merge changed, relative to the repository root. */
  readonly changedPaths: readonly string[];
}

/** Why one merged PR fails the check. */
export interface ChangelogPrFinding {
  readonly pr: MergedPullRequest;
  /** The identifier the shipping section was expected to carry. */
  readonly expectedToken: string;
  readonly kind: 'missing' | 'misfiled';
  /** For `misfiled`: the published section heading the entry was found under. */
  readonly foundIn?: string;
}

/** What one run decided, plus the guards that keep a clean pass meaningful. */
export interface ChangelogPrResult {
  readonly findings: readonly ChangelogPrFinding[];
  /** The heading of the section treated as shipping. */
  readonly shippingSection: string;
  /** PRs that needed an entry and have one. */
  readonly represented: number;
  /** PRs that needed no entry (no milestone id, no `src/` change). */
  readonly exempt: number;
}

/** Matches a GitHub merge-commit subject. */
const MERGE_SUBJECT = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;

/** A milestone feature branch: `feat/m103-…`, `feat/m101d-…`, `feat/M70h-…`. */
const MILESTONE_BRANCH = /^feat\/m(\d+[a-z]?)(?:-|$)/i;

/** A path whose change alters what a published package ships. */
const PUBLISHED_SOURCE = /^packages\/(?:starters\/)?[^/]+\/src\//;

/** The milestone tag in an entry's bold lead: `- **… (M101d).**` / `(M101b, V8-2)`. */
const ENTRY_LEAD_TAG = /^- \*\*[^\n]*?\((M\d+[a-z]?)(?=[,) ])/gm;

/**
 * Parses one merge-commit subject into its PR number and branch, or `null`
 * for a merge that is not a pull request (`Merge remote-tracking branch …`).
 *
 * @param subject - The commit subject line
 * @returns The number and branch, or `null`
 */
export function parseMergeSubject(subject: string): { number: number; branch: string } | null {
  const match = MERGE_SUBJECT.exec(subject);
  if (match === null) return null;
  return { number: Number(match[1]), branch: match[2] };
}

/** One `## [version]` section of the changelog. */
interface Section {
  readonly heading: string;
  readonly version: string;
  readonly body: string;
}

/**
 * Splits a changelog into its `## [version]` sections, in file order.
 *
 * @param changelog - `CHANGELOG.md` contents
 * @returns The sections; the first is the topmost heading
 */
export function splitSections(changelog: string): readonly Section[] {
  const sections: Section[] = [];
  const lines = changelog.split('\n');
  let current: { heading: string; version: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = /^## \[([^\]]+)\]/.exec(line);
    if (match !== null) {
      if (current !== null) {
        sections.push({ ...current, body: current.body.join('\n') });
      }
      current = { heading: line, version: match[1], body: [] };
      continue;
    }
    current?.body.push(line);
  }
  if (current !== null) sections.push({ ...current, body: current.body.join('\n') });
  return sections;
}

/**
 * The identifier the shipping section must carry for a PR, or `null` when the
 * PR needs no entry.
 *
 * @param pr - The merged pull request
 * @returns `M<id>` for a milestone branch, `#<n>` for any other branch that
 *   changed a published `src/` tree, `null` otherwise
 */
export function requiredToken(pr: MergedPullRequest): string | null {
  const milestone = MILESTONE_BRANCH.exec(pr.branch);
  if (milestone !== null) return `M${milestone[1]}`;
  return pr.changedPaths.some((path) => PUBLISHED_SOURCE.test(path)) ? `#${pr.number}` : null;
}

/** Whether `token` appears in `text` as a whole identifier. */
function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A milestone id must not continue into a letter (`M101` vs `M101d`); a PR
  // number must not continue into a digit (`#40` vs `#405`).
  return new RegExp(`${escaped}(?![0-9a-z])`, 'i').test(text);
}

/**
 * Checks merged PRs against the changelog.
 *
 * @param changelog - `CHANGELOG.md` contents
 * @param version - The version being verified; names the shipping section
 *   when `[Unreleased]` is empty
 * @param merged - Every PR merged since the previous release tag
 * @returns Findings plus the counts that show the check ran over something
 * @throws {Error} When the changelog has neither a non-empty `[Unreleased]`
 *   section nor a `[version]` section — there is nothing to check against
 */
export function checkChangelogPrs(
  changelog: string,
  version: string,
  merged: readonly MergedPullRequest[],
): ChangelogPrResult {
  const sections = splitSections(changelog);
  const unreleased = sections.find((section) => section.version === 'Unreleased');
  const shipping = unreleased !== undefined && unreleased.body.trim() !== ''
    ? unreleased
    : sections.find((section) => section.version === version);
  if (shipping === undefined) {
    throw new Error(
      `CHANGELOG.md has neither a non-empty '## [Unreleased]' section nor a '## [${version}]' ` +
        'section to check merged pull requests against.',
    );
  }
  const published = sections.filter((section) =>
    section !== shipping && section.version !== 'Unreleased'
  );

  const findings: ChangelogPrFinding[] = [];
  let represented = 0;
  let exempt = 0;
  for (const pr of merged) {
    const token = requiredToken(pr);
    if (token === null) {
      exempt += 1;
      continue;
    }
    if (mentions(shipping.body, token)) {
      represented += 1;
    } else {
      findings.push({ pr, expectedToken: token, kind: 'missing' });
    }
    if (!token.startsWith('M')) continue;
    for (const section of published) {
      const leads = [...section.body.matchAll(ENTRY_LEAD_TAG)].map((match) => match[1]);
      if (leads.some((lead) => lead.toLowerCase() === token.toLowerCase())) {
        findings.push({ pr, expectedToken: token, kind: 'misfiled', foundIn: section.heading });
      }
    }
  }
  return { findings, shippingSection: shipping.heading, represented, exempt };
}

/** The subprocess runner the git seam uses; injectable so the seam is testable. */
export type GitRunner = (args: readonly string[]) => Promise<string>;

/**
 * Runs git and returns its stdout.
 *
 * @param args - Arguments after `git`
 * @returns stdout
 * @throws {Error} With git's stderr when the command fails
 */
export async function runGit(args: readonly string[]): Promise<string> {
  const output = await new Deno.Command('git', {
    args: [...args],
    stdout: 'piped',
    stderr: 'piped',
  })
    .output();
  if (!output.success) {
    throw new Error(
      `git ${args.join(' ')} failed: ${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

/**
 * Lists every pull request merged after the most recent reachable `v*` tag.
 *
 * @param git - The git runner; defaults to a real subprocess
 * @returns The previous tag and the PRs merged since it
 * @throws {Error} When no tag is reachable — a shallow clone — because a check
 *   that then found nothing to compare would pass while checking nothing
 */
export async function mergedPullRequests(
  git: GitRunner = runGit,
): Promise<{ previousTag: string; merged: readonly MergedPullRequest[] }> {
  let previousTag: string;
  try {
    // On a tag-triggered release run the release's own tag sits on HEAD, and
    // describing HEAD would pick it — an empty range, so the check would pass
    // while checking nothing. Describe from the parent in that case only.
    const tagsAtHead = (await git(['tag', '--points-at', 'HEAD', '--list', 'v*']))
      .split('\n')
      .filter((tag) => tag.trim() !== '');
    const describeFrom = tagsAtHead.length === 0 ? 'HEAD' : 'HEAD^';
    previousTag = (await git(['describe', '--tags', '--abbrev=0', '--match', 'v*', describeFrom]))
      .trim();
  } catch (error: unknown) {
    throw new Error(
      'No release tag is reachable from HEAD, so merged pull requests cannot be listed. ' +
        'In CI this means a shallow checkout: set `fetch-depth: 0` on the job. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const log = await git(['log', '--merges', '--format=%H%x1f%s', `${previousTag}..HEAD`]);
  const merged: MergedPullRequest[] = [];
  for (const line of log.split('\n')) {
    if (line.trim() === '') continue;
    const [hash, subject] = line.split('\x1f');
    const parsed = parseMergeSubject(subject ?? '');
    if (parsed === null) continue;
    const paths = await git(['diff', '--name-only', `${hash}^1`, hash]);
    merged.push({
      ...parsed,
      changedPaths: paths.split('\n').filter((path) => path !== ''),
    });
  }
  return { previousTag, merged };
}

/**
 * Formats findings for the verify-release problem list.
 *
 * @param result - A check result
 * @returns One line per finding
 */
export function describeFindings(result: ChangelogPrResult): readonly string[] {
  return result.findings.map((finding) => {
    const pr = `PR #${finding.pr.number} (${finding.pr.branch})`;
    if (finding.kind === 'missing') {
      return `${pr} merged since the previous tag but ${result.shippingSection} names no entry ` +
        `carrying \`${finding.expectedToken}\` — add one, or name the PR as \`${finding.expectedToken}\`` +
        ` in the entry that already covers it.`;
    }
    return `${pr} has an entry filed under \`${finding.foundIn}\`, which was published before this ` +
      `PR merged — move it into ${result.shippingSection}.`;
  });
}
