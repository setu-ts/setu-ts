/** JSON and JSONC manifest reading shared by CLI project detection. */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';

/** Result of reading a project manifest. */
export type ManifestRead =
  | { readonly kind: 'ok'; readonly value: unknown; readonly format: 'json' | 'jsonc' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string };

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Removes JSONC comments without changing comment-like text inside strings. */
function stripComments(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      let closed = false;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') result += '\n';
        index += 1;
      }
      if (index < source.length) closed = true;
      if (!closed) throw new SyntaxError('Unterminated block comment');
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

/** Removes commas immediately before an object or array closing delimiter. */
function stripTrailingCommas(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }
    if (current === ',') {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? '')) lookahead += 1;
      if (source[lookahead] === '}' || source[lookahead] === ']') continue;
    }
    result += current;
  }
  return result;
}

/** Reads a JSON manifest, accepting JSONC for read-only inspection. */
export async function readJsonManifest(fs: IFileSystem, path: string): Promise<ManifestRead> {
  let source: string;
  try {
    source = new TextDecoder().decode(await fs.readFile(path));
  } catch (cause) {
    return isMissingPath(cause)
      ? { kind: 'missing' }
      : { kind: 'unreadable', reason: failureMessage(cause) };
  }
  try {
    return { kind: 'ok', value: JSON.parse(source), format: 'json' };
  } catch {
    try {
      return {
        kind: 'ok',
        value: JSON.parse(stripTrailingCommas(stripComments(source))),
        format: 'jsonc',
      };
    } catch (cause) {
      return { kind: 'unreadable', reason: failureMessage(cause) };
    }
  }
}
