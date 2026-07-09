// deno-lint-ignore-file require-await -- stubs must be async to satisfy IRepository interface
/**
 * Prisma-specific repository that delegates to the Prisma adapter.
 *
 * @module
 */
import { BaseRepository, type DataSource } from '../../repositories/base-repository.ts';
import type { PrismaAdapter } from './prisma-adapter.ts';

/**
 * Repository backed by the Prisma adapter.
 *
 * Wraps the Prisma client's model operations and exposes them through
 * the standard {@linkcode IRepository} interface.
 *
 * @typeParam Entity - Entity shape
 * @typeParam Id - Primary key type
 * @since 0.1.0
 */
export class PrismaRepository<Entity, Id = string> extends BaseRepository<Entity, Id> {
  constructor(
    protected override readonly _dataSource: DataSource,
  ) {
    super(_dataSource);
  }
}

/**
 * Creates a {@linkcode DataSource} backed by a {@linkcode PrismaAdapter}
 * for the given model name.
 *
 * @param adapter - The Prisma adapter instance
 * @param model - Prisma model name (e.g. `'User'`)
 * @returns A data source bound to the Prisma model
 * @since 0.1.0
 */
export function createPrismaDataSource(
  _adapter: PrismaAdapter,
  _model: string,
): DataSource {
  // Prisma model operations are resolved at runtime.
  // The actual Prisma client is accessed via the adapter's internal client.
  // For now, this returns a no-op data source since Prisma requires
  // a generated client that depends on the application's schema.prisma.
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
