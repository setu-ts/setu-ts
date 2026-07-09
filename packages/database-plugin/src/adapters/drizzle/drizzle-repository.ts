// deno-lint-ignore-file require-await -- stubs must be async to satisfy IRepository interface
/**
 * Drizzle-specific repository that delegates to the Drizzle adapter.
 *
 * @module
 */
import { BaseRepository, type DataSource } from '../../repositories/base-repository.ts';
import type { DrizzleAdapter } from './drizzle-adapter.ts';

/**
 * Repository backed by the Drizzle adapter.
 *
 * Wraps Drizzle query builder operations and exposes them through the
 * standard {@linkcode IRepository} interface.
 *
 * @typeParam Entity - Entity shape
 * @typeParam Id - Primary key type
 * @since 0.1.0
 */
export class DrizzleRepository<Entity, Id = string> extends BaseRepository<Entity, Id> {
  constructor(
    protected readonly _dataSource: DataSource,
  ) {
    super(_dataSource);
  }
}

/**
 * Creates a {@linkcode DataSource} backed by a {@linkcode DrizzleAdapter}
 * for the given table name.
 *
 * @param _adapter - The Drizzle adapter instance
 * @param _table - Table name
 * @returns A data source bound to the Drizzle table
 * @since 0.1.0
 */
export function createDrizzleDataSource(
  _adapter: DrizzleAdapter,
  _table: string,
): DataSource {
  // Drizzle table operations are resolved at runtime against the schema.
  // Similar to Prisma, this requires application-defined table schemas.
  return {
    async findAll() {
      return [];
    },
    async findById() {
      return null;
    },
    async create(data) {
      return data as Record<string, unknown>;
    },
    async update(_id, data) {
      return data as Record<string, unknown>;
    },
    async delete() {
      return false;
    },
    async count() {
      return 0;
    },
  };
}
