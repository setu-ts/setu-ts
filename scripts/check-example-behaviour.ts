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
 * The second payload, substituted into every prop for the URL check: a scheme
 * hostile enough to matter and free of HTML metacharacters, which is exactly
 * why the escaping that neutralises {@linkcode HOSTILE} does nothing to it.
 * X46-1: `<a href={props.note.link}>` with a stored `javascript:alert(1)`
 * kept the scheme verbatim in real Chrome, and clicking it executed.
 */
export const URL_PAYLOAD = 'javascript:alert(1)';

/**
 * The output-side assertion for {@linkcode URL_PAYLOAD}. The payload goes into
 * EVERY prop — the gate cannot know which one a component routes into a URL —
 * so the defect is decided on the OUTPUT: the scheme is a finding only when
 * the rendered markup carries it in a URL attribute. In a text child, or in a
 * non-navigational attribute (`value`, `title`), a scheme is inert in a
 * browser and is not a finding. `xlink:href` matches on the suffix.
 */
export const URL_SCHEME_PATTERN = /(?:href|src|action)\s*=\s*(["']?)\s*javascript:/i;

/**
 * The comment label exempting a component from probe coverage.
 *
 * The probe delivers its payloads through a props `Proxy` and stubs `raw()`
 * to a benign marker, so a component whose own source routes a value through
 * `raw(...)` — or spreads an identifier into an element (`{...props}`) — is
 * rendered WITHOUT its real data path: the gate cannot have delivered either
 * payload into the output, and reporting a clean render for it would be the
 * worst failure mode a security gate has. Such a component is therefore
 * reported `unchecked` and FAILS, unless its own attached comment carries this
 * label with the reason spelled out — the same convention as
 * {@linkcode COUNTER_EXAMPLE_MARKERS}, so the exemption travels with the
 * example in the document instead of in a per-file list in here.
 */
export const UNCHECKED_EXEMPT_MARKERS: readonly string[] = ['UNCHECKED-EXEMPT'];

/**
 * The exemption as it must actually be written: the marker, a colon, and a
 * non-empty reason.
 *
 * A bare `includes(marker)` accepted the marker alone, and accepted prose that
 * merely MENTIONS it — `// never write UNCHECKED-EXEMPT here` exempted the
 * component it sat above. That direction is the dangerous one, because it
 * SUPPRESSES an unchecked-path finding: the gate then reports a clean render
 * for markup it could not have delivered a payload into. Both collection paths
 * read this one pattern, so they cannot disagree about what an exemption is.
 */
const UNCHECKED_EXEMPT_PATTERN = new RegExp(
  `(?:${UNCHECKED_EXEMPT_MARKERS.join('|')})\\s*:\\s*\\S`,
);

/**
 * Whether an attached comment carries a well-formed exemption.
 *
 * @param comment - The comment block attached above a definition
 * @returns True when the documented `MARKER: <reason>` form is present
 */
function isExempt(comment: string): boolean {
  return UNCHECKED_EXEMPT_PATTERN.test(comment);
}

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
  /** True when the component spreads an identifier into an element (`{...`). */
  readonly spreads: boolean;
  /**
   * True when the component's own comment carries an exemption label
   * ({@linkcode UNCHECKED_EXEMPT_MARKERS}) naming the reason its data path is
   * allowed to sit outside what the probe can check.
   */
  readonly exempt: boolean;
  /** Fence-local `const` definitions the component references, in source order. */
  readonly dependencies: readonly string[];
}

/** A view-shaped definition the probe will never render, so cannot check. */
export interface BlindSpot {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** True when the definition's own comment carries an exemption label. */
  readonly exempt: boolean;
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
 * Advances past a comment at `index`, if one starts there.
 *
 * Load-bearing, not defensive. `decorator-plugin`'s README carries a comment
 * quoting a template literal — ``// `(props) => \`<li>${user}</li>\`` `` — and a
 * walker that does not skip comments enters quote state on that backtick,
 * never leaves, and silently stops seeing declarations for the rest of the
 * fence. The document dropped out of this gate's coverage entirely.
 *
 * @param code - The source being scanned
 * @param index - The current offset
 * @returns The offset after the comment, or the same offset when none starts here
 */
export function skipComment(code: string, index: number): number {
  if (code[index] === '/' && code[index + 1] === '/') {
    const end = code.indexOf('\n', index);
    return end === -1 ? code.length : end;
  }
  if (code[index] === '/' && code[index + 1] === '*') {
    const end = code.indexOf('*/', index + 2);
    return end === -1 ? code.length : end + 2;
  }
  return index;
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
  const start = code.search(
    new RegExp(`\\b(?:const\\s+${name}\\s*[=:]|function\\s+${name}\\s*[(<])`),
  );
  if (start === -1) return null;
  // A function declaration has no terminating semicolon: it ends when its body
  // brace closes.
  const isFunction = /^\s*function\b/.test(code.slice(start, start + 12));

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < code.length; i++) {
    if (quote === null) {
      const skipped = skipComment(code, i);
      if (skipped !== i) {
        i = skipped - 1;
        continue;
      }
    }
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
    else if (!isFunction && ch === ';' && depth === 0) return code.slice(start, i + 1);
    if (isFunction && ch === '}' && depth === 0) return code.slice(start, i + 1);
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
 * Every `const` a fence declares at its TOP level, with its offset.
 *
 * Depth matters: a fence's route handler declares its own locals — `const form
 * = await readForm(ctx)` in `docs/mvc.md` — and lifting one of those into the
 * probe produced a `ReferenceError` for a helper that only exists inside the
 * handler. A component and its scaffolding are module-level; a handler's
 * locals are not.
 *
 * @param code - The fence body
 * @returns One entry per top-level declaration, in source order
 */
export function topLevelConsts(code: string): readonly { name: string; index: number }[] {
  // `const X = …`, `const X: T = …`, `function X(…)` and their `export` forms.
  // A component written as a function declaration used to be invisible, so a
  // `@Render(UserList)` naming one was never rendered.
  const DECLARATION =
    /^(?:export\s+)?(?:const\s+([A-Za-z_$][\w$]*)\s*[=:]|function\s+([A-Za-z_$][\w$]*)\s*[(<])/;
  const found: { name: string; index: number }[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    if (quote === null) {
      const skipped = skipComment(code, i);
      if (skipped !== i) {
        i = skipped - 1;
        continue;
      }
    }
    const ch = code[i]!;
    if (quote !== null) {
      if (ch === quote && code[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      continue;
    }
    if (depth !== 0 || (ch !== 'c' && ch !== 'f' && ch !== 'e')) continue;
    const match = DECLARATION.exec(code.slice(i));
    if (match === null) continue;
    const before = code[i - 1];
    if (before !== undefined && /[\w$.]/.test(before)) continue;
    // `export function X` matches at both `e` and the inner `f`; keep the
    // outer one. Skipping ahead instead would step over the opening paren and
    // break the depth tracking every later decision depends on.
    if (ch === 'f' && /\bexport\s+$/.test(code.slice(Math.max(0, i - 12), i))) continue;
    found.push({ name: (match[1] ?? match[2])!, index: i });
  }
  return found;
}

/**
 * The fence-local `const` definitions a component references.
 *
 * A component is rarely alone in its fence: `docs/mvc.md`'s `Page` interpolates
 * a `CLIENT` script defined beside it, and lifting the component without it
 * left a `ReferenceError` that the gate reported as a defect in the document.
 * Only definitions the component actually names are lifted, so an unrelated
 * sibling cannot drag its own failure into the probe.
 *
 * @param code - The fence body
 * @param source - The component's own definition, excluded from the result
 * @returns The referenced definitions, in the order the fence declares them
 */
export function localDependencies(code: string, source: string): readonly string[] {
  const referenced = new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const found: string[] = [];
  for (const { name } of topLevelConsts(code)) {
    if (!referenced.has(name)) continue;
    const definition = extractDefinition(code, name);
    if (definition === null || definition === source) continue;
    found.push(definition);
  }
  return found;
}

/**
 * Whether a definition is a view component rather than a context-taking helper.
 *
 * `renderComponent` renders a `Component<P>` — a function of a PROPS BAG. A
 * documented helper such as `session-plugin`'s `LoginForm`, whose parameter is
 * an `IRequestContext`, is neither, and probing it with a synthetic context
 * only ever produces a throw from the real service it calls. Excluded by its
 * SIGNATURE rather than by name, so the exclusion cannot quietly widen.
 *
 * @param source - The component's definition
 * @returns True when the definition takes a props bag
 */
export function takesProps(source: string): boolean {
  return !/\(\s*[A-Za-z_$][\w$]*\s*:\s*IRequestContext\b/.test(source);
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
    for (const { name, index } of topLevelConsts(fence.code)) {
      if (!/^[A-Z]/.test(name) || seen.has(name)) continue;
      const source = extractDefinition(fence.code, name);
      if (source === null || !MARKUP.test(source) || !takesProps(source)) continue;
      seen.add(name);
      const before = attachedComment(fence.code.slice(0, index));
      found.push({
        file,
        line: fence.line,
        name,
        source,
        expectUnsafe: COUNTER_EXAMPLE_MARKERS.some((marker) => before.includes(marker)),
        usesRaw: /\braw\s*\(/.test(source),
        spreads: /\{\.\.\./.test(source),
        exempt: isExempt(before),
        dependencies: localDependencies(fence.code, source),
      });
    }
  }
  return found;
}

/**
 * Collects view-shaped definitions the probe will NOT render, whose source
 * still routes a value through `raw()` or an element spread.
 *
 * The renderer only probes components taking a props bag — a helper whose
 * parameter is an `IRequestContext` is excluded by signature (see
 * {@linkcode takesProps}). Exclusion is the right rendering decision and the
 * wrong coverage decision: such a helper can carry exactly the same hazards
 * into the page, invisible to both payloads. Each one is reported so the
 * gate's blind spots stay enumerated rather than silent; only an exemption
 * label on the definition's own comment keeps it from failing the run.
 *
 * @param file - The document's path
 * @param markdown - Its contents
 * @returns One entry per unrenderable definition whose data path the probe cannot check
 */
export function collectUnrenderedBlindSpots(
  file: string,
  markdown: string,
): readonly BlindSpot[] {
  const found: BlindSpot[] = [];
  if (!RENDERS_VIEWS.test(markdown)) return found;

  for (const fence of extractFences(file, markdown)) {
    if (!TS_ALIASES.has(fence.lang)) continue;
    if (classify(fence).kind === 'skip') continue;
    const seen = new Set<string>();
    for (const { name, index } of topLevelConsts(fence.code)) {
      if (!/^[A-Z]/.test(name) || seen.has(name)) continue;
      const source = extractDefinition(fence.code, name);
      if (source === null || !MARKUP.test(source) || takesProps(source)) continue;
      seen.add(name);
      if (!/\braw\s*\(/.test(source) && !/\{\.\.\./.test(source)) continue;
      const before = attachedComment(fence.code.slice(0, index));
      found.push({
        file,
        line: fence.line,
        name,
        exempt: isExempt(before),
      });
    }
  }
  return found;
}

/**
 * One finding per unexempted definition the probe can never render.
 *
 * @param spots - The blind spots collected across the scanned documents
 * @returns A finding for each spot whose comment carries no exemption
 */
export function blindSpotFindings(spots: readonly BlindSpot[]): readonly Finding[] {
  return spots
    .filter((spot) => !spot.exempt)
    .map((spot) => ({
      file: spot.file,
      line: spot.line,
      message: `${spot.name} is UNCHECKED: it is not a props component, so the probe never ` +
        `renders it, and its source routes a value through raw() or an element spread — ` +
        `the gate cannot see what reaches the page. Carry an ` +
        `// ${UNCHECKED_EXEMPT_MARKERS[0]}: <reason> comment above it, or reshape it into ` +
        `a props component the gate can render.`,
    }));
}

/**
 * Builds the probe module that renders each component twice — once with
 * {@linkcode HOSTILE} in every prop, once with {@linkcode URL_PAYLOAD} — and
 * prints one JSON line per component carrying both verdicts.
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
${c.dependencies.join('\n')}
${c.source}
try {
  const out = await renderComponent(${c.name} as never, props);
  const outUrl = await renderComponent(${c.name} as never, urlProps);
  console.log(JSON.stringify({
    index: ${index},
    ok: true,
    escaped: !out.includes(HOSTILE),
    scheme: URL_SCHEME.test(outUrl),
  }));
} catch (error) {
  console.log(JSON.stringify({ index: ${index}, ok: false, error: String(error) }));
}
}`
  ).join('\n\n');

  return `/** @jsxImportSource @hono/hono/jsx */
import { renderComponent } from '../../packages/view-plugin/src/render/normalize.ts';
import { html } from '@hono/hono/html';

const HOSTILE = ${JSON.stringify(HOSTILE)};
const URL_PAYLOAD = ${JSON.stringify(URL_PAYLOAD)};
const URL_SCHEME = /(?:href|src|action)\\s*=\\s*(["']?)\\s*javascript:/i;

// A sentinel that answers EVERY read with itself, so a nested access reaches
// the payload as readily as a direct one. The first cut returned a plain
// [HOSTILE] array, which made \`props.values.title\` resolve to \`undefined\` —
// and \`docs/mvc.md\`'s TaskForm, a plain template literal interpolating
// SUBMITTED FORM DATA, scored as escaped.
//
// Array-backed so \`props.users.map(fn)\` still works, and it stringifies to the
// payload so a direct interpolation carries it. It is never nullish, so
// \`props.errors.title ?? ''\` does not fall through to the empty string.
const makeProps = (payload: string): never => {
  const props: never = new Proxy([payload], {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => payload;
      if (key === 'toString' || key === 'valueOf') return () => payload;
      if (key in target) {
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return props;
    },
  }) as never;
  return props;
};
const props = makeProps(HOSTILE);
const urlProps = makeProps(URL_PAYLOAD);

// \`raw()\` is the documented opt-out, so its argument must NOT carry the
// payload — otherwise the opt-out reports itself as a defect. Stubbed to a
// benign marker rather than exempting the whole component, which would have
// stopped checking every OTHER interpolation beside it.
const raw = (_value: unknown): string => '<!--raw-->';
void html;
void raw;

${body}
`;
}

/** One component's rendered outcome, as reported by the probe. */
export type ProbeResult =
  | {
    readonly index: number;
    readonly ok: true;
    readonly escaped: boolean;
    readonly scheme: boolean;
  }
  | { readonly index: number; readonly ok: false; readonly error: string };

/**
 * Parses probe output, refusing an incomplete batch.
 *
 * A short batch means the probe died partway, which must fail the gate rather
 * than silently check fewer components than it collected. Every field is
 * validated, and out-of-order or duplicate indices are refused: a record
 * carrying only `ok` reached {@link compare} with `escaped` undefined, which a
 * counter-example reads as "still unsafe" — a malformed batch that PASSES.
 *
 * @param stdout - JSON-lines output
 * @param expected - How many components were rendered
 * @returns The results, or null when the batch is incomplete or malformed
 */
export function parseProbe(stdout: string, expected: number): readonly ProbeResult[] | null {
  const lines = stdout.trim().length === 0 ? [] : stdout.trim().split('\n');
  if (lines.length !== expected) return null;
  const results: ProbeResult[] = [];
  for (const [position, line] of lines.entries()) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof decoded !== 'object' || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    // Each field is checked, and the index must be the one this position
    // expects. A record carrying only `ok` used to be accepted, and its
    // missing `escaped` reached `compare` as `undefined` — falsy, which a
    // counter-example reads as "still unsafe", so a malformed batch could
    // PASS. Fail closed instead.
    if (record['index'] !== position) return null;
    if (typeof record['ok'] !== 'boolean') return null;
    if (record['ok'] === true) {
      if (typeof record['escaped'] !== 'boolean') return null;
      if (typeof record['scheme'] !== 'boolean') return null;
      results.push({
        index: position,
        ok: true,
        escaped: record['escaped'],
        scheme: record['scheme'],
      });
      continue;
    }
    if (typeof record['error'] !== 'string') return null;
    results.push({ index: position, ok: false, error: record['error'] });
  }
  return results;
}

/**
 * Compares each rendered outcome with what its document claims.
 *
 * Three verdicts per component. The ESCAPE verdict against {@linkcode HOSTILE}
 * — reversed for a labelled counter-example, whose warning must stay true.
 * The URL verdict — a component carrying no counter-example label must not
 * render {@linkcode URL_PAYLOAD} into a URL attribute (a labelled one is
 * demonstrating the escape hazard and its comment already owns the warning).
 * And UNCHECKED — a component whose own source routes a value through `raw()`
 * or an element spread is reported and fails unless its comment carries an
 * exemption label, because the probe stubs that path out and could not have
 * delivered either payload through it: silence there would read as a pass for
 * a component the gate never actually checked.
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
    const unchecked: string[] = [];
    if (component.usesRaw) unchecked.push('`raw()`');
    if (component.spreads) unchecked.push('an element spread (`{...`)');
    if (unchecked.length > 0 && !component.exempt) {
      findings.push({
        file: component.file,
        line: component.line,
        message: `${component.name} is UNCHECKED: its own source routes a value through ` +
          `${unchecked.join(' and ')}, which the probe stubs out — neither payload provably ` +
          `reached its output, so a clean render here means nothing. Remove the indirection, ` +
          `or carry an // ${UNCHECKED_EXEMPT_MARKERS[0]}: <reason> comment above the component.`,
      });
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
    if (!component.expectUnsafe && result.scheme) {
      findings.push({
        file: component.file,
        line: component.line,
        message: `${component.name} renders ${JSON.stringify(URL_PAYLOAD)} into a URL ` +
          `attribute (href, src or action). Escaping protects HTML structure, not URL ` +
          `schemes — a metacharacter-free payload survives it intact, and clicking the ` +
          `link executes. Validate the scheme of a user-supplied URL before it reaches ` +
          `the view.`,
      });
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
    } catch (error) {
      // A missing root is ordinary — a caller may name one that does not
      // exist. Anything else (a permission error, an I/O fault) would
      // silently omit that directory's documents and let the gate pass with
      // incomplete coverage, so it propagates.
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
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
  const blindSpots: BlindSpot[] = [];
  for (const file of documents) {
    let markdown: string;
    try {
      markdown = await Deno.readTextFile(file);
    } catch {
      return [{ file, line: 1, message: 'could not be read' }];
    }
    components.push(...collectComponents(file, markdown));
    blindSpots.push(...collectUnrenderedBlindSpots(file, markdown));
  }
  // Every component is rendered, `raw()` included. An earlier cut skipped a
  // component whose source mentioned `raw` at all, which stopped checking
  // every OTHER interpolation beside the opted-out one — a component mixing
  // trusted markup with a user-controlled field was exempt in full. The
  // opt-out is neutralised per CALL inside the probe instead.
  const rendered = components;
  if (rendered.length === 0) return blindSpotFindings(blindSpots);

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
  if (!outcome.success) {
    // A component can print its result and then fail the process — an
    // unhandled rejection scheduled during rendering, say. The batch would be
    // complete and the gate would report success.
    const stderr = new TextDecoder().decode(outcome.stderr).trim();
    return [{ file: PROBE, line: 1, message: `the render probe exited non-zero.\n${stderr}` }];
  }
  const results = parseProbe(stdout, rendered.length);
  if (results === null) {
    const stderr = new TextDecoder().decode(outcome.stderr).trim();
    return [{
      file: PROBE,
      line: 1,
      message: `the render probe did not report ${rendered.length} result(s).\n${stderr}`,
    }];
  }
  return [...compare(rendered, results), ...blindSpotFindings(blindSpots)];
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
  console.log(
    'Example behaviour check passed: every documented view component escapes its input, ' +
      `carries no ${URL_PAYLOAD} into a URL attribute, and nothing documented is unchecked.`,
  );
}
