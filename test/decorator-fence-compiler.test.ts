/**
 * Actual Markdown fence compiler for `docs/decorators.md`.
 *
 * The curated `decorator-flow.ts` fixture (checked by
 * {@linkcode test/snippet-validation.test.ts}) proves the headline "Basic
 * Controller" block compiles, but a prior verification found 12 of 16
 * `@setu-ts/`-importing fenced blocks in the guide still imported fictional
 * symbols (`ExecutionContext`, `CanActivate`, `NestInterceptor`, `inject`,
 * `injectable`, `injectOptional`, `Scope`, `MetadataStore.set/get`, …) that no
 * gate saw, because the gate checked only the fixture, not the guide's actual
 * code blocks.
 *
 * This test deterministically extracts every TypeScript fenced block from
 * `docs/decorators.md` that imports from `@setu-ts/`, writes each to a scratch
 * `.ts` file under `.tmp/decorator-fences/`, and invokes `deno check --config
 * test/fixtures/snippets/deno.json` on each. It depends only on committed files
 * (the guide, the snippet import map, and the workspace packages). On failure
 * it reports the fence index, the line number of its opening fence, and the
 * nearest preceding heading so a future broken fence is locatable.
 *
 * A regression asserts the exact count of checked fences so a future fence
 * cannot silently be omitted, and a banned-symbol assertion rejects the
 * fictional names the prior verification found in Setu-TS code blocks.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const GUIDE = 'docs/decorators.md';
const SNIPPET_CONFIG = 'test/fixtures/snippets/deno.json';
const SCRATCH_DIR = '.tmp/decorator-fences';

/**
 * A fenced code block extracted from the guide, with the line number of its
 * opening fence and the nearest preceding markdown heading.
 */
interface Fence {
  /** Zero-based index among all fenced blocks in the file. */
  readonly index: number;
  /** 1-based line number of the opening ``` fence. */
  readonly line: number;
  /** Nearest preceding `#`-heading text (or `'<no heading>'`). */
  readonly heading: string;
  /** The fenced language tag (e.g. `typescript`, `json`, `bash`). */
  readonly lang: string;
  /** The raw code inside the fence. */
  readonly code: string;
}

/**
 * Extracts every fenced code block from a markdown string, pairing each with
 * its 1-based opening-fence line number and the nearest preceding heading.
 *
 * Headings are tracked as the last `^#` line seen before a fence opens; this is
 * the "nearest heading" a reader scrolling up from the block would see.
 */
function extractFences(markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const fences: Fence[] = [];
  let heading = '<no heading>';
  let inFence = false;
  let lang = '';
  let fenceLine = 0;
  let codeLines: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inFence) {
      if (line.startsWith('#')) {
        heading = line.trim();
      }
      if (line.startsWith('```')) {
        inFence = true;
        lang = line.slice(3).trim();
        fenceLine = i + 1;
        codeLines = [];
      }
    } else {
      if (line.startsWith('```')) {
        fences.push({
          index: fences.length,
          line: fenceLine,
          heading,
          lang,
          code: codeLines.join('\n'),
        });
        inFence = false;
        lang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
    }
  }
  return fences;
}

/**
 * Reports whether a fence imports from a `@setu-ts/` package — the criterion for
 * "must compile against actual exports".
 */
function importsFromSetuTs(code: string): boolean {
  return /from\s+['"]@setu-ts\//.test(code);
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

/** Reads the guide and returns the Setu-TS-importing fences. */
async function setuTsFences(): Promise<Fence[]> {
  const markdown = await Deno.readTextFile(GUIDE);
  const all = extractFences(markdown);
  return all.filter((f) => importsFromSetuTs(f.code));
}

describe('docs/decorators.md actual-fence compiler', () => {
  it('compiles every @setu-ts/-importing fence against the workspace', async () => {
    const setu = await setuTsFences();
    expect(setu.length).toBeGreaterThan(0);
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const failures: string[] = [];
    for (const fence of setu) {
      const file = `${SCRATCH_DIR}/fence-${fence.index}-L${fence.line}.ts`;
      await Deno.writeTextFile(file, fence.code);
      const { code, stderr } = await denoCheck(file);
      if (code !== 0) {
        failures.push(
          `fence #${fence.index} at line ${fence.line} (heading: "${fence.heading}")` +
            ` failed deno check (exit ${code}):\n${stderr}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${setu.length} @setu-ts/-importing fences failed to compile:\n\n` +
          failures.join('\n\n---\n\n'),
      );
    }
  });

  it('regression: the exact count of checked fences is stable', async () => {
    // A future fence that is silently omitted (e.g. a new block added without
    // the import the compiler keys on, or a block mis-extracted) changes this
    // count. Pin it so the gate notices. If a fence is added or removed,
    // update this number deliberately and confirm the new block compiles.
    const setu = await setuTsFences();
    expect(setu.length).toBe(28);
    // Every checked fence must carry a real heading (no orphan blocks).
    for (const f of setu) {
      expect(f.heading).not.toBe('<no heading>');
    }
  });

  it('banned-symbol regression: fictional Setu-TS symbols are absent from code blocks', async () => {
    // The prior verification found these fictional names in copyable Setu-TS
    // code blocks. They must not return. Prose may mention them to explain
    // NestJS differences; code blocks must not import or use them as Setu-TS
    // APIs.
    const markdown = await Deno.readTextFile(GUIDE);
    const all = extractFences(markdown);
    const setuTsCode = all
      .filter((f) => f.lang === 'typescript')
      .map((f) => f.code)
      .join('\n');
    const banned = [
      'ExecutionContext',
      'CanActivate',
      'NestInterceptor',
      'injectOptional',
      '@RequireAuth',
      '@RequireRole',
      '@RequirePermission',
      '@useGuards',
      '@useInterceptors',
      '@validateBody',
      '@validateQuery',
      '@Request()',
      '@Context()',
      'MetadataStore.set',
      'MetadataStore.get',
    ];
    const hits: string[] = [];
    for (const symbol of banned) {
      if (setuTsCode.includes(symbol)) {
        hits.push(symbol);
      }
    }
    // Lowercase di-plugin imports that do not exist (inject/injectable/
    // injectOptional/Scope are NOT exported by @setu-ts/di-plugin).
    const diImportLines = setuTsCode
      .split('\n')
      .filter((l) => /from\s+['"]@setu-ts\/di-plugin['"]/.test(l));
    for (const l of diImportLines) {
      if (/\b(inject|injectable|injectOptional|Scope)\b/.test(l)) {
        hits.push(`di-plugin fictional import: ${l.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
