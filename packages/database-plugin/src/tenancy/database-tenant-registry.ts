/**
 * A tenant registry over `IDatabaseService` (M127): tenants are rows.
 *
 * `ITenantRegistry` is declared in `@setu-ts/common`, so this package
 * implements it without importing `@setu-ts/multi-tenancy-plugin`
 * (AI_GUIDELINES §2.2). Like the data-store bridge it is a `RegistryFactory`,
 * resolved by the multi-tenancy plugin in `onInit`, so `DatabasePlugin` may be
 * registered after the tenancy plugin.
 *
 * **The row never reaches the request.** A hit carries `id`, `name` (when the
 * name column holds a string) and the result of an explicit `toMetadata` — no
 * other column, so a secret on the tenant table does not land on
 * `ctx.request.tenant` or in a log.
 *
 * @module
 */
import type {
  IServiceRegistry,
  ITenant,
  ITenantRegistry,
  Option,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES, none, some } from '@setu-ts/common';
import type { IDatabaseService, IRepository } from '../interfaces/index.ts';

/**
 * Options for {@linkcode createDatabaseTenantRegistry}.
 *
 * @since 0.12.0
 */
export interface DatabaseTenantRegistryOptions {
  /** Entity holding one row per tenant (default `'Tenant'`). */
  readonly entity?: string;
  /**
   * Field the requested id is matched against, and whose value becomes the
   * canonical tenant id (default `'id'`). A slug column works as well as the
   * primary key.
   */
  readonly idField?: string;
  /** Field copied to `ITenant.name` when it holds a string (default `'name'`). */
  readonly nameField?: string;
  /**
   * Field whose falsy value marks a suspended tenant: such a row answers
   * `none()` — refused, data kept. Omitted: every row is active.
   */
  readonly activeField?: string;
  /**
   * Builds `ITenant.metadata` from the row. Omitted: the tenant has no
   * `metadata`. Copy only what a request may see. Return a plain object — an
   * array, `Map`, class instance or object from another realm is dropped.
   */
  readonly toMetadata?: (
    row: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

/** Throws a `TypeError` naming the option unless `value` is a non-empty string or absent. */
function optionalName(value: unknown, option: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`createDatabaseTenantRegistry: ${option} must be a non-empty string.`);
  }
  return value;
}

/** The resolved options. */
interface ResolvedOptions {
  readonly entity: string;
  readonly idField: string;
  readonly nameField: string;
  readonly activeField: string | undefined;
  readonly toMetadata: DatabaseTenantRegistryOptions['toMetadata'];
}

/** Validates the options once, when the factory is created. */
function resolveOptions(options: DatabaseTenantRegistryOptions | undefined): ResolvedOptions {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('createDatabaseTenantRegistry: options must be an object.');
  }
  const toMetadata = options?.toMetadata;
  if (toMetadata !== undefined && typeof toMetadata !== 'function') {
    throw new TypeError('createDatabaseTenantRegistry: toMetadata must be a function.');
  }
  return {
    entity: optionalName(options?.entity, 'entity', 'Tenant'),
    idField: optionalName(options?.idField, 'idField', 'id'),
    nameField: optionalName(options?.nameField, 'nameField', 'name'),
    activeField:
      options?.activeField === undefined
        ? undefined
        : optionalName(options.activeField, 'activeField', ''),
    toMetadata,
  };
}

/** The registry itself; constructed by the factory over a resolved repository. */
class DatabaseTenantRegistry implements ITenantRegistry {
  readonly #repository: IRepository<Record<string, unknown>>;
  readonly #options: ResolvedOptions;

  constructor(repository: IRepository<Record<string, unknown>>, options: ResolvedOptions) {
    this.#repository = repository;
    this.#options = options;
  }

  async lookup(id: string): Promise<Option<ITenant>> {
    const { entity, idField, nameField, activeField, toMetadata } = this.#options;
    const row = await this.#repository.findOne({ where: { [idField]: id } });
    if (row === null) return none();
    if (activeField !== undefined && !row[activeField]) return none();
    const canonical = row[idField];
    if (typeof canonical !== 'string' || canonical === '') {
      throw new TypeError(
        `createDatabaseTenantRegistry: the '${entity}' row's '${idField}' is not a non-empty string.`,
      );
    }
    const name = row[nameField];
    return some({
      id: canonical,
      ...(typeof name === 'string' && { name }),
      ...(toMetadata !== undefined && { metadata: toMetadata(row) }),
    });
  }
}

/**
 * Creates a tenant registry over the application's database, for the
 * multi-tenancy plugin's `tenants` option.
 *
 * The returned factory resolves `CAPABILITIES.DATABASE` (as `IDatabaseService`)
 * and fetches the entity's repository once. `lookup(id)` runs
 * `findOne({ where: { [idField]: id } })`: no row, or a row whose `activeField`
 * is falsy, is `none()`; a row whose `idField` is not a non-empty string throws
 * a `TypeError` (the plugin answers it with a `503`); otherwise the tenant
 * carries the row's `idField` as its canonical id, `nameField` when a string,
 * and `toMetadata(row)` when given — never other columns.
 *
 * Wrapped by the plugin's bounded cache by default (`tenantCache`). Misses are
 * not cached, so each request naming an unknown tenant runs one query; put a
 * rate limit in front of a public tenant resolver.
 *
 * @param options - Entity and field names, the active flag, the metadata mapper
 * @returns A factory the multi-tenancy plugin resolves in `onInit`
 * @throws {TypeError} When an option is not a non-empty string, or
 * `toMetadata` is not a function
 *
 * @example
 * ```typescript
 * import { DatabasePlugin, createDatabaseTenantRegistry } from '@setu-ts/database-plugin';
 * import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     DatabasePlugin({ type: 'memory' }),
 *     MultiTenancyPlugin({
 *       resolver: 'subdomain',
 *       required: true,
 *       tenants: createDatabaseTenantRegistry({ idField: 'slug', activeField: 'active' }),
 *     }),
 *   ],
 * });
 * ```
 * @since 0.12.0
 */
export function createDatabaseTenantRegistry(
  options?: DatabaseTenantRegistryOptions,
): RegistryFactory<ITenantRegistry> {
  const resolved = resolveOptions(options);
  return (services: IServiceRegistry): ITenantRegistry => {
    const database = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    return new DatabaseTenantRegistry(
      database.getRepository<Record<string, unknown>>(resolved.entity),
      resolved,
    );
  };
}
