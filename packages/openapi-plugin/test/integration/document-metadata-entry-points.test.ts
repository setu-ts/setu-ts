import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ApiOperation, Controller, DecoratorPlugin, Get } from '@setu-ts/decorator-plugin';
import { requireAuth } from '@setu-ts/auth-plugin';
import { OpenApiGenerator, OpenApiPlugin } from '../../src/index.ts';
import type { OpenApiDocument, OpenApiGeneratorOptions } from '../../src/index.ts';

describe('document metadata entry points', () => {
  it('threads every option through the plugin and service identically to the generator', async () => {
    const options: OpenApiGeneratorOptions = {
      title: 'Users',
      version: '2',
      description: 'API',
      termsOfService: '/terms',
      contact: { name: 'Team', url: '/team', email: 'team@example.com' },
      license: { name: 'MIT', identifier: 'MIT' },
      tags: [
        {
          name: 'users',
          description: 'Users',
          externalDocs: { url: '/users', description: 'Guide' },
        },
      ],
      externalDocs: { url: '/docs', description: 'Documentation' },
    };
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ ...options, swagger: false })],
    });
    try {
      await app.start();
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const spec = response.json() as OpenApiDocument;
      expect(spec).toEqual(new OpenApiGenerator(options).generate([]));
      expect(spec.info).toEqual({
        title: 'Users',
        version: '2',
        description: 'API',
        termsOfService: '/terms',
        contact: options.contact,
        license: options.license,
      });
      expect(spec.tags).toEqual(options.tags);
      expect(spec.externalDocs).toEqual(options.externalDocs);
    } finally {
      await app.stop();
    }
  });

  it('threads deriveErrorResponses and errorSchema through the plugin and service (M137b)', async () => {
    for (const options of [
      { deriveErrorResponses: false },
      { errorSchema: 'rfc9457' as const },
    ] satisfies Partial<OpenApiGeneratorOptions>[]) {
      const app = createApplication({
        plugins: [RuntimePlugin(), OpenApiPlugin({ ...options, swagger: false })],
      });
      app.router.get('/guarded', {
        middleware: [requireAuth()],
        handler: (ctx) => ctx.response.json({}),
      });
      try {
        await app.start();
        const spec = (
          await app.inject({ method: 'GET', url: '/openapi.json' })
        ).json() as OpenApiDocument;
        const expected = new OpenApiGenerator({
          title: 'API',
          version: '1.0.0',
          ...options,
        }).generate(app.router.listRoutes().filter((r) => r.path === '/guarded'));
        expect(spec.paths['/guarded']).toEqual(expected.paths['/guarded']);
        const responses = (spec.paths['/guarded'] as Record<string, { responses: object }>)['get']
          ?.responses as Record<string, { content?: object }>;
        if ('deriveErrorResponses' in options) {
          expect(Object.keys(responses)).toEqual(['200']);
        } else {
          expect(responses['401']?.content).toEqual({
            'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
          });
        }
      } finally {
        await app.stop();
      }
    }
  });

  it.each([
    {
      options: { license: { name: 'MIT', identifier: 'MIT', url: '/license' } },
      reason: 'license-identifier-and-url',
    },
    { options: { tags: [{ name: 'users' }, { name: 'users' }] }, reason: 'duplicate-tag' },
    { options: { errorSchema: 'rfc7807' as never }, reason: 'error-schema' },
  ])('refuses $reason during startup before a request', async ({ options, reason }) => {
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ ...options, swagger: false })],
    });
    try {
      await expect(app.start()).rejects.toMatchObject({
        name: 'OpenApiDocumentOptionsError',
        reason,
      });
    } finally {
      await app.stop();
    }
  });

  it('documents both entry points identically and keeps hidden routes served and listed', async () => {
    @Controller('/decorated')
    class C {
      @Get('/old')
      @ApiOperation({ deprecated: true })
      old() {
        return { ok: true };
      }

      @Get('/hidden')
      @ApiOperation({ operationId: 'visible', excludeFromDocument: true })
      hidden() {
        return { hidden: true };
      }
    }
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({ controllers: [C] }),
        OpenApiPlugin({ swagger: false }),
      ],
    });
    app.router.get('/functional/old', {
      schema: { deprecated: true },
      handler: (ctx) => ctx.response.json({ ok: true }),
    });
    app.router.get('/functional/hidden', {
      schema: { operationId: 'visible', excludeFromDocument: true },
      handler: (ctx) => ctx.response.json({ hidden: true }),
    });
    app.router.get('/visible', {
      schema: { operationId: 'visible' },
      handler: (ctx) => ctx.response.json({}),
    });
    try {
      await app.start();
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const spec = response.json() as OpenApiDocument;
      const decorated = spec.paths['/decorated/old']?.get;
      const functional = spec.paths['/functional/old']?.get;
      expect(decorated).toEqual({
        operationId: 'get-decorated-old',
        deprecated: true,
        responses: { 200: { description: 'Successful response' } },
      });
      expect({ ...decorated, operationId: 'same' }).toEqual({ ...functional, operationId: 'same' });
      for (const path of ['/decorated/hidden', '/functional/hidden']) {
        expect(spec.paths).not.toHaveProperty(path);
        expect(app.router.listRoutes().some((route) => route.path === path)).toBe(true);
        const hidden = await app.inject({ method: 'GET', url: path });
        expect(hidden.statusCode).toBe(200);
        expect(hidden.json()).toEqual({ hidden: true });
      }
    } finally {
      await app.stop();
    }
  });
});
