/**
 * Renders a secret name for an error message or a log line (M101a security
 * audit O1).
 *
 * A secret name is caller input. A raw CR or LF in it would let a caller
 * forge a log line, so every C0 control character and DEL is written as a
 * `\uXXXX` escape. A name without control characters is returned unchanged.
 *
 * @module
 * @internal
 */

/** C0 control characters and DEL. */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

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
