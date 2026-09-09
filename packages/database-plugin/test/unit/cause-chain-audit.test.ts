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
        if (block.body.includes(DROPS_CAUSE_MARKER)) {
          continue;
        }
        for (const replacement of replacementThrows(block.body)) {
          if (!forwardsCaughtValue(block.binding, replacement)) {
            violations.push(`${file.name}:${lineAt(source, block.start)}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('rejects unrelated causes and indirectly thrown replacement errors', () => {
    const unrelatedCause =
      "catch (error) { const metadata = { cause: error }; throw new Error('replacement'); }";
    const indirectReplacement =
      "catch (error) { const replacement = new Error('replacement'); throw replacement; }";

    expect(replacementThrows(catchBlocks(unrelatedCause).next().value?.body ?? '')).toHaveLength(1);
    expect(replacementThrows(catchBlocks(indirectReplacement).next().value?.body ?? ''))
      .toHaveLength(1);
    expect(forwardsCaughtValue('error', "new Error('replacement')")).toBe(false);
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

/** Finds direct and variable-backed replacement errors that a catch actually throws. */
function replacementThrows(body: string): string[] {
  const replacements: string[] = [];
  for (const match of body.matchAll(/\bthrow\s+(new\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\()/g)) {
    const start = (match.index ?? 0) + match[0].indexOf('new ');
    const end = statementEnd(body, start);
    replacements.push(body.slice(start, end));
  }
  for (
    const match of body.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(new\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\()/g,
    )
  ) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].lastIndexOf('new ');
    const end = statementEnd(body, start);
    if (new RegExp(`\\bthrow\\s+${name}\\b`).test(body.slice(end))) {
      replacements.push(body.slice(start, end));
    }
  }
  return replacements;
}

/** Returns the end of a statement while respecting nested delimiters and strings. */
function statementEnd(source: string, start: number): number {
  const delimiters: string[] = [];
  let quote: string | undefined;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === '\\') index++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(' || character === '[' || character === '{') {
      delimiters.push(character);
    } else if (character === ')' || character === ']' || character === '}') {
      delimiters.pop();
    } else if (character === ';' && delimiters.length === 0) {
      return index;
    }
  }
  return source.length;
}

/** Determines whether one replacement constructor forwards its catch binding. */
function forwardsCaughtValue(binding: string | undefined, replacement: string): boolean {
  const identifier = binding?.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
  if (identifier === undefined) return false;
  const opening = replacement.indexOf('(');
  const closing = opening < 0 ? undefined : closingDelimiter(replacement, opening);
  if (closing === undefined) return false;
  const arguments_ = topLevelArguments(replacement.slice(opening + 1, closing)).filter((argument) =>
    argument.trim().length > 0
  );
  const options = arguments_[arguments_.length - 1];
  if (options === undefined) return false;
  if (identifier === 'cause') {
    return /\{[\s\S]*?\bcause\s*(?:[,}])/.test(options);
  }
  return new RegExp(`\\{[\\s\\S]*?\\bcause\\s*:\\s*${identifier}\\b`).test(options);
}

/** Finds the matching closing parenthesis for a constructor call. */
function closingDelimiter(source: string, opening: number): number | undefined {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index++) {
    if (source[index] === '(') depth++;
    if (source[index] === ')') depth--;
    if (depth === 0) return index;
  }
  return undefined;
}

/** Splits constructor arguments only at their top-level commas. */
function topLevelArguments(source: string): string[] {
  const arguments_: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '(' || source[index] === '[' || source[index] === '{') depth++;
    if (source[index] === ')' || source[index] === ']' || source[index] === '}') depth--;
    if (source[index] === ',' && depth === 0) {
      arguments_.push(source.slice(start, index));
      start = index + 1;
    }
  }
  arguments_.push(source.slice(start));
  return arguments_;
}
