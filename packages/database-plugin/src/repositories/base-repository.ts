// deno-lint-ignore-file require-await -- interface methods must be async (IRepository)
/**
 * Base repository that normalizes query options and delegates data
 * operations to an adapter-specific data source.
 *
 * @module
 */
import type { IDataSource } from '@setu-ts/common';
import type { CountOptions, FindOptions } from '../query/find-options.ts';
import { normalizeCountOptions, normalizeQuery } from '../query/query-builder.ts';
import type { IRepository } from '../interfaces/index.ts';

/**
 * The data-access seam adapter-specific implementations provide, keeping
 * {@linkcode BaseRepository} decoupled from concrete ORM clients.
 *
 * @deprecated Use {@linkcode IDataSource} from `@setu-ts/common`
 * instead — the port was promoted there in M52c so a backend living in
 * another package can implement it. This alias is the same type and keeps
 * working; it will be removed in the next major version.
 * @example
 * ```typescript
 * // Before
 * import type { DataSource } from '@setu-ts/database-plugin';
 * // After
 * import type { IDataSource } from '@setu-ts/common';
 * ```
 * @since 0.1.0
 */
export type DataSource = IDataSource;

/**
 * Shared repository implementation that normalizes options and delegates
 * data operations to a {@linkcode DataSource}.
 *
 * Subclassing is intentional here: adapter-specific repositories extend
 * this class and provide their own {@linkcode DataSource} wire-up.
 *
 * @typeParam Entity - Entity shape
 * @typeParam Id - Primary key type
 * @since 0.1.0
 */
export abstract class BaseRepository<Entity, Id = string> implements IRepository<Entity, Id> {
  /**
   * Creates a new repository instance.
   *
   * @param dataSource - The underlying data source for this entity
   */
  protected constructor(
    /** The underlying data source for this entity. */
    protected readonly _dataSource: DataSource,
  ) {}

  async findById(id: Id): Promise<Entity | null> {
    const entity = await this._dataSource.findById(this.coerceId(id));
    if (!entity) return null;
    return this.toEntity(entity);
  }

  async findAll(options?: FindOptions): Promise<Entity[]> {
    // The DataSource owns query evaluation — every adapter applies `where`,
    // `orderBy`, `offset`/`limit` and `select` itself (Prisma and Drizzle push
    // down or evaluate; the memory adapter uses the shared helpers). Re-applying
    // any of it here corrupted the result:
    //
    //   `offset` was applied TWICE, so `{ limit: 3, offset: 3 }` sliced index 3
    //   of an already-offset 3-row page and every page after the first came back
    //   EMPTY — through the public `repository.findAll()` surface, on all three
    //   adapters. `where` was re-checked with strict equality too, which drops
    //   rows a database matched on a non-primitive value (a `Date`, a Decimal).
    const query = normalizeQuery(options);
    const results = await this._dataSource.findAll(query);
    return results.map((row) => this.toEntity(row));
  }

  async create(data: Partial<Entity>): Promise<Entity> {
    const created = await this._dataSource.create(data as Partial<Record<string, unknown>>);
    return this.toEntity(created);
  }

  async update(id: Id, data: Partial<Entity>): Promise<Entity> {
    const updated = await this._dataSource.update(
      this.coerceId(id),
      data as Partial<Record<string, unknown>>,
    );
    return this.toEntity(updated);
  }

  async delete(id: Id): Promise<boolean> {
    return this._dataSource.delete(this.coerceId(id));
  }

  async exists(id: Id): Promise<boolean> {
    const entity = await this.findById(id);
    return entity !== null;
  }

  async count(options?: CountOptions): Promise<number> {
    const where = normalizeCountOptions(options);
    return this._dataSource.count(where);
  }

  /** Cast the entity id to the type the adapter expects. */
  protected coerceId(id: Id): string | number {
    return id as string | number;
  }

  /** Cast a raw row to the typed Entity. */
  protected toEntity(row: Partial<Record<string, unknown>>): Entity {
    return row as unknown as Entity;
  }
}
