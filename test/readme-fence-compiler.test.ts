/**
 * Recurrence gate (M70i §3.10a): every copyable TypeScript fence in the two
 * package READMEs this repo owns as user-facing entry points —
 * `packages/grpc-plugin/README.md` and `packages/graphql-plugin/README.md` —
 * compiles against the workspace.
 *
 * X6-2's diagnosis: the M38 fence engine enumerates ten `docs/*.md` guides, so
 * no package-README fence is ever compiled. This gate extends the same
 * machinery (`scanFences`, the snippet import map) to those two READMEs, with
 * the guide compiler's four classifications reduced to the one that matters
 * here: a fence that imports from `@setu-ts/` must compile.
 *
 * Discrimination (observed during M70i): reintroducing a Usage sequence that
 * resolves `CAPABILITIES.GRPC` before `app.start()` fails this gate with
 * "No service registered for capability 'grpc'" at type level via the missing
 * import map entry, and any fictional symbol fails `deno check`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { scanFences } from '../scripts/check-docs.ts';

const SNIPPET_CONFIG = 'test/fixtures/snippets/deno.json';
const SCRATCH_DIR = '.tmp/readme-fences';

/** The package READMEs this gate owns. */
const PACKAGE_READMES = [
  'packages/grpc-plugin/README.md',
  'packages/graphql-plugin/README.md',
] as const;

/** A fenced code block extracted from a markdown file. */
interface Fence {
  readonly file: string;
  /** 1-based line number of the opening ``` fence. */
  readonly line: number;
  readonly heading: string;
  readonly lang: string;
  readonly code: string;
}

/**
 * Extracts every fenced block from a markdown string using the shared
 * CommonMark-faithful scanner, pairing each with its opening-fence line and
 * nearest preceding heading.
 */
function extractFences(file: string, markdown: string): Fence[] {
  const lines = markdown.split('\n');
  const { blocks } = scanFences(lines);
  const fences: Fence[] = [];
  let heading = '<no heading>';
  let lineIndex = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i] as string)) {
      heading = (lines[i] as string).trim();
    }
    if (lineIndex < blocks.length && (blocks[lineIndex] as { line: number }).line === i + 1) {
      const block = blocks[lineIndex]!;
      fences.push({
        file,
        line: block.line,
        heading,
        lang: block.info,
        code: lines.slice(block.bodyStart, block.bodyEnd).join('\n'),
      });
      lineIndex += 1;
    }
  }
  return fences;
}

/** True when a fence imports from a `@setu-ts/` package. */
function importsFromSetuTs(code: string): boolean {
  return /from\s+['"]@setu-ts\//.test(code);
}

/** Invokes `deno check --config <config> <file>` and returns exit code + stderr. */
async function denoCheck(filePath: string): Promise<{ code: number; stderr: string }> {
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

describe('package README actual-fence compiler (M70i §3.10a)', () => {
  it('compiles every @setu-ts/-importing fence in both owned package READMEs', async () => {
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const failures: string[] = [];
    let checked = 0;
    for (const readme of PACKAGE_READMES) {
      const markdown = await Deno.readTextFile(readme);
      const setu = extractFences(readme, markdown)
        .filter((f) => (f.lang === 'typescript' || f.lang === 'ts') && importsFromSetuTs(f.code));
      checked += setu.length;
      for (const fence of setu) {
        const slug = readme.split('/')[1]!.replace(/[^a-z]/g, '');
        const file = `${SCRATCH_DIR}/${slug}-L${fence.line}.ts`;
        await Deno.writeTextFile(file, fence.code);
        const { code, stderr } = await denoCheck(file);
        if (code !== 0) {
          failures.push(
            `${readme} fence at line ${fence.line} (heading: "${fence.heading}")` +
              ` failed deno check (exit ${code}):\n${stderr}`,
          );
        }
      }
    }
    // Both READMEs must contribute: a silent rename would empty the gate.
    expect(checked).toBeGreaterThanOrEqual(4);
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} README fence(s) failed to compile:\n\n${failures.join('\n\n---\n\n')}`,
      );
    }
  });
});
