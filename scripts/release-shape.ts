/**
 * @module
 *
 * Decides whether a version number agrees with what the shipping changelog
 * section says it carries — `verify-release.ts` check 10.
 *
 * README's Versioning table has promised since `v0.2.0` that on `0.x` a PATCH
 * carries fixes and additions only and a MINOR carries the breaking changes.
 * Nothing enforced it, and every release after the label drop was a minor
 * carrying breaks. From `0.9.0` the policy is that a patch is the norm and
 * breaking changes are batched into an occasional minor (ROADMAP "Versioning
 * policy from 0.9.0"), which only holds if two mistakes are refused at cut
 * time rather than noticed afterwards:
 *
 * - a **patch** whose shipping section carries a `BREAKING` entry — the one
 *   that hurts a reader who trusted the table and took `0.9.1` unread;
 * - a **minor** whose shipping section carries NO breaking entry — a spent
 *   minor, which costs every caret pin a manual bump for nothing, unless the
 *   cutter says so explicitly with `--allow-quiet-minor`.
 *
 * The breaking marker is the one the changelog already uses: an entry whose
 * bold lead opens with `BREAKING` (`- **BREAKING: …**`). A prose mention of
 * the word inside another entry ("not breaking", "the breaking change M69
 * shipped") is not a marker, which is why the match is anchored to the lead.
 *
 * Pure: the caller supplies the previous tag, the version being verified and
 * the shipping section's text. Coverage-gated through `SCRIPT_TARGETS`.
 */

/** How `next` relates to `previous`. */
export type BumpKind = 'none' | 'patch' | 'minor' | 'major' | 'prerelease' | 'backwards';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Classifies the bump from `previous` to `next` (both bare versions, no `v`).
 *
 * @param previous - The last released version
 * @param next - The version being verified
 * @returns The kind; `backwards` when `next` is not later, `none` when equal
 * @throws {Error} When either string is not SemVer
 */
export function bumpKind(previous: string, next: string): BumpKind {
  const a = SEMVER.exec(previous);
  const b = SEMVER.exec(next);
  if (a === null) throw new Error(`previous version is not SemVer: ${previous}`);
  if (b === null) throw new Error(`next version is not SemVer: ${next}`);
  if (b[4] !== undefined) return 'prerelease';
  const [pa, pb] = [a, b].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  for (let i = 0; i < 3; i += 1) {
    if (pb[i] > pa[i]) return (['major', 'minor', 'patch'] as const)[i];
    if (pb[i] < pa[i]) return 'backwards';
  }
  // Equal core: a release following its own prerelease is a release of that
  // core, which is the smallest kind that moved.
  return a[4] !== undefined ? 'patch' : 'none';
}

/** An entry whose bold lead opens with `BREAKING`. */
const BREAKING_LEAD = /^- \*\*BREAKING\b/m;

/**
 * Counts the breaking entries in one changelog section.
 *
 * @param section - The section body (no heading)
 * @returns How many entry leads open with `BREAKING`
 */
export function countBreaking(section: string): number {
  return section.split('\n').filter((line) => BREAKING_LEAD.test(line)).length;
}

export interface ShapeInput {
  readonly bump: BumpKind;
  readonly breaking: number;
  /** The cutter has said this minor is deliberate although nothing breaks. */
  readonly allowQuietMinor: boolean;
  readonly version: string;
}

/**
 * The problems check 10 reports for one release shape, in verify-release's
 * problem-list prose.
 *
 * `none` (the tree is still on the released version — every `develop` CI run)
 * and `prerelease` are never a problem: nothing is being cut, or the label
 * already says "anything may change". `backwards` is reported here so the
 * cutter sees it beside the other version problems, though check 1 would fail
 * on it as well.
 */
export function shapeProblems(input: ShapeInput): readonly string[] {
  const { bump, breaking, allowQuietMinor, version } = input;
  switch (bump) {
    case 'none':
    case 'prerelease':
      return [];
    case 'backwards':
      return [`${version} is not later than the previous release tag.`];
    case 'patch':
      return breaking === 0 ? [] : [
        `${version} is a PATCH release but its changelog section carries ${breaking} BREAKING ` +
        `entr${breaking === 1 ? 'y' : 'ies'}. README's Versioning table promises a patch is ` +
        'safe to take unread — cut a minor instead, or defer the breaking entries to one.',
      ];
    case 'minor':
    case 'major':
      return breaking > 0 || allowQuietMinor ? [] : [
        `${version} is a ${bump.toUpperCase()} release but its changelog section carries no ` +
        'BREAKING entry — a spent minor costs every caret pin a manual bump for nothing. Cut a ' +
        'patch, or pass --allow-quiet-minor to say this is deliberate.',
      ];
  }
}
