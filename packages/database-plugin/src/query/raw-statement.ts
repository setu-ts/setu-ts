/**
 * Binds a raw SQL statement and its positional parameters into the chunk list
 * a Drizzle `SQL` object is built from.
 *
 * The Prisma and D1 adapters both hand the statement text to their driver
 * **verbatim** and bind the parameters natively, so that is this framework's
 * `IDatabaseService.query()` contract: the statement carries the connector's
 * own placeholders and the values never reach the driver as text. Drizzle has
 * no equivalent entry point — its `execute()` takes an `SQLWrapper`, and the
 * dialect renders each `Param` chunk as a placeholder in chunk order (`$1`,
 * `$2`, … on PostgreSQL; `?` on MySQL and SQLite). Splitting the statement at
 * its placeholders and interleaving `sql.param(value)` therefore reproduces
 * the caller's text byte-for-byte for an ascending-placeholder statement while
 * keeping every value bound.
 *
 * @module
 */

/**
 * The subset of Drizzle's `sql` template tag this module calls.
 *
 * Both members are invoked as members of the tag so their `this` binding
 * survives.
 *
 * @internal
 */
export interface RawStatementTag {
  /** Emit `text` into the statement literally, contributing no parameter. */
  raw(text: string): unknown;
  /** Bind `value`, contributing one dialect-native placeholder. */
  param(value: unknown): unknown;
}

/** One placeholder token located in a statement. */
interface Placeholder {
  /** Index of the token's first character. */
  readonly start: number;
  /** Index one past the token's last character. */
  readonly end: number;
  /** 1-based parameter number for `$N`, or `null` for positional `?`. */
  readonly index: number | null;
}

/**
 * Split `statement` at its placeholders and interleave bound parameters.
 *
 * With no parameters the statement passes through as a single literal chunk,
 * which matches the Prisma and D1 adapters. With parameters the statement is
 * scanned — skipping string literals, quoted identifiers, comments and
 * PostgreSQL dollar-quoted bodies — so a `?` inside `'text?'` is never
 * mistaken for a placeholder.
 *
 * @param statement - The raw SQL the caller passed to `query()`
 * @param params - Positional parameter values, possibly empty
 * @param tag - Drizzle's `sql` template tag
 * @returns The chunk list to construct a Drizzle `SQL` from
 * @throws {Error} When parameters are supplied but the statement's
 * placeholders cannot be matched to them — a mismatched count, a gap in the
 * `$N` sequence, both placeholder styles in one statement, or none at all.
 * Refusing is deliberate: a mis-bound parameter is silent, and every one of
 * these cases means the caller and the statement disagree.
 * @since 0.2.0
 */
export function bindRawStatement(
  statement: string,
  params: readonly unknown[],
  tag: RawStatementTag,
): unknown[] {
  if (params.length === 0) {
    return [tag.raw(statement)];
  }

  const placeholders = scanPlaceholders(statement);
  assertBindable(statement, params, placeholders);

  const chunks: unknown[] = [];
  let cursor = 0;
  let position = 0;
  for (const placeholder of placeholders) {
    chunks.push(tag.raw(statement.slice(cursor, placeholder.start)));
    // A `$N` token names its parameter; a `?` consumes the next one in order.
    chunks.push(tag.param(params[placeholder.index === null ? position : placeholder.index - 1]));
    position++;
    cursor = placeholder.end;
  }
  chunks.push(tag.raw(statement.slice(cursor)));
  return chunks;
}

/**
 * Reject a statement whose placeholders cannot be matched to `params`.
 *
 * @param statement - The raw SQL, quoted in the diagnostic
 * @param params - The supplied parameter values
 * @param placeholders - Tokens located by {@linkcode scanPlaceholders}
 * @throws {Error} Naming the disagreement, never the parameter values
 */
function assertBindable(
  statement: string,
  params: readonly unknown[],
  placeholders: readonly Placeholder[],
): void {
  if (placeholders.length === 0) {
    throw new Error(
      `Raw query received ${params.length} parameter(s) but the statement has no ` +
        `'?' or '$N' placeholder to bind them to: ${statement}`,
    );
  }

  const numbered = placeholders.filter((item) => item.index !== null);
  if (numbered.length > 0 && numbered.length !== placeholders.length) {
    throw new Error(
      "Raw query mixes '?' and '$N' placeholders in one statement; use one style: " +
        statement,
    );
  }

  if (numbered.length === 0) {
    if (placeholders.length !== params.length) {
      throw new Error(
        `Raw query has ${placeholders.length} '?' placeholder(s) but received ` +
          `${params.length} parameter(s): ${statement}`,
      );
    }
    return;
  }

  const referenced = new Set(numbered.map((item) => item.index as number));
  const highest = Math.max(...referenced);
  if (highest !== params.length) {
    throw new Error(
      `Raw query references up to $${highest} but received ${params.length} ` +
        `parameter(s): ${statement}`,
    );
  }
  for (let position = 1; position <= params.length; position++) {
    if (!referenced.has(position)) {
      throw new Error(
        `Raw query never references $${position}, so parameter ${position} would be ` +
          `dropped: ${statement}`,
      );
    }
  }
}

/**
 * Locate every placeholder token, skipping the regions where one cannot occur.
 *
 * Skipped: `'…'` string literals and `"…"` / `` `…` `` quoted identifiers (all
 * three doubling the quote to escape it, per standard SQL), `--` line
 * comments, nested `/* … *\/` block comments, and PostgreSQL `$tag$ … $tag$`
 * dollar-quoted bodies.
 *
 * A backslash-escaped quote inside a string literal — MySQL's default and
 * PostgreSQL's `E'…'` form, neither of them standard SQL — is NOT recognised.
 * Such a statement ends the literal early here, which surfaces as a
 * placeholder-count refusal rather than a mis-bind; double the quote or use
 * the typed query builder.
 *
 * A `?` that is an OPERATOR rather than a placeholder is not recognised
 * either. PostgreSQL spells jsonb key containment `?`, `?|` and `?&`, and this
 * scanner reads each as a placeholder. It cannot resolve that ambiguity — `?`
 * means both things in one dialect — so it never guesses: with a parameter
 * list the tokens do not match, the statement is refused here; with one that
 * does, the operator is consumed and the database answers a syntax error.
 * Neither outcome mis-binds a value. Write such a statement with `$N`
 * placeholders instead, which are unambiguous on PostgreSQL; mixing the two
 * styles is itself refused, so the two can never silently combine.
 *
 * @param statement - The raw SQL to scan
 * @returns The tokens in the order they appear
 */
function scanPlaceholders(statement: string): Placeholder[] {
  const found: Placeholder[] = [];
  const length = statement.length;
  let cursor = 0;

  while (cursor < length) {
    const char = statement[cursor];

    if (char === "'" || char === '"' || char === '`') {
      cursor = skipQuoted(statement, cursor, char);
      continue;
    }
    if (char === '-' && statement[cursor + 1] === '-') {
      cursor = skipLineComment(statement, cursor);
      continue;
    }
    if (char === '/' && statement[cursor + 1] === '*') {
      cursor = skipBlockComment(statement, cursor);
      continue;
    }
    if (char === '$') {
      const afterDollarQuote = skipDollarQuoted(statement, cursor);
      if (afterDollarQuote !== null) {
        cursor = afterDollarQuote;
        continue;
      }
      const afterDigits = readDigits(statement, cursor + 1);
      if (afterDigits > cursor + 1) {
        found.push({
          start: cursor,
          end: afterDigits,
          index: Number(statement.slice(cursor + 1, afterDigits)),
        });
        cursor = afterDigits;
        continue;
      }
    }
    if (char === '?') {
      found.push({ start: cursor, end: cursor + 1, index: null });
    }
    cursor++;
  }

  return found;
}

/**
 * Skip a quoted region, honouring the doubled-quote escape.
 *
 * @param statement - The raw SQL
 * @param start - Index of the opening quote
 * @param quote - The quote character that opened the region
 * @returns Index one past the closing quote, or the statement length when unterminated
 */
function skipQuoted(statement: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < statement.length) {
    if (statement[cursor] === quote) {
      if (statement[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor++;
  }
  return statement.length;
}

/**
 * Skip a `--` comment up to and including its newline.
 *
 * @param statement - The raw SQL
 * @param start - Index of the first `-`
 * @returns Index of the character after the newline, or the statement length
 */
function skipLineComment(statement: string, start: number): number {
  const newline = statement.indexOf('\n', start + 2);
  return newline === -1 ? statement.length : newline + 1;
}

/**
 * Skip a `/* … *\/` comment, honouring PostgreSQL's nesting.
 *
 * @param statement - The raw SQL
 * @param start - Index of the opening `/`
 * @returns Index one past the outermost close, or the statement length when unterminated
 */
function skipBlockComment(statement: string, start: number): number {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < statement.length - 1) {
    if (statement[cursor] === '/' && statement[cursor + 1] === '*') {
      depth++;
      cursor += 2;
      continue;
    }
    if (statement[cursor] === '*' && statement[cursor + 1] === '/') {
      depth--;
      cursor += 2;
      if (depth === 0) return cursor;
      continue;
    }
    cursor++;
  }
  return statement.length;
}

/**
 * Skip a PostgreSQL dollar-quoted body when one opens at `start`.
 *
 * @param statement - The raw SQL
 * @param start - Index of the opening `$`
 * @returns Index one past the closing tag, or `null` when no dollar quote opens here
 * (which is what leaves `$1` to be read as a placeholder)
 */
function skipDollarQuoted(statement: string, start: number): number | null {
  let cursor = start + 1;
  while (cursor < statement.length && isTagChar(statement[cursor], cursor === start + 1)) {
    cursor++;
  }
  if (statement[cursor] !== '$') return null;

  const tag = statement.slice(start, cursor + 1);
  const close = statement.indexOf(tag, cursor + 1);
  return close === -1 ? statement.length : close + tag.length;
}

/**
 * Whether `char` may appear in a dollar-quote tag.
 *
 * @param char - The character to test
 * @param first - Whether it is the tag's first character, where digits are disallowed
 * (so `$1` is a placeholder rather than an unterminated tag)
 * @returns `true` when the character is allowed at that position
 */
function isTagChar(char: string, first: boolean): boolean {
  if (char === '_' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')) return true;
  return !first && char >= '0' && char <= '9';
}

/**
 * Advance past a run of ASCII digits.
 *
 * @param statement - The raw SQL
 * @param start - Index to read from
 * @returns Index one past the last digit, equal to `start` when there is none
 */
function readDigits(statement: string, start: number): number {
  let cursor = start;
  while (cursor < statement.length) {
    const char = statement[cursor];
    if (char < '0' || char > '9') break;
    cursor++;
  }
  return cursor;
}
