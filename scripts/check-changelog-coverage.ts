/**
 * @module
 *
 * Fails when a symbol added to a published package's barrel since the last
 * release is named nowhere in the changelog's `Unreleased` section.
 *
 * Four releases in a row shipped, or nearly shipped, public surface that no
 * entry announced: `alpha.10` lost PR #195, `v0.4.0` lost #233
 * (`ResponseSnapshotInit` on `@setu-ts/common`), `v0.5.0` lost #248
 * (`respondWithAuthorizationFailure`, `AuthorizationFailure`), and `v0.7.0`
 * lost #327 — thirteen ingress decorators on `@setu-ts/decorator-plugin`.
 * Every one was caught by a HUMAN reading the merged PR list at cut time, and
 * `docs/releasing.md` records that as a manual step. This is that step.
 *
 * The comparison is the README `## Exports` table rather than the barrel
 * itself, and that is what makes the gate cheap: those tables are DERIVED from
 * the barrel by `deno task docs:exports` and already gated for drift, so the
 * committed table is the barrel's contents — checked — in a form two git
 * revisions can be diffed in without a TypeScript parser, a `deno doc` run per
 * package, or a network call. {@linkcode parseExportsTable} does the reading,
 * so this gate and the drift check cannot disagree about what an export is.
 *
 * It deliberately does NOT require an entry to name its PR. That was the
 * blocker recorded when this gate was first proposed — entries are prose and
 * carry no stable identifier — and naming the symbol is both cheaper for the
 * author and a better check: an entry that announces a new export without
 * saying what it is called is not much of an announcement.
 *
 * What it does not catch is a release-worthy change that adds no export: PR
 * #195 was dependency ranges, a workflow and a release artifact. Reading the
 * merged PR list stays in the runbook for that reason.
 */

import { parseExportsTable } from './package-exports.ts';

/** One export that reached a barrel with no changelog entry naming it. */
export interface UnannouncedExport {
  /** The package README the export was added to. */
  readonly readme: string;
  /** The exported identifier. */
  readonly symbol: string;
}

/** A README whose `## Exports` table could not be read at one revision. */
export interface CoverageSkip {
  readonly readme: string;
  readonly reason: string;
}

/** The outcome of one coverage run. */
export interface CoverageResult {
  readonly unannounced: readonly UnannouncedExport[];
  readonly skipped: readonly CoverageSkip[];
  /** READMEs whose tables were read at BOTH revisions and compared. */
  readonly compared: number;
}

/** Injectable I/O, so the comparison itself is tested without a repository. */
export interface CoverageOptions {
  /** Every published package README, repository-relative. */
  readonly readmes: readonly string[];
  /** The README at the base revision; `null` when the file did not exist. */
  readonly readAtBase: (path: string) => Promise<string | null>;
  /** The README in the working tree. */
  readonly readAtHead: (path: string) => Promise<string | null>;
  /** The changelog in the working tree. */
  readonly readChangelog: () => Promise<string>;
}

/**
 * The body of the changelog's `Unreleased` section.
 *
 * @param changelog - The whole `CHANGELOG.md`
 * @returns The section body, or `null` when there is no `Unreleased` heading
 */
export function unreleasedSection(changelog: string): string | null {
  const start = changelog.search(/^## \[Unreleased\]/m);
  if (start === -1) return null;
  const rest = changelog.slice(start);
  const next = rest.search(/\n## \[/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The identifiers a table claims, with the kind stripped.
 *
 * {@linkcode parseExportsTable} returns `name kind` pairs because the drift
 * check compares both; a rename of KIND alone is not new surface, so only the
 * name is compared here.
 *
 * @param readme - The README contents
 * @returns The claimed identifiers, or `null` when the table is absent
 */
export function exportedNames(readme: string): Set<string> | null {
  const claimed = parseExportsTable(readme);
  if (claimed === null) return null;
  return new Set([...claimed].map((entry) => entry.slice(0, entry.lastIndexOf(' '))));
}

/**
 * Whether a changelog section names an identifier IN A CODE SPAN.
 *
 * Prose does not count, and that is the point rather than strictness for its
 * own sake. A first cut matched anywhere in the section, and a test naming its
 * fixture symbol `Added` passed — satisfied by the section's own `### Added`
 * HEADING. Every Keep-a-Changelog heading is a plausible identifier
 * (`Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`), and
 * ordinary prose supplies many more, so matching the whole section admits a
 * false PASS: the export ships unannounced and the gate says it did not. This
 * changelog names symbols in backticks throughout, so requiring one costs an
 * author nothing and removes the whole class.
 *
 * The boundary inside the span is still needed: a span reading
 * `ViewPluginOptions` must not satisfy `ViewPlugin`, nor the reverse.
 *
 * @param section - The `Unreleased` body
 * @param symbol - The exported identifier
 * @returns True when a code span in the section names it
 */
export function mentions(section: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
  for (const span of section.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) {
    if (boundary.test(span[2] ?? '')) return true;
  }
  return false;
}

/**
 * Compares each package's exports between two revisions against the changelog.
 *
 * @param options - The READMEs to read and the readers to read them with
 * @returns Every added-but-unannounced export, plus what could not be compared
 */
export async function run(options: CoverageOptions): Promise<CoverageResult> {
  const changelog = await options.readChangelog();
  const section = unreleasedSection(changelog);
  const unannounced: UnannouncedExport[] = [];
  const skipped: CoverageSkip[] = [];
  let compared = 0;

  for (const readme of options.readmes) {
    const headSource = await options.readAtHead(readme);
    if (headSource === null) {
      skipped.push({ readme, reason: 'the README is absent from the working tree' });
      continue;
    }
    const head = exportedNames(headSource);
    if (head === null) {
      skipped.push({ readme, reason: 'no `## Exports` table in the working tree' });
      continue;
    }
    const baseSource = await options.readAtBase(readme);
    // A package that did not exist at the base revision is new, and every one
    // of its exports is new with it — which is exactly what the release notes
    // for a first publish must say.
    const base = baseSource === null ? new Set<string>() : exportedNames(baseSource);
    if (base === null) {
      skipped.push({ readme, reason: 'no `## Exports` table at the base revision' });
      continue;
    }
    compared += 1;
    for (const symbol of [...head].filter((name) => !base.has(name)).sort()) {
      if (section === null || !mentions(section, symbol)) {
        unannounced.push({ readme, symbol });
      }
    }
  }

  return { unannounced, skipped, compared };
}

/**
 * The version the changelog's newest PUBLISHED section names.
 *
 * Read from the changelog rather than from `git describe`, so the base is the
 * last RELEASE rather than whatever tag happens to be reachable — and so the
 * answer does not change under a shallow clone.
 *
 * @param changelog - The whole `CHANGELOG.md`
 * @returns The version, or `null` when no released section exists
 */
export function lastReleasedVersion(changelog: string): string | null {
  const match = /^## \[(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]/m.exec(changelog);
  return match?.[1] ?? null;
}

/**
 * Reads one path at a git revision.
 *
 * @param revision - The revision to read at
 * @param path - The repository-relative path
 * @returns The contents, or `null` when the path is absent there
 */
export async function readAtRevision(revision: string, path: string): Promise<string | null> {
  const shown = await new Deno.Command('git', {
    args: ['show', `${revision}:${path}`],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  return shown.success ? new TextDecoder().decode(shown.stdout) : null;
}

/** Whether a revision resolves at all, which a shallow clone's tags do not. */
export async function revisionExists(revision: string): Promise<boolean> {
  const shown = await new Deno.Command('git', {
    args: ['rev-parse', '--verify', `${revision}^{commit}`],
    stdout: 'null',
    stderr: 'null',
  }).output();
  return shown.success;
}

/** Every published package README, in a stable order. */
export async function publishedReadmes(): Promise<readonly string[]> {
  const listed = await new Deno.Command('git', {
    args: ['ls-files', 'packages/*/README.md', 'packages/*/*/README.md'],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  return new TextDecoder().decode(listed.stdout).split('\n').filter((line) => line !== '').sort();
}

/** The I/O `main` needs, injected so its branches are testable. */
export interface MainDeps {
  readonly readChangelog: () => Promise<string>;
  readonly revisionExists: (revision: string) => Promise<boolean>;
  readonly readAtRevision: (revision: string, path: string) => Promise<string | null>;
  readonly readWorkingTree: (path: string) => Promise<string | null>;
  readonly listReadmes: () => Promise<readonly string[]>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/**
 * Runs the gate and reports, returning the process exit code.
 *
 * @param deps - The injected I/O
 * @returns `0` when every added export is announced, `1` otherwise
 */
export async function main(deps: MainDeps): Promise<number> {
  const changelog = await deps.readChangelog();
  const version = lastReleasedVersion(changelog);
  if (version === null) {
    deps.error('changelog coverage FAILED: CHANGELOG.md names no released version.');
    return 1;
  }
  const tag = `v${version}`;
  // Fail CLOSED, and say what to do about it. `actions/checkout` is shallow by
  // default and fetches no tags, so an unresolvable base here would leave the
  // gate comparing nothing — the exact failure mode it exists to remove.
  if (!(await deps.revisionExists(tag))) {
    deps.error(
      `changelog coverage FAILED: ${tag} does not resolve, so there is nothing to compare ` +
        `against. A shallow checkout fetches no tags — use actions/checkout@v4 with ` +
        `fetch-depth: 0, or run git fetch --tags locally.`,
    );
    return 1;
  }

  const result = await run({
    readmes: await deps.listReadmes(),
    readAtBase: (path) => deps.readAtRevision(tag, path),
    readAtHead: deps.readWorkingTree,
    readChangelog: () => Promise.resolve(changelog),
  });

  for (const skip of result.skipped) {
    deps.log(`  skipped ${skip.readme} — ${skip.reason}`);
  }
  if (result.unannounced.length > 0) {
    deps.error(
      `\nchangelog coverage FAILED: ${result.unannounced.length} export(s) added since ${tag} ` +
        `that no Unreleased entry names.\n`,
    );
    for (const { readme, symbol } of result.unannounced) {
      deps.error(`  ${readme}`);
      deps.error(
        `    ${symbol} is on the published barrel and is named in no code span in the ` +
          `changelog's Unreleased section — a consumer gets it with no announcement.`,
      );
    }
    return 1;
  }
  deps.log(
    `changelog coverage passed: ${result.compared} package(s) compared against ${tag}, ` +
      `every added export announced.`,
  );
  return 0;
}

/**
 * The production wiring, as a value so it can be asserted.
 *
 * A deps factory is real code: reading the wrong file, or reading the changelog
 * at the base revision rather than the working tree, would leave every branch
 * above correct and the gate wrong.
 *
 * @returns The dependencies `main` runs with outside tests
 */
export function productionDeps(): MainDeps {
  return {
    readChangelog: () => Deno.readTextFile('CHANGELOG.md'),
    revisionExists,
    readAtRevision,
    readWorkingTree: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return null;
      }
    },
    listReadmes: publishedReadmes,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

if (import.meta.main) {
  Deno.exit(await main(productionDeps()));
}
