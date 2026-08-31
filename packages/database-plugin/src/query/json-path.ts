/**
 * Per-dialect JSON path expressions for nested filter fields.
 *
 * `FilterComparison.field` accepts a `readonly string[]` path (M79 §3.5), whose
 * first segment is a real column and whose remaining segments address inside a
 * JSON document. No two SQL dialects spell that extraction alike, so the
 * translation lives here rather than inside an adapter, and every supported
 * dialect is exercised by the same table of cases.
 *
 * **Extraction returns TEXT on every dialect**, deliberately. PostgreSQL's
 * `#>>` and MySQL's `JSON_UNQUOTE(JSON_EXTRACT(...))` are text-valued, while
 * SQLite's `json_extract` preserves the JSON type — so comparing a JSON number
 * against a bound number works on SQLite and compares text lexically on
 * PostgreSQL, where `'9' > '35'` is true. Normalising everything to text and
 * casting explicitly for ordered numeric comparisons is what makes one filter
 * mean the same thing on all three.
 *
 * @module
 */

/**
 * The SQL dialects whose JSON extraction syntax this module can emit.
 *
 * @since 0.2.0
 */
export type SqlJsonDialect = 'postgresql' | 'mysql' | 'sqlite';

/**
 * Render the `$.a.b` JSON path string MySQL and SQLite both take.
 *
 * A segment carrying a quote, a bracket or a dollar is refused rather than
 * escaped: those are path-language metacharacters, and a wrong escape reads a
 * different field instead of failing, which is the silent-divergence class this
 * package keeps closing.
 *
 * @param segments - The path below the column, at least one segment
 * @returns The `$.a.b` path string
 * @throws {Error} When a segment carries a path metacharacter
 * @since 0.2.0
 */
export function jsonPathString(segments: readonly string[]): string {
  if (segments.length === 0) {
    // `$.` is a path expression addressing nothing, which SQLite and MySQL
    // answer with NULL rather than an error — so an empty path would make a
    // filter match nothing while reporting success. Refused for the reason the
    // portable contract refuses an empty path array: a filter that quietly
    // matches nothing (or everything) is a defect, not a no-op.
    throw new Error(
      'Nested filter path is empty below its root column. A path must name at ' +
        'least one JSON key.',
    );
  }
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new Error(
        `Nested filter path segment '${segment}' is not a plain JSON key. ` +
          'Only letters, digits and underscores are accepted, and the first ' +
          'character may not be a digit.',
      );
    }
  }
  return `$.${segments.join('.')}`;
}

/**
 * Map a Drizzle dialect class name onto a {@linkcode SqlJsonDialect}.
 *
 * Drizzle exposes no public dialect discriminant, so the constructor name of
 * `db.dialect` is read — `PgDialect`, `MySqlDialect`, `SQLiteAsyncDialect` and
 * `SQLiteSyncDialect` are the shipped ones. An unrecognised name yields
 * `undefined` so the caller refuses the query BY NAME and points at the
 * explicit `dialect` option, rather than guessing a syntax and returning wrong
 * rows.
 *
 * @param name - The constructor name of the Drizzle dialect object
 * @returns The mapped dialect, or `undefined` when the name is unknown
 * @since 0.2.0
 */
export function dialectFromDrizzleClassName(
  name: string | undefined,
): SqlJsonDialect | undefined {
  if (name === undefined) return undefined;
  if (name.startsWith('Pg')) return 'postgresql';
  if (name.startsWith('MySql')) return 'mysql';
  if (name.startsWith('SQLite')) return 'sqlite';
  return undefined;
}

/**
 * Render the `{a,b}` text-array path PostgreSQL's `#>>` operator takes.
 *
 * Segments are validated by {@linkcode jsonPathString} first, so a comma or a
 * brace can never reach the array literal and re-point the extraction at a
 * different field.
 *
 * @param segments - The path below the column, at least one segment
 * @returns The `{a,b}` array literal
 * @throws {Error} When a segment carries a path metacharacter
 * @since 0.2.0
 */
export function postgresPathArray(segments: readonly string[]): string {
  jsonPathString(segments);
  return `{${segments.join(',')}}`;
}
