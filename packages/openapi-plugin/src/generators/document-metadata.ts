import { OpenApiDocumentOptionsError } from '../errors.ts';
import type {
  OpenApiDocument,
  OpenApiExternalDocs,
  OpenApiGeneratorOptions,
} from './openapi-generator.ts';

/**
 * Refuses conflicting license keys, repeated document tag names and an
 * unknown `errorSchema`.
 * @param options - Document generator options
 * @throws {OpenApiDocumentOptionsError} If a metadata constraint is violated
 * @since 0.13.0
 */
export function validateDocumentMetadata(options: OpenApiGeneratorOptions): void {
  if (options.license?.identifier !== undefined && options.license.url !== undefined) {
    throw new OpenApiDocumentOptionsError(
      'license-identifier-and-url',
      'license.identifier and license.url are mutually exclusive (OpenAPI 3.1 §4.8.4).',
    );
  }
  const names = new Set<string>();
  for (const tag of options.tags ?? []) {
    if (names.has(tag.name)) {
      throw new OpenApiDocumentOptionsError(
        'duplicate-tag',
        `OpenAPI document tag ${JSON.stringify(tag.name)} is duplicated.`,
      );
    }
    names.add(tag.name);
  }
  // Typed as `'rfc9457'`, but an untyped caller can pass anything.
  const errorSchema: unknown = options.errorSchema;
  if (errorSchema !== undefined && errorSchema !== 'rfc9457') {
    throw new OpenApiDocumentOptionsError(
      'error-schema',
      `errorSchema must be 'rfc9457', got ${JSON.stringify(errorSchema)}.`,
    );
  }
}

/** Copies only the defined external-documentation fields. */
function copyExternalDocs(docs: OpenApiExternalDocs): OpenApiExternalDocs {
  return {
    url: docs.url,
    ...(docs.description !== undefined ? { description: docs.description } : {}),
  };
}

/**
 * Builds metadata with defined keys only, preserving document emission order.
 * @param options - Document generator options
 * @returns Additional info fields and the trailing top-level metadata
 * @since 0.13.0
 */
export function buildDocumentMetadata(options: OpenApiGeneratorOptions): {
  info: Pick<OpenApiDocument['info'], 'termsOfService' | 'contact' | 'license'>;
  top: Pick<OpenApiDocument, 'tags' | 'externalDocs'>;
} {
  const { termsOfService, contact, license, tags, externalDocs } = options;
  return {
    info: {
      ...(termsOfService !== undefined ? { termsOfService } : {}),
      ...(contact !== undefined
        ? {
            contact: {
              ...(contact.name !== undefined ? { name: contact.name } : {}),
              ...(contact.url !== undefined ? { url: contact.url } : {}),
              ...(contact.email !== undefined ? { email: contact.email } : {}),
            },
          }
        : {}),
      ...(license !== undefined
        ? {
            license: {
              name: license.name,
              ...(license.identifier !== undefined ? { identifier: license.identifier } : {}),
              ...(license.url !== undefined ? { url: license.url } : {}),
            },
          }
        : {}),
    },
    top: {
      ...(tags !== undefined && tags.length > 0
        ? {
            tags: tags.map((tag) => ({
              name: tag.name,
              ...(tag.description !== undefined ? { description: tag.description } : {}),
              ...(tag.externalDocs !== undefined
                ? { externalDocs: copyExternalDocs(tag.externalDocs) }
                : {}),
            })),
          }
        : {}),
      ...(externalDocs !== undefined ? { externalDocs: copyExternalDocs(externalDocs) } : {}),
    },
  };
}
