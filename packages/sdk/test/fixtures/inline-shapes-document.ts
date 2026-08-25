/**
 * A document whose schemas are INLINE at every position that renders a type.
 *
 * The users and params documents both name their schemas through `$ref`, so
 * every rendered type was a single-line component name and the multi-line
 * indentation defect (M70m/X11-9) could not appear in either fixture. This one
 * exists to make it appear: a request body and a 2xx response declared inline.
 *
 * `@setu-ts/openapi-plugin` produces exactly this shape — a schema derived from
 * `validateBody` and used once is NOT hoisted into `components`, so an inline
 * body is the common case for a generated client rather than an exotic one.
 *
 * @module
 */
import type { SdkOpenApiDocument } from '../../src/codegen/openapi-types.ts';

/** Document exercising inline (non-`$ref`) body and response schemas. */
export const inlineShapesDocument: SdkOpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'place-order',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
                required: ['sku', 'qty'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, total: { type: 'number' } },
                  required: ['id'],
                },
              },
            },
          },
        },
      },
    },
  },
};
