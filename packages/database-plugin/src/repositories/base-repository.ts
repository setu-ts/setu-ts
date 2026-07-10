// deno-lint-ignore-file require-await -- interface methods must be async (IRepository)
/**
 * Base repository that normalizes query options and delegates data
 * operations to an adapter-specific data source.
 *
 * @module
 */
import type { CountOptions, FindOptions } from '../query/find-options.ts';
import {
  applyOrderBy,
  applyPagination,
  matchesWhere,
  normalizeCountOptions,
  type NormalizedQuery,
  normalizeQuery,
  projectFields,
} from '../query/query-builder.ts';
import type { IRepository } from '../interfaces/index.ts';

/**
 * Internal data-source contract that adapter-specific implementations
 * provide. This keeps {@linkcode BaseRepository} decoupled from concrete
 * ORM clients.
 *
 * @internal
 */
export interface DataSource {
  /** Find all entities matching the normalized query. */
  findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]>;
  /** Find a single entity by its primary key value. */
  findById(id: string | number): Promise<Record<string, unknown> | null>;
  /** Insert a new entity and return it with generated fields. */
  create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>>;
  /** Update an existing entity by primary key. */
  update(
    id: string | number,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Delete by primary key; returns `true` when deleted. */
  delete(id: string | number): Promise<boolean>;
  /** Count entities matching the filter. */
  count(where: Record<string, unknown>): Promise<number>;
}

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
    const query = normalizeQuery(options);

    let results = await this._dataSource.findAll(query);

    // Apply filter (may already be done by adapter; this is a safety net).
    if (Object.keys(query.where).length > 0) {
      results = results.filter((row) => matchesWhere(row, query.where));
    }

    results = applyOrderBy(results, query.orderBy);
    results = applyPagination(results, query.offset, query.limit);

    if (query.select.length > 0) {
      return results.map((row) => this.toEntity(projectFields(row, query.select)));
    }

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
