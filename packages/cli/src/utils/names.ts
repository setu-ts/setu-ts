/**
 * Name normalization utilities. Derives multiple naming conventions from a single input.
 *
 * @module
 */

/**
 * The five naming forms derived from an input string.
 */
export interface DerivedNames {
  /** The raw input as provided by the user. */
  readonly raw: string;
  /** kebab-case: lowercase with hyphens (e.g., user-profile). */
  readonly kebab: string;
  /** camelCase: lowercase first letter, no separators (e.g., userProfile). */
  readonly camel: string;
  /** PascalCase: uppercase first letter, no separators (e.g., UserProfile). */
  readonly pascal: string;
  /** SCREAMING_SNAKE_CASE: uppercase with underscores (e.g., USER_PROFILE). */
  readonly screaming: string;
}

/**
 * Derive all five naming forms from a raw input string.
 *
 * @param raw - The input string (e.g., "user-profile", "UserProfile", "user profile")
 * @returns A DerivedNames object containing all five variants
 */
export function deriveNames(raw: string): DerivedNames {
  // First, normalize all separators (spaces, hyphens, underscores) to hyphens
  let normalized = raw.replace(/[\s_-]+/g, '-');

  // Then, split camelCase/PascalCase by inserting hyphens before uppercase letters
  // that are followed by lowercase letters (to avoid splitting acronyms incorrectly)
  normalized = normalized.replace(/([A-Z])([a-z])/g, '-$1$2');

  // Finally, split by hyphens and filter empty strings
  const wordsRaw = normalized.split('-').filter((w) => w.length > 0);

  // Lowercase version for word processing
  const words = wordsRaw.map((w) => w.toLowerCase());

  if (words.length === 0) {
    return { raw, kebab: '', camel: '', pascal: '', screaming: '' };
  }

  // kebab-case: lowercase with hyphens
  const kebab = words.join('-');

  // camelCase: first word lowercase, subsequent words capitalized (first upper, rest lower)
  const camel = words[0] +
    words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');

  // PascalCase: all words capitalized (first upper, rest lower)
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');

  // SCREAMING_SNAKE_CASE: all uppercase with underscores
  const screaming = words.map((w) => w.toUpperCase()).join('_');

  return {
    raw,
    kebab,
    camel,
    pascal,
    screaming,
  };
}

/**
 * Reports whether these names can form valid TypeScript identifiers.
 *
 * Schematics interpolate the derived forms into declarations
 * (`class <Pascal>Service`, `const <SCREAMING>_JOB`), so a name that cannot
 * begin an identifier emits source that does not parse. Two inputs fail:
 *
 * - one that normalizes to nothing (`___`), which would emit `class Service`
 *   at the hidden path `src/services/.service.ts`;
 * - one starting with a digit (`2fa`), which would emit `class 2faService`.
 *
 * Reserved words (`class`, `new`) are NOT rejected: every schematic prefixes or
 * suffixes the derived form, so `class` yields the perfectly valid
 * `ClassService`, and `/class` is a legitimate route path.
 *
 * @param names - The derived naming forms to test
 * @returns True when every schematic can safely interpolate these names
 */
export function isIdentifierSafe(names: DerivedNames): boolean {
  return names.kebab !== '' && !/^[0-9]/.test(names.pascal);
}
