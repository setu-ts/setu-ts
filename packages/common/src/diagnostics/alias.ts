/**
 * Shared diagnostics alias character policy.
 *
 * @module
 */

/**
 * Reports control (Cc) and format (Cf) characters that can spoof display aliases.
 * Byte limits and error messages belong to each consumer.
 *
 * @param value - The alias to scan
 * @returns Whether any code point is forbidden
 * @since 0.9.0
 */
export function hasForbiddenAliasCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}
