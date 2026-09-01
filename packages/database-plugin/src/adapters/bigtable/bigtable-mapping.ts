/**
 * Per-entity mapping for the Bigtable adapter — how an entity name collapses
 * onto a physical table, how its logical fields compose the single row key, and
 * where each field's cell lives.
 *
 * This is the Bigtable half of the two-layer shape `D1EntityMapping →
 * D1Target` established in M52c and followed by `mongo-mapping.ts` and
 * `dynamo-mapping.ts`: a public per-entity override with a zero-config default,
 * collapsed by {@linkcode resolveBigtableTarget} into an internal target the
 * key composer, the scan planner and the data source consume. The public type
 * is the surface; the resolved target is not exported, so one adapter's
 * internal naming never becomes part of the package's published contract.
 *
 * @module
 */
import { UnsupportedQueryFeatureError } from '../../errors.ts';

/** The adapter name every mapping refusal carries. */
const ADAPTER = 'bigtable';

/** The column family an entity with no `columnFamily` override writes to. */
const DEFAULT_COLUMN_FAMILY = 'cf';

/** The field a row key with no `rowKey` override is composed from. */
const DEFAULT_KEY_FIELD = 'id';

/** The separator a composed row key uses when the mapping names none. */
const DEFAULT_ROW_KEY_SEPARATOR = '#';

/**
 * The characters a column family or qualifier may contain.
 *
 * Validated because the projection push-down selects columns by qualifier
 * NAME, which is exact only while the name carries no regex metacharacter —
 * the M52c identifier-validation precedent, turning a silently-wrong
 * projection into a named configuration error.
 */
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

/**
 * How a value round-trips through a cell.
 *
 * - `'tagged'` (default) writes `<tag>:<payload>`, so a number, boolean, `null`,
 *   `Date` or object comes back as itself.
 * - `'raw'` writes `String(value)` and reads every cell as a string — the shape
 *   a table written outside this framework already has.
 *
 * @since 0.2.0
 */
export type BigtableValueEncoding = 'tagged' | 'raw';

/**
 * How an entity's logical fields compose its single row key.
 *
 * Bigtable's row key is one lexicographically-sorted string, and composing it
 * from several logical fields is the platform's standard practice. That is a
 * MAPPING concern rather than the composite-key CONTRACT concern M79 added:
 * the repository still addresses a row by an `EntityKey`, and this decides how
 * that key becomes bytes.
 *
 * @example
 * ```typescript
 * const rowKey = { fields: ['tenantId', 'userId'], separator: '#', prefix: 'u/' };
 * // findById({ tenantId: 't1', userId: 'u2' }) reads row key 'u/t1#u2'
 * ```
 * @since 0.2.0
 */
export interface BigtableRowKeyMapping {
  /**
   * The logical fields the row key is composed from, in order. The order is
   * load-bearing: it is both the byte order the key sorts in and the order the
   * portable cursor carries key values in.
   */
  readonly fields: readonly string[];
  /**
   * The separator joining the fields. Defaults to `'#'`. Ignored for a
   * single-field key, which is the field's own string form.
   */
  readonly separator?: string;
  /** A constant prefix prepended to every row key of this entity. */
  readonly prefix?: string;
}

/**
 * How one entity name maps onto a physical Bigtable table.
 *
 * @since 0.2.0
 */
export interface BigtableEntityMapping {
  /** The table id. Defaults to the entity name itself. */
  readonly table?: string;
  /** How the row key is composed. Defaults to `{ fields: ['id'] }`. */
  readonly rowKey?: BigtableRowKeyMapping;
  /** The column family unmapped fields are written to. Defaults to `'cf'`. */
  readonly columnFamily?: string;
  /**
   * Per-field column addresses. A value of `'family'` keeps the field name as
   * the qualifier; `'family:qualifier'` names both.
   */
  readonly columns?: Readonly<Record<string, string>>;
  /** How values round-trip through a cell. Defaults to `'tagged'`. */
  readonly valueEncoding?: BigtableValueEncoding;
}

/**
 * One field's resolved cell address.
 *
 * @internal
 */
export interface BigtableColumnAddress {
  /** The column family. */
  readonly family: string;
  /** The column qualifier. */
  readonly qualifier: string;
}

/**
 * The resolved, per-entity target the key composer, the scan planner and the
 * data source read.
 *
 * Not exported from the package barrel: the mapping surface is the public
 * type, and leaking the resolved target would make one adapter's internal
 * naming part of the published contract (the M56 defect class).
 *
 * @internal
 */
export interface BigtableTarget {
  /** The entity name, quoted in every diagnostic. */
  readonly entity: string;
  /** The physical table id. */
  readonly table: string;
  /** The row-key fields, in composition order. Also the cursor's key columns. */
  readonly keyFields: readonly string[];
  /** The separator joining composed key fields. */
  readonly separator: string;
  /** The constant row-key prefix, or `''`. */
  readonly prefix: string;
  /** The family unmapped fields are written to. */
  readonly defaultFamily: string;
  /** The declared per-field column addresses. */
  readonly columns: Readonly<Record<string, BigtableColumnAddress>>;
  /** How values round-trip through a cell. */
  readonly valueEncoding: BigtableValueEncoding;
}

/**
 * Refuses a present-but-blank mapping identifier by name.
 *
 * `undefined` is the "not configured" case and is left to the caller's
 * defaulting; only a present, empty or whitespace identifier is refused,
 * because that is a configuration mistake the server would report — if at all —
 * without naming the entity or the option.
 *
 * @param entity - The entity the mapping belongs to
 * @param option - The dotted option path, quoted in the message
 * @param value - The configured identifier, when present
 * @throws {UnsupportedQueryFeatureError} When the identifier is blank
 */
function requireIdentifier(entity: string, option: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.trim() === '') {
    throw new UnsupportedQueryFeatureError(
      'mapping',
      ADAPTER,
      `Bigtable entity '${entity}' has an empty '${option}' in its mapping; omit the option to ` +
        `take its default, or name a real identifier.`,
    );
  }
}

/**
 * Refuses a family or qualifier carrying a character the projection filter
 * cannot address exactly.
 *
 * @param entity - The entity the mapping belongs to
 * @param option - The dotted option path, quoted in the message
 * @param value - The identifier to check
 * @throws {UnsupportedQueryFeatureError} When the identifier is not
 *   `[A-Za-z0-9_.-]+`
 */
function requireColumnIdentifier(entity: string, option: string, value: string): void {
  if (IDENTIFIER.test(value)) return;
  throw new UnsupportedQueryFeatureError(
    'mapping',
    ADAPTER,
    `Bigtable entity '${entity}' maps '${option}' to '${value}', which is not a usable column ` +
      `identifier. A family or qualifier must match [A-Za-z0-9_.-]+ — the projection filter ` +
      `selects columns by qualifier name, and a metacharacter would make that selection inexact.`,
  );
}

/**
 * Parses one `columns` entry into a family and a qualifier.
 *
 * @param entity - The entity the mapping belongs to
 * @param field - The logical field being addressed
 * @param spec - The address spec: `'family'` or `'family:qualifier'`
 * @returns The resolved address
 * @throws {UnsupportedQueryFeatureError} When the spec is blank, carries more
 *   than one colon, or names an unusable identifier
 */
function parseColumnSpec(
  entity: string,
  field: string,
  spec: string,
): BigtableColumnAddress {
  const parts = spec.split(':');
  if (parts.length > 2) {
    throw new UnsupportedQueryFeatureError(
      'mapping',
      ADAPTER,
      `Bigtable entity '${entity}' maps field '${field}' to '${spec}', which carries more than ` +
        `one ':'. Use 'family' or 'family:qualifier'.`,
    );
  }
  const family = parts[0];
  const qualifier = parts.length === 2 ? parts[1] : field;
  requireColumnIdentifier(entity, `columns.${field} family`, family);
  requireColumnIdentifier(entity, `columns.${field} qualifier`, qualifier);
  return { family, qualifier };
}

/**
 * Resolves an entity name to its table, row-key composition, column addresses
 * and value encoding.
 *
 * An entity with no mapping entry uses its own name as the table, `['id']` as
 * the row-key fields, `'cf'` as the column family and tagged values — so the
 * zero-config path works for a table whose name already matches the entity.
 *
 * @param entity - The entity name passed to `getRepository()`
 * @param mapping - The per-entity overrides, or none
 * @returns The resolved target
 * @throws {UnsupportedQueryFeatureError} When an identifier is blank or
 *   unusable, `rowKey.fields` is empty, or two fields resolve to one qualifier
 * @since 0.2.0
 */
export function resolveBigtableTarget(
  entity: string,
  mapping: Readonly<Record<string, BigtableEntityMapping>> | undefined,
): BigtableTarget {
  const override = mapping?.[entity];
  requireIdentifier(entity, 'table', override?.table);
  requireIdentifier(entity, 'columnFamily', override?.columnFamily);

  const defaultFamily = override?.columnFamily ?? DEFAULT_COLUMN_FAMILY;
  requireColumnIdentifier(entity, 'columnFamily', defaultFamily);

  const keyFields = override?.rowKey?.fields ?? [DEFAULT_KEY_FIELD];
  if (keyFields.length === 0) {
    throw new UnsupportedQueryFeatureError(
      'mapping',
      ADAPTER,
      `Bigtable entity '${entity}' declares an empty 'rowKey.fields'. A Bigtable row key is a ` +
        `single string composed from at least one field.`,
    );
  }
  for (const field of keyFields) requireIdentifier(entity, 'rowKey.fields entry', field);

  const separator = override?.rowKey?.separator ?? DEFAULT_ROW_KEY_SEPARATOR;
  if (keyFields.length > 1 && separator === '') {
    throw new UnsupportedQueryFeatureError(
      'mapping',
      ADAPTER,
      `Bigtable entity '${entity}' composes a row key from ${keyFields.length} fields with an ` +
        `empty separator, which makes two different keys indistinguishable. Name a separator.`,
    );
  }

  const columns: Record<string, BigtableColumnAddress> = {};
  const qualifierOwner = new Map<string, string>();
  const declared = Object.entries(override?.columns ?? {});
  for (const [field, spec] of declared) {
    requireIdentifier(entity, `columns.${field}`, spec);
    columns[field] = parseColumnSpec(entity, field, spec);
  }
  // Two fields on ONE qualifier would make the qualifier-name projection
  // filter ambiguous: selecting the qualifier selects both fields' cells, and
  // the decoder would then read one field's value into the other. Refused by
  // name rather than left to produce a silently wrong row.
  for (const [field, address] of Object.entries(columns)) {
    const owner = qualifierOwner.get(address.qualifier);
    if (owner !== undefined) {
      throw new UnsupportedQueryFeatureError(
        'mapping',
        ADAPTER,
        `Bigtable entity '${entity}' maps both '${owner}' and '${field}' to qualifier ` +
          `'${address.qualifier}'. The projection filter selects columns by qualifier name, so ` +
          `two fields sharing one qualifier cannot be told apart.`,
      );
    }
    qualifierOwner.set(address.qualifier, field);
  }
  return {
    entity,
    table: override?.table ?? entity,
    keyFields,
    separator,
    prefix: override?.rowKey?.prefix ?? '',
    defaultFamily,
    columns,
    valueEncoding: override?.valueEncoding ?? 'tagged',
  };
}

/**
 * Resolves one field's cell address, applying the entity's default family to a
 * field the mapping does not name.
 *
 * @param target - The resolved entity target
 * @param field - The logical field
 * @returns The cell address
 * @throws {UnsupportedQueryFeatureError} When an unmapped field's own name is
 *   not a usable qualifier
 * @since 0.2.0
 */
export function columnAddress(target: BigtableTarget, field: string): BigtableColumnAddress {
  const declared = target.columns[field];
  if (declared !== undefined) return declared;
  requireColumnIdentifier(target.entity, `field '${field}'`, field);
  return { family: target.defaultFamily, qualifier: field };
}
