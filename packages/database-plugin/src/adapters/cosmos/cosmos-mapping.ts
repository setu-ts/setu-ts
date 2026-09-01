/**
 * Per-entity mapping for the Cosmos adapter — how an entity name collapses
 * onto a physical container, how a document's `id` maps onto the repository's
 * primary key, and which document field carries the partition key.
 *
 * This is the Cosmos half of the two-layer shape `cloudflare-plugin`'s
 * `D1EntityMapping` → `D1Target` established (M52c) and `MongoEntityMapping` →
 * `MongoTarget` repeated (M78): a public, per-entity override with a
 * zero-config default, collapsed into an internal, unexported target the query
 * builders consume.
 *
 * Cosmos addresses an item by the PAIR (partition key, `id`), which is why the
 * two are separate members here rather than one composite-key list: `id` is
 * the document's identity within its partition, and the partition key is an
 * ordinary document field that also routes the request.
 *
 * @module
 */

/** The identity field every Cosmos document carries. */
const DOCUMENT_ID_FIELD = 'id';

/** The primary-key name assumed for an entity with no explicit mapping. */
const DEFAULT_PRIMARY_KEY = 'id';

/**
 * The Cosmos-owned properties every read carries. They are the service's
 * metadata rather than the application's row, so they are stripped before a
 * row leaves the adapter — the same reason `MongoAdapter` never returns `_id`.
 *
 * Measured on a real read: `_rid`, `_self`, `_etag`, `_attachments`, `_ts`.
 */
const SYSTEM_PROPERTIES: readonly string[] = [
  '_rid',
  '_self',
  '_etag',
  '_attachments',
  '_ts',
];

/** The property carrying the optimistic-concurrency tag. */
export const ETAG_PROPERTY = '_etag';

/**
 * How one entity name maps onto a physical Cosmos container.
 *
 * @since 0.2.0
 */
export interface CosmosEntityMapping {
  /**
   * The container name. Defaults to the entity name itself, so
   * `getRepository('orders')` needs no mapping at all.
   */
  readonly container?: string;

  /**
   * The repository-visible primary-key field name. Defaults to `'id'`.
   *
   * A Cosmos document's identity is always its `id` property, so a mapping
   * that names another field renames it onto `id` on write and back on read —
   * the `MongoEntityMapping.primaryKey` behaviour, for the same reason.
   */
  readonly primaryKey?: string;

  /**
   * The document field path(s) carrying the partition key.
   *
   * Absent, the adapter discovers it from the container definition, which is
   * both cheaper for the developer and safer: a wrong partition key is a
   * silent 404 rather than an error. When present it is VALIDATED against the
   * container definition, so a mistyped path is refused by name at first use.
   *
   * A nested path is written as an array (`['address', 'city']`); a
   * hierarchical (`MultiHash`) partition key is written as an array of paths.
   */
  readonly partitionKey?: string | readonly string[] | readonly (readonly string[])[];
}

/**
 * The resolved, per-entity target the Cosmos query builders consume.
 *
 * The internal half of the two-layer mapping. Deliberately NOT exported from
 * the package: the mapping surface is the public type, and leaking the
 * resolved target would make one adapter's container naming part of the
 * published contract (the M56 defect class).
 *
 * @internal
 */
export interface CosmosTarget {
  /** The container name. */
  readonly container: string;
  /** The repository-visible primary-key field name. */
  readonly primaryKey: string;
  /**
   * The configured partition-key field paths, each a segment list, or `null`
   * when the adapter is to discover them from the container definition.
   */
  readonly partitionKeyPaths: readonly (readonly string[])[] | null;
}

/**
 * Resolves an entity name to its container name, primary-key field, and
 * configured partition-key paths.
 *
 * An entity with no mapping entry uses its own name as the container and
 * `'id'` as the primary key, which is why the zero-config path works for a
 * schema whose container names already match.
 *
 * @param entity - The entity name passed to `getRepository()`
 * @param mapping - The per-entity overrides, or none
 * @returns The resolved target
 * @since 0.2.0
 */
export function resolveCosmosTarget(
  entity: string,
  mapping: Readonly<Record<string, CosmosEntityMapping>> | undefined,
): CosmosTarget {
  const override = mapping?.[entity];
  return {
    container: override?.container ?? entity,
    primaryKey: override?.primaryKey ?? DEFAULT_PRIMARY_KEY,
    partitionKeyPaths: normalizePartitionKeyPaths(override?.partitionKey),
  };
}

/**
 * Normalizes the public `partitionKey` override into the internal segment-list
 * form.
 *
 * Three spellings collapse onto one shape: `'tenantId'` and `['address',
 * 'city']` are a single path, while `[['tenantId'], ['region']]` is a
 * hierarchical key. The single-string and flat-array forms are told apart from
 * the hierarchical one by whether the first element is itself an array, so no
 * ambiguity survives into the target.
 *
 * @param configured - The mapping's `partitionKey` value, or none
 * @returns The segment lists, or `null` when nothing was configured
 * @since 0.2.0
 */
export function normalizePartitionKeyPaths(
  configured: string | readonly string[] | readonly (readonly string[])[] | undefined,
): readonly (readonly string[])[] | null {
  if (configured === undefined) return null;
  if (typeof configured === 'string') return [[configured]];
  if (configured.length === 0) return null;
  if (Array.isArray(configured[0])) {
    return configured as readonly (readonly string[])[];
  }
  return [configured as readonly string[]];
}

/**
 * Parses a Cosmos partition-key path (`'/tenantId'`, `'/address/city'`) into
 * its segment list.
 *
 * @param path - The leading-slash path from a container definition
 * @returns The segments, with empty ones dropped
 * @since 0.2.0
 */
export function parsePartitionKeyPath(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Renders a segment list back as a Cosmos partition-key path, so a refusal can
 * name what was configured in the same spelling the container definition uses.
 *
 * @param segments - The path segments
 * @returns The leading-slash path
 * @since 0.2.0
 */
export function renderPartitionKeyPath(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}

/**
 * Reads a nested value out of a row by segment list.
 *
 * @param row - The row to read from
 * @param segments - The path segments
 * @returns The value, or `undefined` when any segment is absent
 * @since 0.2.0
 */
export function readPath(
  row: Record<string, unknown>,
  segments: readonly string[],
): unknown {
  let current: unknown = row;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Maps a Cosmos document onto the repository's row: the system properties are
 * stripped and `id` is renamed to the mapped primary-key field.
 *
 * @param document - The raw document
 * @param target - The resolved entity target
 * @returns A shallow copy carrying neither system properties nor a stray `id`
 * @since 0.2.0
 */
export function fromDocument(
  document: Record<string, unknown>,
  target: CosmosTarget,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (SYSTEM_PROPERTIES.includes(key)) continue;
    row[key] = value;
  }
  if (
    target.primaryKey !== DOCUMENT_ID_FIELD &&
    Object.prototype.hasOwnProperty.call(row, DOCUMENT_ID_FIELD)
  ) {
    row[target.primaryKey] = row[DOCUMENT_ID_FIELD];
    delete row[DOCUMENT_ID_FIELD];
  }
  return row;
}

/**
 * Maps a repository row onto the document Cosmos stores: the mapped
 * primary-key field is renamed to `id`.
 *
 * @param row - The row a caller supplied
 * @param target - The resolved entity target
 * @returns A shallow copy keyed by `id`
 * @since 0.2.0
 */
export function toDocument(
  row: Record<string, unknown>,
  target: CosmosTarget,
): Record<string, unknown> {
  const document: Record<string, unknown> = { ...row };
  if (
    target.primaryKey !== DOCUMENT_ID_FIELD &&
    Object.prototype.hasOwnProperty.call(document, target.primaryKey)
  ) {
    document[DOCUMENT_ID_FIELD] = document[target.primaryKey];
    delete document[target.primaryKey];
  }
  return document;
}

/**
 * The document field a repository field name addresses.
 *
 * The mapped primary key is stored as `id`, so every query that filters,
 * orders or projects it has to address `id` instead — otherwise a `where`
 * clause on the primary key would match nothing at all.
 *
 * @param field - The repository-visible field name
 * @param target - The resolved entity target
 * @returns The document field name
 * @since 0.2.0
 */
export function documentField(field: string, target: CosmosTarget): string {
  return field === target.primaryKey ? DOCUMENT_ID_FIELD : field;
}
