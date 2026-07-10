/**
 * Drizzle-specific repository that delegates to the Drizzle adapter.
 *
 * @module
 */
import { BaseRepository, type DataSource } from '../../repositories/base-repository.ts';

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
    protected override readonly _dataSource: DataSource,
  ) {
    super(_dataSource);
  }
}

// Re-export createDrizzleDataSource from the adapter (real implementation)
export { createDrizzleDataSource } from './drizzle-adapter.ts';
