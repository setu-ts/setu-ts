/**
 * Validates a filter against a collection's declared fields and returns a
 * fresh frozen copy, so adapters translate only what was checked (a getter or
 * a later mutation of the caller's object cannot change it). Anything outside
 * the narrow filter type is refused with a {@linkcode VectorFilterError} that
 * names the clause — never dropped, which is how filters fail open.
 *
 * @module
 */
import { VectorFilterError } from '@setu-ts/common';
import type { VectorFieldType, VectorFilter } from '@setu-ts/common';
import {
  MAX_FILTER_CLAUSES,
  MAX_FILTER_DEPTH,
  MAX_IN_VALUES,
  MAX_STRING_VALUE_BYTES,
  isBoundedString,
  shownName,
} from './limits.ts';

const RANGE_OPS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);

/**
 * Validates and copies a filter.
 *
 * @param filter - The caller's filter (treated as untrusted)
 * @param fields - The collection's declared fields
 * @returns A frozen, validated copy
 * @throws {VectorFilterError} On any clause outside the filter type
 */
export function validateFilter(
  filter: unknown,
  fields: ReadonlyMap<string, VectorFieldType>,
): VectorFilter {
  const counter = { clauses: 0 };
  return validateNode(filter, fields, 1, counter);
}

function validateNode(
  node: unknown,
  fields: ReadonlyMap<string, VectorFieldType>,
  depth: number,
  counter: { clauses: number },
): VectorFilter {
  counter.clauses += 1;
  if (counter.clauses > MAX_FILTER_CLAUSES) {
    throw new VectorFilterError(`filter has more than ${MAX_FILTER_CLAUSES} clauses`);
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new VectorFilterError('a filter clause must be an object');
  }
  const record = node as Record<string, unknown>;
  if (Object.hasOwn(record, 'and')) {
    if (Object.keys(record).length !== 1) {
      throw new VectorFilterError("an 'and' clause must have no other keys");
    }
    if (depth > MAX_FILTER_DEPTH) {
      throw new VectorFilterError(`filter nests deeper than ${MAX_FILTER_DEPTH}`);
    }
    const children = record['and'];
    if (!Array.isArray(children) || children.length === 0) {
      throw new VectorFilterError("an 'and' clause must hold at least one clause");
    }
    return Object.freeze({
      and: Object.freeze(
        (children as unknown[]).map((child) => validateNode(child, fields, depth + 1, counter)),
      ),
    });
  }
  return validateComparison(record, fields);
}

function validateComparison(
  record: Record<string, unknown>,
  fields: ReadonlyMap<string, VectorFieldType>,
): VectorFilter {
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(record, 'field') ||
    !Object.hasOwn(record, 'op') ||
    !Object.hasOwn(record, 'value')
  ) {
    throw new VectorFilterError("a comparison must have exactly 'field', 'op' and 'value'");
  }
  const { field, op, value } = record;
  if (typeof field !== 'string' || !fields.has(field)) {
    throw new VectorFilterError(
      `filter field '${shownName(field)}' is not declared filterable for this collection`,
    );
  }
  const type = fields.get(field)!;
  if (op === 'eq') {
    assertValue(field, op, value, type);
    return Object.freeze({ field, op, value: value as string | number | boolean });
  }
  if (op === 'in') {
    if (type === 'boolean') {
      throw new VectorFilterError(`filter field '${field}' is boolean; use 'eq', not 'in'`);
    }
    // Copied once and the copy validated, so what is checked is what is returned.
    const values: unknown[] | undefined =
      Array.isArray(value) && value.length <= MAX_IN_VALUES ? [...(value as unknown[])] : undefined;
    if (values === undefined || values.length === 0 || values.length > MAX_IN_VALUES) {
      throw new VectorFilterError(
        `filter field '${field}' 'in' takes 1 to ${MAX_IN_VALUES} values`,
      );
    }
    for (const entry of values) assertValue(field, op, entry, type);
    return Object.freeze({
      field,
      op,
      value: Object.freeze(values as (string | number)[]),
    });
  }
  if (typeof op === 'string' && RANGE_OPS.has(op)) {
    if (type !== 'number') {
      throw new VectorFilterError(
        `filter field '${field}' is ${type}; '${op}' needs a number field`,
      );
    }
    assertValue(field, op, value, type);
    return Object.freeze({ field, op: op as 'gt' | 'gte' | 'lt' | 'lte', value: value as number });
  }
  throw new VectorFilterError(
    `filter field '${field}' uses unsupported operator '${shownName(op)}'`,
  );
}

function assertValue(field: string, op: string, value: unknown, type: VectorFieldType): void {
  const valid =
    type === 'string'
      ? isBoundedString(value, MAX_STRING_VALUE_BYTES)
      : type === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === 'boolean';
  if (!valid) {
    throw new VectorFilterError(
      type === 'string'
        ? `filter field '${field}' '${op}' needs a non-empty string of at most ${MAX_STRING_VALUE_BYTES} UTF-8 bytes`
        : `filter field '${field}' '${op}' needs a ${type === 'number' ? 'finite number' : 'boolean'}`,
    );
  }
}
