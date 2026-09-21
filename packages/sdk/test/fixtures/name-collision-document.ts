/**
 * The M99c V7-6 collision, as a document: a component the generator would
 * name a hoisted alias identically, beside the inline multi-line body that
 * gets hoisted.
 *
 * `@setu-ts/openapi-plugin` names a reused response schema after its first
 * use — `${operationId}Response${status}` — and the generator derives the
 * SAME name for an inline multi-line 200 body. Before the alias learned to
 * yield (M99c §3.1) this document aborted generation with
 * `Duplicate generated name 'GetItemsResponse200'`. It is committed as the
 * third generated-output fixture (the M70m X11-9 precedent): the emitted
 * client is type-checked by `deno task check`, format-checked by
 * `deno task fmt:check`, and compared byte-for-byte by
 * `codegen-name-collision.test.ts`, so the fallback's emitted shape stays
 * under the repo's own gates.
 *
 * @module
 */
import type { SdkOpenApiDocument } from '../../src/codegen/openapi-types.ts';

/** Document exercising the component/alias name collision and its fallback. */
export const nameCollisionDocument: SdkOpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    '/items': {
      get: {
        operationId: 'get-items',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      GetItemsResponse200: {
        type: 'object',
        properties: { total: { type: 'integer' } },
      },
    },
  },
};
