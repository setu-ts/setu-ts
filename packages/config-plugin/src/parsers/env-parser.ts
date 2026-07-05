/**
 * Strict dotenv-style environment file parser.
 *
 * @module
 */

/**
 * Parses dotenv-formatted content into string key-value pairs.
 *
 * Blank lines and comments are ignored. Entries may use an optional `export`
 * prefix, quoted or unquoted values, and comments after unquoted values.
 * Duplicate keys use the last value in the file.
 *
 * @param content - Raw dotenv file content
 * @returns Parsed key-value pairs
 * @throws {Error} If an entry, key, or quoted value is malformed
 * @since 0.1.0
 */
export function parseEnv(content: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    let line = lines[index].trimEnd();

    if (line.trimStart().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }

    line = line.trimStart();
    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trimStart();
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      throw new Error(`Malformed env entry at line ${lineNumber}: missing '=' separator.`);
    }

    const key = line.slice(0, separator).trim();
    if (!isValidKey(key)) {
      throw new Error(`Invalid environment key at line ${lineNumber}.`);
    }

    values[key] = parseValue(line.slice(separator + 1), lineNumber);
  }

  return values;
}

function isValidKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function parseValue(raw: string, lineNumber: number): string {
  const value = raw.trimStart();
  if (value.length === 0) {
    return '';
  }
  if (value.startsWith('"')) {
    return parseDoubleQuoted(value, lineNumber);
  }
  if (value.startsWith("'")) {
    return parseSingleQuoted(value, lineNumber);
  }
  return parseUnquoted(value);
}

function parseDoubleQuoted(value: string, lineNumber: number): string {
  const result: string[] = [];

  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === '"') {
      assertValidQuotedSuffix(value.slice(index + 1), lineNumber);
      return result.join('');
    }
    if (character !== '\\') {
      result.push(character);
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      break;
    }
    const replacements: Readonly<Record<string, string>> = {
      '"': '"',
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const replacement = replacements[escaped];
    if (replacement === undefined) {
      result.push('\\', escaped);
    } else {
      result.push(replacement);
    }
    index++;
  }

  throw new Error(`Unterminated double-quoted value at line ${lineNumber}.`);
}

function parseSingleQuoted(value: string, lineNumber: number): string {
  const closingQuote = value.indexOf("'", 1);
  if (closingQuote === -1) {
    throw new Error(`Unterminated single-quoted value at line ${lineNumber}.`);
  }
  assertValidQuotedSuffix(value.slice(closingQuote + 1), lineNumber);
  return value.slice(1, closingQuote);
}

function assertValidQuotedSuffix(suffix: string, lineNumber: number): void {
  const trimmed = suffix.trimStart();
  if (trimmed.length > 0 && !trimmed.startsWith('#')) {
    throw new Error(`Unexpected content after quoted value at line ${lineNumber}.`);
  }
}

function parseUnquoted(value: string): string {
  const comment = value.search(/[ \t]#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}
