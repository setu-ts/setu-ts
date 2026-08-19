/**
 * Recurrence gate for computed `import()` specifiers (M70e, plan §3.7/§3.8).
 *
 * JSR's npm-compatibility rewrite is **static**: it rewrites only a `npm:`
 * specifier that sits as a literal argument to `import()`. A specifier that
 * reaches `import()` through a parameter, a map lookup, or a
 * `(spec) => import(spec)` indirection ships `npm:` verbatim and cannot load
 * on Node or Bun (X7-3). This module is the source-level gate that keeps the
 * shape from recurring: it refuses any dynamic `import()` in a package's
 * `src` tree whose first argument is not a string literal, unless the call
 * carries the in-source marker — a block comment reading
 * `computed-specifier: <reason>` (inline or on the preceding line; an empty
 * reason is rejected).
 *
 * The decidable half is the pure {@linkcode findComputedImports}; the thin
 * {@linkcode auditPackageSources} walker is the I/O seam that feeds it. The
 * pure core is what carries the 90% coverage bar via `SCRIPT_TARGETS`.
 *
 * @module
 */

/** A computed (non-literal) `import()` the gate refuses. */
export interface ComputedImport {
  /**
   * The file the import was found in. Empty when produced by
   * {@linkcode findComputedImports} (which sees only source text); populated
   * by {@linkcode auditPackageSources}.
   */
  readonly file: string;
  /** The 1-based line of the `import` keyword. */
  readonly line: number;
  /** A short excerpt of the offending import, for failure messages. */
  readonly snippet: string;
}

/** The result of auditing a tree of package sources. */
export interface AuditResult {
  /** Unmarked computed imports — the gate fails when this is non-empty. */
  readonly findings: readonly ComputedImport[];
  /** The number of `.ts` files under `src` the walker visited (vacuity guard). */
  readonly filesVisited: number;
  /** The number of computed imports that carry a valid marker (vacuity guard). */
  readonly markedSites: number;
}

/** The internal per-import record before the `file` is known. */
interface ScanHit {
  readonly line: number;
  readonly snippet: string;
  /** True when a valid `computed-specifier` marker exempts the import. */
  readonly marked: boolean;
}

/** A block-comment span, offsets into the (same-length) source. */
interface CommentSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Scans a single source file and returns every computed `import()` it
 * contains, each tagged with whether a valid marker exempts it. Pure — no I/O,
 * no `Deno` — so it is unit-testable and coverage-gated.
 */
function scanSource(source: string): readonly ScanHit[] {
  const { code, blockComments, offsetToLine } = maskNonCode(source);
  const hits: ScanHit[] = [];
  const re = /\bimport\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const start = m.index;
    // `obj.import(` is a method call, not a dynamic import — skip it.
    if (start > 0 && code[start - 1] === '.') continue;

    const parenOffset = start + m[0].length - 1;
    const argOffset = firstNonSpace(code, parenOffset + 1);
    if (argOffset >= code.length) continue;

    const argChar = code[argOffset];
    const isComputed = argChar === "'" || argChar === '"' || argChar === '`'
      ? !isCleanStringLiteral(source, argOffset)
      : true;
    if (!isComputed) continue;

    const line = offsetToLine[start];
    const argLine = offsetToLine[argOffset];
    hits.push({
      line,
      snippet: makeSnippet(source, start),
      marked: hasValidMarker(source, blockComments, offsetToLine, line, argLine),
    });
  }
  return hits;
}

/**
 * Finds every computed (non-literal) dynamic `import()` in `source`. This is
 * the pure core of the gate. `file` is empty here; {@linkcode auditPackageSources}
 * is the caller that supplies it.
 */
export function findComputedImports(source: string): readonly ComputedImport[] {
  return scanSource(source)
    .filter((hit) => !hit.marked)
    .map((hit) => ({ file: '', line: hit.line, snippet: hit.snippet }));
}

/**
 * Walks every `src` tree under `root` and audits each `.ts` file. Returns
 * the unmarked
 * computed imports (the findings), plus the vacuity counters the gate test
 * asserts on: the number of files visited and the number of marked sites.
 */
export async function auditPackageSources(root: string): Promise<AuditResult> {
  const findings: ComputedImport[] = [];
  let filesVisited = 0;
  let markedSites = 0;

  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory) continue;
    const srcDir = `${root}/${entry.name}/src`;
    if (!(await isDirectory(srcDir))) continue;
    for await (const file of walkTsFiles(srcDir)) {
      filesVisited++;
      const source = await Deno.readTextFile(file);
      for (const hit of scanSource(source)) {
        if (hit.marked) {
          markedSites++;
        } else {
          findings.push({ file, line: hit.line, snippet: hit.snippet });
        }
      }
    }
  }

  return { findings, filesVisited, markedSites };
}

// ── Masking: reduce the source to "code only" ────────────────────────────────

type CodeFrame = { kind: 'code'; interpolation: boolean; depth: number };
type TemplateFrame = { kind: 'template' };
type Frame = CodeFrame | TemplateFrame;

/**
 * Builds a same-length "code only" view of `source` in which every comment,
 * string body, and template body is replaced by spaces (delimiters and
 * newlines are kept so offsets and line numbers are preserved). Also returns
 * the block-comment spans and an offset→line table.
 *
 * The point is that an `import(` inside a comment, string, or template body
 * becomes spaces and is never seen by the scanner, while a real dynamic
 * `import()` in code (including one inside a template `${ }` interpolation)
 * survives.
 */
function maskNonCode(source: string): {
  code: string;
  blockComments: readonly CommentSpan[];
  offsetToLine: Int32Array;
} {
  const n = source.length;
  const out: string[] = new Array<string>(n);
  const blockComments: CommentSpan[] = [];
  const stack: Frame[] = [{ kind: 'code', interpolation: false, depth: 0 }];

  let i = 0;
  while (i < n) {
    const c = source[i];
    const top = stack[stack.length - 1];

    if (top.kind === 'code') {
      if (c === '/' && source[i + 1] === '/') {
        // Line comment: mask to end of line (leave the newline).
        out[i] = ' ';
        i++;
        out[i] = ' ';
        i++;
        while (i < n && source[i] !== '\n') {
          out[i] = ' ';
          i++;
        }
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        // Block comment: mask to the closing `*/`, record the span.
        const start = i;
        out[i] = ' ';
        i++;
        out[i] = ' ';
        i++;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
          out[i] = ' ';
          i++;
        }
        if (i < n) {
          out[i] = ' ';
          i++;
          out[i] = ' ';
          i++;
        }
        blockComments.push({ start, end: i });
        continue;
      }
      if (c === "'" || c === '"') {
        // String literal: keep the delimiters, mask the body.
        out[i] = c;
        i++;
        while (i < n) {
          if (source[i] === '\\') {
            out[i] = ' ';
            i++;
            if (i < n) {
              out[i] = ' ';
              i++;
            }
            continue;
          }
          if (source[i] === c) {
            out[i] = c;
            i++;
            break;
          }
          out[i] = ' ';
          i++;
        }
        continue;
      }
      if (c === '`') {
        // Template literal: keep the opening backtick, enter template state.
        out[i] = c;
        i++;
        stack.push({ kind: 'template' });
        continue;
      }
      if (c === '{') {
        top.depth++;
        out[i] = c;
        i++;
        continue;
      }
      if (c === '}') {
        if (top.interpolation && top.depth === 0) {
          // Closes a `${ }` interpolation — back to the template.
          stack.pop();
        } else {
          top.depth--;
        }
        out[i] = c;
        i++;
        continue;
      }
      out[i] = c;
      i++;
      continue;
    }

    // top.kind === 'template'
    if (c === '\\') {
      out[i] = ' ';
      i++;
      if (i < n) {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '`') {
      stack.pop();
      out[i] = c;
      i++;
      continue;
    }
    if (c === '$' && source[i + 1] === '{') {
      // Interpolation: the body is real code again.
      stack.push({ kind: 'code', interpolation: true, depth: 0 });
      out[i] = ' ';
      i++;
      out[i] = ' ';
      i++;
      continue;
    }
    out[i] = ' ';
    i++;
    continue;
  }

  const offsetToLine = new Int32Array(n);
  let line = 1;
  for (let j = 0; j < n; j++) {
    offsetToLine[j] = line;
    if (source[j] === '\n') line++;
  }

  return { code: out.join(''), blockComments, offsetToLine };
}

/** The first offset at or after `from` whose char is not whitespace. */
function firstNonSpace(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/**
 * True when the string/template literal opening at `offset` is a clean
 * literal — i.e. its value is fixed at publish time. Single- and
 * double-quoted strings always are; a template literal is clean only when it
 * has no `${ }` interpolation (an interpolated template is computed).
 */
function isCleanStringLiteral(source: string, offset: number): boolean {
  const quote = source[offset];
  if (quote !== '`') return true;
  const n = source.length;
  let i = offset + 1;
  while (i < n) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return true;
    if (c === '$' && source[i + 1] === '{') return false;
    i++;
  }
  return false;
}

/**
 * True when a block comment whose line lies in `[importLine - 1, argLine]`
 * carries a `computed-specifier:` marker with a non-empty reason.
 */
function hasValidMarker(
  source: string,
  blockComments: readonly CommentSpan[],
  offsetToLine: Int32Array,
  importLine: number,
  argLine: number,
): boolean {
  for (const span of blockComments) {
    const line = offsetToLine[span.start];
    if (line < importLine - 1 || line > argLine) continue;
    if (markerHasReason(source.slice(span.start, span.end))) return true;
  }
  return false;
}

/** True when a block-comment text is a `computed-specifier:` marker with a reason. */
function markerHasReason(commentText: string): boolean {
  const m = /computed-specifier:\s*([\s\S]*?)\s*\*\//.exec(commentText);
  if (!m) return false;
  return m[1].trim().length > 0;
}

/** A short, single-line excerpt of the import starting at `start`. */
function makeSnippet(source: string, start: number): string {
  const end = Math.min(source.length, start + 80);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

// ── Walker helpers ───────────────────────────────────────────────────────────

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTsFiles(path);
    } else if (entry.isFile && entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}
