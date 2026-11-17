/**
 * `errorSchema: 'rfc9457'` (M137b §3.7): one shared RFC 9457 `ProblemDetails`
 * component on every GENERATED error response, asserted field by field.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { MiddlewareFunction, RouteInfo } from '@setu-ts/common';
import { withValidationMetadata } from '@setu-ts/common';
import { requireAuth } from '@setu-ts/auth-plugin';

import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';
import type {
  OpenApiDocument,
  OpenApiGeneratorOptions,
  OpenApiOperation,
} from '../../src/generators/openapi-generator.ts';
import { OpenApiService } from '../../src/services/openapi-service.ts';
import { OpenApiDocumentOptionsError } from '../../src/errors.ts';

const bodyBrand = (): MiddlewareFunction =>
  withValidationMetadata(() => Promise.resolve(), {
    target: 'body',
    schema: z.object({ a: z.string() }),
  });

function route(
  path: string,
  middleware: MiddlewareFunction[],
  response?: Record<number, unknown>,
): RouteInfo {
  return {
    method: 'POST',
    path,
    definition: {
      handler: () => undefined as never,
      middleware,
      ...(response !== undefined ? { schema: { response } } : {}),
    },
  };
}

function generate(
  routes: RouteInfo[],
  options: Partial<OpenApiGeneratorOptions> = {},
): OpenApiDocument {
  return new OpenApiGenerator({
    title: 'T',
    version: '1',
    errorSchema: 'rfc9457',
    ...options,
  }).generate(routes);
}

const post = (doc: OpenApiDocument, path: string): OpenApiOperation =>
  (doc.paths[path] as Record<string, OpenApiOperation>)['post'] as OpenApiOperation;

describe("errorSchema: 'rfc9457'", () => {
  it('declares a ProblemDetails component matching RFC 9457, field by field', () => {
    const doc = generate([route('/a', [requireAuth()])]);
    const component = (doc.components?.schemas as Record<string, unknown>)['ProblemDetails'];
    expect(component).toEqual({
      type: 'object',
      properties: {
        type: { type: 'string', format: 'uri-reference', default: 'about:blank' },
        title: { type: 'string' },
        status: { type: 'integer', minimum: 100, maximum: 599 },
        detail: { type: 'string' },
        instance: { type: 'string', format: 'uri-reference' },
      },
    });
    const shape = component as { properties: Record<string, unknown>; required?: unknown };
    // RFC 9457 §3: every member optional, extension members allowed; and the
    // framework-default `message` member is not part of Problem Details.
    expect(shape.required).toBeUndefined();
    expect('additionalProperties' in shape).toBe(false);
    expect('message' in shape.properties).toBe(false);
  });

  it('attaches it to every generated error response, including the validation 400', () => {
    const op = post(generate([route('/a', [requireAuth(), bodyBrand()])]), '/a');
    for (const status of ['400', '401', '415']) {
      expect(op.responses[status]?.content).toEqual({
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      });
    }
    expect(op.responses['200']?.content).toBeUndefined();
  });

  it('leaves a declared error response untouched', () => {
    const op = post(
      generate([route('/a', [requireAuth()], { 200: z.object({}), 401: { description: 'Mine' } })]),
      '/a',
    );
    expect(op.responses['401']).toEqual({ description: 'Mine' });
  });

  it('adds no component when no generated error response exists', () => {
    const doc = generate([route('/a', [])]);
    expect(doc.components).toBeUndefined();
  });

  it('adds no body when omitted', () => {
    const op = post(
      generate([route('/a', [requireAuth()])], { errorSchema: undefined } as never),
      '/a',
    );
    expect(op.responses['401']).toEqual({ description: 'Unauthorized' });
  });

  it('lets an application schema named ProblemDetails keep its name', () => {
    const generator = new OpenApiGenerator({ title: 'T', version: '1', errorSchema: 'rfc9457' });
    generator.addSchema('ProblemDetails', z.object({ mine: z.string() }));
    const doc = generator.generate([route('/a', [requireAuth()])]);
    const schemas = doc.components?.schemas as Record<string, unknown>;
    expect(schemas['ProblemDetails']).toEqual({
      type: 'object',
      properties: { mine: { type: 'string' } },
      required: ['mine'],
      additionalProperties: false,
    });
    expect(schemas['ProblemDetails2']).toBeDefined();
    expect(post(doc, '/a').responses['401']?.content?.['application/problem+json']?.schema).toEqual(
      {
        $ref: '#/components/schemas/ProblemDetails2',
      },
    );
  });

  it('is purged and re-claimed on every generate()', () => {
    const generator = new OpenApiGenerator({ title: 'T', version: '1', errorSchema: 'rfc9457' });
    const first = generator.generate([route('/a', [requireAuth()])]);
    const second = generator.generate([route('/b', [])]);
    expect(first.components?.schemas).toHaveProperty('ProblemDetails');
    expect(second.components).toBeUndefined();
  });

  it('refuses any other value from the generator and the service', () => {
    const bad = {
      title: 'T',
      version: '1',
      errorSchema: 'rfc7807',
    } as unknown as OpenApiGeneratorOptions;
    for (const build of [
      () => new OpenApiGenerator(bad),
      () => new OpenApiService({ ...bad, app: {} as never, schemas: [] } as never),
    ]) {
      try {
        build();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(OpenApiDocumentOptionsError);
        expect((error as OpenApiDocumentOptionsError).reason).toBe('error-schema');
        expect((error as Error).message).toContain('"rfc7807"');
      }
    }
  });
});
