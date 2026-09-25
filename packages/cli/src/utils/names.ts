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
 * Reports whether these names are safe to use as both a TypeScript identifier
 * and a single filesystem path segment.
 *
 * Every name-taking verb uses the derived forms in two ways at once: schematics
 * interpolate them into declarations (`class <Pascal>Service`,
 * `const <SCREAMING>_JOB`), and the commands join the kebab into a filesystem
 * path — the project directory (`new`), a workspace member (`generate app`,
 * `adopt`), or an artifact file name (`src/controllers/<kebab>.routes.ts`). Both
 * uses break on the same inputs, so this is the single guard every one of them
 * runs before it writes anything.
 *
 * Four classes of input fail:
 *
 * - one that normalizes to nothing (`___`), which would emit `class Service`
 *   at the hidden path `src/services/.service.ts`;
 * - one starting with a digit (`2fa`), which would emit `class 2faService`;
 * - one carrying no letter at all (`.`, `..`), which survives normalization
 *   intact and becomes a PATH rather than a name — `setu adopt` derives its
 *   member name from a directory, so `--dir .` produced `apps/.` and failed
 *   part-way through the conversion with a bare `mkdir` errno. Requiring a letter
 *   is also what the refusals around this already claim it checks.
 * - one that is not a legal filename component: a path separator (`../sibling`,
 *   `a/b`), a control character (`a\u0000b`), or a kebab longer than
 *   {@linkcode MAX_COMPONENT_BYTES}. `deriveNames` preserves `/` verbatim — it is
 *   not a separator it normalizes away — so `deriveNames('../sibling').kebab` is
 *   `../sibling`, and joining it into `joinPath(dir, kebab)` escapes the intended
 *   directory and writes the scaffold into an ancestor. A NUL byte and an
 *   over-long component pass every other rule here, and the filesystem rejects
 *   them mid-flight (`TypeError: file name contained an unexpected NUL byte`,
 *   `File name too long`) as an error nothing up to the CLI entry point catches —
 *   an uncaught rejection, not a refusal. The check therefore looks at the
 *   derived kebab, not the raw input: a raw `../sibling` and a raw `..sibling`
 *   normalize differently, and only the former carries the separator that makes
 *   it a traversal, while a raw `a\r\nb` normalizes the CR/LF away into `a-b`,
 *   which is harmless.
 *
 * Reserved words (`class`, `new`) are NOT rejected: every schematic prefixes or
 * suffixes the derived form, so `class` yields the perfectly valid
 * `ClassService`, and the route schematic renders it as the path `/class`.
 *
 * @param names - The derived naming forms to test
 * @returns True when the names are safe as identifiers and as one path segment
 */
export function isIdentifierSafe(names: DerivedNames): boolean {
  return (
    /[a-zA-Z]/.test(names.kebab) &&
    !/^[0-9]/.test(names.pascal) &&
    !names.kebab.includes('/') &&
    !/[\u0000-\u001f\u007f]/.test(names.kebab) &&
    utf8ByteLength(names.kebab) <= MAX_COMPONENT_BYTES
  );
}

/** The portable per-component filename ceiling: NAME_MAX on Linux, and the
 * same 255 on NTFS and APFS. A component over it is refused with a usage error
 * instead of surfacing mid-write as `File name too long (os error 36)`. */
const MAX_COMPONENT_BYTES = 255;

const UTF8 = new TextEncoder();

/** The kebab's length in UTF-8 bytes, the unit filesystems measure names in. */
function utf8ByteLength(text: string): number {
  return UTF8.encode(text).length;
}

/**
 * Renders a raw name safely inside a refusal message.
 *
 * Refusals quote the name the user typed. A name carrying a newline or a
 * carriage return would break out of the quoted line and forge a standalone
 * line in the rendered message, so every control character is rendered as its
 * `\uXXXX` escape instead — the quote stays one line and still shows exactly
 * what was typed. Everything else passes through verbatim.
 *
 * @param raw - The raw name as the user typed it
 * @returns The same name, safe to interpolate into a single-line message
 */
export function escapeName(raw: string): string {
  return raw.replace(
    /[\u0000-\u001f\u007f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
