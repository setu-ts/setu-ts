// deno-lint-ignore-file no-console -- a gate must print actionable findings.
/**
 * Executable behaviour gate for documented view components.
 *
 * The fence compilers prove a documented example TYPE-CHECKS. They cannot
 * prove it is correct: `v0.6.0` shipped a class-based view example written as
 * a plain template literal, which compiles perfectly and escapes nothing, so a
 * user-supplied `<script>` reached the page verbatim. Every gate was green.
 *
 * This gate closes that one class by RUNNING the documented components. It
 * derives its work from the documents rather than from an author remembering
 * to write an assertion: every component a fence passes to `renderView(...)`
 * or `@Render(...)` is rendered through the framework's own
 * {@linkcode renderComponent} with a hostile payload, and its output must not
 * contain that payload unescaped.
 *
 * Counter-examples are checked in the OTHER direction. A document that shows
 * an unsafe shape to warn against it — `docs/mvc.md` does, and so does
 * `docs/upgrading.md` — labels it — see {@linkcode COUNTER_EXAMPLE_MARKERS} —
 * and the gate then requires it to be unsafe. A warning that stopped being
 * true would fail here rather than quietly misinform.
 *
 * @module
 */
import { classify, extractFences, TS_ALIASES } from '../test/fixtures/snippets/fence-engine.ts';

/** The payload rendered into every string-shaped prop. */
export const HOSTILE = '<script>alert(1)</script>';

/**
 * Documents scanned for renderable components.
 *
 * Every Markdown file the repository publishes, so a component documented in a
 * package README is covered exactly as one in a guide is.
 */
export const SCAN_ROOTS: readonly string[] = ['docs', 'packages', '.'];

/**
 * Markers a document uses to label a component it is warning against.
 *
 * Derived from the document rather than held in a list here, and that is the
 * point: a list keyed by name cannot describe `docs/upgrading.md`, which shows
 * the same `UserList` three times — once as the shape to stop using and twice
 * as the remedy. The label travels with the example, so a new counter-example
 * is covered the day it is written and an UNLABELLED unsafe component fails,
 * which is the case this gate exists for.
 */
export const COUNTER_EXAMPLE_MARKERS: readonly string[] = ['UNSAFE', 'DO NOT USE'];

/**
 * Evidence that an arrow function is a view component rather than a helper.
 *
 * A JSX tag's `<` is never preceded by an identifier character, which is what
 * separates `(<ul>` from the generic `Custom<string>(` — the latter matched a
 * looser pattern and sent a parameter-decorator factory through the renderer,
 * where it threw and was reported as a defect in `PUBLIC_API.md`.
 */
const MARKUP = /(^|[^A-Za-z0-9_$])<[a-z][a-zA-Z0-9-]*[\s/>]|html`|`[^`]*<[a-zA-Z]/;

/** A document reaches for view rendering, so its components are in scope. */
const RENDERS_VIEWS = /renderView\(|@Render\(|@setu-ts\/view-plugin|@hono\/hono\/html/;

/** A component definition lifted out of a documentation fence. */
export interface DocComponent {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly source: string;
  /** True when the document declares this one a deliberate counter-example. */
  readonly expectUnsafe: boolean;
  /** True when the component opts out of escaping through `raw()`. */
  readonly usesRaw: boolean;
}

/** A component whose rendered output did not match its declared safety. */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/**
 * Names every component a fence renders as a view.
 *
 * Read from the fence's own USE of the component — `renderView(ctx, X, …)` or
 * `@Render(X)` — rather than from its shape, so a helper that merely returns a
 * string is not mistaken for a view and a new rendering entry point is a
 * deliberate addition here rather than a silent gap.
 *
 * @param code - The fence body
 * @returns The referenced component names, in source order, deduplicated
 */
export function renderedComponentNames(code: string): readonly string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/@Render\(\s*([A-Z][A-Za-z0-9_$]*)/g)) names.add(m[1]!);
  for (const m of code.matchAll(/renderView\(\s*[A-Za-z0-9_$.]+\s*,\s*([A-Z][A-Za-z0-9_$]*)/g)) {
    names.add(m[1]!);
  }
  return [...names];
}

/**
 * Lifts one `const <name> = …;` statement out of a fence.
 *
 * Scans to the first `;` at nesting depth zero, tracking parentheses, braces,
 * brackets, strings and template literals — enough for the arrow functions a
 * component is written as, in any of the three authoring shapes (JSX, an
 * `html` tagged template, a plain literal). Returns null when the fence does
 * not define the name, which is the ordinary case for a fence that uses a
 * component defined in an earlier one.
 *
 * @param code - The fence body
 * @param name - The component's identifier
 * @returns The statement source, or null when absent
 */
export function extractDefinition(code: string, name: string): string | null {
  const start = code.search(new RegExp(`\\bconst\\s+${name}\\s*[=:]`));
  if (start === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    const prev = code[i - 1];
    if (quote !== null) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return code.slice(start, i + 1);
  }
  return null;
}

/**
 * The comment block directly above a definition, and nothing else.
 *
 * Walks back over CONTIGUOUS comment lines and stops at the first line that is
 * not one, so a label belongs to the component it sits on. A fixed window of
 * preceding lines does not: with two components a line apart, the first one's
 * `// UNSAFE:` reached the second and marked a safe example as a
 * counter-example.
 *
 * @param before - Fence source preceding the definition
 * @returns The attached comment lines, joined
 */
export function attachedComment(before: string): string {
  const lines = before.split('\n');
  // The definition's own line is the last (partial) entry; drop it.
  lines.pop();
  const attached: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
      attached.unshift(line);
      continue;
    }
    break;
  }
  return attached.join('\n');
}

/**
 * Collects every renderable component defined across a document's fences.
 *
 * @param file - The document's path
 * @param markdown - Its contents
 * @returns One entry per component the document both defines and renders
 */
export function collectComponents(file: string, markdown: string): readonly DocComponent[] {
  const found: DocComponent[] = [];
  if (!RENDERS_VIEWS.test(markdown)) return found;

  for (const fence of extractFences(file, markdown)) {
    if (!TS_ALIASES.has(fence.lang)) continue;
    if (classify(fence).kind === 'skip') continue;

    // Scoped to the FENCE, never the document. A name deduplicated per
    // document checks only its first definition, and a README routinely
    // defines the same component twice — once functional, once class-based.
    // Reintroducing the exact v0.6.0 defect in the second one did not fail
    // this gate until the scope was narrowed.
    const seen = new Set<string>();
    for (const m of fence.code.matchAll(/\bconst\s+([A-Z][A-Za-z0-9_$]*)\s*=/g)) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      const source = extractDefinition(fence.code, name);
      if (source === null || !MARKUP.test(source)) continue;
      seen.add(name);
      const before = attachedComment(fence.code.slice(0, m.index ?? 0));
      found.push({
        file,
        line: fence.line,
        name,
        source,
        expectUnsafe: COUNTER_EXAMPLE_MARKERS.some((marker) => before.includes(marker)),
        usesRaw: /\braw\s*\(/.test(source),
      });
    }
  }
  return found;
}

/**
 * Builds the probe module that renders each component with hostile input.
 *
 * The props object is one `Proxy` answering every read with a single-element
 * array holding the payload. That satisfies both shapes a documented component
 * takes without the gate having to know which: `props.users.map(…)` sees a real
 * array, and `props.name` interpolates as its only element, because a
 * one-element array stringifies to that element.
 *
 * @param components - The components to render
 * @returns A TSX module printing one JSON line per component
 */
export function buildProbe(components: readonly DocComponent[]): string {
  // Each component gets its own block. Several documents define a component
  // called `UserList`, and the extracted source is emitted VERBATIM — it is
  // what is under test, so renaming it to dodge the collision would mean
  // checking something the reader will not copy.
  const body = components.map((c, index) =>
    `{
${c.source}
try {
  const out = await renderComponent(${c.name} as never, props);
  console.log(JSON.stringify({ index: ${index}, ok: true, escaped: !out.includes(HOSTILE) }));
} catch (error) {
  console.log(JSON.stringify({ index: ${index}, ok: false, error: String(error) }));
}
}`
  ).join('\n\n');

  return `/** @jsxImportSource @hono/hono/jsx */
import { renderComponent } from '../../packages/view-plugin/src/render/normalize.ts';
import { html } from '@hono/hono/html';
import { raw } from '@hono/hono/html';

const HOSTILE = ${JSON.stringify(HOSTILE)};
const props = new Proxy({}, { get: () => [HOSTILE] }) as never;
void html;
void raw;

${body}
`;
}

/** One component's rendered outcome, as reported by the probe. */
export type ProbeResult =
  | { readonly index: number; readonly ok: true; readonly escaped: boolean }
  | { readonly index: number; readonly ok: false; readonly error: string };

/**
 * Parses probe output, refusing an incomplete batch.
 *
 * A short batch means the probe died partway, which must fail the gate rather
 * than silently check fewer components than it collected.
 *
 * @param stdout - JSON-lines output
 * @param expected - How many components were rendered
 * @returns The results, or null when the batch is incomplete or malformed
 */
export function parseProbe(stdout: string, expected: number): readonly ProbeResult[] | null {
  const lines = stdout.trim().length === 0 ? [] : stdout.trim().split('\n');
  if (lines.length !== expected) return null;
  const results: ProbeResult[] = [];
  for (const line of lines) {
    try {
      const decoded = JSON.parse(line) as ProbeResult;
      if (typeof decoded !== 'object' || decoded === null || !('ok' in decoded)) return null;
      results.push(decoded);
    } catch {
      return null;
    }
  }
  return results;
}

/**
 * Compares each rendered outcome with what its document claims.
 *
 * @param components - The components rendered, in probe order
 * @param results - The probe's report
 * @returns One finding per component whose behaviour contradicts its document
 */
export function compare(
  components: readonly DocComponent[],
  results: readonly ProbeResult[],
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const [index, component] of components.entries()) {
    const result = results[index];
    if (result === undefined || !result.ok) {
      findings.push({
        file: component.file,
        line: component.line,
        message: `${component.name} could not be rendered: ${
          result === undefined ? 'no result' : result.error
        }`,
      });
      continue;
    }
    if (component.expectUnsafe && result.escaped) {
      findings.push({
        file: component.file,
        line: component.line,
        message: `${component.name} is labelled a counter-example by its own comment, but it ` +
          `ESCAPES its input. The document warns against a shape that is no longer unsafe — ` +
          `update the warning, or drop the entry.`,
      });
      continue;
    }
    if (!component.expectUnsafe && !result.escaped) {
      findings.push({
        file: component.file,
        line: component.line,
        message:
          `${component.name} renders ${
            JSON.stringify(HOSTILE)
          } UNESCAPED. A documented component ` +
          `must escape its input: write it with JSX or hono's \`html\` tag, never a plain ` +
          `template literal, which is a \`string\` the engine returns unchanged.`,
      });
    }
  }
  return findings;
}

const SCRATCH = '.tmp/example-behaviour';
const PROBE = `${SCRATCH}/probe.tsx`;
const CONFIG = 'test/fixtures/snippets/deno.json';
const TIMEOUT_MS = 30_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'build', 'dist', '.wrangler']);

/**
 * Every tracked Markdown document under the scan roots.
 *
 * @param roots - Directories to walk
 * @returns Markdown paths, sorted
 */
export async function scanDocuments(roots: readonly string[]): Promise<readonly string[]> {
  const found = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (depth > 0) await walk(path, depth - 1);
      } else if (entry.name.endsWith('.md')) found.add(path);
    }
  };
  for (const root of roots) await walk(root, 3);
  return [...found].sort();
}

/**
 * Runs the probe and reports every contradiction between a document and what
 * its components actually do.
 *
 * @param files - Documents to check; defaults to the scan roots
 * @param options - `timeoutMs` bounds the probe; the default is generous
 * @returns One finding per component whose behaviour contradicts its document
 */
export async function run(
  files: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly Finding[]> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const documents = files.length > 0 ? files : await scanDocuments(SCAN_ROOTS);
  const components: DocComponent[] = [];
  for (const file of documents) {
    let markdown: string;
    try {
      markdown = await Deno.readTextFile(file);
    } catch {
      return [{ file, line: 1, message: 'could not be read' }];
    }
    components.push(...collectComponents(file, markdown));
  }
  // A component reaching for `raw()` has opted out of escaping deliberately —
  // that is the documented escape hatch, and rendering it would report the
  // opt-out as a defect.
  const rendered = components.filter((c) => !c.usesRaw);
  if (rendered.length === 0) return [];

  await Deno.mkdir(SCRATCH, { recursive: true });
  await Deno.writeTextFile(PROBE, buildProbe(rendered));

  const command = new Deno.Command('deno', {
    args: ['run', '--config', CONFIG, '--allow-read', '--no-prompt', PROBE],
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = command.spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.output(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch { /* already gone */ }
        resolve(null);
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === null) {
    return [{ file: PROBE, line: 1, message: 'the render probe timed out' }];
  }
  const stdout = new TextDecoder().decode(outcome.stdout);
  const results = parseProbe(stdout, rendered.length);
  if (results === null) {
    const stderr = new TextDecoder().decode(outcome.stderr).trim();
    return [{
      file: PROBE,
      line: 1,
      message: `the render probe did not report ${rendered.length} result(s).\n${stderr}`,
    }];
  }
  return compare(rendered, results);
}

if (import.meta.main) {
  const findings = await run(Deno.args);
  if (findings.length > 0) {
    console.error(`Example behaviour check FAILED: ${findings.length} finding(s).\n`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line}\n    ${finding.message}\n`);
    }
    Deno.exit(1);
  }
  console.log('Example behaviour check passed: every documented view component escapes its input.');
}
