// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Markdown documentation linter — catches the class of defect that renders a
 * committed doc wrong while every other gate stays green.
 *
 * The motivating defect: `PUBLIC_API.md` opened a code block in one section and
 * never closed it. That was papered over by making the opener a FOUR-backtick
 * fence and adding a matching four-backtick line as the file's last line, which
 * a three-backtick line cannot close. The result was one code block spanning
 * ~5,300 lines — two-thirds of the document rendered as source, 121 of 228
 * headings stopped being headings, and 27 of 44 table-of-contents links pointed
 * at anchors that no longer existed.
 *
 * Nothing could see it. A four-backtick fence is valid CommonMark, so
 * `deno fmt` accepted it; no test parses the file; and the loss is visible only
 * once the page is rendered. Three checks close that gap:
 *
 *   - **Unclosed fence** — the direct form of the root cause.
 *   - **Swallowed headings** — the form the real defect took. That fence was
 *     technically BALANCED, because the stray four-backtick line closed it, so
 *     an unclosed-fence check alone would have passed the file and caught the
 *     defect only through its link symptoms. A code block whose language does
 *     not treat `#` as a comment has no business containing `##` heading lines;
 *     when it does, it has swallowed the document.
 *   - **Unresolved anchor link** — the symptom, and independently worth
 *     catching: a heading renamed without updating its links is the ordinary
 *     way a contents list rots.
 *   - **Section missing from the contents** — a file carrying a
 *     "Table of Contents" must link every one of its own `##` sections.
 *     `PUBLIC_API.md` had sixteen with no entry at all, mostly plugins whose
 *     milestone added the section and forgot the row.
 *
 * Fence tracking follows CommonMark rather than toggling on every ``` line: a
 * fence is closed only by a line of the SAME character, at least as long as the
 * opener, carrying no info string. A naive toggler mis-parses nested fences and
 * would have reported this file's own examples wrong — a checker that lies is
 * worse than no checker.
 *
 * Known limitation: indented (4-space) code blocks are not tracked, only fenced
 * ones. Distinguishing an indented code block from list continuation needs a
 * full block parser, and every code sample in this repo's docs is fenced.
 *
 * Usage:
 *   deno run --allow-read scripts/check-docs.ts              # the default set
 *   deno run --allow-read scripts/check-docs.ts a.md b.md    # specific files
 *
 * Exits 1 on any finding.
 */

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** Directories whose markdown is not part of the maintained documentation. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'build', '.wrangler', 'dist']);

/** Roots scanned when no explicit file list is given. */
const SCAN_ROOTS: readonly string[] = ['.', 'docs', 'packages', 'apps'];

/**
 * Fence info strings whose language does NOT treat `#` as a line comment, so a
 * `##`-prefixed line inside one is a swallowed markdown heading rather than a
 * legitimate comment. Shell, YAML, TOML, and Python are deliberately absent —
 * `# comment` is ordinary there — as is `markdown`, where a heading is the
 * point.
 */
const HASH_IS_NOT_COMMENT = new Set([
  'typescript',
  'ts',
  'tsx',
  'javascript',
  'js',
  'jsx',
  'json',
  'jsonc',
  'java',
  'c',
  'cpp',
  'go',
  'rust',
  'css',
  'html',
  'proto',
]);

/** Heading lines inside one code block before it is reported as a swallow. */
const SWALLOW_THRESHOLD = 2;

/**
 * A heading parsed out of a document, with the anchor a renderer derives from
 * it.
 */
interface Heading {
  readonly line: number;
  readonly text: string;
  readonly level: number;
  readonly anchor: string;
}

/**
 * Derives the anchor a markdown renderer assigns to a heading: lowercased,
 * punctuation dropped except hyphens and underscores, spaces to hyphens.
 *
 * @param text - The heading text, without its leading `#` characters
 * @returns The anchor, without a leading `#`
 */
export function anchorFor(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9 \-_]/g, '')
    .replace(/ /g, '-');
}

/** One fenced code block: its opening line, declared language, and body range. */
export interface FenceBlock {
  /** 1-based line of the opening delimiter. */
  readonly line: number;
  /** Lowercased first word of the info string (`''` when none). */
  readonly info: string;
  /** 0-based index of the first body line. */
  readonly bodyStart: number;
  /** 0-based index one past the last body line. */
  readonly bodyEnd: number;
}

/**
 * Splits a document into lines and marks which of them sit inside a fenced code
 * block, following CommonMark: an opening fence is three or more backticks or
 * tildes, and only a line of the same character at least as long, with no info
 * string, closes it.
 *
 * Tracking fence LENGTH is what makes this faithful. A toggle-on-every-backtick
 * scanner treats a ```` fence as closed by the next ``` line, which is exactly
 * the mis-parse that let the motivating defect hide.
 *
 * @param lines - The document's lines
 * @returns A parallel array where `true` means the line is fenced or is itself
 * a fence delimiter, the opening line of any fence left unclosed, and every
 * complete block
 */
export function scanFences(
  lines: readonly string[],
): {
  readonly fenced: readonly boolean[];
  readonly unclosedAt: number | null;
  readonly blocks: readonly FenceBlock[];
} {
  const fenced: boolean[] = [];
  const blocks: FenceBlock[] = [];
  let open: { char: string; length: number; line: number; info: string } | null = null;

  for (const [index, line] of lines.entries()) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      // A backtick fence's info string may not itself contain a backtick.
      if (match !== null) {
        const delim = match[1] as string;
        const info = match[2] as string;
        if (!(delim.startsWith('`') && info.includes('`'))) {
          open = {
            char: delim[0] as string,
            length: delim.length,
            line: index + 1,
            info: (info.trim().split(/\s+/)[0] ?? '').toLowerCase(),
          };
          fenced.push(true);
          continue;
        }
      }
      fenced.push(false);
      continue;
    }
    fenced.push(true);
    if (match === null) {
      continue;
    }
    const delim = match[1] as string;
    const closes = delim[0] === open.char &&
      delim.length >= open.length &&
      (match[2] as string).trim() === '';
    if (closes) {
      blocks.push({ line: open.line, info: open.info, bodyStart: open.line, bodyEnd: index });
      open = null;
    }
  }

  return { fenced, unclosedAt: open === null ? null : open.line, blocks };
}

/**
 * Finds code blocks that have swallowed markdown headings.
 *
 * A block whose declared language does not treat `#` as a comment should never
 * contain `##` heading lines. When it does, a fence has run past its intended
 * end and the document below it is rendering as source — the defect this script
 * exists for, in the form that an unclosed-fence check cannot see because the
 * runaway fence was closed by a stray delimiter far below.
 *
 * @param lines - The document's lines
 * @param blocks - Complete blocks from {@linkcode scanFences}
 * @returns One entry per suspect block, with the headings it swallowed
 */
export function findSwallowedHeadings(
  lines: readonly string[],
  blocks: readonly FenceBlock[],
): readonly { readonly block: FenceBlock; readonly headings: readonly string[] }[] {
  const suspects: { block: FenceBlock; headings: string[] }[] = [];
  for (const block of blocks) {
    if (!HASH_IS_NOT_COMMENT.has(block.info)) {
      continue;
    }
    const headings: string[] = [];
    for (let i = block.bodyStart; i < block.bodyEnd; i += 1) {
      const match = /^(#{2,6})\s+(\S.*)$/.exec(lines[i] as string);
      if (match !== null) {
        headings.push(match[2] as string);
      }
    }
    if (headings.length >= SWALLOW_THRESHOLD) {
      suspects.push({ block, headings });
    }
  }
  return suspects;
}

/**
 * Collects the headings of a document, skipping fenced regions, and assigns the
 * `-1`/`-2` suffixes a renderer uses to disambiguate repeated headings.
 *
 * @param lines - The document's lines
 * @param fenced - Per-line fenced flags from {@linkcode scanFences}
 * @returns The headings in document order
 */
export function collectHeadings(
  lines: readonly string[],
  fenced: readonly boolean[],
): readonly Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const [index, line] of lines.entries()) {
    if (fenced[index] === true) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    const text = match[2] as string;
    const base = anchorFor(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      line: index + 1,
      text,
      level: (match[1] as string).length,
      anchor: count === 0 ? base : `${base}-${count}`,
    });
  }
  return headings;
}

/**
 * Collects every in-document anchor link (`](#target)`), skipping fenced
 * regions.
 *
 * @param lines - The document's lines
 * @param fenced - Per-line fenced flags from {@linkcode scanFences}
 * @returns Each link's line, label, and target anchor
 */
export function collectAnchorLinks(
  lines: readonly string[],
  fenced: readonly boolean[],
): readonly { readonly line: number; readonly label: string; readonly target: string }[] {
  const links: { line: number; label: string; target: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (fenced[index] === true) {
      continue;
    }
    for (const match of line.matchAll(/\[([^\]]*)\]\(#([^)\s]+)\)/g)) {
      links.push({ line: index + 1, label: match[1] as string, target: match[2] as string });
    }
  }
  return links;
}

/**
 * Runs all three checks over one document.
 *
 * @param file - Path used in findings
 * @param source - The document's full text
 * @returns Every finding, in line order
 */
export function checkDocument(file: string, source: string): readonly Finding[] {
  const lines = source.split('\n');
  const findings: Finding[] = [];

  const { fenced, unclosedAt, blocks } = scanFences(lines);

  for (const { block, headings } of findSwallowedHeadings(lines, blocks)) {
    const sample = headings.slice(0, 3).map((h) => `"${h}"`).join(', ');
    findings.push({
      file,
      line: block.line,
      message: `This \`${block.info}\` block contains ${headings.length} markdown headings ` +
        `(${sample}${headings.length > 3 ? ', …' : ''}) and runs to line ${block.bodyEnd}. ` +
        `A fence has almost certainly run past its intended end, so the document below it is ` +
        `rendering as source. Check the opening delimiter's length against its closer.`,
    });
  }

  if (unclosedAt !== null) {
    findings.push({
      file,
      line: unclosedAt,
      message:
        'Unclosed code fence opened here — everything below it renders as code, so its headings ' +
        'and links stop working. Close it, and check that the opener is not longer than its ' +
        'intended closer (a ```` fence is not closed by ```).',
    });
    // Heading and link positions below the opener are unreliable once the
    // document is mis-fenced; reporting them too would be noise.
    return findings;
  }

  const headings = collectHeadings(lines, fenced);
  const anchors = new Set(headings.map((h) => h.anchor));

  for (const link of collectAnchorLinks(lines, fenced)) {
    if (!anchors.has(link.target)) {
      findings.push({
        file,
        line: link.line,
        message: `Link [${link.label}](#${link.target}) matches no heading in this file.`,
      });
    }
  }

  const hasToc = headings.some((h) => /^table of contents$/i.test(h.text.trim()));
  if (hasToc) {
    const linked = new Set(collectAnchorLinks(lines, fenced).map((l) => l.target));
    for (const heading of headings) {
      if (heading.level !== 2 || /^table of contents$/i.test(heading.text.trim())) {
        continue;
      }
      if (!linked.has(heading.anchor)) {
        findings.push({
          file,
          line: heading.line,
          message: `Section "${heading.text}" has no Table of Contents entry.`,
        });
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

const REQUIRED_GUIDES = [
  'docs/getting-started.md',
  'docs/plugin-architecture.md',
  'docs/plugins.md',
  'docs/programmatic-api.md',
  'docs/decorators.md',
  'docs/custom-plugins.md',
  'docs/migration-nestjs.md',
  'docs/migration-fastify.md',
  'docs/examples.md',
  'docs/runtime-deployment.md',
];

/**
 * Checks that all required guides exist.
 *
 * @param files - Array of markdown file paths
 * @returns Findings for missing guides
 */
export function checkRequiredGuides(files: readonly string[]): readonly Finding[] {
  const findings: Finding[] = [];
  const fileSet = new Set(files);

  for (const guide of REQUIRED_GUIDES) {
    if (!fileSet.has(guide)) {
      findings.push({
        file: guide,
        line: 1,
        message: `Required guide "${guide}" is missing.`,
      });
    }
  }

  return findings;
}

/**
 * Checks that local Markdown links resolve to existing files/anchors.
 *
 * Resolves each relative target from the containing document's directory using
 * real filesystem checks. Handles files, directories (with README fallback),
 * anchors/fragments, root-relative policy, and URL/mailto exclusions.
 *
 * @param file - The file being checked (repository-relative)
 * @param source - The file contents
 * @param allFiles - Complete set of known markdown files for resolution
 * @returns Findings for broken links
 */
export async function checkLocalLinks(
  file: string,
  source: string,
  allFiles: readonly string[],
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const lines = source.split('\n');

  // Build a set of all known markdown files for resolution
  const knownFiles = new Set(allFiles);
  // Also track directory paths (for README fallback)
  const knownDirs = new Set<string>();
  for (const f of allFiles) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    knownDirs.add(dir);
  }

  // The containing directory of the file being checked
  const fileDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';

  // First, scan fences to know which lines are inside code blocks
  const { fenced } = scanFences(lines);

  // Link pattern: matches [text](target) but not [text](#anchor) or URLs
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const [index, line] of lines.entries()) {
    // Skip lines inside fenced code blocks
    if (fenced[index] === true) {
      continue;
    }
    for (const match of line.matchAll(linkPattern)) {
      const link = match[2] as string;

      // Skip external links, anchors-only, and mailto/tel
      if (
        link.startsWith('http://') || link.startsWith('https://') ||
        link.startsWith('mailto:') || link.startsWith('tel:') ||
        link.startsWith('#')
      ) {
        continue;
      }

      // Split path and anchor
      const hashIndex = link.indexOf('#');
      const linkPath = hashIndex === -1 ? link : link.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? null : link.slice(hashIndex + 1);

      if (!linkPath) continue;

      // Resolve relative path from the containing document's directory
      let resolvedPath: string;
      if (linkPath.startsWith('./')) {
        // Relative to current file's directory
        resolvedPath = `${fileDir}/${linkPath.slice(2)}`;
      } else if (linkPath.startsWith('../')) {
        // Walk up from current file's directory
        const dirParts = fileDir === '.' ? [] : fileDir.split('/');
        const relParts = linkPath.split('/').filter((p) => p !== '.');
        let upCount = 0;
        for (const part of relParts) {
          if (part === '..') upCount++;
        }
        const targetParts = dirParts.slice(0, dirParts.length - upCount);
        const remaining = relParts.filter((p) => p !== '..' && p !== '.');
        resolvedPath = [...targetParts, ...remaining].join('/');
      } else if (linkPath.startsWith('/')) {
        // Root-relative: resolve from repo root
        resolvedPath = linkPath.slice(1);
      } else {
        // Bare path — treat as relative to current directory
        resolvedPath = `${fileDir}/${linkPath}`;
      }

      // Normalize path (remove ./, resolve //, etc.)
      resolvedPath = resolvedPath
        .replace(/^\.\//, '') // Strip leading ./
        .split('/')
        .filter((p) => p !== '')
        .join('/');

      // Skip generated API links (docs/api/ is intentionally untracked)
      if (resolvedPath.startsWith('docs/api/')) {
        continue;
      }

      // Check if the path resolves to a known file, directory, or anchor
      let resolved = false;

      // Direct file match (any file type, not just markdown)
      if (knownFiles.has(resolvedPath)) {
        resolved = true;
      }

      // Check for file:line anchor format (e.g., "packages/foo.ts:79")
      if (!resolved && resolvedPath.includes(':')) {
        const colonIdx = resolvedPath.indexOf(':');
        const filePath = resolvedPath.slice(0, colonIdx);
        // Check if the file portion exists (markdown or any file type)
        if (knownFiles.has(filePath) || knownFiles.has(`${filePath}.md`)) {
          resolved = true;
        } else {
          try {
            const info = await Deno.stat(filePath);
            if (info.isFile) {
              resolved = true;
            }
          } catch {
            // File doesn't exist
          }
        }
      }

      // Directory with README fallback
      if (!resolved && knownFiles.has(`${resolvedPath}/README.md`)) {
        resolved = true;
      }

      // .md extension fallback
      if (!resolved && knownFiles.has(`${resolvedPath}.md`)) {
        resolved = true;
      }

      // Check if the path exists on disk (file or directory)
      if (!resolved) {
        try {
          const info = await Deno.stat(resolvedPath);
          if (info.isFile || info.isDirectory) {
            resolved = true;
          }
        } catch {
          // Path doesn't exist
        }
      }

      // Anchor in same file
      if (!resolved && anchor !== null && anchor !== '') {
        // Check if the anchor exists in the current document
        const headings = collectHeadings(lines, scanFences(lines).fenced);
        const anchorSet = new Set(headings.map((h) => h.anchor));
        if (anchorSet.has(anchor)) {
          resolved = true;
        }
      }

      if (!resolved) {
        findings.push({
          file,
          line: index + 1,
          message: `Local link "${linkPath}" does not resolve to an existing file or directory.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Checks that the examples guide covers all directories under apps/.
 *
 * The expected set is derived from the filesystem (`Deno.readDir('apps')`), not
 * from the index it polices, so a stale index cannot mask its own blind spots.
 *
 * @param examplesGuideContent - The content of docs/examples.md
 * @param appDirs - Array of directory names under apps/ (from filesystem)
 * @returns Findings for missing examples
 */
export function checkExamplesCoverage(
  examplesGuideContent: string,
  appDirs: readonly string[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const coveredApps = new Set<string>();

  // Look for app directory references in the examples guide
  for (const dir of appDirs) {
    if (examplesGuideContent.includes(dir) || examplesGuideContent.includes(`apps/${dir}`)) {
      coveredApps.add(dir);
    }
  }

  for (const dir of appDirs) {
    if (!coveredApps.has(dir)) {
      findings.push({
        file: 'docs/examples.md',
        line: 1,
        message: `Example app "${dir}" is not documented in docs/examples.md.`,
      });
    }
  }

  return findings;
}

/**
 * Checks that the apps README covers all directories under apps/.
 *
 * @param appsReadmeContent - The content of apps/README.md
 * @param appDirs - Array of directory names under apps/ (from filesystem)
 * @returns Findings for missing entries
 */
export function checkAppsReadmeCoverage(
  appsReadmeContent: string,
  appDirs: readonly string[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const coveredApps = new Set<string>();

  // Look for app directory references in the README
  for (const dir of appDirs) {
    if (appsReadmeContent.includes(dir) || appsReadmeContent.includes(`apps/${dir}`)) {
      coveredApps.add(dir);
    }
  }

  for (const dir of appDirs) {
    if (!coveredApps.has(dir)) {
      findings.push({
        file: 'apps/README.md',
        line: 1,
        message: `Example app "${dir}" is not listed in apps/README.md.`,
      });
    }
  }

  return findings;
}

/**
 * Checks that all published packages have a README, metadata entry, catalog entry,
 * API link, and runtime note.
 *
 * Derives the authoritative package set from PUBLISHED_PACKAGES and
 * PACKAGE_METADATA rather than scanning the catalog text.
 *
 * @param pluginsMdContent - The content of docs/plugins.md
 * @param runtimeMdContent - The content of docs/runtime-deployment.md
 * @param publishedPackages - Authoritative list of published package names
 * @param packageMetadata - Package metadata map with runtime compat flags
 * @returns Findings for missing package entries
 */
export function checkPackageCatalog(
  pluginsMdContent: string,
  runtimeMdContent: string,
  publishedPackages: readonly string[],
  packageMetadata: Readonly<Record<string, { description: string; runtimeCompat: unknown }>>,
): readonly Finding[] {
  const findings: Finding[] = [];

  // Check runtime columns in runtime-deployment.md
  if (
    !runtimeMdContent.includes('Deno') || !runtimeMdContent.includes('Node') ||
    !runtimeMdContent.includes('Bun') || !runtimeMdContent.includes('Workers')
  ) {
    findings.push({
      file: 'docs/runtime-deployment.md',
      line: 1,
      message: 'Runtime deployment guide must have columns for Deno, Node, Bun, and Workers.',
    });
  }

  // Derive expected package keys from authoritative sources
  const expectedKeys = new Set<string>();
  for (const pkgPath of publishedPackages) {
    const match = pkgPath.match(/^packages\/([^/]+)/);
    if (match) {
      expectedKeys.add(match[1]);
    }
  }
  // "starters" is a directory, not a package — remove it from expected keys
  expectedKeys.delete('starters');

  // Check each expected package has a catalog entry
  for (const pkg of expectedKeys) {
    // Check README exists
    const readmePath = `packages/${pkg}/README.md`;
    try {
      Deno.statSync(readmePath);
    } catch {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no README at ${readmePath}.`,
      });
    }

    // Check metadata entry exists
    if (!packageMetadata[pkg]) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no metadata entry in PACKAGE_METADATA.`,
      });
    }

    // Check catalog entry exists (look for package name in plugins.md)
    if (!pluginsMdContent.includes(`@setu-ts/${pkg}`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no catalog entry in docs/plugins.md.`,
      });
    }

    // Check API link exists
    if (!pluginsMdContent.includes(`./api/packages/${pkg}/`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no API link in docs/plugins.md.`,
      });
    }

    // Check runtime note exists (README link in the package section)
    if (!pluginsMdContent.includes(`packages/${pkg}/README.md`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no runtime note in docs/plugins.md.`,
      });
    }
  }

  // Starters are under packages/starters/<name>/ — check them separately
  for (const starter of ['rest-starter', 'microservice-starter', 'full-stack-starter']) {
    const readmePath = `packages/starters/${starter}/README.md`;
    try {
      Deno.statSync(readmePath);
    } catch {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${starter}" has no README at ${readmePath}.`,
      });
    }

    if (!packageMetadata[starter]) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${starter}" has no metadata entry in PACKAGE_METADATA.`,
      });
    }

    if (!pluginsMdContent.includes(`@setu-ts/${starter}`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${starter}" has no catalog entry in docs/plugins.md.`,
      });
    }

    if (!pluginsMdContent.includes(`./api/packages/starters/${starter}/`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${starter}" has no API link in docs/plugins.md.`,
      });
    }

    if (!pluginsMdContent.includes(`packages/starters/${starter}/README.md`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${starter}" has no runtime note in docs/plugins.md.`,
      });
    }
  }

  // Check for duplicate entries (package mentioned more than once)
  const pkgMatches = [...pluginsMdContent.matchAll(/@setu-ts\/([^/\s]+)/g)];
  const pkgCounts = new Map<string, number>();
  for (const match of pkgMatches) {
    const pkgName = match[1];
    pkgCounts.set(pkgName, (pkgCounts.get(pkgName) ?? 0) + 1);
  }
  for (const [pkg, count] of pkgCounts) {
    if (count > 1) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" appears ${count} times in docs/plugins.md (expected 1).`,
      });
    }
  }

  // Check for extra entries not in published packages
  // Note: starters are under packages/starters/<name>/ so their short name
  // (e.g. "rest-starter") is NOT in expectedKeys — they are valid catalog entries.
  const starterShortNames = new Set([
    'rest-starter',
    'microservice-starter',
    'full-stack-starter',
  ]);
  for (const match of pluginsMdContent.matchAll(/###\s+@setu-ts\/([^\s]+)/g)) {
    const pkgName = match[1];
    if (!expectedKeys.has(pkgName) && !starterShortNames.has(pkgName)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Extra catalog entry "${pkgName}" not in PUBLISHED_PACKAGES.`,
      });
    }
  }

  return findings;
}

/**
 * Collects markdown files under a root, skipping build and vendor directories.
 *
 * @param root - Directory to walk
 * @returns Markdown file paths, sorted
 */
async function collectMarkdown(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        // The repo root is walked one level deep only; nested roots are listed
        // explicitly in SCAN_ROOTS so an unrelated tree cannot join silently.
        if (dir !== '.') {
          await walk(path, depth + 1);
        }
      } else if (
        entry.name.endsWith('.md') || entry.name.endsWith('.ts') || entry.name.endsWith('.js')
      ) {
        found.push(path);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}

if (import.meta.main) {
  const args = Deno.args.filter((a) => !a.startsWith('-'));
  let files: string[];
  if (args.length > 0) {
    files = args;
  } else {
    const collected = new Set<string>();
    for (const root of SCAN_ROOTS) {
      for (const file of await collectMarkdown(root)) {
        collected.add(file);
      }
    }
    // Also include markdown files from docs/ subdirectories
    const docsRoots = ['docs', 'plans/archive'];
    for (const root of docsRoots) {
      try {
        for await (const entry of Deno.readDir(root)) {
          if (!entry.name.startsWith('.') && entry.name.endsWith('.md')) {
            const path = `${root}/${entry.name}`;
            collected.add(path);
          }
        }
      } catch {
        // Skip if directory doesn't exist
      }
    }
    files = [...collected].sort();
  }

  // Read all file contents for cross-file checks
  const fileContents = new Map<string, string>();
  for (const file of files) {
    try {
      fileContents.set(file, await Deno.readTextFile(file));
    } catch (error) {
      console.error(`Cannot read ${file}: ${(error as Error).message}`);
      Deno.exit(1);
    }
  }

  const findings: Finding[] = [];

  // Run document checks (fences, anchors, TOC)
  for (const file of files) {
    const source = fileContents.get(file)!;
    findings.push(...checkDocument(file, source));
  }

  // Run local link checks (only in default scan mode, only on markdown files)
  // Skip archived plan files as they may reference historical paths
  if (args.length === 0) {
    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('plans/archive/')) continue;
      const source = fileContents.get(file)!;
      const linkFindings = await checkLocalLinks(file, source, files);
      findings.push(...linkFindings);
    }

    // Check required guides
    findings.push(...checkRequiredGuides(files));

    // Check examples coverage
    const examplesContent = fileContents.get('docs/examples.md');
    if (examplesContent) {
      try {
        const appDirs: string[] = [];
        for await (const entry of Deno.readDir('apps')) {
          if (entry.isDirectory && !entry.name.startsWith('.')) {
            appDirs.push(entry.name);
          }
        }
        findings.push(...checkExamplesCoverage(examplesContent, appDirs));
      } catch {
        // If apps/ doesn't exist, skip
      }
    }

    // Check apps README coverage
    const appsReadmeContent = fileContents.get('apps/README.md');
    if (appsReadmeContent) {
      try {
        const appDirs: string[] = [];
        for await (const entry of Deno.readDir('apps')) {
          if (entry.isDirectory && !entry.name.startsWith('.')) {
            appDirs.push(entry.name);
          }
        }
        findings.push(...checkAppsReadmeCoverage(appsReadmeContent, appDirs));
      } catch {
        // If apps/ doesn't exist, skip
      }
    }

    // Check package catalog completeness
    const pluginsContent = fileContents.get('docs/plugins.md');
    const runtimeContent = fileContents.get('docs/runtime-deployment.md');
    if (pluginsContent && runtimeContent) {
      // Import authoritative sources
      const { PUBLISHED_PACKAGES } = await import('./release-packages.ts');
      const { PACKAGE_METADATA } = await import('./jsr-metadata.ts');
      findings.push(
        ...checkPackageCatalog(
          pluginsContent,
          runtimeContent,
          PUBLISHED_PACKAGES,
          PACKAGE_METADATA,
        ),
      );
    }
  }

  if (findings.length === 0) {
    console.log(`Documentation check passed: ${files.length} markdown files, 0 findings.`);
    Deno.exit(0);
  }

  console.error(`Documentation check FAILED: ${findings.length} findings.\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}`);
    console.error(`    ${finding.message}\n`);
  }
  Deno.exit(1);
}
