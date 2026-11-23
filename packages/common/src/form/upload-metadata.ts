/**
 * The upload brand: what an upload-taking middleware accepts, recorded on the
 * middleware function so a documentation generator can describe the route's
 * `multipart/form-data` body without importing the plugin that produced it.
 * `@setu-ts/openapi-plugin` does not read it yet.
 *
 * Like the validation brand it is a description, not a mechanism: removing it
 * changes no runtime behaviour.
 *
 * @module
 */

/**
 * Global key of the upload brand, shared across copies of this package.
 *
 * @since 0.14.0
 */
export const UPLOAD_METADATA: unique symbol = Symbol.for('setu.upload.metadata');

/**
 * What an upload middleware accepts.
 *
 * @since 0.14.0
 */
export interface UploadMetadata {
  /** The multipart field name the files arrive under. */
  readonly fieldname: string;
  /** The largest accepted file, in bytes. */
  readonly maxBytes: number;
  /** The most files accepted under the field; absent means no count limit. */
  readonly maxFiles?: number;
  /** The accepted MIME types; absent means any type. */
  readonly mimeTypes?: readonly string[];
}

/**
 * Brands a middleware with the uploads it accepts, in place, without changing
 * its identity or its enumerable keys.
 *
 * @param middleware - The upload middleware
 * @param metadata - What it accepts
 * @returns The same middleware reference
 * @example withUploadMetadata(middleware, { fieldname: 'file', maxBytes: 10_485_760 });
 * @since 0.14.0
 */
export function withUploadMetadata<T extends object>(middleware: T, metadata: UploadMetadata): T {
  Object.defineProperty(middleware, UPLOAD_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return middleware;
}

/**
 * Reads a conforming upload brand, treating foreign or malformed values as
 * absent.
 *
 * @param value - A middleware or any other value
 * @returns The upload metadata, or `undefined`
 * @since 0.14.0
 */
export function uploadMetadataOf(value: unknown): UploadMetadata | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  const metadata: unknown = (value as { readonly [UPLOAD_METADATA]?: unknown })[UPLOAD_METADATA];
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const record = metadata as Record<string, unknown>;
  if (typeof record.fieldname !== 'string' || record.fieldname === '') return undefined;
  if (!isPositiveInteger(record.maxBytes)) return undefined;
  if ('maxFiles' in record && !isPositiveInteger(record.maxFiles)) return undefined;
  if (
    'mimeTypes' in record &&
    (!Array.isArray(record.mimeTypes) ||
      !record.mimeTypes.every((entry: unknown) => typeof entry === 'string'))
  ) {
    return undefined;
  }
  return metadata as UploadMetadata;
}

/** Reports whether a value is a positive safe integer. */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
