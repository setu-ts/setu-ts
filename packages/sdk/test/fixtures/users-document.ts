/**
 * The OpenAPI document behind `generated-client.ts`, the fixture the codegen
 * drift test compares against and the e2e drives through the real
 * `HttpClient`.
 *
 * Extracted from the test body so ONE definition feeds the drift assertion and
 * the fixture regeneration; an inline copy would let the two disagree.
 *
 * It declares `404` and `409` on `getUserById` deliberately: the per-operation
 * error union and its narrowing guard (M70m/X11-7) are emitted only for an
 * operation with a declared non-2xx response, so without them the whole
 * surface would be committed to no fixture and compiled by nothing.
 *
 * @module
 */
import type { SdkOpenApiDocument } from '../../src/codegen/openapi-types.ts';

/** The users API document. */
export const usersDocument: SdkOpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        parameters: [
          { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'X-API-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/User' } },
              },
            },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUserById',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/User' } },
            },
          },
          '404': {
            description: 'Not found',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/NotFound' } },
            },
          },
          '409': {
            description: 'Conflict',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { conflictingId: { type: 'string' } },
                  required: ['conflictingId'],
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
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['id', 'name'],
      },
      NotFound: {
        type: 'object',
        properties: { code: { type: 'string' }, detail: { type: 'string' } },
        required: ['code'],
      },
    },
  },
};
