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
 * Builds the set of generated API page paths that `deno task docs:api`
 * produces from a list of manifest export targets. Each target
 * `packages/<pkg>/src/<path>.ts` maps to `docs/api/<pkg>/src/<path>.ts/index.html`.
 *
 * @param targets - The manifest export targets (from collectApiEntrypoints)
 * @returns The set of generated API page paths
 */
export function buildGeneratedApiPages(targets: readonly string[]): Set<string> {
  const pages = new Set<string>();
  // `deno doc --html` always emits a top-level site index at
  // docs/api/index.html (the landing page listing every symbol). Include it
  // so a doc that links to the bare top-level index resolves instead of
  // false-positiving as "does not resolve to a known generated page".
  pages.add('docs/api/index.html');
  for (const target of targets) {
    // deno doc --html maps packages/<pkg>/src/index.ts →
    // docs/api/<pkg>/src/index.ts/index.html (the packages/ prefix is stripped).
    let stripped = target.startsWith('./') ? target.slice(2) : target;
    if (stripped.startsWith('packages/')) {
      stripped = stripped.slice('packages/'.length);
    }
    pages.add(`docs/api/${stripped}/index.html`);
  }
  return pages;
}

/**
 * Checks that local Markdown links resolve to existing files/anchors.
 *
 * Resolves each relative target from the containing document's directory.
 * Handles files, directories (with README fallback), anchors/fragments,
 * root-relative policy, decoded URI paths/fragments, query strings, and
 * URL/mailto exclusions. Generated API links (`./api/...`) are validated
 * against a deterministic manifest-derived page set when one is supplied,
 * rather than unconditionally accepted.
 *
 * @param file - The file being checked (repository-relative)
 * @param source - The file contents
 * @param allFiles - Complete set of known markdown files for resolution
 * @param generatedApiPages - Optional set of valid generated API page paths;
 *   when null, generated API links are skipped (output not yet generated)
 * @returns Findings for broken links
 */
export async function checkLocalLinks(
  file: string,
  source: string,
  allFiles: readonly string[],
  generatedApiPages?: Set<string> | null,
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
      let link = match[2] as string;

      // Skip external links and mailto/tel. A bare `#anchor` is a same-file
      // anchor that must be validated against the current document's headings.
      if (
        link.startsWith('http://') || link.startsWith('https://') ||
        link.startsWith('mailto:') || link.startsWith('tel:')
      ) {
        continue;
      }

      // Decode URI-encoded characters in the link before splitting/resolving.
      link = decodeURIComponent(link);

      // Strip a query string before resolving the path (e.g. "?raw=true").
      const queryIndex = link.indexOf('?');
      if (queryIndex !== -1) {
        link = link.slice(0, queryIndex);
      }

      // Split path and anchor
      const hashIndex = link.indexOf('#');
      const linkPath = hashIndex === -1 ? link : link.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? null : decodeURIComponent(link.slice(hashIndex + 1));

      // A bare anchor with no path is a same-file anchor.
      if (!linkPath) {
        if (anchor !== null && anchor !== '') {
          const headings = collectHeadings(lines, scanFences(lines).fenced);
          const anchorSet = new Set(headings.map((h) => h.anchor));
          if (!anchorSet.has(anchor)) {
            findings.push({
              file,
              line: index + 1,
              message: `Same-file anchor "#${anchor}" matches no heading in this file.`,
            });
          }
        }
        continue;
      }

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

      // Generated API links: validate against the manifest-derived page set
      // rather than unconditionally accepting. When the set is null/undefined
      // (output not yet generated), skip — the gate runs before `deno task docs:api`.
      if (resolvedPath.startsWith('docs/api/')) {
        if (generatedApiPages == null) {
          continue;
        }
        if (!generatedApiPages.has(resolvedPath)) {
          findings.push({
            file,
            line: index + 1,
            message:
              `Generated API link "${linkPath}" does not resolve to a known generated page (${resolvedPath}).`,
          });
        }
        continue;
      }

      // Check if the path resolves to a known file, directory, or anchor
      let resolved = false;
      let resolvedFilePath: string | null = null;

      // Direct file match (any file type, not just markdown)
      if (knownFiles.has(resolvedPath)) {
        resolved = true;
        resolvedFilePath = resolvedPath;
      }

      // Check for file:line anchor format (e.g., "packages/foo.ts:79")
      if (!resolved && resolvedPath.includes(':')) {
        const colonIdx = resolvedPath.indexOf(':');
        const filePath = resolvedPath.slice(0, colonIdx);
        // Check if the file portion exists (markdown or any file type)
        if (knownFiles.has(filePath) || knownFiles.has(`${filePath}.md`)) {
          resolved = true;
          resolvedFilePath = knownFiles.has(filePath) ? filePath : `${filePath}.md`;
        } else {
          try {
            const info = await Deno.stat(filePath);
            if (info.isFile) {
              resolved = true;
              resolvedFilePath = filePath;
            }
          } catch {
            // File doesn't exist
          }
        }
      }

      // Directory with README fallback
      if (!resolved && knownFiles.has(`${resolvedPath}/README.md`)) {
        resolved = true;
        resolvedFilePath = `${resolvedPath}/README.md`;
      }

      // .md extension fallback
      if (!resolved && knownFiles.has(`${resolvedPath}.md`)) {
        resolved = true;
        resolvedFilePath = `${resolvedPath}.md`;
      }

      // Check if the path exists on disk (file or directory) — non-Markdown
      // assets (images, configs) are valid link targets but are NOT parsed as
      // documents, so a fragment on one is not validated against headings.
      if (!resolved) {
        try {
          const info = await Deno.stat(resolvedPath);
          if (info.isFile || info.isDirectory) {
            resolved = true;
            resolvedFilePath = info.isFile ? resolvedPath : null;
          }
        } catch {
          // Path doesn't exist
        }
      }

      // Cross-file anchor: if the link targets a Markdown file with a fragment,
      // parse the TARGET file's headings and reject a missing fragment even when
      // the file exists. Same-file anchors were handled above.
      if (anchor !== null && anchor !== '') {
        if (resolvedFilePath && resolvedFilePath.endsWith('.md') && resolvedFilePath !== file) {
          // Cross-file anchor: parse the target file's renderer-compatible anchors.
          let targetSource: string;
          try {
            targetSource = await Deno.readTextFile(resolvedFilePath);
          } catch {
            targetSource = '';
          }
          const targetLines = targetSource.split('\n');
          const targetHeadings = collectHeadings(targetLines, scanFences(targetLines).fenced);
          const targetAnchors = new Set(targetHeadings.map((h) => h.anchor));
          if (!targetAnchors.has(anchor)) {
            findings.push({
              file,
              line: index + 1,
              message:
                `Cross-file anchor "${linkPath}#${anchor}" matches no heading in ${resolvedFilePath}.`,
            });
            // The file exists, but the anchor does not — report only the anchor.
            continue;
          }
        } else if (!resolvedFilePath || resolvedFilePath === file) {
          // Same-file anchor (file matched is the current document, or no file
          // path resolved — check the current document's headings).
          const headings = collectHeadings(lines, scanFences(lines).fenced);
          const anchorSet = new Set(headings.map((h) => h.anchor));
          if (!anchorSet.has(anchor)) {
            if (!resolved) {
              findings.push({
                file,
                line: index + 1,
                message:
                  `Local link "${linkPath}" does not resolve to an existing file or directory.`,
              });
            } else {
              findings.push({
                file,
                line: index + 1,
                message: `Same-file anchor "#${anchor}" matches no heading in this file.`,
              });
            }
          }
        }
        // For non-Markdown assets with a fragment, the fragment is not
        // validated (assets are not parsed as documents).
      } else if (!resolved) {
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
 * The runtime compatibility flags a catalog entry must reflect. The catalog
 * uses ✅/❌ cells; this maps the metadata flags to the expected cell symbol.
 */
interface RuntimeCompatFlags {
  readonly deno?: boolean;
  readonly node?: boolean;
  readonly bun?: boolean;
  readonly workerd?: boolean;
}

/**
 * Packages whose catalog section must include an explicit provider/resource
 * caveat (e.g. SMTP/raw-socket brokers, worker threads, DNS-SRV unavailable on
 * Workers). Keyed by package short name; the value is a substring the section
 * must mention. This is the explicit checked metadata map the plan requires.
 */
const REQUIRED_CAVEATS: Readonly<Record<string, string>> = {
  'mail-plugin': 'SMTP',
  'messaging-plugin': 'broker',
  'queue-plugin': 'Redis',
  'scheduler-plugin': 'lock',
  'storage-plugin': 'S3',
  'service-discovery-plugin': 'Consul',
  'worker-pool-plugin': 'thread',
  'realtime-backplane-plugin': 'redis',
};

/** Allowed runtime cell values in the catalog's compatibility table. */
const RUNTIME_CELL_VALUES = new Set(['✅', '❌', '⚠️', 'N/A']);

/**
 * Parses the catalog into bounded per-package sections keyed by
 * `### @setu-ts/<name>` headings. Each section's body is the text from its
 * heading line up to the next `###` heading or a `---` separator.
 *
 * @param content - The docs/plugins.md content
 * @returns A map of package short name → section body text
 */
export function parseCatalogSections(
  content: string,
): { sections: Map<string, string>; duplicates: Set<string> } {
  const sections = new Map<string, string>();
  const duplicates = new Set<string>();
  const lines = content.split('\n');
  let currentName: string | null = null;
  let currentBody: string[] = [];
  const flush = () => {
    if (currentName !== null) {
      if (sections.has(currentName)) {
        duplicates.add(currentName);
      }
      sections.set(currentName, currentBody.join('\n'));
      currentName = null;
      currentBody = [];
    }
  };
  for (const line of lines) {
    const headingMatch = /^###\s+@setu-ts\/([^\s]+)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentName = headingMatch[1] as string;
      currentBody = [];
      continue;
    }
    if (currentName !== null) {
      // A `---` separator or a same-level `##` heading ends the section.
      if (line.trim() === '---' || /^##\s/.test(line)) {
        flush();
        continue;
      }
      currentBody.push(line);
    }
  }
  flush();
  return { sections, duplicates };
}

/**
 * Extracts the runtime compatibility table cells from a section body. Returns
 * the four cell values (Deno, Node, Bun, Workers) in order, or null if no
 * table row is found.
 */
/**
 * Extracts the base value of a runtime cell, stripping any parenthetical
 * caveat (e.g. "✅ (KV)" → "✅"). The parenthetical is a provider-level note,
 * not a different status.
 */
function cellBase(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*/g, '').trim();
}

function extractRuntimeCells(
  sectionBody: string,
): { deno: string; node: string; bun: string; workers: string } | null {
  const lines = sectionBody.split('\n');
  // Find the header row with Deno|Node|Bun|Workers, then the next data row.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Deno\s*\|\s*Node\s*\|\s*Bun\s*\|\s*Workers/.test(lines[i] as string)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;
  // Skip the separator row (|---|---|), then the data row.
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.startsWith('|') && !line.includes('-')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length >= 4) {
        return { deno: cells[0]!, node: cells[1]!, bun: cells[2]!, workers: cells[3]! };
      }
    }
  }
  return null;
}

/**
 * Structurally validates the package catalog in docs/plugins.md.
 *
 * Parses bounded per-package sections keyed by `### @setu-ts/<name>` headings
 * and requires, within each section:
 * - exactly one expected heading/record;
 * - a Purpose line;
 * - an exact README link;
 * - an exact valid generated API link;
 * - explicit Deno/Node/Bun/Workers compatibility cells with allowed values;
 * - a provider/resource caveat where required by {@linkcode REQUIRED_CAVEATS}.
 *
 * Rejects duplicate/extra/missing sections, fields moved into another
 * package, wrong README/API links, absent/invalid runtime cells, and missing
 * required caveats. One unstructured paragraph cannot pass.
 *
 * @param pluginsMdContent - The content of docs/plugins.md
 * @param runtimeMdContent - The content of docs/runtime-deployment.md
 * @param publishedPackages - Authoritative list of published package paths
 * @param packageMetadata - Package metadata map with runtime compat flags
 * @returns Findings for structural catalog defects
 */
export function checkPackageCatalog(
  pluginsMdContent: string,
  runtimeMdContent: string,
  publishedPackages: readonly string[],
  packageMetadata: Readonly<
    Record<string, { description: string; runtimeCompat: RuntimeCompatFlags }>
  >,
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

  // Derive the expected package set (short name → path) from authoritative sources.
  const expected = new Map<string, string>();
  for (const pkgPath of publishedPackages) {
    const match = pkgPath.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
    if (!match) continue;
    const first = match[1] as string;
    const second = match[2];
    const shortName = (first === 'starters' && second) ? second : first;
    expected.set(shortName, pkgPath);
  }
  // "starters" is a directory, not a package — remove it.
  expected.delete('starters');

  // Parse the catalog into bounded sections.
  const { sections, duplicates } = parseCatalogSections(pluginsMdContent);

  // Reject duplicate sections (same package heading appears more than once).
  for (const name of duplicates) {
    findings.push({
      file: 'docs/plugins.md',
      line: 1,
      message:
        `Duplicate catalog section "@setu-ts/${name}" appears more than once in docs/plugins.md.`,
    });
  }

  // Reject extra sections not in the expected set.
  for (const name of sections.keys()) {
    if (!expected.has(name)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Extra catalog section "@setu-ts/${name}" is not in PUBLISHED_PACKAGES.`,
      });
    }
  }

  // Validate each expected package's section structurally.
  for (const [pkg, pkgPath] of expected) {
    // Check README exists on disk.
    const readmePath = pkgPath.includes('starters/')
      ? `${pkgPath}/README.md`
      : `packages/${pkg}/README.md`;
    try {
      Deno.statSync(readmePath);
    } catch {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no README at ${readmePath}.`,
      });
    }

    // Check metadata entry exists.
    if (!packageMetadata[pkg]) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" has no metadata entry in PACKAGE_METADATA.`,
      });
    }

    const section = sections.get(pkg);
    if (!section) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message:
          `Package "${pkg}" has no catalog section (### @setu-ts/${pkg}) in docs/plugins.md.`,
      });
      continue;
    }

    // Required: a Purpose line.
    if (!/\*\*Purpose:\*\*/.test(section)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" catalog section has no **Purpose:** line.`,
      });
    }

    // Required: exact README link within this section.
    const expectedReadmeLink = pkgPath.includes('starters/')
      ? `../packages/starters/${pkg}/README.md`
      : `../packages/${pkg}/README.md`;
    if (!section.includes(`[README](${expectedReadmeLink})`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message:
          `Package "${pkg}" catalog section has a wrong or missing README link (expected [README](${expectedReadmeLink})).`,
      });
    }

    // Required: exact valid generated API link within this section.
    const apiPathPrefix = pkgPath.includes('starters/') ? `starters/${pkg}` : pkg;
    const expectedApiLink = `./api/${apiPathPrefix}/src/index.ts/index.html`;
    if (!section.includes(`[API Reference](${expectedApiLink})`)) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message:
          `Package "${pkg}" catalog section has a wrong or missing API link (expected [API Reference](${expectedApiLink})).`,
      });
    }

    // Required: explicit runtime compatibility cells with allowed values.
    const cells = extractRuntimeCells(section);
    if (!cells) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message: `Package "${pkg}" catalog section has no runtime compatibility table.`,
      });
    } else {
      const cellMap: Record<string, string> = {
        deno: cells.deno,
        node: cells.node,
        bun: cells.bun,
        workers: cells.workers,
      };
      for (const [runtime, value] of Object.entries(cellMap)) {
        const base = cellBase(value);
        if (!RUNTIME_CELL_VALUES.has(base)) {
          findings.push({
            file: 'docs/plugins.md',
            line: 1,
            message:
              `Package "${pkg}" has an invalid ${runtime} runtime cell "${value}" (allowed: ${
                [...RUNTIME_CELL_VALUES].join(', ')
              }).`,
          });
        }
      }
      // Cross-check cells against metadata flags when metadata exists. The base
      // value (stripped of any parenthetical caveat) must match. `N/A` is
      // compatible with a `false` flag (both mean "not applicable here").
      const meta = packageMetadata[pkg];
      if (meta) {
        const flags = meta.runtimeCompat;
        const expectedCells: Record<string, string> = {
          deno: flags.deno ? '✅' : '❌',
          node: flags.node ? '✅' : '❌',
          bun: flags.bun ? '✅' : '❌',
          workers: flags.workerd ? '✅' : '❌',
        };
        for (const [runtime, expectedValue] of Object.entries(expectedCells)) {
          const rawCell = cellMap[runtime]!;
          const actualBase = cellBase(rawCell);
          // N/A is compatible with a false metadata flag.
          if (actualBase === 'N/A' && expectedValue === '❌') continue;
          // A ✅ cell with a parenthetical caveat (e.g. "✅ (HTTP brokers)")
          // documents provider-level support that overrides the package-level
          // metadata flag — the caveat IS the provider/resource note. Do not
          // flag it against the package-level flag.
          if (
            actualBase === '✅' && expectedValue === '❌' &&
            rawCell.includes('(') && rawCell.includes(')')
          ) {
            continue;
          }
          if (actualBase !== expectedValue) {
            findings.push({
              file: 'docs/plugins.md',
              line: 1,
              message:
                `Package "${pkg}" ${runtime} cell "${rawCell}" does not match PACKAGE_METADATA (expected "${expectedValue}").`,
            });
          }
        }
      }
    }

    // Required: provider/resource caveat where the metadata map demands it.
    const requiredCaveat = REQUIRED_CAVEATS[pkg];
    if (requiredCaveat && !section.toLowerCase().includes(requiredCaveat.toLowerCase())) {
      findings.push({
        file: 'docs/plugins.md',
        line: 1,
        message:
          `Package "${pkg}" catalog section is missing the required caveat mentioning "${requiredCaveat}".`,
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
  // Skip archived plan files as they may reference historical paths.
  // Collect the deterministic manifest-derived generated API page set so
  // generated links are validated rather than unconditionally accepted.
  if (args.length === 0) {
    let generatedApiPages: Set<string> | null;
    try {
      const { collectApiEntrypoints } = await import('./generate-api-docs.ts');
      const fs = {
        readTextFile: (path: string) => Deno.readTextFile(path),
        readDir: (path: string) => Deno.readDir(path),
        stat: (path: string) => Deno.stat(path),
      };
      const { targets } = await collectApiEntrypoints(fs);
      generatedApiPages = buildGeneratedApiPages(targets);
    } catch {
      // If entrypoint collection fails, skip generated-link validation.
      generatedApiPages = null;
    }

    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('plans/archive/')) continue;
      const source = fileContents.get(file)!;
      const linkFindings = await checkLocalLinks(file, source, files, generatedApiPages);
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
