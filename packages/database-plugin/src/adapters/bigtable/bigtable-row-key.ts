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
 * **A key field's TYPE is not part of the row key.** A Bigtable row key is
 * bytes, and a numeric field renders as its decimal text, so `1` and `'1'`
 * compose the same physical row: creating one then refuses the other as
 * existing, and `findById('1')` answers the row stored under `1` — whose `id`
 * cell still decodes as the NUMBER, so the caller sees the stored type rather
 * than the one it asked with. That is a property of mapping two JavaScript
 * types onto one byte string, not a defect: tagging the key would make it
 * unreadable in `cbt` and break every table this adapter did not write, and
 * refusing numeric key fields outright (the Cosmos precedent, where the
 * SERVICE refuses them) would remove a shape Bigtable users rely on — they
 * routinely zero-pad numbers precisely because the key is text. Choose one
 * type per key field.
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
 * Order two row keys the way **Bigtable** orders them, which is not the way
 * JavaScript's `<` does.
 *
 * A Bigtable row key is bytes, sorted lexicographically as UTF-8. JavaScript's
 * relational operators compare UTF-16 **code units**, and the two disagree for
 * every non-BMP character: `'\u{1F600}' < '\uFF21'` is `true` in JavaScript
 * (its leading surrogate `\uD83D` sorts below `\uFF21`) and `false` as UTF-8
 * (`F0 9F 98 80` sorts above `EF BC A1`). Comparing **code points** reproduces
 * UTF-8 byte order exactly, because UTF-8 is order-preserving over code points.
 *
 * The divergence is not cosmetic: a cursor walk over an explicit key set
 * filtered with `>` DROPPED a row whose key carried an emoji, because the
 * comparison placed it before the cursor the server had placed it after.
 *
 * @param left - The first row key
 * @param right - The second row key
 * @returns Negative when `left` sorts first, positive when `right` does, `0`
 *   when they are equal
 * @since 0.2.0
 */
export function compareRowKeys(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const codeA = a[index].codePointAt(0) as number;
    const codeB = b[index].codePointAt(0) as number;
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * The exclusive upper bound of the row-key range whose members all start with
 * `prefix`.
 *
 * Incrementing the final **code point** is the prefix-scan successor, and code
 * points are the right unit for the same reason {@linkcode compareRowKeys}
 * gives: UTF-8 preserves code-point order, so the next code point is the next
 * key. Incrementing the final code UNIT would step from `\uFFFF` to a
 * carry — skipping every non-BMP key that genuinely sorts after it.
 *
 * A position that cannot be incremented carries to the one before it. A prefix
 * that is empty, or entirely made of the maximum code point, has no finite
 * successor, so the range is left open at the top — which is correct, because
 * every remaining row does start with it.
 *
 * @param prefix - The row-key prefix
 * @returns The exclusive end key, or `undefined` for an unbounded top
 * @since 0.2.0
 */
export function prefixSuccessor(prefix: string): string | undefined {
  const points = [...prefix];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const code = points[index].codePointAt(0) as number;
    // A LONE surrogate is not a code point UTF-8 can carry, so incrementing it
    // would produce a key the wire cannot express; carry past it instead.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const next = code + 1 === 0xd800 ? 0xe000 : code + 1;
    if (next > 0x10ffff) continue;
    return points.slice(0, index).join('') + String.fromCodePoint(next);
  }
  return undefined;
}
