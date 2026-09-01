/**
 * Per-entity key mapping for the DynamoDB adapter — how an entity name
 * collapses onto a physical table and how the repository's primary key maps
 * onto the table's partition/sort key schema.
 *
 * This is the DynamoDB half of the two-layer shape `cloudflare-plugin`'s
 * `D1EntityMapping` → `D1Target` established (M52c), the same layering
 * `mongo-mapping.ts` applies: a public, per-entity override with a zero-config
 * default, collapsed by {@linkcode resolveDynamoTarget} into an internal,
 * unexported target the key and expression builders consume. The public type
 * is the surface; the internal target is what the code actually reads — its
 * key columns are always a normalised array, so no builder ever branches on an
 * absent sort key.
 *
 * @module
 */

/**
 * The storage encoding a date-bearing attribute is declared to use.
 *
 * DynamoDB has no date type (M80 plan §1A F7 — a JS `Date` sent raw is a
 * `ValidationException`), so a stored timestamp is a string or a number and
 * the adapter cannot know which without a declaration.
 *
 * @since 0.1.0
 */
export type DynamoDateEncoding = 'iso' | 'epochMs';

/**
 * A configured global secondary index and its key schema.
 *
 * @since 0.1.0
 */
export interface DynamoIndexMapping {
  /** The index's partition-key attribute. */
  readonly partitionKey: string;

  /** The index's sort-key attribute, when the index carries one. */
  readonly sortKey?: string;
}

/**
 * How one entity name maps onto a physical DynamoDB table.
 *
 * **A DynamoDB `Key` map is order-insensitive.** Unlike Mongo's compound
 * `_id` — which is matched by order-sensitive subdocument equality — a `Key`
 * map of `{partitionKey, sortKey}` and one of `{sortKey, partitionKey}`
 * retrieve the same item (measured, M80 plan §1A P2). No canonical ordering is
 * therefore imposed on the key records a caller supplies, and Mongo's
 * declared-order canonicalisation must not be ported across. The ONE place
 * column order matters is the resolved target's `keyColumns` (partition then
 * sort), because the cursor codec needs a stable order to carry values in.
 *
 * @since 0.1.0
 */
export interface DynamoEntityMapping {
  /**
   * The table name. Defaults to the entity name itself, so
   * `getRepository('users')` needs no mapping at all.
   */
  readonly table?: string;

  /**
   * The table's partition-key attribute.
   *
   * Required — unlike the scalar `'id'` default the other adapters assume —
   * because DynamoDB has no implicit key to guess: a table's key schema is a
   * physical fact, and the `attribute_exists` / `attribute_not_exists` write
   * guards and every key builder read this attribute by name. The `'id'`
   * default applies only to an entity with no mapping entry at all.
   */
  readonly partitionKey: string;

  /**
   * The table's sort-key attribute, when the table is keyed by partition AND
   * sort.
   *
   * When present, a scalar key is no longer a complete key — `GetItem` naming
   * only the partition key is a `ValidationException` (M80 plan §1A P3) — and
   * the sort key is the one field the adapter serves `orderBy` on natively
   * (M80 plan §1A Q4).
   */
  readonly sortKey?: string;

  /**
   * The table's configured global secondary indexes, keyed by index name.
   *
   * The access-path resolver selects an index when the caller's filter
   * constrains that index's partition key; it invents no portable way to ask
   * for one (M79's out-of-scope list).
   */
  readonly indexes?: Readonly<Record<string, DynamoIndexMapping>>;

  /**
   * The encoding each date-bearing attribute is stored under.
   *
   * A `Date` in an ordered comparison is converted to the attribute's declared
   * encoding — `'iso'` (ISO-8601 string) or `'epochMs'` (epoch-milliseconds
   * number). With no declaration for the attribute, the comparison is refused
   * by name: DynamoDB has no date type, so the adapter cannot know how the
   * stored value is encoded (M80 plan §1A F7).
   */
  readonly dateAttributes?: Readonly<Record<string, DynamoDateEncoding>>;
}

/**
 * The resolved, per-entity target the DynamoDB key and expression builders
 * consume.
 *
 * This is the internal half of the two-layer mapping: the public
 * {@linkcode DynamoEntityMapping} is the override bag, and this is the
 * concrete table name, key columns, and per-index/attribute configuration the
 * builders read. It is deliberately NOT exported — the mapping surface is the
 * public type, and leaking the resolved target would make one adapter's key
 * naming part of the package's published contract (the M56 defect class).
 *
 * The key schema is represented exactly once, as `keyColumns`: one element for
 * a partition-only table, two (partition then sort) when a sort key is
 * configured. Carrying the sort key as an optional sibling field instead would
 * put a `sortKey === undefined` branch in every builder — the exact place a
 * composite key silently degrades to its partition half — so no builder ever
 * sees an optional key member.
 *
 * @internal
 */
interface DynamoTarget {
  /** The physical table name. */
  readonly table: string;

  /**
   * The partition-key attribute — always `keyColumns[0]`, named separately
   * because the `attribute_exists` / `attribute_not_exists` write guards
   * address it directly and the access-path resolver keys off it.
   */
  readonly partitionKey: string;

  /**
   * The complete key schema in partition-then-sort order: a one-element array
   * for a partition-only table, `[partitionKey, sortKey]` when a sort key is
   * configured. The order is load-bearing for the cursor (M80 plan §3.9
   * carries the values in this order), not for the `Key` map itself, which
   * DynamoDB matches order-insensitively (M80 plan §1A P2).
   */
  readonly keyColumns: readonly string[];

  /** The configured global secondary indexes. Empty when none are configured. */
  readonly indexes: Readonly<Record<string, DynamoIndexMapping>>;

  /** The declared date encodings. Empty when none are declared. */
  readonly dateAttributes: Readonly<Record<string, DynamoDateEncoding>>;
}

/** The partition-key name assumed for an entity with no explicit mapping. */
const DEFAULT_PARTITION_KEY = 'id';

/**
 * Resolves an entity name to its table, key columns and declared index/date
 * configuration.
 *
 * An entity with no mapping entry uses its own name as the table and `'id'`
 * as the partition key, which is why the zero-config path works for a schema
 * whose table names already match. A mapped entity states its partition key
 * explicitly — DynamoDB has no implicit key to guess.
 *
 * @param entity - The entity name passed to `getRepository()`
 * @param mapping - The per-entity overrides, or none
 * @returns The resolved target
 * @since 0.1.0
 */
export function resolveDynamoTarget(
  entity: string,
  mapping: Readonly<Record<string, DynamoEntityMapping>> | undefined,
): DynamoTarget {
  const override = mapping?.[entity];
  const partitionKey = override?.partitionKey ?? DEFAULT_PARTITION_KEY;
  const sortKey = override?.sortKey;
  return {
    table: override?.table ?? entity,
    partitionKey,
    // The one normalisation this module exists for: the key schema is ALWAYS
    // an array — one element partition-only, two with a sort key — so every
    // downstream builder reads one shape and none branches on an absent
    // sortKey.
    keyColumns: sortKey === undefined ? [partitionKey] : [partitionKey, sortKey],
    indexes: override?.indexes ?? {},
    dateAttributes: override?.dateAttributes ?? {},
  };
}
