/**
 * Finds the module specifiers a TypeScript source imports, with their exact spans.
 *
 * `setu g module --adopt-controllers` moves files and must rewrite every relative
 * import that points into or out of them. An import it misses breaks the project
 * and an edit it misplaces corrupts a file, so the reader is two independent
 * readers that must agree:
 *
 * 1. A small lexer that walks comments, strings, template literals (nested
 *    `${…}` included) and regular expressions, and reports the span of every
 *    specifier after `from` or a bare `import`, plus every `import(…)` and
 *    `require(…)` call.
 * 2. esbuild, which parses the file properly but reports neither positions nor
 *    `import type` declarations (it erases them). With `verbatimModuleSyntax`
 *    it keeps every other import.
 *
 * The lexer's non-type static specifiers must equal esbuild's import records as
 * a multiset, and its dynamic imports must match esbuild's. Any disagreement, a
 * relative `require`, or an `import(…)` whose argument is not a plain string
 * makes the file unclassifiable, and the caller refuses the whole operation.
 *
 * @module
 */
import { build } from 'esbuild';

/** One specifier string literal, located in the source. */
export interface ISpecifierSpan {
  /** Offset of the opening quote. */
  readonly start: number;
  /** Offset just past the closing quote. */
  readonly end: number;
  /** The specifier text between the quotes. */
  readonly value: string;
  /** `import type` / `export type`: erased at runtime but still type-checked. */
  readonly typeOnly: boolean;
  /** A static declaration or an `import('…')` call. */
  readonly kind: 'static' | 'dynamic';
}

/**
 * One `import.meta.glob(…)` call, read from tokens (M130): its literal
 * patterns and its literal `base` option, if any.
 */
export interface IGlobCall {
  /** Offset of the `import` keyword. */
  readonly start: number;
  /** The patterns, in order, including `!` exclusions. */
  readonly patterns: readonly string[];
  /** The literal `base` option, when the call has one. */
  readonly base?: string;
}

/** The lexer's reading of one file. */
export type LexedImports =
  | {
      readonly kind: 'ok';
      readonly spans: readonly ISpecifierSpan[];
      /**
       * Every `import.meta.glob` call, or `unreadable` when one is not a call
       * of literal patterns with an options object of literal keys (a spread,
       * a computed key, a non-literal `base`, or the function used as a value).
       * Kept apart from `kind` so a glob never changes how the file's imports
       * classify for other checks.
       */
      readonly globs: readonly IGlobCall[] | 'unreadable';
    }
  | { readonly kind: 'unclassifiable'; readonly reason: string };

interface IToken {
  readonly kind: 'word' | 'string' | 'template' | 'punct' | 'regex' | 'number';
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Words after which a `/` begins a regular expression rather than a division. */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Splits source into tokens, skipping comments and whitespace.
 *
 * @param source - TypeScript source
 * @returns The tokens, or undefined when a literal or comment is unterminated
 */
function tokenize(source: string): readonly IToken[] | undefined {
  const tokens: IToken[] = [];
  // Brace depths at which an open template literal resumes after `${ … }`.
  const templates: number[] = [];
  let depth = 0;
  let at = 0;
  const regexAllowed = (): boolean => {
    const last = tokens.at(-1);
    if (last === undefined) return true;
    if (last.kind === 'word') return REGEX_AFTER_WORDS.has(last.text);
    // `</` closes a JSX element; `)`, `]` and `}` end a value.
    if (last.kind === 'punct') return ![')', ']', '}', '<'].includes(last.text);
    return false;
  };
  // Reads a template literal's text from `from` (just past a backtick or `}`).
  const template = (from: number): number | undefined => {
    let i = from;
    while (i < source.length) {
      const c = source[i]!;
      if (c === '\\') i += 2;
      else if (c === '`') return i + 1;
      else if (c === '$' && source[i + 1] === '{') {
        templates.push(depth);
        depth++;
        return i + 2;
      } else i++;
    }
    return undefined;
  };
  while (at < source.length) {
    const c = source[at]!;
    const next = source[at + 1];
    if (/\s/.test(c)) at++;
    else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', at);
      at = end < 0 ? source.length : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2);
      if (end < 0) return undefined;
      at = end + 2;
    } else if (c === "'" || c === '"') {
      let i = at + 1;
      while (i < source.length && source[i] !== c && source[i] !== '\n')
        i += source[i] === '\\' ? 2 : 1;
      if (source[i] !== c) return undefined;
      tokens.push({ kind: 'string', start: at, end: i + 1, text: source.slice(at + 1, i) });
      at = i + 1;
    } else if (c === '`') {
      const end = template(at + 1);
      if (end === undefined) return undefined;
      tokens.push({ kind: 'template', start: at, end, text: source.slice(at, end) });
      at = end;
    } else if (c === '}' && templates.at(-1) === depth - 1) {
      templates.pop();
      depth--;
      const end = template(at + 1);
      if (end === undefined) return undefined;
      tokens.push({ kind: 'template', start: at, end, text: source.slice(at, end) });
      at = end;
    } else if (c === '/' && regexAllowed()) {
      let i = at + 1;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        const r = source[i]!;
        if (r === '\\') i += 2;
        else {
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) break;
          i++;
        }
      }
      if (source[i] !== '/') return undefined;
      i++;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i++;
      tokens.push({ kind: 'regex', start: at, end: i, text: source.slice(at, i) });
      at = i;
    } else if (/[A-Za-z_$]/.test(c)) {
      let i = at + 1;
      while (i < source.length && /[\w$]/.test(source[i]!)) i++;
      tokens.push({ kind: 'word', start: at, end: i, text: source.slice(at, i) });
      at = i;
    } else if (/[0-9]/.test(c)) {
      let i = at + 1;
      while (i < source.length && /[\w.]/.test(source[i]!)) i++;
      tokens.push({ kind: 'number', start: at, end: i, text: source.slice(at, i) });
      at = i;
    } else if (c === '\\') {
      // A Unicode escape can spell `import` without the lexer seeing the word.
      return undefined;
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      tokens.push({ kind: 'punct', start: at, end: at + 1, text: c });
      at++;
    }
  }
  return templates.length === 0 ? tokens : undefined;
}

/** A string token's text, or a template's when it has no substitution. */
function literalOf(token: IToken | undefined): string | undefined {
  if (token?.kind === 'string') return token.text;
  if (token?.kind === 'template' && token.text.endsWith('`') && token.text.startsWith('`'))
    return token.text.includes('${') ? undefined : token.text.slice(1, -1);
  return undefined;
}

/**
 * Reads the `import.meta.glob(…)` call whose `import` is at `i`.
 *
 * @param tokens - The file's tokens
 * @param i - Index of the `import` token
 * @returns The call, or undefined when it is not one the lexer can read
 */
function readGlobCall(tokens: readonly IToken[], i: number): IGlobCall | undefined {
  const text = (k: number): string | undefined => tokens[k]?.text;
  if (text(i + 5) !== '(') return undefined;
  let j = i + 6;
  const patterns: string[] = [];
  const first = literalOf(tokens[j]);
  if (first !== undefined) {
    patterns.push(first);
    j++;
  } else if (text(j) === '[') {
    j++;
    for (;;) {
      if (text(j) === ']') break;
      const pattern = literalOf(tokens[j]);
      if (pattern === undefined) return undefined;
      patterns.push(pattern);
      j++;
      if (text(j) === ',') j++;
      else if (text(j) !== ']') return undefined;
    }
    j++;
  } else return undefined;
  let base: string | undefined;
  if (text(j) === ',') j++;
  if (text(j) === '{') {
    j++;
    while (text(j) !== '}') {
      const key = tokens[j];
      if (key === undefined || (key.kind !== 'word' && key.kind !== 'string')) return undefined;
      j++;
      if (text(j) !== ':') return undefined;
      j++;
      if (key.text === 'base') {
        base = literalOf(tokens[j]);
        if (base === undefined) return undefined;
        j++;
      } else {
        let depth = 0;
        while (j < tokens.length) {
          const value = text(j)!;
          if (depth === 0 && (value === ',' || value === '}')) break;
          if (value === '(' || value === '[' || value === '{') depth++;
          else if (value === ')' || value === ']' || value === '}') depth--;
          j++;
        }
      }
      if (text(j) === ',') j++;
      else if (text(j) !== '}') return undefined;
    }
    j++;
    if (text(j) === ',') j++;
  }
  if (text(j) !== ')') return undefined;
  return { start: tokens[i]!.start, patterns, ...(base === undefined ? {} : { base }) };
}

/**
 * Reads the import specifiers of one file with the lexer alone.
 *
 * @param source - TypeScript source
 * @returns Every specifier span, or why the file cannot be classified
 */
export function lexImportSpecifiers(source: string): LexedImports {
  const tokens = tokenize(source);
  if (tokens === undefined)
    return { kind: 'unclassifiable', reason: 'an unterminated literal or comment' };
  const spans: ISpecifierSpan[] = [];
  const globs: IGlobCall[] = [];
  let globsReadable = true;
  const span = (token: IToken, typeOnly: boolean, kind: 'static' | 'dynamic'): ISpecifierSpan => ({
    start: token.start,
    end: token.end,
    value: token.text,
    typeOnly,
    kind,
  });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'word') continue;
    const previous = tokens[i - 1];
    // `x.import`, `x.require` and `import.meta` are not module loads.
    if (previous?.kind === 'punct' && previous.text === '.') continue;
    const next = tokens[i + 1];
    if (token.text === 'require' && next?.text === '(') {
      const argument = tokens[i + 2];
      if (argument?.kind !== 'string' || argument.text.startsWith('.'))
        return { kind: 'unclassifiable', reason: 'a require() call' };
      continue;
    }
    if (token.text !== 'import' && token.text !== 'export') continue;
    if (token.text === 'import' && next?.kind === 'punct' && next.text === '.') {
      if (
        tokens[i + 2]?.text === 'meta' &&
        tokens[i + 3]?.text === '.' &&
        tokens[i + 4]?.text === 'glob'
      ) {
        const call = readGlobCall(tokens, i);
        if (call === undefined) globsReadable = false;
        else globs.push(call);
      }
      continue;
    }
    if (token.text === 'import' && next?.text === '(') {
      const argument = tokens[i + 2];
      const close = tokens[i + 3];
      if (argument?.kind !== 'string' || close?.text !== ')')
        return { kind: 'unclassifiable', reason: 'an import() whose argument is not a string' };
      spans.push(span(argument, false, 'dynamic'));
      continue;
    }
    if (token.text === 'import' && next?.kind === 'string') {
      spans.push(span(next, false, 'static'));
      continue;
    }
    const typeOnly = next?.kind === 'word' && next.text === 'type';
    if (token.text === 'export') {
      // Only `export … from` re-exports load a module.
      let j = i + 1 + (typeOnly ? 1 : 0);
      const head = tokens[j];
      if (head?.text === '{') {
        while (j < tokens.length && tokens[j]!.text !== '}') j++;
        j++;
      } else if (head?.text === '*') {
        j++;
        if (tokens[j]?.text === 'as') j += 2;
      } else continue;
      if (tokens[j]?.text === 'from' && tokens[j + 1]?.kind === 'string')
        spans.push(span(tokens[j + 1]!, typeOnly, 'static'));
      continue;
    }
    // A static import: the specifier is the first string, after `from`.
    let j = i + 1;
    while (j < tokens.length && tokens[j]!.kind !== 'string') {
      const text = tokens[j]!.text;
      if (text === ';' || text === '=' || text === '(') break;
      j++;
    }
    const literal = tokens[j];
    if (literal?.kind !== 'string' || tokens[j - 1]?.text !== 'from')
      return { kind: 'unclassifiable', reason: 'an import declaration it cannot read' };
    spans.push(span(literal, typeOnly, 'static'));
  }
  return { kind: 'ok', spans, globs: globsReadable ? globs : 'unreadable' };
}

/** Counts each value, for an order-independent comparison. */
function multiset(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

/**
 * Reads the import specifiers of every file, refusing any file the two readers
 * disagree on.
 *
 * @param files - Absolute path → source, `.ts` or `.tsx`
 * @returns Each file's spans, or the first file that cannot be classified
 */
export async function readImportSpecifiers(
  files: ReadonlyMap<string, string>,
): Promise<
  | { readonly kind: 'ok'; readonly spans: ReadonlyMap<string, readonly ISpecifierSpan[]> }
  | { readonly kind: 'unclassifiable'; readonly path: string; readonly reason: string }
> {
  const spans = new Map<string, readonly ISpecifierSpan[]>();
  for (const [path, source] of files) {
    const lexed = lexImportSpecifiers(source);
    if (lexed.kind === 'unclassifiable') return { ...lexed, path };
    const records = await esbuildImports(path, source);
    if (records === undefined)
      return { kind: 'unclassifiable', path, reason: 'esbuild cannot parse it' };
    const value = lexed.spans.filter((entry) => !entry.typeOnly);
    if (
      multiset(value.filter((entry) => entry.kind === 'static').map((entry) => entry.value)) !==
        multiset(records.static) ||
      multiset(value.filter((entry) => entry.kind === 'dynamic').map((entry) => entry.value)) !==
        multiset(records.dynamic)
    )
      return {
        kind: 'unclassifiable',
        path,
        reason: 'its imports read differently to the TypeScript parser',
      };
    spans.set(path, lexed.spans);
  }
  return { kind: 'ok', spans };
}

/**
 * Lists one file's import records as esbuild parses them.
 *
 * @param path - The file's path, which picks the `ts` or `tsx` loader
 * @param source - The file's text
 * @returns Static and dynamic specifiers, or undefined when esbuild cannot parse it
 */
async function esbuildImports(
  path: string,
  source: string,
): Promise<
  { readonly static: readonly string[]; readonly dynamic: readonly string[] } | undefined
> {
  try {
    const result = await build({
      stdin: { contents: source, loader: path.endsWith('.tsx') ? 'tsx' : 'ts', sourcefile: path },
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      jsx: 'preserve',
      logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      plugins: [
        {
          name: 'every-import-external',
          setup(context) {
            context.onResolve({ filter: /.*/ }, (args) => ({ path: args.path, external: true }));
          },
        },
      ],
    });
    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports);
    return {
      static: imports.filter((entry) => entry.kind === 'import-statement').map((e) => e.path),
      dynamic: imports.filter((entry) => entry.kind === 'dynamic-import').map((e) => e.path),
    };
  } catch {
    return undefined;
  }
}
