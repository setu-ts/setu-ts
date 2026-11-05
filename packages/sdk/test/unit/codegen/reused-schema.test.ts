import { expect, it } from 'vitest';
import { z } from 'zod';
import type { RouteInfo } from '@setu-ts/common';
import { OpenApiGenerator } from '@setu-ts/openapi-plugin';
import { generateOpenApiClient } from '../../../src/codegen/openapi-codegen.ts';
import type { SdkOpenApiDocument } from '../../../src/codegen/openapi-types.ts';
it('M131b 3.15 generates distinct site roots and one named reused model without Body2', () => {
  const line = z.object({ sku: z.string() }).meta({ id: 'SdkOrderLine' });
  const routes: RouteInfo[] = ['/orders', '/returns'].map((path) => ({
    method: 'POST',
    path,
    definition: {
      handler: (ctx) => ctx.response.send(),
      schema: { body: z.object({ lines: z.array(line) }) },
    },
  }));
  const doc = new OpenApiGenerator({}).generate(routes);
  const source = generateOpenApiClient(doc as unknown as SdkOpenApiDocument);
  expect(source).toContain('SdkOrderLine');
  expect(source).not.toContain('Body2');
});
