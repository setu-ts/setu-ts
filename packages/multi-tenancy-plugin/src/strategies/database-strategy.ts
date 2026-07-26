/**
 * Database-per-tenant isolation strategy.
 *
 * @module
 */

/**
 * Isolates tenants by assigning each a separate database.
 *
 * The default database prefix is `'tenant_'`, configurable at construction.
 *
 * Implements the `'database'` arm of `ITenantIsolationStrategy`.
 */
export class DatabasePerTenant {
  public readonly kind = 'database' as const;

  private readonly prefix: string;

  constructor(prefix?: string) {
    this.prefix = prefix ?? 'tenant_';
  }

  /** Derive the database name for a tenant id. */
  resolveDatabase(tenantId: string): string {
    return `${this.prefix}${tenantId}`;
  }
}
