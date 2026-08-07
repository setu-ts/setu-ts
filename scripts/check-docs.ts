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

/**
 * Collects markdown files under a root, skipping build and vendor directories.
 *
 * @param root - Directory to walk
 * @returns Markdown file paths, sorted
 */
async function collectMarkdown(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
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
      } else if (entry.name.endsWith('.md')) {
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
    files = [...collected].sort();
  }

  const findings: Finding[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch (error) {
      console.error(`Cannot read ${file}: ${(error as Error).message}`);
      Deno.exit(1);
    }
    findings.push(...checkDocument(file, source));
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
