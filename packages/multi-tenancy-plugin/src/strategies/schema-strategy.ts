/**
 * Schema-per-tenant isolation strategy.
 *
 * @module
 */

/**
 * Isolates tenants by assigning each a separate database schema.
 *
 * The default schema prefix is `'tenant_'`, configurable at construction.
 *
 * Implements the `'schema'` arm of `ITenantIsolationStrategy`.
 */
export class SchemaPerTenant {
  public readonly kind = 'schema' as const;

  private readonly prefix: string;

  constructor(prefix?: string) {
    this.prefix = prefix ?? 'tenant_';
  }

  /** Derive the schema name for a tenant id. */
  resolveSchema(tenantId: string): string {
    return `${this.prefix}${tenantId}`;
  }
}
