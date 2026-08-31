/**
 * Base repository that normalizes query options and delegates data
 * operations to an adapter-specific data source.
 *
 * @module
 */
import type { EntityKey, IDataSource } from '@setu-ts/common';
import type { CountOptions, FindOptions, Page, PageOptions } from '../query/find-options.ts';
import {
  normalizeCountOptions,
  normalizePageQuery,
  normalizeQuery,
  PageNormalizationError,
} from '../query/query-builder.ts';
import type { IRepository } from '../interfaces/index.ts';
import { UnsupportedQueryFeatureError } from '../errors.ts';

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
 * import type { EntityKey, IDataSource } from '@setu-ts/common';
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
 * @typeParam Id - Primary key type, constrained to {@linkcode EntityKey}
 * @since 0.1.0
 */
export abstract class BaseRepository<Entity, Id extends EntityKey = string>
  implements IRepository<Entity, Id> {
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

  /** Find the first entity that matches the supplied query options. */
  async findOne(options?: FindOptions): Promise<Entity | null> {
    const results = await this.findAll({ ...options, limit: 1 });
    return results[0] ?? null;
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
    return await this._dataSource.delete(this.coerceId(id));
  }

  async exists(id: Id): Promise<boolean> {
    const entity = await this.findById(id);
    return entity !== null;
  }

  async count(options?: CountOptions): Promise<number> {
    const where = normalizeCountOptions(options);
    return await this._dataSource.count(where, options?.filter);
  }

  /**
   * Find a page of entities by cursor pagination.
   *
   * Refuses by name with {@linkcode UnsupportedQueryFeatureError} when the
   * bound data source does not expose a `findPage` member — which is true for
   * every shipped adapter until the milestone that implements cursor paging
   * on that backend. Absence means "cannot page by cursor", never "there are
   * no more rows".
   *
   * @param options - Find options, optionally carrying a cursor
   * @returns The page of entities plus a `nextCursor`
   * @throws {UnsupportedQueryFeatureError} When the data source lacks `findPage`
   * @throws {PageNormalizationError} When the query carries both a non-zero
   *   offset and a cursor (§3.10 — rejected, never a synchronous throw)
   */
  async findPage(options: PageOptions): Promise<Page<Entity>> {
    // normalizePageQuery — NOT normalizeQuery, which has no cursor member and
    // silently DROPS one — carries the cursor into the query and owns the §3.10
    // refusal of a non-zero offset beside a cursor. The old call meant every
    // page requested through this surface was page one, whatever cursor the
    // caller passed.
    const query = normalizePageQuery(options);
    if (query instanceof PageNormalizationError) {
      // §3.12 — reject, never a synchronous throw.
      return Promise.reject(query);
    }
    // Read presence WITHOUT detaching the method: calling an extracted
    // `findPage` loses its receiver, so a class-backed data source reading a
    // private field rejects. This repository shipped that defect once already
    // (`resolveLogger`, M52c), where every logged repository call threw.
    if (this._dataSource.findPage === undefined) {
      return Promise.reject(
        new UnsupportedQueryFeatureError(
          'cursor-pagination',
          'database-plugin',
          `The bound data source does not support cursor pagination (no findPage member). ` +
            `Use findAll with offset/limit instead.`,
        ),
      );
    }
    const result = await this._dataSource.findPage(query);
    return {
      rows: result.rows.map((row) => this.toEntity(row)),
      nextCursor: result.nextCursor,
    };
  }

  /** Cast the entity id to the type the adapter expects. */
  protected coerceId(id: Id): EntityKey {
    return id;
  }

  /** Cast a raw row to the typed Entity. */
  protected toEntity(row: Partial<Record<string, unknown>>): Entity {
    return row as unknown as Entity;
  }
}
