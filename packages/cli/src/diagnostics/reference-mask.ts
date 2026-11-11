/** Tolerant read-only reference mask. Automatic edits retain the strict lexer. @module */
import { maskSourceDiagnosis } from '../devtool/sources.ts';
import type { ISourceStop } from '../devtool/sources.ts';

/** Masks ordinary literals while retaining executable template substitutions and stop locations. */
export function referenceDiagnosis(
  source: string,
): { readonly code: string } | { readonly stop: ISourceStop } {
  const text = source.split('');
  const templates: { readonly start: number; depth: number; literal: boolean }[] = [];
  const delimiters: { readonly char: string; readonly offset: number }[] = [];
  let previous = '';
  const blank = (at: number) => {
    if (text[at] !== '\n' && text[at] !== '\r') text[at] = ' ';
  };
  const stop = (reason: string, offset: number) => ({ stop: { reason, offset } });
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    const template = templates.at(-1);
    if (template?.literal) {
      if (c === '\\') {
        blank(i);
        if (next === undefined) return stop('unterminated template', template.start);
        blank(++i);
      } else if (c === '`') {
        text[i] = ')';
        templates.pop();
        previous = 'value';
      } else if (c === '$' && next === '{') {
        text[i] = '(';
        text[++i] = ' ';
        template.literal = false;
        template.depth = 0;
        previous = '(';
      } else blank(i);
      continue;
    }
    if (c === '/' && (next === '/' || next === '*')) {
      const line = next === '/';
      const start = i;
      i += 2;
      while (
        i < source.length &&
        (line ? !/[\r\n\u2028\u2029]/.test(source[i]!) : !source.startsWith('*/', i))
      )
        i++;
      if (!line && i === source.length) return stop('unterminated comment', start);
      const end = line ? i : i + 2;
      for (let at = start; at < end; at++) blank(at);
      i = end - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      let escaped = false;
      for (i++; i < source.length && source[i] !== c; i++) {
        if (/[\r\n\u2028\u2029]/.test(source[i]!)) return stop('unterminated string', start);
        if (source[i] === '\\') {
          escaped = true;
          if (++i >= source.length) return stop('unterminated string', start);
        }
      }
      if (i === source.length) return stop('unterminated string', start);
      if (escaped) {
        if (previous === 'from' || previous === 'import')
          return stop('escaped import specifier', start);
        // An escaped property remains computed, never a plain named access.
        // Preserve line continuations so later stop locations stay exact.
        text[start] = '0';
        for (let at = start + 1; at <= i; at++) blank(at);
      }
      previous = 'value';
      continue;
    }
    if (c === '`') {
      templates.push({ start: i, depth: 0, literal: true });
      text[i] = '(';
      previous = '(';
      continue;
    }
    if (c === '/') {
      if (['}', '!', ')'].includes(previous)) return stop(`ambiguous / after ${previous}`, i);
      const regex =
        previous === '' ||
        ['return', 'typeof', 'default', 'extends'].includes(previous) ||
        '(,=:[&|?{;'.includes(previous);
      if (regex) {
        const start = i;
        let bracket = false;
        let closed = false;
        for (i++; i < source.length; i++) {
          const part = source[i]!;
          if (/[\r\n\u2028\u2029]/.test(part)) break;
          if (part === '\\') {
            i++;
            continue;
          }
          if (part === '[') bracket = true;
          if (part === ']') bracket = false;
          if (part === '/' && !bracket) {
            closed = true;
            break;
          }
        }
        if (!closed) return stop('unterminated regex', start);
        while (/[A-Za-z]/.test(source[i + 1] ?? '')) i++;
        // Keep a value token, rather than erasing the expression entirely.
        text[start] = '0';
        for (let at = start + 1; at <= i; at++) blank(at);
        previous = 'value';
      } else {
        if (
          [
            'throw',
            'case',
            'delete',
            'void',
            'yield',
            'await',
            'new',
            'instanceof',
            'in',
            'of',
            'else',
            'do',
          ].includes(previous) ||
          !(previous === 'value' || previous === ']' || /^[A-Za-z_$][\w$]*$/.test(previous))
        )
          return stop('ambiguous /', i);
        text[i] = '*'; // Same expression shape, accepted by the strict lexer.
        previous = '/';
      }
      continue;
    }
    if (template !== undefined) {
      if (c === '{') template.depth++;
      if (c === '}') {
        if (template.depth === 0) {
          text[i] = ')';
          template.literal = true;
          previous = 'value';
          continue;
        }
        template.depth--;
      }
    }
    if ('({['.includes(c)) delimiters.push({ char: c, offset: i });
    if (')}]'.includes(c)) {
      const expected = '({['[')}]'.indexOf(c)];
      if (delimiters.pop()?.char !== expected) return stop('unmatched delimiter', i);
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (/[\w$]/.test(source[i + 1] ?? '')) i++;
      // A property name (`env.default`, `mod?.return`) is a value, so a `/` after
      // it divides; only a keyword in code position may precede a regex (audit F1).
      // A spread's `...` also ends in `.`, and what follows it is an expression,
      // so only a single `.` or `?.` names a property (re-audit F6).
      // Walked over `text`, where comments are already blanked, so a comment
      // between `...` and the keyword cannot hide the spread (re-audit F7).
      let before = start - 1;
      while (before >= 0 && /\s/.test(text[before]!)) before--;
      const property = previous === '.' && text[before - 1] !== '.';
      previous = property ? 'value' : source.slice(start, i + 1);
    } else if (/[0-9]/.test(c)) previous = 'value';
    else if (!/\s/.test(c)) previous = c;
  }
  if (templates.length > 0) return stop('unterminated template', templates[0]!.start);
  if (delimiters.length > 0) return stop('unterminated source', delimiters[0]!.offset);
  return maskSourceDiagnosis(text.join(''));
}

/** Code-only projection consumed by read-only wiring and activation checks. */
export function referenceMask(source: string): string | undefined {
  const result = referenceDiagnosis(source);
  return 'code' in result ? result.code : undefined;
}
