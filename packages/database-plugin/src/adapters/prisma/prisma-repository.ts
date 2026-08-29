/**
 * Prisma-specific repository that delegates to the Prisma adapter.
 *
 * @module
 */
import type { EntityKey } from '@setu-ts/common';
import { BaseRepository, type DataSource } from '../../repositories/base-repository.ts';

/**
 * Repository backed by the Prisma adapter.
 *
 * Wraps the Prisma client's model operations and exposes them through
 * the standard {@linkcode IRepository} interface.
 *
 * @typeParam Entity - Entity shape
 * @typeParam Id - Primary key type, constrained to {@linkcode EntityKey}
 * @since 0.1.0
 */
export class PrismaRepository<Entity extends Record<string, unknown>, Id extends EntityKey = string>
  extends BaseRepository<Entity, Id> {
  constructor(
    protected override readonly _dataSource: DataSource,
  ) {
    super(_dataSource);
  }
}

// Re-export createPrismaDataSource from the adapter (real implementation)
export { createPrismaDataSource } from './prisma-adapter.ts';
