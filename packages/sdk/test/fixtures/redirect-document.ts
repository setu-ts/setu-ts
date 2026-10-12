/** OpenAPI input for the committed redirect-only client fixture. */
import type { SdkOpenApiDocument } from '../../src/codegen/openapi-types.ts';

export const redirectDocument: SdkOpenApiDocument = {
  openapi: '3.1.0',
  paths: {
    '/redirect': {
      get: {
        operationId: 'followRedirect',
        responses: { '303': { description: 'See Other' } },
      },
    },
  },
};
