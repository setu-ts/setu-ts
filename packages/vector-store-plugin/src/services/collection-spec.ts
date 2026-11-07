/**
 * Validates the collections declared in `VectorStorePlugin({ collections })`
 * and freezes a private copy of each, so a later edit to the caller's object
 * cannot change what was validated.
 *
 * @module
 */
import type { VectorCollectionSpec, VectorFieldType } from '@setu-ts/common';
import { MAX_DIMENSIONS, MAX_FILTERABLE_FIELDS } from './limits.ts';

/** Safe as a pgvector table suffix with index suffixes under 63 bytes. */
const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** No `.`, `[`, `"`, `|` or `$`, which Qdrant or Vectorize read as syntax. */
const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Names the adapters use for their own columns or payload keys. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set(['scope', 'id', 'source_id', 'content']);
const FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean']);

/** A validated collection: the frozen spec adapters receive, plus a field lookup. */
export interface ResolvedCollection {
  /** Frozen copy handed to adapters. */
  readonly spec: VectorCollectionSpec;
  /** Declared filterable fields and their types. */
  readonly fields: ReadonlyMap<string, VectorFieldType>;
}

/**
 * Validates and copies every declared collection.
 *
 * @param collections - The plugin option
 * @returns The collections by name
 * @throws {TypeError} When the option, a name, the dimensions or a field is invalid
 */
export function resolveCollections(collections: unknown): ReadonlyMap<string, ResolvedCollection> {
  if (!Array.isArray(collections) || collections.length === 0) {
    throw new TypeError('VectorStorePlugin: collections must be a non-empty array.');
  }
  const resolved = new Map<string, ResolvedCollection>();
  for (const candidate of collections as unknown[]) {
    const collection = resolveCollection(candidate);
    if (resolved.has(collection.spec.name)) {
      throw new TypeError(
        `VectorStorePlugin: collection '${collection.spec.name}' is declared twice.`,
      );
    }
    resolved.set(collection.spec.name, collection);
  }
  return resolved;
}

function resolveCollection(candidate: unknown): ResolvedCollection {
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('VectorStorePlugin: each collection must be an object.');
  }
  const { name, dimensions, filterable } = candidate as Record<string, unknown>;
  if (typeof name !== 'string' || !COLLECTION_NAME.test(name)) {
    throw new TypeError('VectorStorePlugin: a collection name must match ^[a-z][a-z0-9_]{0,39}$.');
  }
  if (
    typeof dimensions !== 'number' ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > MAX_DIMENSIONS
  ) {
    throw new TypeError(
      `VectorStorePlugin: collection '${name}' dimensions must be an integer from 1 to ${MAX_DIMENSIONS}.`,
    );
  }
  const fields = resolveFields(name, filterable);
  const spec: VectorCollectionSpec = Object.freeze({
    name,
    dimensions,
    filterable: Object.freeze(Object.fromEntries(fields)),
  });
  return { spec, fields };
}

function resolveFields(collection: string, filterable: unknown): Map<string, VectorFieldType> {
  const fields = new Map<string, VectorFieldType>();
  if (filterable === undefined) return fields;
  if (filterable === null || typeof filterable !== 'object' || Array.isArray(filterable)) {
    throw new TypeError(
      `VectorStorePlugin: collection '${collection}' filterable must be an object.`,
    );
  }
  for (const [field, type] of Object.entries(filterable)) {
    if (!FIELD_NAME.test(field) || RESERVED_FIELDS.has(field)) {
      throw new TypeError(
        `VectorStorePlugin: collection '${collection}' field '${field}' must match ^[a-z][a-z0-9_]{0,63}$ and not be scope, id, source_id or content.`,
      );
    }
    if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
      throw new TypeError(
        `VectorStorePlugin: collection '${collection}' field '${field}' type must be 'string', 'number' or 'boolean'.`,
      );
    }
    fields.set(field, type as VectorFieldType);
  }
  if (fields.size > MAX_FILTERABLE_FIELDS) {
    throw new TypeError(
      `VectorStorePlugin: collection '${collection}' declares more than ${MAX_FILTERABLE_FIELDS} filterable fields.`,
    );
  }
  return fields;
}
