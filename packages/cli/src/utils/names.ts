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
 * (`class <Pascal>Service`, `<camel>Middleware`, `<SCREAMING>_EVENT`) and into
 * string literals (`@Injectable({ token: '<kebab>-service' })`), and the
 * commands join the kebab into a filesystem path — a workspace member
 * (`generate app`, `adopt`), a library, or an artifact file name
 * (`src/controllers/<kebab>.routes.ts`). `setu new` joins the kebab into a path
 * and a manifest and never into an identifier, so it runs
 * {@linkcode isPathSegmentSafe} alone — a project may be called `3d-shop`.
 *
 * Beyond the path rules:
 *
 * - every derived form — Pascal, camel and SCREAMING — must be an identifier,
 *   `\p{ID_Start}\p{ID_Continue}*`. That refuses a leading digit (`2fa` would
 *   emit `class 2faService`) and every punctuation character `deriveNames`
 *   carries through: `a:b` emitted `class A:bService`, and `x'y` closed the
 *   `@Injectable` token literal early, which is source injection from argv.
 *   Unicode letters (`café`) are identifiers and pass;
 * - the kebab must carry an ASCII letter — the refusals around this have always
 *   said "must contain a letter", and `setu adopt` derives its member name from a
 *   directory, where `--dir .` once produced `apps/.`.
 *
 * Reserved words (`class`, `new`) are NOT rejected: every schematic prefixes or
 * suffixes the derived form, so `class` yields the perfectly valid
 * `ClassService`, and the route schematic renders it as the path `/class`.
 *
 * @param names - The derived naming forms to test
 * @returns True when the names are safe as identifiers and as one path segment
 */
export function isIdentifierSafe(names: DerivedNames): boolean {
  return /[a-zA-Z]/.test(names.kebab) &&
    [names.pascal, names.camel, names.screaming].every((form) => IDENTIFIER.test(form)) &&
    isPathSegmentSafe(names);
}

/**
 * Reports whether the derived kebab is one portable path segment.
 *
 * The rule every name-taking verb shares, because every one of them joins the
 * kebab into a path, and `setu new` also writes it into manifests as a string
 * (`wrangler.toml`'s `name = "<kebab>"`). It is an allowlist rather than a list
 * of refusals: the kebab starts with a letter or digit and holds only letters,
 * combining marks, digits, `.` and `-`, in at most {@linkcode MAX_COMPONENT_BYTES}.
 * That refuses, by construction:
 *
 * - an empty segment (`___` normalizes to nothing) and `.`/`..` or any leading
 *   dot, which make `joinPath(dir, kebab)` name a directory that is not a new one
 *   (or a hidden one);
 * - `/`, and `\` (a separator Deno honours on Windows) — `deriveNames` preserves
 *   both verbatim, so `deriveNames('../sibling').kebab` is `../sibling`, and
 *   joining it wrote the scaffold into an ancestor;
 * - every control character, and every quote or other punctuation, which broke
 *   the string it was written into;
 * - an over-long name, which the filesystem refused mid-write
 *   (`File name too long`) as an uncaught rejection rather than a refusal.
 *
 * The check looks at the derived kebab, not the raw input: a raw `a\r\nb`
 * normalizes the CR/LF away into `a-b`, which is harmless. A verb that APPENDS
 * to the kebab (an artifact file name, a library's test file) checks the
 * planned file names too, with {@linkcode overlongComponent} — a kebab at this
 * bound plus `.controller.ts` is over it.
 *
 * @param names - The derived naming forms to test
 * @returns True when the kebab is safe as one path segment
 */
export function isPathSegmentSafe(names: DerivedNames): boolean {
  return PATH_SEGMENT.test(names.kebab) && !names.kebab.endsWith('.') &&
    !WINDOWS_DEVICE.test(names.kebab) && utf8ByteLength(names.kebab) <= MAX_COMPONENT_BYTES;
}

/**
 * The rule a generating verb's name refusal states, shared so the five
 * commands that print it cannot drift from {@linkcode isIdentifierSafe}.
 */
export const IDENTIFIER_NAME_RULE = 'it must contain a letter, must not start with a digit, and ' +
  'may hold only letters, digits and the separators `-`, `_` and space — no path separator, ' +
  'quote or other punctuation, since each form becomes a TypeScript identifier and a file ' +
  'name — and not a Windows device name (`con`, `nul`, `com1`, …), in at most 255 bytes.';

/** The rule `setu new`'s project-name refusal states; see {@linkcode isPathSegmentSafe}. */
export const PROJECT_NAME_RULE = 'It must start with a letter or digit and hold only letters, ' +
  'digits, `.` and `-` (a space or `_` becomes `-`) — no path separator, control character, ' +
  'quote or other punctuation — not a Windows device name (`con`, `nul`, `com1`, …, with or ' +
  'without an extension) and not ending in `.`, in at most 255 bytes.';

/** One identifier: an ID_Start character, then ID_Continue characters. */
const IDENTIFIER = /^\p{ID_Start}\p{ID_Continue}*$/u;

/** A portable segment: letters, marks, digits, `.` and `-`, not dot-led. */
const PATH_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}.-]*$/u;

/**
 * A Windows reserved device name, case-insensitive, with or without an
 * extension: Windows resolves `con`, `con.txt` and `CON.service.ts` alike to the
 * device, so a project or file named that cannot be created there, and a
 * repository holding one cannot be checked out. The superscript digits `¹²³` are
 * reserved alongside `0`–`9` for `COM` and `LPT`.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/iu;

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
 * Unicode line and paragraph separators, and the bidirectional format
 * characters that could reorder the quote as displayed — is rendered as its
 * `\uXXXX` escape instead — the quote stays one line and still shows exactly
 * what was typed. Everything else passes through verbatim.
 *
 * @param raw - The raw name as the user typed it
 * @returns The same name, safe to interpolate into a single-line message
 */
export function escapeName(raw: string): string {
  return raw.replace(CONTROL, escapeChar);
}

/**
 * Renders a whole output line safely for a terminal or a log.
 *
 * The backstop behind {@linkcode escapeName}: the CLI's `log` and `error`
 * sinks pass every message through it, so a value that reaches output by a
 * path no call site escaped still cannot move the cursor, redraw the line, or
 * hide text behind a carriage return. It leaves the line feed and the tab
 * alone, because the CLI's own multi-line and indented output uses both — which
 * is why an argv value is still escaped where it is quoted, and why a flag
 * value carrying a control character is refused before any command runs.
 *
 * @param text - A message about to be written
 * @returns The message with every other control character, and the two
 *   Unicode line and paragraph separators, rendered as `\uXXXX`
 */
export function escapeTerminalControls(text: string): string {
  return text.replace(CONTROL, (char) => char === '\n' || char === '\t' ? char : escapeChar(char));
}

/**
 * Whether a value carries a control character or a Unicode line or paragraph
 * separator — the characters {@linkcode escapeName} escapes.
 *
 * @param value - The value to test
 * @returns `true` when at least one such character is present
 */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_TEST.test(value);
}

// Control characters, the two Unicode line and paragraph separators, and the
// bidirectional format characters (ALM, LRM/RLM, the embeddings and overrides,
// and the isolates), which can reorder a line as it is displayed.
const CONTROL = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const CONTROL_TEST = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** One character as its `\uXXXX` escape. */
function escapeChar(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}
