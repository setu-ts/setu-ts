import type { FormFileMetadata } from '@setu-ts/common';
import { formFileMetadataOf } from '@setu-ts/common';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function internals(value: unknown): Record<string, unknown> | undefined {
  return record(record(value)?.['_zod']);
}

/**
 * Reads a file brand through Zod metadata clones.
 * @param schema - Schema node to inspect
 * @returns File constraints when branded
 * @since 0.13.0
 */
export function fileMetadataOf(schema: unknown): FormFileMetadata | undefined {
  const seen = new Set<unknown>();
  let current = schema;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const metadata = formFileMetadataOf(current);
    if (metadata !== undefined) return metadata;
    current = internals(current)?.['parent'];
  }
  return undefined;
}

function unwrap(schema: unknown): unknown {
  const seen = new Set<unknown>();
  let current = schema;
  while (!seen.has(current)) {
    seen.add(current);
    if (fileMetadataOf(current) !== undefined) return current;
    const zod = internals(current);
    if (zod?.['parent'] !== undefined) {
      current = zod['parent'];
      continue;
    }
    const def = record(zod?.['def']);
    switch (def?.['type']) {
      // `nonoptional`: `.required()` wraps every field, even a required one.
      case 'optional':
      case 'nonoptional':
      case 'nullable':
      case 'default':
      case 'readonly':
      case 'catch':
        current = def['innerType'];
        break;
      case 'pipe':
        current = def['in'];
        break;
      default:
        return current;
    }
  }
  return current;
}

/**
 * Finds top-level file fields (including arrays) in a Zod object request body.
 * @param bodySchema - Effective body schema
 * @returns Field names and their file constraints; empty for other bodies
 * @since 0.13.0
 */
export function formFileFieldsOf(bodySchema: unknown): ReadonlyMap<string, FormFileMetadata> {
  const fields = new Map<string, FormFileMetadata>();
  const def = record(internals(unwrap(bodySchema))?.['def']);
  if (def?.['type'] !== 'object') return fields;
  const shape = record(def['shape']);
  if (shape === undefined) return fields;
  for (const [key, field] of Object.entries(shape)) {
    const value = unwrap(field);
    const fieldDef = record(internals(value)?.['def']);
    const metadata = fileMetadataOf(
      fieldDef?.['type'] === 'array' ? unwrap(fieldDef['element']) : value,
    );
    if (metadata !== undefined) fields.set(key, metadata);
  }
  return fields;
}
