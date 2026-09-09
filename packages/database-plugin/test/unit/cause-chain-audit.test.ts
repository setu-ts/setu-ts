/** Guards database error wrappers from silently discarding a caught cause. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const ADAPTERS_DIRECTORY = new URL('../../src/adapters/', import.meta.url);
const DROPS_CAUSE_MARKER = 'drops-cause:';

describe('database adapter error causes', () => {
  it('requires a replacement error thrown from catch to forward its cause', async () => {
    const violations: string[] = [];
    for await (const file of sourceFiles(ADAPTERS_DIRECTORY)) {
      const source = await Deno.readTextFile(file.url);
      for (const block of catchBlocks(source)) {
        if (!/throw new\s+[A-Za-z]/.test(block.body) || block.body.includes(DROPS_CAUSE_MARKER)) {
          continue;
        }
        if (!forwardsCaughtValue(block.binding, block.body)) {
          violations.push(`${file.name}:${lineAt(source, block.start)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function* sourceFiles(directory: URL): AsyncGenerator<{ name: string; url: URL }> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, directory);
    if (entry.isDirectory) {
      yield* sourceFiles(url);
    } else if (entry.isFile && entry.name.endsWith('.ts')) {
      yield { name: entry.name, url };
    }
  }
}

function* catchBlocks(
  source: string,
): Generator<{ binding: string | undefined; body: string; start: number }> {
  const matcher = /catch\s*(?:\(([^)]*)\))?\s*\{/g;
  for (const match of source.matchAll(matcher)) {
    const openingBrace = (match.index ?? 0) + match[0].length - 1;
    const end = closingBrace(source, openingBrace);
    if (end === undefined) continue;
    yield { binding: match[1], body: source.slice(openingBrace + 1, end), start: match.index ?? 0 };
  }
}

function closingBrace(source: string, openingBrace: number): number | undefined {
  let depth = 1;
  for (let index = openingBrace + 1; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}') depth--;
    if (depth === 0) return index;
  }
  return undefined;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function forwardsCaughtValue(binding: string | undefined, body: string): boolean {
  const identifier = binding?.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
  if (identifier === undefined) return false;
  if (identifier === 'cause') {
    return /\{\s*cause\s*(?:[,}])/.test(body);
  }
  return new RegExp(`\\{\\s*cause\\s*:\\s*${identifier}\\b`).test(body);
}
