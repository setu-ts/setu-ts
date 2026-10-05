/**
 * Shared diagnostics alias character policy.
 *
 * @module
 */

/**
 * Reports control (Cc), format (Cf), line separator (Zl) and paragraph separator (Zp)
 * characters — each can reorder, hide or break the line an alias is displayed on.
 * Byte limits and error messages belong to each consumer.
 *
 * @param value - The alias to scan
 * @returns Whether any code point is forbidden
 * @since 0.9.0
 */
export function hasForbiddenAliasCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
