/**
 * Column-per-tenant isolation strategy.
 *
 * @module
 */

/**
 * Isolates tenants by adding a tenant-specific column to rows.
 *
 * The default column name is `'tenant_id'`, configurable at construction.
 */
/**
 * Implements the `'column'` arm of {@linkcode ITenantIsolationStrategy}.
 */
export class ColumnPerTenant {
  public readonly kind: 'column' = 'column' as const;

  private readonly _columnName: string;

  constructor(columnName?: string) {
    this._columnName = columnName ?? 'tenant_id';
  }

  /** Return the column name used to stamp tenant ids on rows. */
  getTenantColumn(): string {
    return this._columnName;
  }
}
