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
 * Escapes the control characters in a secret name.
 *
 * @param name - The secret name as the caller supplied it
 * @returns The name with each control character written as `\uXXXX`
 */
export function printableSecretName(name: string): string {
  return name.replace(
    CONTROL_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
