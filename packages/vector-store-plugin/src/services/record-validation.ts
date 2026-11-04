/**
 * Validates scopes, ids, vectors and records before any adapter sees them, and
 * returns fresh copies (plan §3.6, §3.10). Metadata is read by OWN keys only,
 * so a key such as `constructor` is never read through a prototype.
 *
 * @module
 */
import { VectorDimensionError, VectorRecordError, VectorScopeInvalidError } from '@setu-ts/common';
import type { VectorFieldType, VectorMetadataValue, VectorRecord } from '@setu-ts/common';
import {
  MAX_CONTENT_BYTES,
  MAX_ID_BYTES,
  MAX_IDS_PER_CALL,
  MAX_RECORDS_PER_CALL,
  MAX_SCOPE_BYTES,
  MAX_STRING_VALUE_BYTES,
  isBoundedString,
  utf8Bytes,
} from './limits.ts';

/**
 * Checks a tenant scope.
 *
 * @param scope - The scope
 * @returns The scope
 * @throws {VectorScopeInvalidError} When empty, ill-formed or over 64 UTF-8 bytes
 */
export function validateScope(scope: unknown): string {
  if (!isBoundedString(scope, MAX_SCOPE_BYTES)) {
    throw new VectorScopeInvalidError(
      `a vector-store scope must be a non-empty, well-formed string of at most ${MAX_SCOPE_BYTES} UTF-8 bytes`,
    );
  }
  return scope;
}

/**
 * Checks a record or source id.
 *
 * @param id - The id
 * @param label - `record id` or `source id`, for the message
 * @returns The id
 * @throws {VectorRecordError} When empty, ill-formed or over 256 UTF-8 bytes
 */
export function validateId(id: unknown, label: string): string {
  if (!isBoundedString(id, MAX_ID_BYTES)) {
    throw new VectorRecordError(
      `a ${label} must be a non-empty, well-formed string of at most ${MAX_ID_BYTES} UTF-8 bytes`,
    );
  }
  return id;
}

/**
 * Checks a vector and copies it.
 *
 * @param vector - The vector
 * @param dimensions - The collection's declared length
 * @returns A plain copy
 * @throws {VectorDimensionError} On the wrong length, a non-finite component or zero norm
 */
export function validateVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new VectorDimensionError(`a vector must have exactly ${dimensions} components`);
  }
  const copy: number[] = [];
  let squares = 0;
  for (const component of vector as unknown[]) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new VectorDimensionError('every vector component must be a finite number');
    }
    copy.push(component);
    squares += component * component;
  }
  // Cosine similarity is undefined for a zero vector.
  if (squares === 0) throw new VectorDimensionError('a vector must not be all zeros');
  return copy;
}

/**
 * Checks a list of ids for `delete`.
 *
 * @param ids - The ids
 * @returns A copy
 * @throws {VectorRecordError} When not an array, too long, or any id is invalid
 */
export function validateIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_IDS_PER_CALL) {
    throw new VectorRecordError(`delete takes an array of at most ${MAX_IDS_PER_CALL} ids`);
  }
  return (ids as unknown[]).map((id) => validateId(id, 'record id'));
}

/**
 * Checks a batch of records and copies each one.
 *
 * @param records - The records
 * @param dimensions - The collection's declared length
 * @param fields - The collection's declared fields
 * @returns Validated copies
 * @throws {VectorRecordError} On a bad batch, id, content or metadata
 * @throws {VectorDimensionError} On a bad vector
 */
export function validateRecords(
  records: unknown,
  dimensions: number,
  fields: ReadonlyMap<string, VectorFieldType>,
): VectorRecord[] {
  if (!Array.isArray(records) || records.length > MAX_RECORDS_PER_CALL) {
    throw new VectorRecordError(
      `a write takes an array of at most ${MAX_RECORDS_PER_CALL} records`,
    );
  }
  return (records as unknown[]).map((record) => validateRecord(record, dimensions, fields));
}

function validateRecord(
  record: unknown,
  dimensions: number,
  fields: ReadonlyMap<string, VectorFieldType>,
): VectorRecord {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new VectorRecordError('each record must be an object');
  }
  const source = record as Record<string, unknown>;
  const id = validateId(own(source, 'id'), 'record id');
  const vector = validateVector(own(source, 'vector'), dimensions);
  const sourceId = own(source, 'sourceId');
  const content = own(source, 'content');
  const metadata = own(source, 'metadata');
  if (
    content !== undefined &&
    (typeof content !== 'string' ||
      !content.isWellFormed() ||
      utf8Bytes(content) > MAX_CONTENT_BYTES)
  ) {
    throw new VectorRecordError(
      `record content must be a well-formed string of at most ${MAX_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  return {
    id,
    vector,
    ...(sourceId === undefined ? {} : { sourceId: validateId(sourceId, 'source id') }),
    ...(content === undefined ? {} : { content: content as string }),
    metadata: validateMetadata(metadata, fields),
  };
}

function validateMetadata(
  metadata: unknown,
  fields: ReadonlyMap<string, VectorFieldType>,
): Record<string, VectorMetadataValue> {
  const copy: Record<string, VectorMetadataValue> = {};
  if (metadata === undefined) return copy;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new VectorRecordError('record metadata must be an object');
  }
  for (const key of Object.keys(metadata)) {
    const type = fields.get(key);
    if (type === undefined) {
      throw new VectorRecordError(`record metadata key '${key}' is not declared filterable`);
    }
    const value = (metadata as Record<string, unknown>)[key];
    const valid =
      type === 'string'
        ? isBoundedString(value, MAX_STRING_VALUE_BYTES)
        : type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean';
    if (!valid) {
      throw new VectorRecordError(
        `record metadata '${key}' must be a ${type === 'string' ? `non-empty string of at most ${MAX_STRING_VALUE_BYTES} UTF-8 bytes` : type === 'number' ? 'finite number' : 'boolean'}`,
      );
    }
    // Declared field names cannot be `__proto__` (the grammar requires a
    // leading letter), so plain assignment is safe.
    copy[key] = value as VectorMetadataValue;
  }
  return copy;
}

/** Reads an own property only, so nothing is taken from a prototype. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
