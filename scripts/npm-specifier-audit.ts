/**
 * Recurrence gates for dynamic `import()` in package `src` trees.
 *
 * **Computed specifiers** (M70e, plan §3.7/§3.8). JSR's npm-compatibility
 * rewrite is **static**: it rewrites only a `npm:` specifier that sits as a
 * literal argument to `import()`. A specifier that reaches `import()` through
 * a parameter, a map lookup, or a `(spec) => import(spec)` indirection ships
 * `npm:` verbatim and cannot load on Node or Bun (X7-3). The gate refuses any
 * dynamic `import()` whose first argument is not a string literal, unless the
 * call carries the in-source marker — a block comment reading
 * `computed-specifier: <reason>` (inline or on the preceding line; an empty
 * reason is rejected).
 *
 * **Unguarded bare imports** (M113d, plan §3.2). Wrangler bundles a Worker
 * with esbuild, which resolves a string-literal `import('<bare peer>')` at
 * build time: a Worker importing a Setu-TS package fails its build with
 * `Could not resolve "mongodb"` although it never loads one. The rule
 * (AI_GUIDELINES §12.2, as amended) is that every bare-package dynamic
 * `import()` sits inside the `try` block of a `try`/`catch` in the SAME
 * function — the one shape esbuild leaves as a runtime import, Node resolves
 * unchanged, and every bundler needs. {@linkcode findUnguardedImports} reads
 * the real syntax tree (the regex scanner cannot see lexical nesting) and
 * refuses any bare import whose walk to the first function-like node never
 * passes through a `tryBlock`; a `catch` block and a `.catch()` chain are NOT
 * accepted although esbuild tolerates them — one shape, so the gate and a
 * reader have one thing to recognise.
 *
 * The decidable halves are the pure {@linkcode findComputedImports} and
 * {@linkcode findUnguardedImports}; the thin {@linkcode auditPackageSources}
 * walker is the I/O seam that feeds them. The pure cores carry the 90%
 * coverage bar via `SCRIPT_TARGETS`.
 *
 * **Heuristic limits.** The computed-import scanner is a regex-based heuristic
 * over masked source text, not a parser. A regex literal that happens to
 * contain the text `import(` can false-positive, and a specifier built by
 * `new Function("return import(...)")`-style construction is invisible to it.
 * `eval`/`new Function` are forbidden repo-wide (AI_GUIDELINES §13.5), which
 * is what keeps that blind spot empty; the `computed-specifier` marker is the
 * escape hatch for a genuinely computed import the heuristic would otherwise
 * refuse.
 *
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import ts from 'typescript';

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
  /**
   * Every `src` root the walker audited, in discovery order.
   *
   * This is the coverage guard, and it exists because `filesVisited` is not
   * one: a walker that reaches most of the tree still reports a large,
   * healthy-looking count. The first version of this walker looked only at
   * `<root>/<pkg>/src`, so it silently skipped `packages/starters/*` — three
   * PUBLISHED packages — while reporting 651 files audited and a clean result
   * for an import shape it would have refused anywhere else. Asserting on the
   * roots themselves is what makes a missed subtree visible.
   */
  readonly srcRootsVisited: readonly string[];
  /** `npm:`/`jsr:` import specifiers in `src` — the gate fails when non-empty (M111a §3.8). */
  readonly prefixed: readonly PrefixedSpecifier[];
  /**
   * Bare-package dynamic `import()` sites not guarded by a same-function
   * `try` — the gate fails when this is non-empty (M113d §3.2).
   */
  readonly unguarded: readonly UnguardedImport[];
}

/** A bare-package dynamic `import()` the guard rule refuses (M113d §3.2). */
export interface UnguardedImport {
  /**
   * The file the import was found in. Empty when produced by
   * {@linkcode findUnguardedImports} (which sees only source text); populated
   * by {@linkcode auditPackageSources}.
   */
  readonly file: string;
  /** The 1-based line of the `import` keyword. */
  readonly line: number;
  /** A short excerpt of the offending import, for failure messages. */
  readonly snippet: string;
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
    const isComputed =
      argChar !== "'" && argChar !== '"' && argChar !== '`'
        ? true
        : !isBareStringArgument(source, code, argOffset, parenOffset);
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

// ── The guarded-import rule (M113d §3.2) ─────────────────────────────────────

/**
 * Finds every bare-package dynamic `import()` in `source` that is NOT guarded
 * by a same-function `try` — the pure core of the M113d gate. `file` is empty
 * here; {@linkcode auditPackageSources} is the caller that supplies it.
 *
 * `scriptKind` selects how the text is parsed (`.tsx` files parse as TSX); it
 * changes only JSX handling, never the guard decision.
 */
export function findUnguardedImports(
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS,
): readonly UnguardedImport[] {
  const sourceFile = ts.createSourceFile(
    'audit.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const hits: { line: number; snippet: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      isBarePackageSpecifier(node.arguments[0].text) &&
      !isGuardedBySameFunctionTry(node)
    ) {
      const start = node.getStart(sourceFile);
      hits.push({
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        snippet: makeSnippet(source, start),
      });
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  return hits.map((hit) => ({ file: '', ...hit }));
}

/** The `ts.ScriptKind` a source file at `file` parses as. */
function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * True when `specifier` names a bare package: not relative (`.`/`/`), not
 * `@setu-ts/*` (a workspace package resolves for every bundler), and not a
 * scheme-like prefix (`node:`, `cloudflare:`, `data:`) — those carry their own
 * resolution rules and are exempt from the guard rule.
 */
function isBarePackageSpecifier(specifier: string): boolean {
  if (specifier === '') return false;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('@setu-ts/')) return false;
  if (/^[A-Za-z][A-Za-z0-9._-]*:/.test(specifier)) return false;
  return true;
}

/**
 * True when the `import()` call at `node` is AWAITED inside the `try` block of a
 * `try`/`catch` in the SAME function — the one shape the rule admits (M113d
 * §3.1) and a shape esbuild leaves as a runtime import.
 *
 * Both halves were measured against esbuild 0.28.2, which is what Wrangler
 * bundles a Worker with:
 *
 * - **The `await` is load-bearing.** An awaited import is tolerated wherever the
 *   `await` sits in the surrounding expression — a statement, an assignment, a
 *   `return`, a call argument, an array element, an object property. An
 *   UNAWAITED import is refused everywhere, including as a variable initializer
 *   (`const p = import('x')`), a bare `return import('x')`, and an element of
 *   `Promise.all([import('x')])`: esbuild resolves it at build time and fails on
 *   the absent package. Parentheses and TypeScript assertions between the call
 *   and the `await` are skipped, since `tsc` erases the assertions before a
 *   bundler ever sees the code.
 * - **The `try` must be in the same function.** The walk stops at the first
 *   function-like node, so a `try` of an ENCLOSING function does not guard; nor
 *   does a `catch` or `finally` block.
 *
 * esbuild also tolerates an awaited `.catch()` chain; the rule refuses it
 * anyway, so a reader and this gate recognise one shape.
 */
function isGuardedBySameFunctionTry(node: ts.Node): boolean {
  let operand: ts.Node = node;
  while (operand.parent !== undefined && isTransparentWrapper(operand.parent)) {
    operand = operand.parent;
  }
  if (operand.parent === undefined || !ts.isAwaitExpression(operand.parent)) return false;
  let current: ts.Node = operand.parent;
  while (current.parent !== undefined) {
    const parent: ts.Node = current.parent;
    if (isFunctionLikeNode(parent)) return false;
    if (ts.isTryStatement(parent) && parent.tryBlock === current) return true;
    current = parent;
  }
  return false;
}

/** Syntax that changes neither what is awaited nor what a bundler sees. */
function isTransparentWrapper(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

/** The function-like syntax kinds a guard walk may not cross. */
function isFunctionLikeNode(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Walks every `src` tree under `root` and audits each `.ts`/`.tsx` file.
 * Returns the unmarked computed imports (the findings), the unguarded
 * bare-package imports, plus the vacuity counters the gate test asserts on:
 * the number of files visited and the number of marked sites.
 */
export async function auditPackageSources(root: string): Promise<AuditResult> {
  const findings: ComputedImport[] = [];
  const prefixed: PrefixedSpecifier[] = [];
  const unguarded: UnguardedImport[] = [];
  let filesVisited = 0;
  let markedSites = 0;

  const srcRootsVisited = await collectSrcRoots(root);
  for (const srcDir of srcRootsVisited) {
    for await (const file of walkTsFiles(srcDir)) {
      filesVisited++;
      const source = await readFile(file, 'utf8');
      for (const hit of scanSource(source)) {
        if (hit.marked) {
          markedSites++;
        } else {
          findings.push({ file, line: hit.line, snippet: hit.snippet });
        }
      }
      for (const hit of findPrefixedSpecifiers(source)) prefixed.push({ ...hit, file });
      for (const hit of findUnguardedImports(source, scriptKindFor(file))) {
        unguarded.push({ ...hit, file });
      }
    }
  }

  return { findings, filesVisited, markedSites, srcRootsVisited, prefixed, unguarded };
}

/**
 * Every `src` directory under `root`, at ANY depth.
 *
 * Depth matters: workspace members are not all one level down. The starters
 * live at `packages/starters/<name>/src`, so a walker that only probes
 * `<root>/<entry>/src` misses all three — and they are published packages, so
 * the rewrite defect this gate exists to catch applies to them exactly as it
 * does anywhere else.
 *
 * Descent stops at a `src` directory (its own subtree is audited by
 * {@linkcode walkTsFiles}, so a nested `src/` inside it is not a second root),
 * and `node_modules` is skipped so a vendored tree is never audited as ours.
 */
async function collectSrcRoots(root: string): Promise<string[]> {
  const roots: string[] = [];

  async function descend(dir: string): Promise<void> {
    for await (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      const path = `${dir}/${entry.name}`;
      if (entry.name === 'src') {
        roots.push(path);
        continue;
      }
      await descend(path);
    }
  }

  if (await isDirectory(root)) await descend(root);
  return roots;
}

// ── Masking: reduce the source to "code only" ────────────────────────────────

type CodeFrame = { kind: 'code'; interpolation: boolean; depth: number };
type TemplateFrame = { kind: 'template' };
type Frame = CodeFrame | TemplateFrame;

/** The masked view {@linkcode maskNonCode} returns. */
export interface MaskResult {
  code: string;
  blockComments: readonly CommentSpan[];
  offsetToLine: Int32Array;
  /**
   * Offsets of every string/template delimiter that OPENED in code state —
   * the only quotes that begin a literal. A closing delimiter preserved by
   * the mask is NOT here, so a consumer that classifies literals (the
   * node-manifests import scan) must iterate these rather than hunting quotes
   * itself: from a closing backtick, `readStringLiteral` would read forward to
   * the NEXT template's opening delimiter and swallow every real import
   * between the two (measured: `service-bus-broker.ts`'s
   * `import('@azure/service-bus')` vanished exactly this way).
   */
  literalStarts: readonly number[];
}

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
 *
 * Shared with `scripts/node-manifests.ts` (M111a), which scans import
 * specifiers over the same masked view so JSDoc `@example` imports and
 * generated-project template text cannot invent dependency edges
 * (AI_GUIDELINES §11.1 — one masking implementation, not two).
 */
export function maskNonCode(source: string): MaskResult {
  const n = source.length;
  const out: string[] = new Array<string>(n);
  const blockComments: CommentSpan[] = [];
  const literalStarts: number[] = [];
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
        literalStarts.push(i);
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
        literalStarts.push(i);
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

  return { code: out.join(''), blockComments, offsetToLine, literalStarts };
}

/** The first offset at or after `from` whose char is not whitespace. */
function firstNonSpace(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/**
 * True when the first argument of the `import(` call whose opening paren is
 * at `parenOffset` is EXACTLY the string literal opening at `argOffset` —
 * nothing but whitespace (and masked comments) between the literal's closing
 * delimiter and the end of the argument. A concatenated (`'a' + b`), cast
 * (`'a' as string`), or otherwise composed argument is not a bare literal and
 * is reported as computed: JSR's static rewrite reaches only the literal, so
 * the composed value would ship `npm:` verbatim (X7-3).
 */
function isBareStringArgument(
  source: string,
  code: string,
  argOffset: number,
  parenOffset: number,
): boolean {
  const literal = readStringLiteral(source, argOffset);
  if (!literal.clean || literal.end < 0) return false;
  const argEnd = firstArgumentEnd(code, parenOffset);
  return /^\s*$/.test(code.slice(literal.end, argEnd));
}

/**
 * The offset of the token that ends the FIRST argument of the call whose
 * opening paren is at `parenOffset`: the first `,` at paren depth 0, or the
 * matching `)`. Scans the masked `code` view, where string/template bodies
 * and comments are spaces, so only real code tokens affect the depth count.
 */
function firstArgumentEnd(code: string, parenOffset: number): number {
  let depth = 0;
  for (let i = parenOffset + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) {
      return i;
    }
  }
  return code.length;
}

/**
 * Reads the string/template literal opening at `offset` and reports where it
 * ends (the offset just past the closing delimiter) and whether it is clean —
 * i.e. its value is fixed at publish time. Single- and double-quoted strings
 * are always clean; a template literal is clean only when it has no `${ }`
 * interpolation (an interpolated template is computed). `end` is `-1` when
 * the literal is unterminated or interpolated.
 */
export function readStringLiteral(source: string, offset: number): { end: number; clean: boolean } {
  const quote = source[offset];
  const n = source.length;
  let i = offset + 1;
  while (i < n) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return { end: i + 1, clean: true };
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      return { end: -1, clean: false };
    }
    i++;
  }
  return { end: -1, clean: false };
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
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkTsFiles(path);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      yield path;
    }
  }
}

// ── Import edges (shared with scripts/node-manifests.ts, M111a) ──────────────

/** One import edge found in one scanned file. */
export interface ImportEdge {
  /** The specifier exactly as written (bare, `npm:`/`jsr:`-prefixed, relative, or `node:`). */
  readonly specifier: string;
  /** How the file reaches the specifier. */
  readonly mode: 'value' | 'type' | 'dynamic';
  /** The scanned file's repository-relative path, for failure messages. */
  readonly file: string;
  /** The 1-based line of the specifier's opening quote. */
  readonly line: number;
}

/**
 * Scans one source file and returns every import edge it expresses.
 *
 * Comments and template bodies are masked first (delimiters preserved, so
 * literal values are read from the original source at the masked offsets);
 * an `import`/`from` inside a JSDoc `@example`, a line comment, or an emitted
 * template string is therefore invisible to this scan.
 *
 * Classification walks BACKWARD from each string-literal delimiter over the
 * masked code, so only a literal whose preceding token is `from`, a
 * side-effect `import`, or an `import(` is an edge — a plain string constant
 * (`const X = 'pkg'`, preceded by `=`) or an object value (`{ key: 'pkg' }`,
 * preceded by `:`) is not, and a function call argument (`err('pkg')`,
 * preceded by `(` whose word is the callee's name) is not either. This is what
 * keeps the CLI's emitted-Deno-project strings (`PROTO_TASK_COMMAND`,
 * `PROTO_IMPORTS`) out of the dependency graph: they are string constants, and
 * 111d owns them.
 */
export function scanImportEdges(source: string, file: string): readonly ImportEdge[] {
  const { code, literalStarts, offsetToLine } = maskNonCode(source);
  const edges: ImportEdge[] = [];

  // Iterate the masker's literal-OPENING offsets, never a quote hunt: a
  // closing delimiter preserved by the mask would read forward to the next
  // literal's opening delimiter and swallow the imports in between.
  for (const start of literalStarts) {
    const literal = readStringLiteral(source, start);
    if (!literal.clean || literal.end < 0) continue; // interpolated/computed — no edge
    const specifier = source.slice(start + 1, literal.end - 1);
    const edge = classifyLiteral(code, start, specifier, file, offsetToLine[start] ?? 0);
    if (edge !== null) edges.push(edge);
  }
  return edges;
}

/**
 * Classifies one string literal by the token that precedes it in the masked
 * code. Returns `null` when the literal is not an import specifier.
 */
function classifyLiteral(
  code: string,
  quoteOffset: number,
  specifier: string,
  file: string,
  line: number,
): ImportEdge | null {
  // A legal module specifier carries only name/path/range characters. Anything else
  // (`(`, `\`, a quote, whitespace) is a MISREAD — the masking pass does not
  // model regex literals, so a `/from "(@setu-ts\/…)/"` test regex presents its
  // quotes as a string literal preceded by `from`. Refusing impossible
  // specifiers keeps those out of the graph rather than inventing dependencies
  // (and, via the cycle check, false cycles) from test regexes.
  // Semver range characters (`^`, `~`, `*`, `+`, `<`, `>`, `=`) are legal in
  // an `npm:`/`jsr:` specifier and must stay in: `npm:zod@^3.24.0` is exactly
  // the shape §3.8 refuses, and a narrower class let it through as a "misread".
  if (!/^[A-Za-z0-9@/._:^~*+<>=-]+$/.test(specifier)) return null;
  let p = quoteOffset - 1;
  while (p >= 0 && /\s/.test(code[p])) p -= 1;
  if (p < 0) return null;

  if (code[p] === '(') {
    // `import('x')` — or a call whose name happens to precede the paren.
    const word = wordBefore(code, p);
    if (word === null || word.text !== 'import') return null;
    if (word.start > 0 && code[word.start - 1] === '.') return null; // obj.import( — a method call
    return { specifier, mode: 'dynamic', file, line };
  }

  if (!/[A-Za-z0-9_$]/.test(code[p])) return null; // `: 'x'`, `= 'x'`, `, 'x'` — a value, not an import
  const word = wordBefore(code, p + 1);
  if (word === null) return null;
  if (word.text === 'import') return { specifier, mode: 'value', file, line }; // side-effect import
  if (word.text !== 'from') return null;

  // `… from 'x'` — static. Type-only when the keyword introducing the clause
  // (`import`/`export`) is immediately followed by `type`. The clause between
  // keyword and `from` is real code in the masked view (string bodies are
  // spaces), so a bounded window suffices for even the widest import list.
  // The LAST keyword in the window is this statement's — an earlier import in
  // the same window must not decide this literal's mode.
  const window = code.slice(Math.max(0, quoteOffset - 2000), quoteOffset);
  let keywordEnd = -1;
  for (const match of window.matchAll(/\b(?:import|export)\b/g)) {
    keywordEnd = (match.index ?? 0) + match[0].length;
  }
  if (keywordEnd < 0) return { specifier, mode: 'value', file, line };
  const afterKeyword = window.slice(keywordEnd);
  return {
    specifier,
    mode: /^\s*type\b/.test(afterKeyword) ? 'type' : 'value',
    file,
    line,
  };
}

/** The identifier ending just before `from`, as `{ text, start }`, or null. */
function wordBefore(code: string, from: number): { text: string; start: number } | null {
  let end = from;
  while (end > 0 && /\s/.test(code[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(code[start - 1])) start -= 1;
  if (start === end) return null;
  return { text: code.slice(start, end), start };
}

/** A `npm:`/`jsr:`-prefixed import specifier the gate refuses (M111a §3.8). */
export interface PrefixedSpecifier {
  /** The file the specifier was found in; empty from {@linkcode findPrefixedSpecifiers}. */
  readonly file: string;
  /** The 1-based line of the specifier. */
  readonly line: number;
  /** The specifier exactly as written. */
  readonly specifier: string;
}

/**
 * Finds every import specifier in `source` that carries an `npm:` or `jsr:`
 * prefix — the Deno-only forms Node cannot resolve (M111a §3.8).
 *
 * Only a real import position counts (`import()`, `from`, a side-effect
 * `import`), read through {@linkcode scanImportEdges}, so the masked
 * comment and template text the CLI emits into generated Deno projects is
 * exempt by construction rather than by an allow-list.
 */
export function findPrefixedSpecifiers(source: string): readonly PrefixedSpecifier[] {
  return scanImportEdges(source, '')
    .filter((edge) => edge.specifier.startsWith('npm:') || edge.specifier.startsWith('jsr:'))
    .map((edge) => ({ file: '', line: edge.line, specifier: edge.specifier }));
}
