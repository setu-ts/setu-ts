/**
 * Scoped RBAC sources over `IDatabaseService` (M110b): grants and per-scope
 * custom roles read from the application's own database.
 *
 * `IGrantSource` and `IScopedRoleSource` are declared in `@setu-ts/common`, so
 * this package implements them by name without importing
 * `@setu-ts/auth-plugin` (AI_GUIDELINES §2.2). Both are `RegistryFactory`s,
 * resolved by AuthPlugin in `onInit` — the M101c `DatabaseTenantDataStore`
 * precedent — so `DatabasePlugin` may be registered in any order.
 *
 * **Only scalar strings reach a filter.** Field names are validated as
 * identifiers when the factory is built, and every value is a principal id or
 * a scope reference the evaluator has already validated — never an object,
 * which MongoDB would read as a query operator.
 *
 * **A query is abandoned, not cancelled, on the evaluator's deadline.**
 * `IRepository.findAll` takes no `AbortSignal`, so the signal is checked
 * before the query is issued; a query already running keeps running on the
 * database after the check has denied. AuthPlugin coalesces identical
 * concurrent questions, which bounds how many abandoned copies one principal
 * can create.
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type {
  FilterExpression,
  GrantQuery,
  IGrantSource,
  IPrincipal,
  IScopedRoleSource,
  IServiceRegistry,
  RegistryFactory,
  ScopedGrant,
  ScopedRoleDefinition,
  ScopeRef,
} from '@setu-ts/common';
import type { IDatabaseService } from '../interfaces/index.ts';

/** The field names a grant row is read through. */
export interface GrantFields {
  /** The principal id column (default `'subject'`). */
  readonly subject?: string;
  /** The role column (default `'role'`). */
  readonly role?: string;
  /** The scope type column, `null` for a global grant (default `'scopeType'`). */
  readonly scopeType?: string;
  /** The scope id column, `null` for a global grant (default `'scopeId'`). */
  readonly scopeId?: string;
}

/**
 * Options of {@linkcode createDatabaseGrantSource}.
 *
 * @since 0.9.0
 */
export interface DatabaseGrantSourceOptions {
  /** The entity (table, collection) holding one row per grant. */
  readonly entity: string;
  /** The source's name in log records (default `'database-grants'`). */
  readonly name?: string;
  /** Column names, when they differ from the defaults. */
  readonly fields?: GrantFields;
  /**
   * The most rows one query reads, 1–10 001 (default 10 001). Keep it above
   * `scopedRbac.maxGrantsPerPrincipal`, so an over-limit principal is refused
   * by AuthPlugin rather than silently truncated here.
   */
  readonly limit?: number;
}

/** The field names a custom-role row is read through. */
export interface RoleFields {
  /** The defining scope's type column (default `'scopeType'`). */
  readonly scopeType?: string;
  /** The defining scope's id column (default `'scopeId'`). */
  readonly scopeId?: string;
  /** The role name column (default `'role'`). */
  readonly role?: string;
  /** The permission column — one row per permission (default `'permission'`). */
  readonly permission?: string;
}

/**
 * Options of {@linkcode createDatabaseRoleSource}.
 *
 * @since 0.9.0
 */
export interface DatabaseRoleSourceOptions {
  /** The entity holding one row per (scope, role, permission). */
  readonly entity: string;
  /** The source's name in log records (default `'database-roles'`). */
  readonly name?: string;
  /** Column names, when they differ from the defaults. */
  readonly fields?: RoleFields;
  /** The most rows one query reads, 1–100 000 (default 100 000). */
  readonly limit?: number;
}

/** A column name: an identifier, so it can never be read as an operator. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function field(value: string | undefined, fallback: string, factory: string): string {
  const name = value ?? fallback;
  if (typeof name !== 'string' || !FIELD.test(name)) {
    throw new TypeError(
      `${factory}: field names must be identifiers, received ${JSON.stringify(String(name))}`,
    );
  }
  return name;
}

function limitOf(value: number | undefined, max: number, factory: string): number {
  if (value === undefined) {
    return max;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${factory}: limit must be an integer between 1 and ${max}`);
  }
  return value;
}

function entityOf(value: unknown, factory: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${factory}: entity must be a non-empty string`);
  }
  return value;
}

function eq(fieldName: string, value: string | null): FilterExpression {
  return { type: 'comparison', field: fieldName, operator: 'eq', value };
}

function scopeClause(types: string, ids: string, scope: ScopeRef): FilterExpression {
  return { type: 'and', filters: [eq(types, scope.type), eq(ids, scope.id)] };
}

/** Refuses to start a query whose deadline has already passed. */
function assertLive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('the scoped RBAC deadline expired before the query', 'AbortError');
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Builds a scoped RBAC grant source over a repository: one row per grant,
 * `scopeType`/`scopeId` both `null` for a global grant.
 *
 * A `chain` question is ONE query — the subject, and the scope in the chain or
 * global; an `all` question (sign-in timing) reads every row of the subject.
 *
 * @param options - The entity, column names and row limit
 * @returns A factory AuthPlugin resolves in `onInit`
 * @throws {TypeError} When the entity, a field name or the limit is invalid
 * @example
 * ```typescript
 * AuthPlugin({
 *   rbac: { roles: { approver: { permissions: ['invoices:approve'] } } },
 *   scopedRbac: {
 *     sources: [{ kind: 'custom', source: createDatabaseGrantSource({ entity: 'grants' }) }],
 *   },
 * });
 * ```
 * @since 0.9.0
 */
export function createDatabaseGrantSource(
  options: DatabaseGrantSourceOptions,
): RegistryFactory<IGrantSource> {
  const factory = 'createDatabaseGrantSource';
  const entity = entityOf(options?.entity, factory);
  const subject = field(options.fields?.subject, 'subject', factory);
  const role = field(options.fields?.role, 'role', factory);
  const scopeType = field(options.fields?.scopeType, 'scopeType', factory);
  const scopeId = field(options.fields?.scopeId, 'scopeId', factory);
  const limit = limitOf(options.limit, 10_001, factory);
  const name = options.name ?? 'database-grants';
  const globalClause: FilterExpression = {
    type: 'and',
    filters: [eq(scopeType, null), eq(scopeId, null)],
  };

  return (services: IServiceRegistry): IGrantSource => {
    const service = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    return {
      name,
      grantsFor: async (
        principal: IPrincipal,
        query: GrantQuery,
        signal: AbortSignal,
      ): Promise<readonly ScopedGrant[]> => {
        assertLive(signal);
        const bySubject = eq(subject, principal.id);
        const filter: FilterExpression = query.kind === 'all' ? bySubject : {
          type: 'and',
          filters: [
            bySubject,
            {
              type: 'or',
              filters: [
                globalClause,
                ...query.scopes.map((scope) => scopeClause(scopeType, scopeId, scope)),
              ],
            },
          ],
        };
        const rows = await service.getRepository<Record<string, unknown>>(entity).findAll({
          filter,
          limit,
        });
        return rows.map((row) => {
          const type = text(row[scopeType]);
          const id = text(row[scopeId]);
          // Both null is a global grant; one null is malformed, and is left
          // for AuthPlugin's validator to drop and count.
          return {
            role: text(row[role]) ?? '',
            scope: type === null && id === null ? null : { type: type ?? '', id: id ?? '' },
          } as ScopedGrant;
        });
      },
    };
  };
}

/**
 * Builds a scoped RBAC custom-role source over a repository: one row per
 * (defining scope, role, permission).
 *
 * One query per call, for every scope asked about; rows are grouped into
 * role definitions. AuthPlugin drops a role that would shadow a catalogue role
 * and a permission outside the catalogue.
 *
 * @param options - The entity, column names and row limit
 * @returns A factory AuthPlugin resolves in `onInit`
 * @throws {TypeError} When the entity, a field name or the limit is invalid
 * @since 0.9.0
 */
export function createDatabaseRoleSource(
  options: DatabaseRoleSourceOptions,
): RegistryFactory<IScopedRoleSource> {
  const factory = 'createDatabaseRoleSource';
  const entity = entityOf(options?.entity, factory);
  const scopeType = field(options.fields?.scopeType, 'scopeType', factory);
  const scopeId = field(options.fields?.scopeId, 'scopeId', factory);
  const role = field(options.fields?.role, 'role', factory);
  const permission = field(options.fields?.permission, 'permission', factory);
  const limit = limitOf(options.limit, 100_000, factory);
  const name = options.name ?? 'database-roles';

  return (services: IServiceRegistry): IScopedRoleSource => {
    const service = services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    return {
      name,
      rolesFor: async (
        scopes: readonly ScopeRef[],
        signal: AbortSignal,
      ): Promise<readonly ScopedRoleDefinition[]> => {
        assertLive(signal);
        if (scopes.length === 0) {
          return [];
        }
        const rows = await service.getRepository<Record<string, unknown>>(entity).findAll({
          filter: {
            type: 'or',
            filters: scopes.map((scope) => scopeClause(scopeType, scopeId, scope)),
          },
          limit,
        });
        const grouped = new Map<string, { scope: ScopeRef; role: string; permissions: string[] }>();
        for (const row of rows) {
          const type = text(row[scopeType]);
          const id = text(row[scopeId]);
          const roleName = text(row[role]);
          const granted = text(row[permission]);
          if (type === null || id === null || roleName === null || granted === null) {
            continue;
          }
          const key = JSON.stringify([type, id, roleName]);
          const entry = grouped.get(key) ??
            { scope: { type, id }, role: roleName, permissions: [] };
          entry.permissions.push(granted);
          grouped.set(key, entry);
        }
        return [...grouped.values()];
      },
    };
  };
}
