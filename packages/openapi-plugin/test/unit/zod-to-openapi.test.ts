/** Public transformer entry points with the supported Zod 4 range. @module */
import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import { ZodToOpenApi, zodToOpenApi } from '../../src/transformers/zod-to-openapi.ts';

describe('Zod to OpenAPI public entry points', () => {
  it('converts supported schemas through the convenience function', () => {
    expect(zodToOpenApi(z.string())).toEqual({ type: 'string' });
    expect(zodToOpenApi(z.object({ id: z.string() }))).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it.each([undefined, null, 'not a schema', {}, { toJSONSchema: true }])(
    'degrades unrecognized input %j through both entry points',
    (schema) => {
      const reasons: string[] = [];
      const transformer = new ZodToOpenApi(undefined, {
        onUnrepresentable: ({ reason }) => reasons.push(reason),
      });
      expect(zodToOpenApi(schema)).toEqual({});
      expect(transformer.transform(schema)).toEqual({});
      expect(reasons).toEqual(['not a recognized zod schema']);
    },
  );

  it('lets a hook replace the root before conversion', () => {
    const schema = z.string();
    const transformer = new ZodToOpenApi((node) =>
      node === schema ? { $ref: '#/components/schemas/Named' } : undefined,
    );
    expect(transformer.transform(schema)).toEqual({ $ref: '#/components/schemas/Named' });
  });
});
