/**
 * Optimistic locking over the conditional writes every adapter already has
 * (M128): one implementation for outer, unit-of-work and tenant repositories.
 *
 * @module
 */
import type { WritePrecondition } from '@setu-ts/common';
import {
  EntityNotFoundError,
  UnsupportedQueryFeatureError,
  VersionConflictError,
} from '../errors.ts';

/** The adapter named by this package's own caller-input refusals. */
const ADAPTER = 'database-plugin';

/** The version field used when the caller names none. */
const DEFAULT_FIELD = 'version';

/**
 * The least a repository needs for {@linkcode updateVersioned}: a conditional
 * update and a read by id. `IRepository`, a unit-of-work repository and an
 * `ITenantRepository` all satisfy it, so the one implementation serves each.
 *
 * @typeParam E - The entity type
 * @typeParam Id - The identifier type
 * @since 0.12.0
 */
export interface VersionedWritable<E, Id> {
  /** Applies `data` only while the row matches `where`; `null` when it did not. */
  updateWhere?(id: Id, where: WritePrecondition, data: Readonly<Partial<E>>): Promise<E | null>;
  /** Reads the row, or `null` when it does not exist. */
  findById(id: Id): Promise<E | null>;
}

/**
 * The least a repository needs for {@linkcode deleteVersioned}.
 *
 * @typeParam E - The entity type
 * @typeParam Id - The identifier type
 * @since 0.12.0
 */
export interface VersionedDeletable<E, Id> {
  /** Deletes only while the row matches `where`; `false` when it did not. */
  deleteWhere?(id: Id, where: WritePrecondition): Promise<boolean>;
  /** Reads the row, or `null` when it does not exist. */
  findById(id: Id): Promise<E | null>;
}

/**
 * Options for {@linkcode updateVersioned} and {@linkcode deleteVersioned}.
 *
 * @since 0.12.0
 */
export interface VersionedWriteOptions {
  /** The version column, in both the precondition and the written payload. Default `'version'`. */
  readonly field?: string;
  /** The entity name carried by the two errors; never part of their served detail. */
  readonly entity?: string;
}

/**
 * Updates a record only if its version is still `expectedVersion`, writing
 * `data` with the version set to `expectedVersion + 1`.
 *
 * Every refusal happens before any I/O. When the conditional write matches
 * nothing, the record is read once to tell the two outcomes apart; a delete
 * that lands between the write and that read is reported as not found, which
 * is true at the moment of the read.
 *
 * @param repo - Any repository with `updateWhere` and `findById`
 * @param id - The record's identifier
 * @param expectedVersion - The version the caller read; a non-negative safe integer
 * @param data - The fields to write; must not set the version field
 * @param options - The version field and the entity name for the errors
 * @returns The updated record, carrying the new version
 * @throws {UnsupportedQueryFeatureError} `'write-precondition'` for an invalid version, field
 *   or payload; `'conditional-write'` (501) when the repository has no conditional update
 * @throws {VersionConflictError} When the record exists at another version (409)
 * @throws {EntityNotFoundError} When the record does not exist (404)
 * @example
 * ```typescript
 * const article = await updateVersioned(repo, id, body.version, { title: body.title });
 * ```
 * @since 0.12.0
 */
export async function updateVersioned<E, Id>(
  repo: VersionedWritable<E, Id>,
  id: Id,
  expectedVersion: number,
  data: Readonly<Partial<E>>,
  options?: VersionedWriteOptions,
): Promise<E> {
  const field = checkedField(options);
  checkVersion(expectedVersion);
  if (Object.hasOwn(data, field)) {
    throw new UnsupportedQueryFeatureError(
      'write-precondition',
      ADAPTER,
      'updateVersioned sets the version field itself; remove it from the update payload.',
    );
  }
  if (repo.updateWhere === undefined) throw conditionalWriteRefusal('updateWhere');
  const row = await repo.updateWhere(id, { [field]: expectedVersion }, {
    ...data,
    [field]: expectedVersion + 1,
  } as Readonly<Partial<E>>);
  if (row !== null) return row;
  throw await missOutcome(repo, id, options?.entity);
}

/**
 * Deletes a record only if its version is still `expectedVersion`.
 *
 * Refusals and the not-found/conflict read follow {@linkcode updateVersioned}.
 *
 * @param repo - Any repository with `deleteWhere` and `findById`
 * @param id - The record's identifier
 * @param expectedVersion - The version the caller read; a non-negative safe integer
 * @param options - The version field and the entity name for the errors
 * @returns Resolves once the record is deleted
 * @throws {UnsupportedQueryFeatureError} `'write-precondition'` for an invalid version or
 *   field; `'conditional-write'` (501) when the repository has no conditional delete
 * @throws {VersionConflictError} When the record exists at another version (409)
 * @throws {EntityNotFoundError} When the record does not exist (404)
 * @example
 * ```typescript
 * await deleteVersioned(repo, id, Number(ctx.query['version']));
 * ```
 * @since 0.12.0
 */
export async function deleteVersioned<E, Id>(
  repo: VersionedDeletable<E, Id>,
  id: Id,
  expectedVersion: number,
  options?: VersionedWriteOptions,
): Promise<void> {
  const field = checkedField(options);
  checkVersion(expectedVersion);
  if (repo.deleteWhere === undefined) throw conditionalWriteRefusal('deleteWhere');
  if (await repo.deleteWhere(id, { [field]: expectedVersion })) return;
  throw await missOutcome(repo, id, options?.entity);
}

/** The version field, refusing an empty name. */
function checkedField(options: VersionedWriteOptions | undefined): string {
  const field = options?.field ?? DEFAULT_FIELD;
  if (typeof field !== 'string' || field === '') {
    throw new UnsupportedQueryFeatureError(
      'write-precondition',
      ADAPTER,
      'The version field must be a non-empty string.',
    );
  }
  return field;
}

/** Refuses a version that is not a non-negative safe integer, or whose successor is unsafe. */
function checkVersion(expectedVersion: number): void {
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    !Number.isSafeInteger(expectedVersion + 1)
  ) {
    throw new UnsupportedQueryFeatureError(
      'write-precondition',
      ADAPTER,
      'The expected version must be a non-negative safe integer.',
    );
  }
}

/** The existing `conditional-write` refusal, raised before any I/O. */
function conditionalWriteRefusal(member: string): UnsupportedQueryFeatureError {
  return new UnsupportedQueryFeatureError(
    'conditional-write',
    ADAPTER,
    `The repository lacks ${member}, so a versioned write cannot be made atomic.`,
  );
}

/** Reads the record once after a miss: absent → not found, present → conflict. */
async function missOutcome<E, Id>(
  repo: { findById(id: Id): Promise<E | null> },
  id: Id,
  entity: string | undefined,
): Promise<Error> {
  const named = entity === undefined ? 'The record' : `The '${entity}' record`;
  const options = entity === undefined ? undefined : { entity };
  return (await repo.findById(id)) === null
    ? new EntityNotFoundError(`${named} does not exist.`, options)
    : new VersionConflictError(`${named} is no longer at the expected version.`, options);
}
