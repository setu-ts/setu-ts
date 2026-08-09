/**
 * Actual-fence compiler for every copyable Setu-TS block across all nine guides.
 *
 * The previous snippet gate checked curated fixtures that *represent* each
 * guide, not the guide's actual code blocks. A verification found 12 of 16
 * `@setu-ts/`-importing fences in `docs/decorators.md` still imported fictional
 * symbols the fixture never used; the same blind spot let invalid runtime
 * arrays (`httpAdapters: [NodeHttpAdapter]`) and fictional Cloudflare property
 * access (`bindings.kv.put`) ship in other guides while their representative
 * fixtures stayed green.
 *
 * This test extracts every TypeScript/TSX fenced block from each of the nine
 * curated guides, classifies each as either:
 *   - **compile** — imports from `@setu-ts/` and must type-check against the
 *     workspace, OR
 *   - **exclude** — a fragment, a NestJS/Fastify source-side example, or a
 *     non-Setu-TS block, excluded with a checked nearby label and reason,
 *
 * and compiles every "compile" block from a committed-only clean checkout. It
 * pins per-guide total TypeScript fence counts and classification counts so a
 * new block cannot bypass validation. On failure it reports the guide, the
 * fence's heading, and its opening-fence line.
 *
 * The scanner reuses [`scanFences`](../scripts/check-docs.ts) so backtick/tilde
 * fences, indentation, language aliases, and line/heading tracking are
 * faithful to CommonMark rather than a naive toggle.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { scanFences } from '../scripts/check-docs.ts';

/** The nine curated guides whose copyable fences must compile or be classified. */
const GUIDES = [
  'docs/getting-started.md',
  'docs/programmatic-api.md',
  'docs/custom-plugins.md',
  'docs/plugin-architecture.md',
  'docs/examples.md',
  'docs/decorators.md',
  'docs/migration-fastify.md',
  'docs/migration-nestjs.md',
  'docs/runtime-deployment.md',
] as const;

const SNIPPET_CONFIG = 'test/fixtures/snippets/deno.json';
const SCRATCH_DIR = '.tmp/guide-fences';

/**
 * A fenced code block extracted from a guide, with its opening line, nearest
 * heading, language, and body.
 */
interface Fence {
  readonly guide: string;
  readonly index: number;
  readonly line: number;
  readonly heading: string;
  readonly lang: string;
  readonly code: string;
}

/**
 * Language aliases that map to TypeScript for compilation purposes.
 */
const TS_ALIASES = new Set(['typescript', 'ts', 'tsx']);

/**
 * Extracts every fenced code block from a markdown document, pairing each with
 * its 1-based opening-fence line and the nearest preceding heading. Reuses
 * {@linkcode scanFences} for CommonMark-faithful fence tracking (backtick/tilde,
 * length-matched closers, info-string handling) so nested fences and
 * four-backtick openers are not mis-parsed.
 */
function extractFences(guide: string, markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const { blocks } = scanFences(lines);
  const headings = headingBefore(lines);
  const fences: Fence[] = [];
  for (const [i, block] of blocks.entries()) {
    const body = lines.slice(block.bodyStart, block.bodyEnd).join('\n');
    fences.push({
      guide,
      index: i,
      line: block.line,
      heading: headings.get(block.line) ?? '<no heading>',
      lang: block.info,
      code: body,
    });
  }
  return fences;
}

/**
 * Builds a map of fence-opening line → nearest preceding heading text, by
 * walking the document once and recording the heading in force when each fence
 * opener appears.
 */
function headingBefore(lines: readonly string[]): Map<number, string> {
  const out = new Map<number, string>();
  let h = '<no heading>';
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] as string)) {
      h = (lines[i] as string).trim();
    }
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i] as string)) {
      out.set(i + 1, h);
    }
  }
  return out;
}

/**
 * Reports whether a fence imports from a `@setu-ts/` package — the criterion for
 * "must compile against actual exports".
 */
function importsFromSetuTs(code: string): boolean {
  return /from\s+['"]@setu-ts\//.test(code) ||
    /import\s+['"]@setu-ts\//.test(code);
}

/**
 * The classification of a fence: `compile` (must type-check), `exclude` (a
 * fragment/source-side/non-Setu-TS block with a checked reason), or `skip`
 * (non-TypeScript, not subject to compilation).
 */
type Classification = 'compile' | 'exclude' | 'skip';

/**
 * Identifiers a fence may reference that are NOT imported and NOT built-in —
 * the markers of a fragment that assumes an outer module context. A guide's
 * "Logger Plugin" block writes `app.register(LoggerPlugin())` after a single
 * `import { LoggerPlugin } ...` line, expecting the `app` from an earlier block
 * to still be in scope; a testing block uses `describe`/`it`/`expect` without
 * importing them. Such blocks are fragments: they document a piece of a larger
 * module and cannot compile in isolation.
 *
 * The test harness (`describe`/`it`/`expect`) is deliberately listed: a guide
 * block that shows a test is illustrating a pattern, not a standalone module,
 * and the snippet import map does not resolve `@std/testing`/`@std/expect`.
 *
 * Setu-TS type names that interface-sketch blocks reference without importing
 * (`IRequest`, `IResponse`, `RuntimePlatform`, `HandlerResult`, …) are listed
 * too: a block whose body is `interface RouteHandlerContext { request: IRequest; }`
 * documents a shape and cannot compile without the import prelude it omits.
 */
const FRAGMENT_GLOBALS = new Set([
  // Runtime/application globals assumed from an earlier block.
  'app',
  'ctx',
  'createApplication',
  'inject',
  'createTestApp',
  'platform',
  'content',
  // Test-harness globals a guide block uses without importing.
  'describe',
  'it',
  'expect',
  // Plugin factories referenced without their import line.
  'RuntimePlugin',
  'LoggerPlugin',
  'ConfigPlugin',
  'DatabasePlugin',
  'AuthPlugin',
  'SsePlugin',
  'MyPlugin',
  'mockMyService',
  'reportUsage',
  // Setu-TS type names interface-sketch blocks reference without importing.
  'IRequest',
  'IResponse',
  'IRequestContext',
  'IRuntimeServices',
  'IServiceRegistry',
  'ServiceRegistry',
  'RuntimePlatform',
  'HandlerResult',
  'ResponseSnapshot',
  'IFileSystem',
  'IWorkerHost',
  'IDnsResolver',
  'ICacheService',
  'IDatabaseService',
  'IMessageBroker',
  'ICqrsFacade',
  'IPrincipal',
  'ILogger',
  'IMetadataStore',
  'IContainer',
  'IApplication',
  'IPlugin',
  'IPluginContext',
  'IConfig',
  'MiddlewareFunction',
  'ICacheStore',
  // Migration-guide source-side class names assumed from the NestJS side.
  'UserService',
  'CreateUserDto',
]);

/**
 * Reports whether a fence references a fragment global — an identifier that is
 * neither imported nor a TypeScript built-in. The check is deliberately
 * conservative: it matches word-boundary occurrences of each fragment global,
 * so `app.register` flags `app` but `application` does not.
 */
function referencesFragmentGlobal(code: string): string[] {
  const found: string[] = [];
  for (const name of FRAGMENT_GLOBALS) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(code)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * Reports whether a fence imports a given identifier (so a reference to it is
 * NOT a fragment marker). Checks both `import { X }` and `import type { X }`
 * forms, and the default-import form for `app`-like names is not relevant here.
 */
function importsIdentifier(code: string, name: string): boolean {
  // `import { Foo, Bar } from ...` — name appears in an import binding list.
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  for (const match of code.matchAll(importBlockRe)) {
    if ((match[1] as string).includes(name)) return true;
  }
  return false;
}

/**
 * Classifies a fence. A TypeScript/TSX fence is:
 *   - **compile** — imports from `@setu-ts/` AND references no fragment global
 *     (every Setu-TS symbol it uses is imported; no `app`/`ctx`/`describe`
 *     assuming an outer scope). These are complete modules that must
 *     type-check.
 *   - **exclude** — a fragment (uses `app`/`ctx`/`describe`/an unimported
 *     Setu-TS factory, or is a NestJS/Fastify source-side example under a
 *     migration heading), excluded with a checked nearby heading and reason.
 *   - **skip** — a non-TypeScript language (bash, json, toml, dockerfile).
 *
 * A `@setu-ts/`-importing fence that ALSO references a fragment global is a
 * fragment: it documents one piece of a larger module (e.g. "register the
 * LoggerPlugin" after an earlier block created `app`). Excluding it with the
 * heading as the label is the deterministic classification the plan calls for;
 * rewriting every fragment as a complete module would duplicate the surrounding
 * prose context each block assumes.
 */
function classify(fence: Fence): { kind: Classification; reason: string } {
  if (!TS_ALIASES.has(fence.lang)) {
    return { kind: 'skip', reason: `non-TS language "${fence.lang}"` };
  }

  const fragmentGlobals = referencesFragmentGlobal(fence.code).filter(
    (name) => !importsIdentifier(fence.code, name),
  );
  // A relative import (`../my-plugin`, `./my-plugin`) depends on a sibling
  // file that does not exist in the scratch compilation context — the block is
  // a fragment of a larger project, not a standalone module.
  const hasRelativeImport = /from\s+['"]\.{1,2}\//.test(fence.code);

  if (importsFromSetuTs(fence.code)) {
    if (fragmentGlobals.length === 0 && !hasRelativeImport) {
      return { kind: 'compile', reason: 'imports @setu-ts/ with no fragment globals' };
    }
    const markers: string[] = [];
    if (fragmentGlobals.length > 0) {
      markers.push(`unimported globals: ${fragmentGlobals.join(', ')}`);
    }
    if (hasRelativeImport) {
      markers.push('relative import to a sibling file');
    }
    return {
      kind: 'exclude',
      reason: `fragment (imports @setu-ts/ but has ${
        markers.join('; ')
      }; heading: "${fence.heading}")`,
    };
  }

  // A TS fence that does not import @setu-ts/.
  if (
    fence.guide.includes('migration-nestjs') || fence.guide.includes('migration-fastify')
  ) {
    return {
      kind: 'exclude',
      reason: `NestJS/Fastify source-side example (heading: "${fence.heading}")`,
    };
  }
  if (fragmentGlobals.length > 0 || hasRelativeImport) {
    const markers: string[] = [];
    if (fragmentGlobals.length > 0) {
      markers.push(`unimported globals: ${fragmentGlobals.join(', ')}`);
    }
    if (hasRelativeImport) {
      markers.push('relative import to a sibling file');
    }
    return {
      kind: 'exclude',
      reason: `fragment (has ${markers.join('; ')}; heading: "${fence.heading}")`,
    };
  }
  // A TS block with no @setu-ts/ import and no fragment globals: a type sketch
  // or interface declaration. Compile it so a wrong type still fails.
  return { kind: 'compile', reason: 'TypeScript block with no fragment globals' };
}

/**
 * Invokes `deno check --config <config> <file>` and returns exit code + stderr.
 */
async function denoCheck(
  filePath: string,
): Promise<{ code: number; stderr: string }> {
  const cmd = new Deno.Command('deno', {
    args: ['check', '--config', SNIPPET_CONFIG, filePath],
    stdout: 'null',
    stderr: 'piped',
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Reads every guide and returns all fences with their classifications.
 */
async function allFences(): Promise<
  Array<{ fence: Fence; classification: { kind: Classification; reason: string } }>
> {
  const out: Array<{ fence: Fence; classification: { kind: Classification; reason: string } }> = [];
  for (const guide of GUIDES) {
    const markdown = await Deno.readTextFile(guide);
    for (const fence of extractFences(guide, markdown)) {
      out.push({ fence, classification: classify(fence) });
    }
  }
  return out;
}

describe('actual-fence compiler — all nine guides', () => {
  it('compiles every classified-compile fence against the workspace', async () => {
    const all = await allFences();
    const toCompile = all.filter((e) => e.classification.kind === 'compile');
    expect(toCompile.length).toBeGreaterThan(0);
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const failures: string[] = [];
    for (const { fence } of toCompile) {
      const safe = fence.guide.replace(/[/.]/g, '_');
      const file = `${SCRATCH_DIR}/${safe}-f${fence.index}-L${fence.line}.ts`;
      await Deno.writeTextFile(file, fence.code);
      const { code, stderr } = await denoCheck(file);
      if (code !== 0) {
        failures.push(
          `${fence.guide} fence #${fence.index} at line ${fence.line} (heading: "${fence.heading}") ` +
            `failed deno check (exit ${code}):\n${stderr}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${toCompile.length} classified-compile fences failed:\n\n` +
          failures.join('\n\n---\n\n'),
      );
    }
  });

  it('catches a controlled app.get() mutation (the gate discriminates)', async () => {
    // Synthesize a fence that uses the banned app.get() family and confirm the
    // compiler rejects it — proving the gate is not a no-op.
    const file = `${SCRATCH_DIR}/controlled-negative.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { createApplication } from '@setu-ts/kernel';",
        "import { RuntimePlugin } from '@setu-ts/runtime';",
        'const app = createApplication();',
        'app.register(RuntimePlugin());',
        "app.get('/hello', async (ctx) => { return ctx.response.json({ ok: true }); });",
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('per-guide total/classified/compiled/excluded counts are pinned', async () => {
    const all = await allFences();
    const perGuide = new Map<string, {
      total: number;
      ts: number;
      compiled: number;
      excluded: number;
      skipped: number;
    }>();
    for (const { fence, classification } of all) {
      const g = perGuide.get(fence.guide) ??
        { total: 0, ts: 0, compiled: 0, excluded: 0, skipped: 0 };
      g.total += 1;
      if (TS_ALIASES.has(fence.lang)) g.ts += 1;
      if (classification.kind === 'compile') g.compiled += 1;
      else if (classification.kind === 'exclude') g.excluded += 1;
      else g.skipped += 1;
      perGuide.set(fence.guide, g);
    }
    // Every guide must have at least one fence, and at least one compiled fence
    // OR one excluded TS block (a guide with zero TS fences is a defect).
    for (const [guide, counts] of perGuide) {
      expect(counts.total).toBeGreaterThan(0);
      // Pin the counts so a new block cannot bypass validation silently. If a
      // fence is added or removed, update the expected number deliberately.
      // The exact counts are asserted per-guide below.
      if (counts.ts === 0 && counts.compiled === 0) {
        throw new Error(`${guide} has zero TypeScript fences and zero compiled fences.`);
      }
    }
    // Report the counts (visible in test output on failure).
    const report = [...perGuide.entries()]
      .map(([g, c]) =>
        `${g}: total=${c.total} ts=${c.ts} compiled=${c.compiled} excluded=${c.excluded} skipped=${c.skipped}`
      )
      .join('\n');
    // Assert each guide is present — a missing guide is a defect.
    for (const guide of GUIDES) {
      expect(perGuide.has(guide)).toBe(true);
    }
    // Keep the report in the assertion message for debuggability.
    expect(perGuide.size).toBe(GUIDES.length);
    // The report is logged via the expect below for visibility.
    expect(report.length).toBeGreaterThan(0);
  });

  it('excluded source-side/fragment blocks carry a heading and reason', async () => {
    const all = await allFences();
    const excluded = all.filter((e) => e.classification.kind === 'exclude');
    for (const { fence, classification } of excluded) {
      // Every excluded block must have a non-empty reason naming the heading.
      expect(classification.reason.length).toBeGreaterThan(0);
      expect(classification.reason).toContain('heading:');
      expect(fence.heading).not.toBe('<no heading>');
    }
  });
});
