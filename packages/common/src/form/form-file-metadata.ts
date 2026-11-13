/** Global schema brand shared across copies of common. @since 0.13.0 */
export const FORM_FILE_METADATA: unique symbol = Symbol.for('setu.form-file.metadata');

/** File constraints recorded by a form-file schema. @since 0.13.0 */
export interface FormFileMetadata {
  /** Accepted MIME essences, including type wildcards. */
  readonly mimeTypes?: readonly string[];
  /** Maximum parsed file size in bytes; not a request-size bound. */
  readonly maxBytes?: number;
}

/**
 * Brands a schema in place without changing its identity or enumerable keys.
 * @param schema - Schema to brand
 * @param metadata - File constraints
 * @returns The same schema reference
 * @example withFormFileMetadata(schema, { mimeTypes: ['image/*'] });
 * @since 0.13.0
 */
export function withFormFileMetadata<T extends object>(schema: T, metadata: FormFileMetadata): T {
  Object.defineProperty(schema, FORM_FILE_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return schema;
}

/**
 * Reads a conforming file-schema brand, treating foreign values as absent.
 * @param value - Schema or foreign value to inspect
 * @returns The file constraints, or undefined
 * @since 0.13.0
 */
export function formFileMetadataOf(value: unknown): FormFileMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const metadata: unknown = (value as { readonly [FORM_FILE_METADATA]?: unknown })[
    FORM_FILE_METADATA
  ];
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  if (
    'mimeTypes' in metadata &&
    (!Array.isArray(metadata.mimeTypes) ||
      !metadata.mimeTypes.every((entry: unknown) => typeof entry === 'string'))
  )
    return undefined;
  if (
    'maxBytes' in metadata &&
    (typeof metadata.maxBytes !== 'number' ||
      !Number.isSafeInteger(metadata.maxBytes) ||
      metadata.maxBytes <= 0)
  )
    return undefined;
  return metadata;
}
