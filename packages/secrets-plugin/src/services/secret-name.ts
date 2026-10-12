/**
 * Renders a secret name for an error message or a log line (M101a security
 * audit O1).
 *
 * A secret name is caller input. A raw CR or LF in it would let a caller
 * forge a log line, so every C0 control character, DEL, every C1 control
 * character (which includes NEL and the terminal CSI), and the Unicode line
 * and paragraph separators are written as `\uXXXX` escapes. A name without
 * them is returned unchanged.
 *
 * @module
 * @internal
 */

/** C0 and C1 control characters, DEL, and U+2028/U+2029. */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * The most characters of a name a message quotes (M101a security audit L3).
 * A longer name is cut there and the remainder counted, so a caller-supplied
 * name cannot make one log record arbitrarily large.
 */
export const MAX_PRINTED_NAME_LENGTH = 256;

/**
 * Escapes the control characters in a secret name and bounds its length.
 *
 * @param name - The secret name as the caller supplied it
 * @returns The name with each control character written as `\uXXXX`, cut at
 *   {@linkcode MAX_PRINTED_NAME_LENGTH} characters with the rest counted
 */
export function printableSecretName(name: string): string {
  if (name.length > MAX_PRINTED_NAME_LENGTH) {
    const rest = name.length - MAX_PRINTED_NAME_LENGTH;
    return `${escapeControls(name.slice(0, MAX_PRINTED_NAME_LENGTH))}… (${rest} more characters)`;
  }
  return escapeControls(name);
}

/** Writes each control character in `text` as `\uXXXX`. */
function escapeControls(text: string): string {
  return text.replace(
    CONTROL_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
