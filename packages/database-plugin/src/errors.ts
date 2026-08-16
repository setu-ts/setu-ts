/**
 * Errors the database plugin throws, exported so consumers can branch on them
 * with `instanceof` rather than matching message text.
 *
 * @module
 */

/**
 * Thrown at translation time when a filter operator cannot be honoured by the
 * active backend **with the connector in use**.
 *
 * The current case is the Prisma adapter's `contains` on SQLite: Prisma emits
 * no `ESCAPE` clause and SQLite defines no default escape character, so a
 * literal substring match is not expressible through Prisma's filter API there.
 * Returning wrong rows quietly is the defect; returning a named error is the
 * repair. The error names the operator, the connector, and the adapters that
 * do support the operator, so the caller can choose a path (switch adapters,
 * use a raw query, or pass `provider` to disambiguate).
 *
 * @example
 * ```typescript
 * import { UnsupportedFilterOperatorError } from '@setu-ts/database-plugin';
 *
 * try {
 *   await repo.findAll({ filter: { type: 'comparison', field: 'name', operator: 'contains', value: '50%' } });
 * } catch (err) {
 *   if (err instanceof UnsupportedFilterOperatorError) {
 *     console.error(`'${err.operator}' is unsupported on ${err.connector ?? 'an unknown connector'}`);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class UnsupportedFilterOperatorError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'UnsupportedFilterOperatorError';

  /** The filter operator that could not be translated (e.g. `'contains'`). */
  readonly operator: string;

  /**
   * The connector the operator failed on, or `undefined` when the connector
   * could not be determined. `'sqlite'` names the concrete refusal; `undefined`
   * means the adapter could not identify its connector and the `provider`
   * option is the fix.
   */
  readonly connector: string | undefined;

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log, never
   * to serve — and names the operator and, when known, the connector.
   *
   * @param operator - The filter operator that could not be translated
   * @param connector - The connector, or `undefined` when undetermined
   * @param message - The full diagnostic, safe to log
   */
  constructor(operator: string, connector: string | undefined, message: string) {
    super(message);
    this.operator = operator;
    this.connector = connector;
  }
}
