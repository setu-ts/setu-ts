/**
 * The OpenAPI document behind `params-client.ts`, the compile-regression fixture.
 *
 * It lives in its own module because BOTH the unit test (which asserts the
 * generator still emits `params-client.ts` byte-for-byte) and the checked-in
 * fixture itself derive from it. Inlining the document in the test would let the
 * two drift apart silently.
 *
 * Every operation here exists to pin a parameter shape that previously emitted
 * source which did not COMPILE, or which compiled but was wrong:
 *
 * - a non-string (`integer`) header, which must be stringified;
 * - a schemaless path / query / header parameter, which must default to `string`;
 * - a placeholder sharing a segment with literal text (`{fileId}.json`), which an
 *   anchored whole-segment match silently emitted as a literal;
 * - a required query parameter and a required request body, which must make the
 *   `opts` parameter itself required;
 * - a camelCase `operationId`, whose interior casing must survive derivation;
 * - a `$ref` to a component, whose type name must be PascalCase.
 *
 * The generated file is type-checked by `deno task check` (which covers `test/`),
 * so a shape that does not compile fails a real gate.
 */

import type { SdkOpenApiDocument } from '../../src/codegen/openapi-types.ts';

export const paramsDocument: SdkOpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    // Non-string header + string header on one operation.
    '/ping': {
      get: {
        operationId: 'pingService',
        parameters: [
          { name: 'X-Retry-Count', in: 'header', required: false, schema: { type: 'integer' } },
          { name: 'X-API-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'No Content' } },
      },
    },
    // Schemaless path parameter → defaults to `string`.
    '/users/{id}': {
      get: {
        operationId: 'getUserById',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
    },
    // Schemaless query and header parameters on one operation.
    '/search': {
      get: {
        operationId: 'searchEverything',
        parameters: [
          { name: 'q', in: 'query', required: false },
          { name: 'X-Custom', in: 'header', required: false },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
    // Placeholder sharing a segment with literal text, plus a second path param.
    '/tenants/{tenantId}/files/{fileId}.json': {
      get: {
        operationId: 'downloadFileMetadata',
        parameters: [
          { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'fileId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    // Required query parameter AND required body → `opts` becomes required.
    '/reports': {
      post: {
        operationId: 'createReport',
        parameters: [
          { name: 'format', in: 'query', required: true, schema: { enum: ['pdf', 'csv'] } },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
    },
    // Optional body only → `opts` stays optional.
    '/notes': {
      patch: {
        operationId: 'updateNote',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          age: { type: 'integer' },
          nickname: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['id'],
      },
    },
  },
};
