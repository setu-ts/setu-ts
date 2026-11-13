/**
 * Declared response headers (M137b §3.6): the `RouteResponseDocumentation`
 * wrapper's `headers`, emitted as the OpenAPI response's `headers` object.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { RouteInfo, RouteResponseDocumentation } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ApiResponse, Controller, DecoratorPlugin, Post } from '@setu-ts/decorator-plugin';
import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import type { OpenApiDocument } from '../../src/generators/openapi-generator.ts';

import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';
import type { OpenApiOperation } from '../../src/generators/openapi-generator.ts';

function op(response: Record<number, unknown>): OpenApiOperation {
  const r: RouteInfo = {
    method: 'POST',
    path: '/items',
    definition: { handler: () => undefined as never, schema: { response } },
  };
  const doc = new OpenApiGenerator({ title: 'T', version: '1' }).generate([r]);
  return (doc.paths['/items'] as Record<string, OpenApiOperation>)['post'] as OpenApiOperation;
}

describe('declared response headers', () => {
  it('emits a wrapper carrying only headers as headers, not as a schema', () => {
    const created: RouteResponseDocumentation = {
      headers: { Location: { description: 'The new item URL', required: true } },
    };
    const response = op({ 201: created }).responses['201'];
    expect(response).toEqual({
      description: 'Resource created',
      headers: {
        Location: { description: 'The new item URL', required: true, schema: { type: 'string' } },
      },
    });
  });

  it('resolves a Zod header schema and copies description and required only when set', () => {
    const response = op({
      200: {
        description: 'OK',
        schema: z.object({ id: z.string() }),
        headers: {
          ETag: { schema: z.string().min(1) },
          'X-Count': { schema: z.number().int(), required: false },
        },
      },
    }).responses['200'];
    expect(response?.headers).toEqual({
      ETag: { schema: { type: 'string', minLength: 1 } },
      'X-Count': {
        required: false,
        schema: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
      },
    });
    expect(Object.keys(response ?? {})).toEqual(['description', 'headers', 'content']);
  });

  it('orders header names case-insensitively and keeps their declared casing', () => {
    const response = op({
      200: { headers: { zeta: {}, Alpha: {}, beta: {} } },
    }).responses['200'];
    expect(Object.keys(response?.headers ?? {})).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('orders by code unit, not by locale, so every host serves the same bytes', () => {
    // `localeCompare` places `\u00e9` before `f`; code-unit order places it after.
    const response = op({ 200: { headers: { 'X-\u00e9': {}, 'X-F': {}, 'x-a': {} } } }).responses[
      '200'
    ];
    expect(Object.keys(response?.headers ?? {})).toEqual(['x-a', 'X-F', 'X-\u00e9']);
  });

  it('treats a non-object header value as an empty declaration', () => {
    const response = op({ 200: { headers: { 'X-Flag': 'yes' } } }).responses['200'];
    expect(response?.headers).toEqual({ 'X-Flag': { schema: { type: 'string' } } });
  });

  it('emits no headers object for an empty or non-object headers field', () => {
    expect(op({ 200: { description: 'OK', headers: {} } }).responses['200']).toEqual({
      description: 'OK',
    });
    expect(op({ 200: { description: 'OK', headers: 'nope' } }).responses['200']).toEqual({
      description: 'OK',
    });
  });

  it('serves @ApiResponse({ headers }) from a decorated route as headers', async () => {
    @Controller('/things')
    class Things {
      @Post('/')
      @ApiResponse({ status: 201, headers: { Location: { description: 'New thing' } } })
      create() {
        return {};
      }
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [Things] }),
        OpenApiPlugin({ swagger: false }),
      ],
    });
    try {
      await app.start();
      const spec = (
        await app.inject({ method: 'GET', url: '/openapi.json' })
      ).json() as OpenApiDocument;
      const created = (spec.paths['/things'] as Record<string, OpenApiOperation>)['post']
        ?.responses['201'];
      expect(created).toEqual({
        description: 'Resource created',
        headers: { Location: { description: 'New thing', schema: { type: 'string' } } },
      });
    } finally {
      await app.stop();
    }
  });
});
