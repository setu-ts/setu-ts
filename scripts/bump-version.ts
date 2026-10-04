// deno-lint-ignore-file no-console -- a release tool prints what it changed.
/**
 * @module
 *
 * Moves the workspace from one version to the next: every site a release bump
 * has to touch, discovered by PACKAGE NAME where a reference names one and
 * enumerated — with the reason — where it does not.
 *
 * `docs/releasing.md` step 1 grew one bullet per release for six releases,
 * each recording a site a hand bump had missed: the three starters pinning the
 * whole plugin set (`v0.3.0`), the SDK's pinned import-map value (`v0.8.0`),
 * the 15 tracked `apps/*\/deno.lock` files (`v0.4.0`), the rendered Kubernetes
 * manifests (`v0.5.0`), `SDK_VERSION` (`v0.8.0`). Each bullet is a check a
 * human runs after the bump; this script is the bump, and it runs the residual
 * check itself. It was asked for on the `v0.3.0` release PR and deliberately
 * built at the START of a cycle, so a real release exercises it before any
 * release depends on it.
 *
 * **Discovery, not enumeration, wherever a reference carries the package
 * name.** Every `@setu-ts/<pkg>@<old>` token in every tracked text file moves —
 * manifests, import maps, the SDK's inline `jsr:` specifiers, the Dockerfiles'
 * quoted resolution errors, the guides' install snippets — and a lockfile's
 * `major.minor` shorthand moves with it. That is the rule `check:versions`
 * reads by, so the two cannot disagree about what a reference is.
 *
 * **Bare version numbers are never rewritten.** A line-oriented sweep of
 * `0.6.0` rewrote both ends of README's worked range `>=0.6.0 <0.7.0` into
 * `>=0.7.0 <0.7.0`, an empty range (`v0.7.0`); and `packages/cli/src`
 * legitimately stamps `version: '0.1.0'` into scaffolded projects. The bare
 * numbers that ARE this project's version live at named sites — a manifest's
 * `"version"`, `SDK_VERSION`, the chart's `appVersion`, the manifests' version
 * label, two headings — and each is rewritten by its own rule. Prose claims
 * ("the current release is 0.8.0") are left to `check:docs`, which reports
 * them; this tool names that run as a residual step rather than guessing at
 * prose.
 *
 * **Test fixtures stay too.** A test that pins `@^0.8.0` and checks it against
 * `'0.8.0'` is asserting a property of the gate, not naming the release, and
 * moving one side breaks it; nothing under a `test/` directory is swept, which
 * is also where `check:versions` draws its line.
 *
 * **A historical reference stays.** The `version:history` marker exempts a
 * line (or the line above it) in source, and a whole paragraph in Markdown —
 * the same two conventions `check:versions` and `check:docs` already read.
 *
 * The decidable half is {@linkcode planBump}: a pure function from the tree's
 * text to the edits. {@linkcode main} is the I/O seam that reads tracked
 * files, writes the plan, and re-sweeps the result with the same reader
 * `check:versions` uses, so a residual old reference fails the bump itself.
 */

import { findStaleReferences, isSweptPath } from './version-sweep.ts';

/** One file the bump rewrites. */
export interface PlannedEdit {
  readonly path: string;
  readonly content: string;
  /** How many replacements the file received. */
  readonly replacements: number;
}

/** Everything a bump decides before any file is written. */
export interface BumpPlan {
  readonly edits: readonly PlannedEdit[];
  /** Steps the tool cannot perform and the operator must — each names why. */
  readonly residual: readonly string[];
  /** Conditions that stop the bump before any write. */
  readonly refusals: readonly string[];
}

export interface BumpOptions {
  /** The version the tree is on. */
  readonly from: string;
  /** The version being cut. */
  readonly to: string;
  /** The release date written into the CHANGELOG heading, `YYYY-MM-DD`. */
  readonly date: string;
  /** Workspace member directories from the root `deno.json`, e.g. `./packages/common`. */
  readonly members: readonly string[];
}

/** A version per SemVer 2.0.0, with optional prerelease and build metadata. */
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The in-tree exemption marker, shared with `check:versions` and `check:docs`. */
const HISTORY_MARKER = 'version:history';

/** The sites rewritten by a rule of their own rather than by package name. */
const SDK_VERSION_FILE = 'packages/sdk/src/http/observed-fetch.ts';
const CHART_FILE = 'k8s/chart/Chart.yaml';
const MANIFEST_DIR = 'k8s/manifests/';
const CHANGELOG_FILE = 'CHANGELOG.md';
const UPGRADING_FILE = 'docs/upgrading.md';
const CHECK_DOCS_FILE = 'scripts/check-docs.ts';

/**
 * Files whose bare version numbers ARE claims about the current release — the
 * same three `VERSIONED_ARTIFACTS` that `check:docs` reads as claims: the
 * chart's `appVersion` and its note, and each Dockerfile's quoted resolution
 * error (`that matches '^0.8.0'`), which names a RANGE rather than a package.
 * Nowhere else is a bare number rewritten.
 */
const VERSIONED_ARTIFACTS: readonly string[] = [
  'k8s/chart/Chart.yaml',
  'docker/Dockerfile',
  'docker/Dockerfile.compiled',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `major.minor` of a version, the shorthand a lockfile writes for a caret range. */
export function minorLine(version: string): string {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`not a version: ${version}`);
  return `${match[1]}.${match[2]}`;
}

/**
 * Whether `to` is a later version than `from` (release, prerelease and build
 * identifiers compared per SemVer precedence, build metadata ignored).
 */
export function isLater(from: string, to: string): boolean {
  const a = SEMVER.exec(from);
  const b = SEMVER.exec(to);
  if (a === null || b === null) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(b[i]) !== Number(a[i])) return Number(b[i]) > Number(a[i]);
  }
  const preA = from.replace(/\+.*$/, '').split('-').slice(1).join('-');
  const preB = to.replace(/\+.*$/, '').split('-').slice(1).join('-');
  if (preA === preB) return false;
  if (preA === '') return false; // a release precedes nothing with the same core
  if (preB === '') return true; // a release follows its prereleases
  // SemVer §11.4: compare dot-separated identifiers left to right; numeric
  // ones numerically, numeric below alphanumeric, a shorter list lower.
  // A plain string compare ranks `rc.10` below `rc.2`.
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i += 1) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return Number(y) > Number(x);
    if (numericX !== numericY) return numericX;
    return y > x;
  }
  return false;
}

/**
 * Rewrites `@setu-ts/<pkg>@<from>` tokens (with an optional `^`/`~`) to `to`,
 * plus — in lockfiles only — the `major.minor` shorthand when the line
 * changes. Lines (or Markdown blocks) carrying the history marker are left.
 *
 * @returns The rewritten text and the number of tokens moved
 */
export function rewriteReferences(
  path: string,
  source: string,
  from: string,
  to: string,
): { content: string; replacements: number } {
  const full = new RegExp(
    String.raw`(@setu-ts/[a-z0-9-]+@[\^~]?)${escapeRegExp(from)}(?![\d.-])`,
    'g',
  );
  const fromLine = minorLine(from);
  const toLine = minorLine(to);
  const short = path.endsWith('deno.lock') && fromLine !== toLine
    ? new RegExp(String.raw`(@setu-ts/[a-z0-9-]+@)${escapeRegExp(fromLine)}(?![\d.-])`, 'g')
    : null;

  const exempt = exemptLines(path, source);
  const lines = source.split('\n');
  let replacements = 0;
  const out = lines.map((line, index) => {
    if (exempt.has(index)) return line;
    let next = line.replace(full, (_m, prefix: string) => {
      replacements += 1;
      return `${prefix}${to}`;
    });
    if (short !== null) {
      next = next.replace(short, (_m, prefix: string) => {
        replacements += 1;
        return `${prefix}${toLine}`;
      });
    }
    return next;
  });
  return { content: out.join('\n'), replacements };
}

/**
 * The 0-based lines a history marker exempts: the marker's own line and the
 * one below it in source; the marker's whole blank-line-delimited block in
 * Markdown, where `deno fmt` reflows prose and a marker pinned to a line would
 * drift off the reference it covers.
 */
function exemptLines(path: string, source: string): Set<number> {
  const lines = source.split('\n');
  const exempt = new Set<number>();
  if (path.endsWith('.md')) {
    let blockStart = 0;
    let marked = false;
    const flush = (end: number): void => {
      if (marked) { for (let i = blockStart; i < end; i += 1) exempt.add(i); }
    };
    for (const [index, line] of lines.entries()) {
      if (/^\s*>?\s*$/.test(line)) {
        flush(index);
        blockStart = index + 1;
        marked = false;
        continue;
      }
      if (line.includes(HISTORY_MARKER)) marked = true;
    }
    flush(lines.length);
    return exempt;
  }
  for (const [index, line] of lines.entries()) {
    if (line.includes(HISTORY_MARKER)) {
      exempt.add(index);
      exempt.add(index + 1);
    }
  }
  return exempt;
}

/**
 * Whether a path is a test tree, whose version-pinning fixtures the sweep must
 * leave alone.
 *
 * @param path - A repository-relative path
 * @returns `true` for anything under a `test/` directory
 */
export function isTestPath(path: string): boolean {
  return /(^|\/)test\//.test(path);
}

/** Replaces exactly one occurrence, reporting whether it was found. */
function replaceOnce(source: string, pattern: RegExp, replacement: string): string | null {
  if (!pattern.test(source)) return null;
  return source.replace(pattern, replacement);
}

/**
 * Plans every edit of a bump without touching the filesystem.
 *
 * @param files - Every tracked text file, by repository-relative path
 * @param options - The versions, the date and the workspace members
 * @returns The edits, the residual operator steps, and any refusal
 */
export function planBump(
  files: ReadonlyMap<string, string>,
  options: BumpOptions,
): BumpPlan {
  const { from, to, date, members } = options;
  const refusals: string[] = [];
  const residual: string[] = [];
  const edits = new Map<string, PlannedEdit>();

  if (!SEMVER.test(to)) refusals.push(`'${to}' is not a SemVer version.`);
  if (!SEMVER.test(from)) refusals.push(`the tree's version '${from}' is not a SemVer version.`);
  if (refusals.length > 0) return { edits: [], residual, refusals };
  if (!isLater(from, to)) refusals.push(`'${to}' is not later than the tree's version '${from}'.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refusals.push(`'${date}' is not a YYYY-MM-DD date.`);

  const stage = (path: string, content: string, replacements: number): void => {
    const existing = edits.get(path);
    edits.set(path, {
      path,
      content,
      replacements: (existing?.replacements ?? 0) + replacements,
    });
  };
  const current = (path: string): string | undefined => edits.get(path)?.content ?? files.get(path);

  // 1. Every workspace member's own `"version"`.
  for (const member of members) {
    const path = `${member.replace(/^\.\//, '')}/deno.json`;
    const source = current(path);
    if (source === undefined) {
      refusals.push(`workspace member ${path} is not a tracked file.`);
      continue;
    }
    const next = replaceOnce(
      source,
      new RegExp(String.raw`("version":\s*")${escapeRegExp(from)}(")`),
      `$1${to}$2`,
    );
    if (next === null) {
      refusals.push(
        `${path} does not carry "version": "${from}" — the tree is not all on ${from}.`,
      );
      continue;
    }
    stage(path, next, 1);
  }

  // 2. Every `@setu-ts/<pkg>@<from>` reference, by package name — outside test
  //    trees, whose fixtures pin a version ON PURPOSE (`test/docs-gate.test.ts`
  //    asserts that `@^0.8.0` is clean at 0.8.0; moving the fixture and not the
  //    version it is checked against would fail the test it belongs to).
  //    `check:versions` reads no test file either, so the two agree.
  for (const [path, source] of files) {
    if (isTestPath(path)) continue;
    const base = current(path) ?? source;
    const { content, replacements } = rewriteReferences(path, base, from, to);
    if (replacements > 0) stage(path, content, replacements);
  }

  // 3. Named sites whose version is a bare number.
  const named: { path: string; pattern: RegExp; replacement: string; why: string }[] = [
    {
      path: SDK_VERSION_FILE,
      pattern: new RegExp(String.raw`(SDK_VERSION = ')${escapeRegExp(from)}(')`),
      replacement: `$1${to}$2`,
      why: 'the browser-portable SDK cannot import its own manifest, so it reports a literal',
    },
  ];
  // The chart is one of the versioned artifacts below, but its `appVersion`
  // is what the rendered manifests are compared with, so its absence is a
  // refusal rather than a silently empty rewrite.
  const chart = files.get(CHART_FILE);
  if (chart === undefined) {
    refusals.push(`${CHART_FILE} is not a tracked file (the chart is the single authored source).`);
  } else if (!new RegExp(String.raw`appVersion:\s*'${escapeRegExp(from)}'`).test(chart)) {
    refusals.push(`${CHART_FILE} does not carry appVersion: '${from}'.`);
  }
  for (const artifact of VERSIONED_ARTIFACTS) {
    const source = current(artifact);
    if (source === undefined) continue;
    const bare = new RegExp(String.raw`(?<![\d.])${escapeRegExp(from)}(?![\d.-])`, 'g');
    let count = 0;
    const next = source.replace(bare, () => {
      count += 1;
      return to;
    });
    if (count > 0) stage(artifact, next, count);
  }
  for (const site of named) {
    const source = current(site.path);
    if (source === undefined) {
      refusals.push(`${site.path} is not a tracked file (${site.why}).`);
      continue;
    }
    const next = replaceOnce(source, site.pattern, site.replacement);
    if (next === null) {
      refusals.push(`${site.path} does not carry ${from} where expected (${site.why}).`);
      continue;
    }
    stage(site.path, next, 1);
  }
  for (const [path, source] of files) {
    if (!path.startsWith(MANIFEST_DIR)) continue;
    const label = new RegExp(
      String.raw`(app\.kubernetes\.io/version:\s*")${escapeRegExp(from)}(")`,
      'g',
    );
    let count = 0;
    const next = (current(path) ?? source).replace(label, (_m, a: string, b: string) => {
      count += 1;
      return `${a}${to}${b}`;
    });
    if (count > 0) stage(path, next, count);
  }

  // 4. The CHANGELOG: rename `[Unreleased]` to the version and leave a fresh one above.
  const changelog = current(CHANGELOG_FILE);
  if (changelog === undefined) {
    refusals.push(`${CHANGELOG_FILE} is not a tracked file.`);
  } else {
    const heading = /^## \[Unreleased\][^\n]*$/m;
    if (!heading.test(changelog)) {
      refusals.push(`${CHANGELOG_FILE} has no '## [Unreleased]' heading to rename.`);
    } else if (new RegExp(String.raw`^## \[${escapeRegExp(to)}\]`, 'm').test(changelog)) {
      refusals.push(`${CHANGELOG_FILE} already carries a '## [${to}]' section.`);
    } else {
      const sectionBody = changelog.split(heading)[1]?.split(/^## \[/m)[0] ?? '';
      if (sectionBody.trim() === '') {
        refusals.push(
          `${CHANGELOG_FILE}'s '## [Unreleased]' section is empty — a release with no notes is ` +
            'not a release (verify-release check 7 refuses it too).',
        );
      } else {
        stage(
          CHANGELOG_FILE,
          changelog.replace(heading, `## [Unreleased]\n\n## [${to}] — ${date}`),
          1,
        );
      }
    }
  }

  // 5. The upgrading guide: rename a non-empty `## Unreleased` to the version.
  const upgrading = current(UPGRADING_FILE);
  if (upgrading !== undefined) {
    const parts = upgrading.split(/^## Unreleased[^\n]*$/m);
    if (parts.length === 2) {
      const body = parts[1].split(/^## /m)[0];
      if (body.trim() === '') {
        residual.push(
          `${UPGRADING_FILE}'s '## Unreleased' section is empty. A release that demands reader ` +
            'action — a breaking change, a required interface member, a manifest edit — needs an ' +
            `entry under '## ${to}'; one that demands none needs nothing.`,
        );
      } else {
        stage(UPGRADING_FILE, upgrading.replace(/^## Unreleased([^\n]*)$/m, `## ${to}$1`), 1);
      }
    }
  }

  // 6. A new minor line must be named in check-docs' alternation, or both
  //    document version gates match nothing and pass over every stale claim.
  const checkDocs = current(CHECK_DOCS_FILE);
  const toLine = minorLine(to);
  if (checkDocs !== undefined && !to.includes('-')) {
    const arrayMatch =
      /export const POST_ALPHA_MINOR_LINES: readonly string\[\] = \[\n([\s\S]*?)\n\];/
        .exec(checkDocs);
    if (arrayMatch === null) {
      refusals.push(
        `${CHECK_DOCS_FILE}: POST_ALPHA_MINOR_LINES was not found in its expected shape.`,
      );
    } else if (!new RegExp(String.raw`'${escapeRegExp(toLine)}'`).test(arrayMatch[1])) {
      const widened = checkDocs.replace(
        arrayMatch[0],
        `${arrayMatch[0].slice(0, -3)}\n  '${toLine}',\n];`,
      );
      stage(CHECK_DOCS_FILE, widened, 1);
      residual.push(
        `${CHECK_DOCS_FILE}: POST_ALPHA_MINOR_LINES gained '${toLine}'. Add the matching ` +
          `stale-WITHIN-${toLine} cases to test/docs-gate.test.ts for BOTH checkers — a widening ` +
          'nothing asserts can be narrowed back without a test going red.',
      );
    }
  }

  residual.push(
    'Run `deno task check:docs`: prose claims naming the previous release ("the current release ' +
      'is …") are reported there and corrected by hand — this tool never rewrites a bare number.',
    "Run `deno task deploy:render` (needs helm) or `deno task check:deploy`: the manifests' " +
      'version label was rewritten to what the chart renders, and the render check confirms it.',
    'Run the first `deno task check` and commit the root `deno.lock` it leaves — its workspace ' +
      'member entries were rewritten here, and Deno re-resolves nothing when they already agree.',
    'Read the CHANGELOG section once as a whole: no entry filed under a published heading, no ' +
      'contradiction between entries (verify-release check 9 covers the merged-PR half).',
    `Grep for a range whose bounds became equal: grep -rn '>=${to} <${to}' --include='*.md' .`,
  );

  return { edits: [...edits.values()], residual, refusals };
}

/** The I/O `main` performs, injectable so the command path is testable. */
export interface MainDeps {
  readonly readTracked: () => Promise<Map<string, string>>;
  readonly isClean: () => Promise<boolean>;
  readonly write: (path: string, content: string) => Promise<void>;
  readonly today: () => string;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** The real filesystem, git and console. */
export const productionDeps: MainDeps = {
  readTracked: readTrackedText,
  isClean: workingTreeIsClean,
  write: Deno.writeTextFile,
  today: () => new Date().toISOString().slice(0, 10),
  log: console.log,
  error: console.error,
};

/** Files read as text: anything tracked whose bytes carry no NUL. */
export async function readTrackedText(): Promise<Map<string, string>> {
  const list = await new Deno.Command('git', { args: ['ls-files', '-z'], stdout: 'piped' })
    .output();
  const paths = new TextDecoder().decode(list.stdout).split('\0').filter((p) => p !== '');
  const files = new Map<string, string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch {
      continue; // a tracked path absent from the working tree (sparse checkout)
    }
    if (bytes.includes(0)) continue;
    try {
      files.set(path, decoder.decode(bytes));
    } catch {
      continue; // not UTF-8 text
    }
  }
  return files;
}

export async function workingTreeIsClean(): Promise<boolean> {
  const status = await new Deno.Command('git', { args: ['status', '--porcelain'], stdout: 'piped' })
    .output();
  return new TextDecoder().decode(status.stdout).trim() === '';
}

/**
 * Runs the bump against the working tree.
 *
 * @param args - `<version> [--dry-run] [--date YYYY-MM-DD] [--allow-dirty]`
 * @param deps - The I/O; defaults to the real filesystem, git and console
 * @returns `true` when the tree was moved (or, dry-run, could be) and the
 *   re-sweep found no residual reference
 */
export async function main(
  args: readonly string[],
  deps: MainDeps = productionDeps,
): Promise<boolean> {
  const to = args.find((arg) => !arg.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const allowDirty = args.includes('--allow-dirty');
  const dateIndex = args.indexOf('--date');
  const date = dateIndex === -1 ? deps.today() : args[dateIndex + 1] ?? '';
  if (to === undefined) {
    deps.error('usage: release:bump <version> [--dry-run] [--date YYYY-MM-DD] [--allow-dirty]');
    return false;
  }
  if (!dryRun && !allowDirty && !(await deps.isClean())) {
    deps.error(
      'release:bump: the working tree is dirty — commit or discard first, so the bump ' +
        'is one reviewable commit (or pass --allow-dirty).',
    );
    return false;
  }

  const files = await deps.readTracked();
  const root = JSON.parse(files.get('deno.json') ?? '{}') as {
    workspace?: readonly string[];
  };
  const members = root.workspace ?? [];
  const kernel = JSON.parse(files.get('packages/kernel/deno.json') ?? '{}') as { version?: string };
  const from = kernel.version ?? '';

  const plan = planBump(files, { from, to, date, members });
  if (plan.refusals.length > 0) {
    deps.error(`release:bump refused ${from} → ${to}:\n`);
    for (const refusal of plan.refusals) deps.error(`  ✗ ${refusal}`);
    return false;
  }

  let total = 0;
  for (const edit of plan.edits) {
    total += edit.replacements;
    deps.log(`${dryRun ? 'would rewrite' : 'rewrote'} ${edit.path} (${edit.replacements})`);
    if (!dryRun) await deps.write(edit.path, edit.content);
  }
  deps.log(`\n${plan.edits.length} file(s), ${total} replacement(s), ${from} → ${to}.`);

  // The same reader `check:versions` uses, over the planned contents: a
  // residual reference to `from` fails the bump rather than the next gate.
  let stale = 0;
  let seen = 0;
  for (const [path, source] of files) {
    if (!isSweptPath(path)) continue;
    const content = plan.edits.find((edit) => edit.path === path)?.content ?? source;
    const result = findStaleReferences(path, content, to);
    seen += result.seen;
    for (const finding of result.findings) {
      stale += 1;
      deps.error(
        `  ✗ residual ${finding.file}:${finding.line} @setu-ts/${finding.pkg}@${finding.version}`,
      );
    }
  }
  if (seen === 0) {
    deps.error(
      'release:bump: the re-sweep saw no @setu-ts references at all — the reader is broken.',
    );
    return false;
  }
  if (stale > 0) {
    deps.error(`\n${stale} residual reference(s) to a version other than ${to}.`);
    return false;
  }

  deps.log('\nResidual steps this tool does not perform:');
  for (const step of plan.residual) deps.log(`  • ${step}`);
  return true;
}

if (import.meta.main) {
  Deno.exit((await main(Deno.args)) ? 0 : 1);
}
