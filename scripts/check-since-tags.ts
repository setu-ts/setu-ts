// deno-lint-ignore-file no-console -- a gate must print actionable findings.
/**
 * The `@since` gate: every tag is checked against the version that SHIPPED the
 * symbol it sits on — at symbol level, fetched from the jsr.io registry.
 *
 * The class this closes is X50-2 and PR #286's cause, named there as
 * systematic: a release branch bumps each package manifest to the shipping
 * version, so an author filling in `@since` while reading the manifest names
 * the PREVIOUS release every time. A manual sweep (PR #286, 26 tags) held
 * until `packages/common/src/form/` landed after the branch was cut — six of
 * its tags named `0.5.0`, a release whose tarball does not contain the module
 * at all. A manual sweep has therefore demonstrably failed to hold, and this
 * gate is what replaces it.
 *
 * Symbol level, not file level. Resolving only whether the containing FILE
 * existed at the claimed version misses the commonest drift by construction:
 * a symbol added to a long-lived file (`packages/common/src/http.ts` has
 * accumulated members across a dozen releases) passes with any `@since` at
 * all. For each `@since X.Y.Z`, the gate fetches THAT file at THAT version
 * from the registry and fails when the resolved symbol is absent from it. A
 * file that does not exist at the version fails the same way, so the
 * missing-module case is the degenerate one.
 *
 * The registry is queried once per fetched artifact and cached for the run,
 * never once per tag. A version the registry has not published is SKIPPED
 * rather than failed in exactly two cases — it is newer than everything
 * published (the normal state on a release branch, which must never be
 * blocked), or some published version shares its release line (`@since
 * 0.1.0`, a line that shipped only as `0.1.0-alpha.*`). Any OTHER unpublished
 * version is reported: it names a release that was skipped over and can never
 * appear, which absence alone cannot distinguish. See
 * {@linkcode mayBeSkipped}.
 *
 * A network failure is NOT an exit 77 here. `check:docs` is an `&&` chain of
 * `deno run` invocations, so any non-zero status fails the task — 77
 * included — and a transient registry outage would fail the documentation
 * job and block release PRs. Instead every unreachable fetch is reported on
 * stderr and the run exits 0; and so that silence is never mistaken for a
 * pass, the number of tags VERIFIED is printed on stdout on every run —
 * zero when everything skipped.
 *
 * @module
 */

/** The JSR scope every published package ships under. */
const SCOPE = '@setu-ts';

/** The registry fetched when no override is injected. */
const DEFAULT_REGISTRY_BASE = 'https://jsr.io';

/**
 * A `@since` tag resolved from a source file, with the symbol it is attached
 * to.
 */
export interface SinceTag {
  /** The file carrying the tag, as the scanner addressed it. */
  readonly file: string;
  /** One-based line of the tag. */
  readonly line: number;
  /** The version the tag claims, e.g. `0.6.0` (prereleases included). */
  readonly version: string;
  /**
   * The next declaration's identifier after the tag's comment, or null when
   * no declaration follows — a tag on something other than a top-level
   * declaration, which cannot be verified mechanically.
   */
  readonly symbol: string | null;
}

/** A tag the gate could not verify, with the reason it was not failed. */
export interface SinceSkip {
  readonly file: string;
  readonly line: number;
  readonly version: string;
  readonly reason: string;
}

/** Why a tag failed. */
export type SinceFindingKind =
  | 'file-absent'
  | 'symbol-absent'
  | 'version-absent';

/** A tag whose claim the registry disproves. */
export interface SinceFinding {
  readonly file: string;
  readonly line: number;
  readonly version: string;
  readonly kind: SinceFindingKind;
  readonly message: string;
}

/** The outcome of one gate run. */
export interface SinceRunResult {
  readonly findings: readonly SinceFinding[];
  readonly skipped: readonly SinceSkip[];
  /** Tags whose claimed version provably contains the resolved symbol. */
  readonly verified: number;
}

/** The shape of `deno.json` this gate reads its scan roots from. */
export interface WorkspaceManifest {
  readonly workspace?: readonly string[];
}

/**
 * The minimal HTTP response surface the gate consumes — `fetch`'s `Response`
 * satisfies it, and so does a test double that never touches a socket.
 */
export interface FetchLike {
  (url: string): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly text: () => Promise<string>;
  }>;
}

/** Injection seams for {@linkcode run} — every default is the real thing. */
export interface SinceRunOptions {
  /** Registry root; defaults to `https://jsr.io`. */
  readonly registryBase?: string;
  /** The parsed root manifest; defaults to reading `deno.json`. */
  readonly manifest?: WorkspaceManifest;
  /** File reader; defaults to `Deno.readTextFile`. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Source-file lister per workspace member; defaults to a real walk. */
  readonly listSourceFiles?: (member: string) => Promise<readonly string[]>;
  /** Fetch; defaults to the global. Replaced in tests, never in CI. */
  readonly fetchImpl?: FetchLike;
}

/** Matches a semver tag: `0.6.0`, `0.1.0-alpha.10` — not the prose after it. */
const SINCE = /@since\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/g;

/**
 * The declaration forms a `@since` may sit on. A member (`readonly foo: T`)
 * deliberately does not match: a tag on a member cannot be resolved to a
 * symbol this way, and guessing the enclosing declaration would verify a
 * symbol the tag is not on.
 */
const DECLARATION =
  /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Walks source text with comment awareness, used when resolving the
 * declaration a tag's comment is attached to. The visitor advances one
 * character per call by returning nothing, seeks by returning an offset, or
 * ends the walk by returning `true`.
 */
function forwardWalk(
  source: string,
  start: number,
  startInsideBlock: boolean,
  visit: (offset: number, ch: string) => number | true | void,
): void {
  let i = start;
  let inBlock = startInsideBlock;
  while (i < source.length) {
    const ch = source[i]!;
    if (inBlock) {
      if (ch === '*' && source[i + 1] === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    const result = visit(i, ch);
    if (result === true) return;
    if (typeof result === 'number') {
      i = result;
      continue;
    }
    i++;
  }
}

/**
 * Whether `position` sits inside a `/* … *` block comment.
 *
 * Heuristic on purpose: the last comment opener before the position is
 * compared with the last closer. A line comment carrying a literal `/*` would
 * confuse it — and only cost a resolved symbol, which degrades to a reported
 * skip, never to a false finding.
 */
function insideBlockComment(source: string, position: number): boolean {
  const opener = source.lastIndexOf('/*', position - 1);
  const closer = source.lastIndexOf('*/', position - 1);
  return opener !== -1 && opener > closer;
}

/**
 * The identifier of the first declaration following `from`, walking over
 * whitespace, comments and decorator lines. Returns null when the next code
 * is not a top-level declaration — a member, a continuation line — because
 * the tag is then not attached to a symbol this gate can verify.
 *
 * @param source - The file's full text
 * @param from - Offset just after the `@since` version literal
 * @returns The declaration's identifier, or null when there is none
 */
export function resolveFollowingSymbol(source: string, from: number): string | null {
  let start = from;
  if (!insideBlockComment(source, from)) {
    // A tag inside a LINE comment: the walk resumes on the next line, since
    // the rest of this one is comment text the char-walk would otherwise read
    // as code (and stop at).
    const lineStart = source.lastIndexOf('\n', from) + 1;
    const lineComment = source.lastIndexOf('//', from - 1);
    if (lineComment >= lineStart && lineComment !== -1) {
      const nl = source.indexOf('\n', from);
      start = nl === -1 ? source.length : nl + 1;
    }
  }
  let resolved: string | null = null;
  forwardWalk(source, start, insideBlockComment(source, from), (offset, ch) => {
    if (/\s/.test(ch)) return;
    // A decorator between the comment and the declaration is skipped whole.
    if (ch === '@') {
      const nl = source.indexOf('\n', offset);
      return nl === -1 ? source.length : nl;
    }
    const match = DECLARATION.exec(source.slice(offset));
    if (match !== null) {
      resolved = match[1]!;
    }
    return true;
  });
  return resolved;
}

/**
 * Collects every `@since` tag in a source file with its resolved symbol.
 *
 * @param file - The file's path, as the scanner addressed it
 * @param source - The file's full text
 * @returns One entry per tag, in source order
 */
export function collectSinceTags(file: string, source: string): readonly SinceTag[] {
  const tags: SinceTag[] = [];
  for (const match of source.matchAll(SINCE)) {
    const offset = match.index ?? 0;
    const line = source.slice(0, offset).split('\n').length;
    tags.push({
      file,
      line,
      version: match[1]!,
      symbol: resolveFollowingSymbol(source, offset + match[0].length),
    });
  }
  return tags;
}

/**
 * Whether `symbol` occurs in `fetched` as a whole word.
 *
 * @param fetched - The file content at the claimed version
 * @param symbol - The resolved identifier the tag sits on
 * @returns True when the symbol is present
 */
export function symbolPresent(fetched: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(fetched);
}

/** Matches the release triple at the head of a semver string. */
const RELEASE_TRIPLE = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * The `[major, minor, patch]` of a version string; any prerelease identifier
 * and build metadata are ignored, because this only has to order release
 * LINES, never two prereleases of one line.
 *
 * A string that carries no triple at all returns `null` rather than a
 * zero-filled tuple. The registry's version list is remote input, so a value
 * that is not semver must not silently compare equal to `0.0.0` and make an
 * unrelated tag look like it shares that line.
 *
 * @param version - A version string, from a tag or from the registry
 * @returns Its release triple, or `null` when there is none
 */
function releaseTriple(version: string): readonly [number, number, number] | null {
  const match = RELEASE_TRIPLE.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a tag naming an unpublished version may be skipped rather than
 * reported. Two cases qualify, and they are different questions:
 *
 * 1. The version is NEWER than every version the registry holds — the normal
 *    state on a release branch, which must never be blocked.
 * 2. Some published version shares its release line. `@since 0.1.0` is the
 *    repo-wide spelling for "since the first release", and that line shipped
 *    only as `0.1.0-alpha.*`, so the exact string is absent while the release
 *    it names plainly exists.
 *
 * Absence from the published list is NOT by itself either question, and
 * conflating them left a permanent blind spot: a version that was never
 * released and never will be (`0.6.1`, on a line that went `0.6.0` -> `0.7.0`)
 * is absent forever, so it was skipped forever while the message claimed it
 * was "ahead of the registry". Four such tags were live on `main` and this
 * gate could not have reported any of them.
 *
 * @param version - The version the tag claims
 * @param published - Every version the registry holds for that package
 * @returns True when the tag must not be reported
 */
function mayBeSkipped(version: string, published: readonly string[]): boolean {
  const triple = releaseTriple(version);
  if (triple === null) return true;
  const [major, minor, patch] = triple;
  const lines = published.map(releaseTriple).filter((t) => t !== null);
  if (lines.some(([m, n, p]) => m === major && n === minor && p === patch)) return true;
  return lines.every(([m, n, p]) => {
    if (major !== m) return major > m;
    if (minor !== n) return minor > n;
    return patch > p;
  });
}

/**
 * The registry URL for one file at one version.
 *
 * @param registryBase - The registry root
 * @param packageName - Scoped package name, e.g. `@setu-ts/common`
 * @param version - The claimed version
 * @param modulePath - The file's path from the package root (`src/…`)
 * @returns The absolute URL
 */
export function registryFileUrl(
  registryBase: string,
  packageName: string,
  version: string,
  modulePath: string,
): string {
  return `${registryBase}/${packageName}/${version}/${modulePath}`;
}

/** Strips a member path's leading `./`, as root-manifest entries spell it. */
function normalizeMember(member: string): string {
  return member.replace(/^\.\//, '');
}

/** The scoped package name a workspace member publishes under. */
export function packageNameFor(member: string): string {
  return `${SCOPE}/${normalizeMember(member).split('/').pop()}`;
}

/** A member's file path relative to the package root, for the registry URL. */
function modulePathFor(member: string, file: string): string {
  const prefix = `${normalizeMember(member)}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

/**
 * The real source-file lister: walks `<member>/src` for `.ts` files.
 * A member without a `src/` directory has nothing to scan and is not an
 * error; any other listing failure propagates.
 *
 * @param member - The workspace member path
 * @returns `.ts` paths, sorted
 */
export async function defaultListSourceFiles(
  member: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory) await walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.ts')) found.push(`${dir}/${entry.name}`);
    }
  };
  await walk(`${normalizeMember(member)}/src`);
  return found.sort();
}

/**
 * Runs the gate over every workspace member in the root manifest.
 *
 * Scan roots come from the manifest's `workspace` list — the one place that
 * already names every package and cannot drift as packages are added, unlike
 * a glob over the `packages` top level, which silently misses the members
 * under `packages/starters/`.
 *
 * @param options - Injection seams; every default is the real implementation
 * @returns Findings, skips, and the number of tags verified
 */
export async function run(options: SinceRunOptions = {}): Promise<SinceRunResult> {
  const registryBase = options.registryBase ?? DEFAULT_REGISTRY_BASE;
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url));
  const readFile = options.readFile ?? ((path: string) => Deno.readTextFile(path));
  const listSourceFiles = options.listSourceFiles ?? defaultListSourceFiles;
  const manifest: WorkspaceManifest = options.manifest ??
    JSON.parse(await readFile('deno.json')) as WorkspaceManifest;
  const members = (manifest.workspace ?? []).map(normalizeMember);

  const findings: SinceFinding[] = [];
  const skipped: SinceSkip[] = [];
  let verified = 0;

  /** Per-package version list; undefined = not fetched, null = unreachable. */
  const metaCache = new Map<
    string,
    Promise<
      { readonly kind: 'ok'; readonly versions: readonly string[] } | {
        readonly kind: 'unreachable';
        readonly reason: string;
      } | { readonly kind: 'unpublished' }
    >
  >();

  const metaFor = (packageName: string) => {
    const cached = metaCache.get(packageName);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      try {
        const response = await fetchImpl(`${registryBase}/${packageName}/meta.json`);
        if (!response.ok) {
          // Only 404 means the package is absent. A 429 or a 5xx is the
          // registry declining to answer, and reading that as "unpublished"
          // skips validation under a reason that is not true. This gate makes
          // ~200 requests per run, so rate limiting is a realistic outcome.
          if (response.status === 404) return { kind: 'unpublished' as const };
          throw new Error(`HTTP ${response.status}`);
        }
        const parsed = JSON.parse(await response.text()) as {
          versions?: Record<string, unknown>;
        };
        return { kind: 'ok' as const, versions: Object.keys(parsed.versions ?? {}) };
      } catch (error) {
        return { kind: 'unreachable' as const, reason: String(error) };
      }
    })();
    metaCache.set(packageName, pending);
    return pending;
  };

  /** Per-URL file content; undefined = not fetched, null = absent. */
  const fileCache = new Map<string, Promise<string | null>>();
  const fileFor = (url: string) => {
    const cached = fileCache.get(url);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      try {
        const response = await fetchImpl(url);
        if (response.ok) return await response.text();
        // As above: only 404 is absence. Reading a 429 or a 5xx as an absent
        // file would raise a `file-absent` FINDING and exit 1, failing the
        // whole `check:docs` chain on a transient registry fault — the exact
        // outcome the outage contract in this module's JSDoc forbids.
        if (response.status === 404) return null;
        throw new Error(`HTTP ${response.status}`);
      } catch {
        return await Promise.reject(new Error(`fetch failed for ${url}`));
      }
    })();
    fileCache.set(url, pending);
    return pending;
  };

  const pushSkip = (tag: SinceTag, reason: string): void => {
    skipped.push({ file: tag.file, line: tag.line, version: tag.version, reason });
  };

  for (const member of members) {
    const packageName = packageNameFor(member);
    let files: readonly string[];
    try {
      files = await listSourceFiles(member);
    } catch (error) {
      skipped.push({
        file: member,
        line: 0,
        version: '-',
        reason: `could not list sources of ${member}: ${String(error)}`,
      });
      continue;
    }
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file);
      } catch (error) {
        skipped.push({
          file,
          line: 0,
          version: '-',
          reason: `could not read ${file}: ${String(error)}`,
        });
        continue;
      }
      for (const tag of collectSinceTags(file, source)) {
        if (tag.symbol === null) {
          pushSkip(
            tag,
            'no top-level declaration follows the tag; the symbol could not be resolved',
          );
          continue;
        }
        const meta = await metaFor(packageName);
        if (meta.kind === 'unreachable') {
          pushSkip(tag, `the registry could not be reached: ${meta.reason}`);
          continue;
        }
        if (meta.kind === 'unpublished') {
          pushSkip(tag, `${packageName} has no published versions to compare against`);
          continue;
        }
        if (!meta.versions.includes(tag.version)) {
          if (mayBeSkipped(tag.version, meta.versions)) {
            pushSkip(
              tag,
              `${tag.version} is not on the registry yet — a tag ahead of the registry is ` +
                `skipped, not failed, so a release branch cannot be blocked`,
            );
            continue;
          }
          findings.push({
            file: tag.file,
            line: tag.line,
            version: tag.version,
            kind: 'version-absent',
            message: `${packageName} has no ${tag.version} — the tag names a version that ` +
              `was never published, and is older than one that was, so it can never appear. ` +
              `Name the release that ships the symbol.`,
          });
          continue;
        }
        let content: string | null;
        try {
          content = await fileFor(
            registryFileUrl(registryBase, packageName, tag.version, modulePathFor(member, file)),
          );
        } catch (error) {
          pushSkip(tag, String(error));
          continue;
        }
        if (content === null) {
          findings.push({
            file: tag.file,
            line: tag.line,
            version: tag.version,
            kind: 'file-absent',
            message: `${packageName}@${tag.version} does not contain ` +
              `${modulePathFor(member, file)} — the tag names a release that does not ` +
              `ship the file the symbol lives in.`,
          });
          continue;
        }
        if (symbolPresent(content, tag.symbol)) {
          verified++;
          continue;
        }
        findings.push({
          file: tag.file,
          line: tag.line,
          version: tag.version,
          kind: 'symbol-absent',
          message: `${tag.symbol} is absent from ${packageName}@${tag.version}'s ` +
            `${modulePathFor(member, file)} — the tag names a release that does not ` +
            `ship the symbol it sits on.`,
        });
      }
    }
  }

  return { findings, skipped, verified };
}

if (import.meta.main) {
  const { findings, skipped, verified } = await run();
  for (const skip of skipped) {
    console.error(
      `  skipped ${skip.file}:${skip.line} (@since ${skip.version}) — ${skip.reason}`,
    );
  }
  if (findings.length > 0) {
    console.error(
      `@since check FAILED: ${findings.length} tag(s) name a version that does not ship ` +
        `what they claim.\n`,
    );
    for (const finding of findings) {
      console.error(
        `  ${finding.file}:${finding.line} (@since ${finding.version}) [${finding.kind}]\n` +
          `    ${finding.message}\n`,
      );
    }
    Deno.exit(1);
  }
  console.log(`@since check passed: verified ${verified} tag(s) against the registry.`);
}
