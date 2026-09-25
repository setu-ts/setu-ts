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
 * Every name-taking verb that GENERATES source uses the derived forms in two
 * ways at once: schematics interpolate them into declarations
 * (`class <Pascal>Service`, `const <SCREAMING>_JOB`), and the commands join the
 * kebab into a filesystem path — a workspace member (`generate app`, `adopt`),
 * a library, or an artifact file name (`src/controllers/<kebab>.routes.ts`).
 * `setu new` joins the kebab into a path and never into an identifier, so it
 * runs {@linkcode isPathSegmentSafe} alone — a project may be called `3d-shop`.
 *
 * Beyond the path rules, two classes of input fail:
 *
 * - one starting with a digit (`2fa`), which would emit `class 2faService`;
 * - one carrying no letter at all (`.`, `..`), which survives normalization
 *   intact and becomes a PATH rather than a name — `setu adopt` derives its
 *   member name from a directory, so `--dir .` produced `apps/.` and failed
 *   part-way through the conversion with a bare `mkdir` errno. Requiring a letter
 *   is also what the refusals around this already claim it checks.
 *
 * Reserved words (`class`, `new`) are NOT rejected: every schematic prefixes or
 * suffixes the derived form, so `class` yields the perfectly valid
 * `ClassService`, and the route schematic renders it as the path `/class`.
 *
 * @param names - The derived naming forms to test
 * @returns True when the names are safe as identifiers and as one path segment
 */
export function isIdentifierSafe(names: DerivedNames): boolean {
  return /[a-zA-Z]/.test(names.kebab) && !/^[0-9]/.test(names.pascal) &&
    isPathSegmentSafe(names);
}

/**
 * Reports whether the derived kebab is one legal filesystem path segment.
 *
 * The rules every name-taking verb shares, because every one of them joins the
 * kebab into a path. A segment fails when it is:
 *
 * - empty (`___` normalizes to nothing), or the current or parent directory
 *   (`.`, `..`), either of which makes `joinPath(dir, kebab)` name a directory
 *   that is not a new one;
 * - carrying a path separator — `/` everywhere, and `\` too, since Deno honours
 *   it on Windows. `deriveNames` preserves both verbatim — neither is a
 *   separator it normalizes away — so `deriveNames('../sibling').kebab` is
 *   `../sibling`, and joining it escapes the intended directory and writes the
 *   scaffold into an ancestor;
 * - carrying a control character (the whole Unicode `Cc` category, so a C1
 *   `U+0085` a terminal renders as a line break is covered with the C0 set);
 * - longer than {@linkcode MAX_COMPONENT_BYTES}.
 *
 * A NUL byte and an over-long component reach the filesystem otherwise, which
 * rejects them mid-flight (`TypeError: file name contained an unexpected NUL
 * byte`, `File name too long`) as an error nothing up to the CLI entry point
 * catches — an uncaught rejection, not a refusal. The check looks at the
 * derived kebab, not the raw input: a raw `a\r\nb` normalizes the CR/LF away
 * into `a-b`, which is harmless. A verb that APPENDS to the kebab (an artifact
 * file name, a library's test file) checks the planned file names too, with
 * {@linkcode overlongComponent} — a kebab at this bound plus `.controller.ts`
 * is over it.
 *
 * @param names - The derived naming forms to test
 * @returns True when the kebab is safe as one path segment
 */
export function isPathSegmentSafe(names: DerivedNames): boolean {
  const kebab = names.kebab;
  return kebab !== '' && kebab !== '.' && kebab !== '..' && !/[/\\]/.test(kebab) &&
    !CONTROL_CHARACTER.test(kebab) && utf8ByteLength(kebab) <= MAX_COMPONENT_BYTES;
}

/**
 * Returns the first path segment over {@linkcode MAX_COMPONENT_BYTES}, if any.
 *
 * For a verb whose planned file names extend the kebab: the name guard bounds
 * the kebab, and the suffix a schematic appends can still carry a file name past
 * the ceiling, which the filesystem refuses mid-write.
 *
 * @param paths - The planned file paths, `/`-separated
 * @returns The first over-long segment, or undefined when every one fits
 */
export function overlongComponent(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    for (const segment of path.split('/')) {
      if (utf8ByteLength(segment) > MAX_COMPONENT_BYTES) return segment;
    }
  }
  return undefined;
}

/** The portable per-component filename ceiling: NAME_MAX on Linux, and the
 * same 255 on NTFS and APFS. A component over it is refused with a usage error
 * instead of surfacing mid-write as `File name too long (os error 36)`. */
export const MAX_COMPONENT_BYTES = 255;

/** Every Unicode control character (`Cc`: C0, DEL and C1). */
const CONTROL_CHARACTER = /\p{Cc}/u;

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
 * line in the rendered message, so every control character — and the two
 * Unicode line and paragraph separators — is rendered as its
 * `\uXXXX` escape instead — the quote stays one line and still shows exactly
 * what was typed. Everything else passes through verbatim.
 *
 * @param raw - The raw name as the user typed it
 * @returns The same name, safe to interpolate into a single-line message
 */
export function escapeName(raw: string): string {
  return raw.replace(
    /[\p{Cc}\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
