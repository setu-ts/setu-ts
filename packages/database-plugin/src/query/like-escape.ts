/**
 * Shared SQL `LIKE` metacharacter escaping.
 *
 * Moved out of the Drizzle adapter so the Prisma adapter can apply the same
 * literal-substring escaping to its `contains` translation — one copy, not two
 * (the M30b `pemToDer` situation the plan refuses to recreate).
 *
 * The escaping is inert without an `ESCAPE '\'` clause (Drizzle emits one) or a
 * connector whose `LIKE` defaults its escape character to backslash (PostgreSQL,
 * MySQL, SQL Server, CockroachDB). On a connector with no default escape
 * character (SQLite) the escaping would be a different wrong answer, so the
 * Prisma adapter refuses there rather than guess.
 *
 * @module
 */

/**
 * Escape SQL `LIKE` metacharacters so `contains` remains literal substring
 * matching.
 *
 * Escapes `\` first, then `%` and `_`, so a value that already contains a
 * backslash is not double-mangled. Read together with the escape clause the
 * caller emits — the escaping is inert without it.
 *
 * @param value - The raw search value
 * @returns The escaped value
 * @example
 * ```typescript
 * escapeLikePattern('50% off'); // '50\\% off'
 * escapeLikePattern('back\\slash'); // 'back\\\\slash'
 * ```
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
