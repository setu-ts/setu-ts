/**
 * Input sanitizer — pure string transforms for untrusted user input.
 *
 * Exposes a {@link SanitizationRules} configuration shape and two convenience
 * functions: {@link sanitize} (one-shot) and {@link createSanitizer} (factory).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for sanitizing a string value.
 *
 * All options are optional and composable. When multiple options are
 * enabled they are applied in a fixed, deterministic order:
 * trim → case → pattern → stripTags → htmlEncode → maxLength.
 *
 * @since 0.1.0
 */
export interface SanitizationRules {
  /** Encode HTML entities (`<`, `>`, `&`, `"`, `'`). */
  htmlEncode?: boolean;
  /** Remove all HTML tags. */
  stripTags?: boolean;
  /** Keep only the listed tag names (implies `stripTags` for non-listed tags). */
  allowedTags?: string[];
  /** Truncate the string to this many characters (applied after other transforms). */
  maxLength?: number;
  /** Replace the entire string with an empty string if it does not match. */
  pattern?: RegExp;
  /** Trim leading and trailing whitespace. */
  trim?: boolean;
  /** Convert the string to lowercase. */
  toLowerCase?: boolean;
  /** Convert the string to uppercase. */
  toUpperCase?: boolean;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Sanitize a single string value with the given rules.
 *
 * @param input - The raw string to sanitize
 * @param rules - The sanitization rules to apply
 * @returns The sanitized string
 */
export function sanitize(input: string, rules: SanitizationRules): string {
  const fn = createSanitizer(rules);
  return fn(input);
}

/**
 * Create a sanitization function that applies the given rules to each call.
 *
 * @param rules - The sanitization rules to apply
 * @returns A function that sanitizes a string with the configured rules
 */
export function createSanitizer(rules: SanitizationRules): (input: string) => string {
  return (input: string) => {
    let value = input;

    // 1. Trim
    if (rules.trim) {
      value = value.trim();
    }

    // 2. Case transforms
    if (rules.toLowerCase) {
      value = value.toLowerCase();
    }
    if (rules.toUpperCase) {
      value = value.toUpperCase();
    }

    // 3. Pattern guard (reject if no match)
    if (rules.pattern && !rules.pattern.test(value)) {
      value = '';
    }

    // 4. Strip HTML tags
    if (rules.stripTags && !rules.allowedTags) {
      value = stripAllTags(value);
    } else if (rules.allowedTags && rules.allowedTags.length > 0) {
      value = keepAllowedTags(value, rules.allowedTags);
    }

    // 5. HTML encode
    if (rules.htmlEncode) {
      value = encodeHtml(value);
    }

    // 6. Truncate to maxLength (final step)
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      value = value.slice(0, rules.maxLength);
    }

    return value;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode HTML entity characters.
 */
function encodeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Strip all HTML tags from the string.
 */
function stripAllTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

/**
 * Remove all HTML tags except the ones explicitly allowed.
 */
function keepAllowedTags(value: string, allowedTags: string[]): string {
  const lowerAllowed = new Set(allowedTags.map((t) => t.toLowerCase()));
  return value.replace(/<([^>]+)>/g, (match, inner) => {
    const tagMatch = inner.match(/^\/?(\w+)/);
    if (!tagMatch) {
      return match;
    }
    const tagName = tagMatch[1].toLowerCase();
    if (lowerAllowed.has(tagName)) {
      return match;
    }
    return '';
  });
}
