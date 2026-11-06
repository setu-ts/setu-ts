/**
 * @module
 *
 * The CHANGELOG's link definitions, checked and edited as text.
 *
 * A released `## [x]` heading is inert unless it has a matching `[x]: …`
 * definition — GitHub renders the heading, and the link, only when both exist.
 * The `[unreleased]` definition must compare from the newest release, or the
 * compare view a reader lands on starts at the wrong tag. Both were hand edits
 * until X93-4: `[0.11.0]` shipped without its definition (M131d §3.6) and
 * `[unreleased]` still compared from `v0.10.0`.
 *
 * {@linkcode changelogLinkProblems} is the read-only gate
 * `scripts/verify-release.ts` calls; {@linkcode recordReleaseDefinition} is
 * the edit `scripts/bump-version.ts` applies in its CHANGELOG step, so the
 * next cut cannot repeat either miss.
 */

/** A `## [label]` heading found in the changelog, in file order. */
export interface ChangelogHeading {
  /** The label without its brackets, for example `Unreleased` or `0.11.0`. */
  readonly label: string;
  /** 0-based line index. */
  readonly line: number;
}

/** A `[label]: url` definition found in the changelog. */
export interface ChangelogDefinition {
  /** The label without its brackets. */
  readonly label: string;
  readonly url: string;
  /** 0-based line index. */
  readonly line: number;
}

/** The lines of a fenced block are literals, not headings or definitions. */
function unfencedLines(changelog: string): { line: string; fenced: boolean }[] {
  let fenced = false;
  return changelog.split('\n').map((line) => {
    const isFence = /^\s*(```|~~~)/.test(line);
    const inside = fenced || isFence;
    if (isFence) fenced = !fenced;
    return { line, fenced: inside };
  });
}

/**
 * Every `## [label]` heading outside a fenced code block, in file order.
 *
 * @param changelog - The CHANGELOG's full text
 * @returns The headings, unresolved
 */
export function changelogHeadings(changelog: string): ChangelogHeading[] {
  const headings: ChangelogHeading[] = [];
  for (const [line, entry] of unfencedLines(changelog).entries()) {
    if (entry.fenced) continue;
    const match = /^## \[([^\]]+)\]/.exec(entry.line);
    if (match !== null) headings.push({ label: match[1], line });
  }
  return headings;
}

/**
 * Every `[label]: url` definition outside a fenced code block, in file order.
 * Accepts CommonMark's forms: up to three leading spaces, an `<url>`, and a
 * trailing title.
 *
 * @param changelog - The CHANGELOG's full text
 * @returns The definitions, unresolved
 */
export function changelogDefinitions(changelog: string): ChangelogDefinition[] {
  const definitions: ChangelogDefinition[] = [];
  for (const [line, entry] of unfencedLines(changelog).entries()) {
    if (entry.fenced) continue;
    const match = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/.exec(entry.line);
    if (match !== null) definitions.push({ label: match[1], url: match[2], line });
  }
  return definitions;
}

/** The version a `…/compare/v<version>...HEAD` URL compares from, or `null`. */
function compareBase(url: string): string | null {
  const match = /\/compare\/v([^/]+?)\.\.\.HEAD$/.exec(url);
  return match === null ? null : match[1];
}

/**
 * Problems in the CHANGELOG's link definitions, one line each.
 *
 * Two rules, both read from the file alone — no git tag is consulted, because
 * `release:verify` runs after the bump and before the tag exists:
 *
 * 1. Every `## [label]` heading has a `[label]: …` definition. Labels match
 *    case-insensitively, so `[Unreleased]` is satisfied by `[unreleased]:`.
 * 2. `[unreleased]` compares from the newest released heading below it, the
 *    first `## [x]` after `## [Unreleased]`.
 *
 * @param changelog - The CHANGELOG's full text
 * @returns Every problem found; empty means the definitions agree
 */
export function changelogLinkProblems(changelog: string): string[] {
  const problems: string[] = [];
  const headings = changelogHeadings(changelog);
  const definitions = changelogDefinitions(changelog);
  const defined = new Set(definitions.map((definition) => definition.label.toLowerCase()));

  for (const heading of headings) {
    if (!defined.has(heading.label.toLowerCase())) {
      problems.push(
        `CHANGELOG.md: '## [${heading.label}]' has no link definition — add ` +
          `'[${heading.label}]: …' so the heading renders as a link.`,
      );
    }
  }

  const unreleasedHeading = headings.findIndex(
    (heading) => heading.label.toLowerCase() === 'unreleased',
  );
  const unreleasedDefinition = definitions.find(
    (definition) => definition.label.toLowerCase() === 'unreleased',
  );
  if (unreleasedHeading === -1 || unreleasedDefinition === undefined) return problems;

  const newest = headings[unreleasedHeading + 1];
  if (newest === undefined) return problems;
  const base = compareBase(unreleasedDefinition.url);
  if (base === null) {
    problems.push(
      `CHANGELOG.md: '[unreleased]' does not compare from a release — expected ` +
        `'…/compare/v${newest.label}...HEAD'.`,
    );
  } else if (base !== newest.label) {
    problems.push(
      `CHANGELOG.md: '[unreleased]' compares from v${base}, but the newest release heading is ` +
        `'## [${newest.label}]' — expected '…/compare/v${newest.label}...HEAD'.`,
    );
  }
  return problems;
}

/** The definition line the bump inserts for a release. */
function releaseDefinition(version: string): string {
  return `[${version}]: https://github.com/setu-ts/setu-ts/releases/tag/v${version}`;
}

/** The `[unreleased]` definition comparing from a release. */
function unreleasedDefinition(version: string): string {
  return `[unreleased]: https://github.com/setu-ts/setu-ts/compare/v${version}...HEAD`;
}

/** The index just after the last non-blank line, so a trailing newline survives. */
function endOfContent(lines: readonly string[]): number {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  return end;
}

/** The result of recording one release's definition. */
export interface RecordedRelease {
  readonly content: string;
  /** Whether anything changed — `false` when the file already agreed. */
  readonly changed: boolean;
}

/**
 * Records a release in the link definitions: inserts `[<version>]: …` above
 * the previous release's definition (never duplicating one that exists) and
 * rebases `[unreleased]` to compare from `v<version>...HEAD`.
 *
 * The definition is inserted above the release the old compare base named, so
 * the block stays newest-first. A tree that has none — a hand-edited file —
 * gets the new definition directly above the first definition after
 * `[unreleased]`, or after `[unreleased]` itself when it is the only one. A
 * file with no `[unreleased]` definition gains one, and a file with no
 * definitions at all gets both lines before its trailing blank lines.
 *
 * @param changelog - The CHANGELOG's full text
 * @param version - The version being cut, without a leading `v`
 * @returns The edited text and whether it differs
 */
export function recordReleaseDefinition(changelog: string, version: string): RecordedRelease {
  const lines = changelog.split('\n');
  const definitions = changelogDefinitions(changelog);
  const byLabel = new Map(
    definitions.map((definition) => [definition.label.toLowerCase(), definition]),
  );
  const unreleased = byLabel.get('unreleased');
  const oldBase = unreleased === undefined ? null : compareBase(unreleased.url);

  let changed = false;

  if (unreleased !== undefined && oldBase !== null && oldBase !== version) {
    lines[unreleased.line] = lines[unreleased.line].replace(
      /\/compare\/v[^/]+?\.\.\.HEAD/,
      `/compare/v${version}...HEAD`,
    );
    changed = true;
  }

  if (!byLabel.has(version.toLowerCase())) {
    let anchor: number;
    const previous = oldBase === null ? undefined : byLabel.get(oldBase.toLowerCase());
    if (previous !== undefined) {
      anchor = previous.line;
    } else {
      const after = definitions.find((definition) => definition.line > (unreleased?.line ?? -1));
      anchor =
        after?.line ?? (unreleased === undefined ? endOfContent(lines) : unreleased.line + 1);
    }
    lines.splice(anchor, 0, releaseDefinition(version));
    if (unreleased === undefined) lines.splice(anchor, 0, unreleasedDefinition(version));
    changed = true;
  } else if (unreleased === undefined) {
    lines.splice(byLabel.get(version.toLowerCase())!.line, 0, unreleasedDefinition(version));
    changed = true;
  }

  return { content: lines.join('\n'), changed };
}
