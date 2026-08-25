import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/**
 * The recurrence gate §3.12 of the M72 plan commits to: nothing under
 * `packages/cli/src` may prompt, read stdin, or terminate the process, because
 * `runCli` returns an exit code and every gate drives it in-process.
 *
 * An ALLOWLIST, not a bare grep, for two reasons. A bare grep false-positives
 * on EMITTED source — `src/workspace/dev-runner.ts` carries `Deno.exit` inside
 * the runner source the CLI writes into a generated workspace, which this
 * process never executes. And a bare grep cannot see its own allowlist grow:
 * the membership assertion below is the M37c `ALLOW_SKIP` lesson, so adding a
 * third entry is a visible edit to THIS file, never a silent exemption.
 */
const PATTERNS = [/prompt\(/, /confirm\(/, /Deno\.stdin/, /Deno\.exit/] as const;

/** The only files allowed to carry one, and why each earns its place. */
const ALLOWLIST = [
  'src/main.ts', // The process boundary: Deno.stdin.isTerminal(), the single exit.
  'src/workspace/dev-runner.ts', // Emitted runner source; its matches are written, never run here.
] as const;

/** The package's own src directory, resolved independently of the CWD. */
const SRC_DIR = new URL('../../src', import.meta.url).pathname.replace(/\/$/, '');

describe('the process boundary of packages/cli/src', () => {
  it('carries no prompt, stdin or exit reference outside the allowlist', async () => {
    const offenders: string[] = [];
    for await (const entry of walk(SRC_DIR)) {
      // Paths are package-relative (`src/main.ts`), matching the allowlist.
      const relative = `src/${entry.slice(SRC_DIR.length + 1)}`;
      if ((ALLOWLIST as readonly string[]).includes(relative)) continue;
      const source = stripComments(await Deno.readTextFile(entry));
      for (const pattern of PATTERNS) {
        if (pattern.test(source)) offenders.push(`${relative}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the allowlist to exactly its two named entries', () => {
    // A third entry is a visible edit to THIS constant, reviewed as such.
    expect([...ALLOWLIST].sort()).toEqual(['src/main.ts', 'src/workspace/dev-runner.ts']);
  });
});

/**
 * Lists every `.ts` file under a directory, recursively.
 *
 * @param dir - Directory to walk
 * @returns Absolute paths of the `.ts` files found
 */
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

/**
 * Removes comments from TypeScript source, leaving strings intact.
 *
 * The sweep targets CODE, not prose: JSDoc legitimately names these APIs when
 * explaining that the CLI does NOT use them. String literals are tracked so a
 * `'http://…'` inside one is not mistaken for a comment opener.
 *
 * @param source - The file contents
 * @returns The source without comments
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    out += char;
  }
  return out;
}
