/**
 * Row-key composition and parse-back.
 *
 * Bigtable addresses a row by ONE lexicographically-sorted string, so the
 * repository's {@linkcode EntityKey} — a scalar or a named record — has to
 * collapse onto it. The composition is `prefix + fields.map(String).join(sep)`,
 * and it is the only place that mapping happens.
 *
 * @module
 */
import type { EntityKey } from '@setu-ts/common';
import { UnsupportedQueryFeatureError } from '../../errors.ts';
import type { BigtableTarget } from './bigtable-mapping.ts';

/** The adapter name every refusal carries. */
const ADAPTER = 'bigtable';

/**
 * Renders one key field value as the bytes it contributes to the row key.
 *
 * @param target - The resolved entity target
 * @param field - The key field being rendered
 * @param value - The field's value
 * @param operation - The calling operation, quoted in a refusal
 * @returns The rendered segment
 * @throws {UnsupportedQueryFeatureError} When the value is absent, is not a
 *   string or finite number, or contains the separator
 */
function renderKeySegment(
  target: BigtableTarget,
  field: string,
  value: unknown,
  operation: string,
): string {
  if (value === undefined || value === null) {
    throw new UnsupportedQueryFeatureError(
      'row-key',
      ADAPTER,
      `Bigtable entity '${target.entity}' composes its row key from ` +
        `[${target.keyFields.join(', ')}], and '${field}' is missing from the key supplied to ` +
        `${operation}.`,
    );
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new UnsupportedQueryFeatureError(
      'row-key',
      ADAPTER,
      `Bigtable entity '${target.entity}' received a ${typeof value} for row-key field ` +
        `'${field}' in ${operation}. A row key is composed from string or number fields only.`,
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new UnsupportedQueryFeatureError(
      'row-key',
      ADAPTER,
      `Bigtable entity '${target.entity}' received ${String(value)} for row-key field '${field}' ` +
        `in ${operation}. A row key cannot carry NaN or Infinity.`,
    );
  }
  const rendered = String(value);
  // A value containing the separator would make two DIFFERENT logical keys
  // compose to one row key, so a write would silently overwrite an unrelated
  // row and a read would return it. Escaping instead would break the byte
  // ordering the row key exists for, so this is refused rather than encoded.
  if (target.keyFields.length > 1 && rendered.includes(target.separator)) {
    throw new UnsupportedQueryFeatureError(
      'row-key',
      ADAPTER,
      `Bigtable entity '${target.entity}' cannot compose a row key: field '${field}' holds ` +
        `'${rendered}', which contains the '${target.separator}' separator. Two different keys ` +
        `would compose to one row key. Choose a separator the data cannot contain.`,
    );
  }
  return rendered;
}

/**
 * Composes the row key for an entity key.
 *
 * A single-field key accepts a scalar; a multi-field key requires a record
 * carrying every field, and refuses a scalar by name — a scalar cannot say
 * which of several fields it is.
 *
 * @param target - The resolved entity target
 * @param id - The primary key, scalar or composite
 * @param operation - The calling operation, quoted in a refusal
 * @returns The row key
 * @throws {UnsupportedQueryFeatureError} When the key cannot compose one
 * @since 0.2.0
 */
export function composeRowKey(
  target: BigtableTarget,
  id: EntityKey,
  operation: string,
): string {
  if (typeof id === 'string' || typeof id === 'number') {
    if (target.keyFields.length !== 1) {
      throw new UnsupportedQueryFeatureError(
        'composite-key',
        ADAPTER,
        `Bigtable entity '${target.entity}' composes its row key from ` +
          `[${target.keyFields.join(', ')}], so ${operation} needs a record naming every field, ` +
          `not the scalar '${String(id)}'.`,
      );
    }
    return target.prefix + renderKeySegment(target, target.keyFields[0], id, operation);
  }
  return composeRowKeyFromFields(target, id as Record<string, unknown>, operation);
}

/**
 * Composes the row key from a field bag — a data payload on the write path, or
 * a composite key record.
 *
 * @param target - The resolved entity target
 * @param fields - The bag to read key fields from
 * @param operation - The calling operation, quoted in a refusal
 * @returns The row key
 * @throws {UnsupportedQueryFeatureError} When a key field is missing or unusable
 * @since 0.2.0
 */
export function composeRowKeyFromFields(
  target: BigtableTarget,
  fields: Readonly<Record<string, unknown>>,
  operation: string,
): string {
  const segments = target.keyFields.map((field) =>
    renderKeySegment(target, field, fields[field], operation)
  );
  return target.prefix + segments.join(target.separator);
}

/**
 * Parses a row key back into its key-field values.
 *
 * This is the **fallback** read path, not the primary one: a row this adapter
 * wrote carries its key fields as cells, which preserve their types, and the
 * parse-back only fills fields the cells did not carry. That is what lets a
 * table written outside this framework — which has no key cells at all — still
 * yield a complete row.
 *
 * Every parsed value is a string, necessarily: the row key is bytes and it
 * records no type. A key whose segment count disagrees with the mapping yields
 * nothing rather than a mis-split row.
 *
 * @param target - The resolved entity target
 * @param rowKey - The physical row key
 * @returns The recovered key fields, or `{}` when the key does not fit
 * @since 0.2.0
 */
export function parseRowKey(
  target: BigtableTarget,
  rowKey: string,
): Record<string, string> {
  if (!rowKey.startsWith(target.prefix)) return {};
  const body = rowKey.slice(target.prefix.length);
  if (target.keyFields.length === 1) return { [target.keyFields[0]]: body };
  const segments = body.split(target.separator);
  if (segments.length !== target.keyFields.length) return {};
  const parsed: Record<string, string> = {};
  target.keyFields.forEach((field, index) => {
    parsed[field] = segments[index];
  });
  return parsed;
}

/**
 * The exclusive upper bound of the row-key range whose members all start with
 * `prefix`.
 *
 * Incrementing the final byte is the standard prefix-scan successor. A prefix
 * whose final code unit is already the maximum (or an empty prefix) has no
 * finite successor, so the range is left open at the top — which is correct,
 * because every remaining row does start with it.
 *
 * @param prefix - The row-key prefix
 * @returns The exclusive end key, or `undefined` for an unbounded top
 * @since 0.2.0
 */
export function prefixSuccessor(prefix: string): string | undefined {
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const code = prefix.charCodeAt(index);
    if (code < 0xffff) {
      return prefix.slice(0, index) + String.fromCharCode(code + 1);
    }
  }
  return undefined;
}
