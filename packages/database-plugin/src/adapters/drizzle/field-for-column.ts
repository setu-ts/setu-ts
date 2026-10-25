/** Internal Drizzle column-to-property resolution. @module */
/** Internal data-source column resolver marker. @since 0.11.0 */
export const FIELD_FOR_COLUMN: unique symbol = Symbol('field-for-column');
/** Internal service entity-field resolver marker. @since 0.11.0 */
export const ENTITY_FIELD_RESOLVER: unique symbol = Symbol('entity-field-resolver');

/**
 * Resolve a property first, then a unique SQL column name.
 * @param table - The registered table
 * @param name - The strategy's column or property name
 * @returns The resolved property, or undefined when absent or ambiguous
 * @since 0.11.0
 */
export function fieldForColumn(table: object, name: string): string | undefined {
  const columns = (table as Record<symbol, unknown>)[Symbol.for('drizzle:Columns')];
  const fields =
    columns !== null && typeof columns === 'object' && !Array.isArray(columns)
      ? (columns as Record<string, unknown>)
      : (table as Record<string, unknown>);
  if (Object.hasOwn(fields, name)) return name;
  const matches = Object.entries(fields).filter(
    ([, column]) =>
      column !== null && typeof column === 'object' && (column as { name?: unknown }).name === name,
  );
  return matches.length === 1 ? matches[0]![0] : undefined;
}
