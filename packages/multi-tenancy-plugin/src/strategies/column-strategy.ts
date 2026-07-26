/**
 * Column-per-tenant isolation strategy.
 *
 * @module
 */

/**
 * Isolates tenants by stamping a tenant column on every row.
 *
 * The default column name is `'tenant_id'`, configurable at construction.
 *
 * Implements the `'column'` arm of `ITenantIsolationStrategy`.
 */
export class ColumnPerTenant {
  public readonly kind = 'column' as const;

  private readonly columnName: string;

  constructor(columnName?: string) {
    this.columnName = columnName ?? 'tenant_id';
  }

  /** Return the column name used to stamp tenant ids on rows. */
  getTenantColumn(): string {
    return this.columnName;
  }
}
