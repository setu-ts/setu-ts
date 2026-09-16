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
 * never once per tag. A version the registry has not seen — a tag ahead of
 * the registry, the normal state on a release branch — is SKIPPED rather
 * than failed, so the gate cannot block a release PR.
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
  | 'symbol-absent';

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
        if (!response.ok) return { kind: 'unpublished' as const };
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
        return response.ok ? await response.text() : null;
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
          pushSkip(
            tag,
            `${tag.version} is not on the registry yet — a tag ahead of the registry is ` +
              `skipped, not failed, so a release branch cannot be blocked`,
          );
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
