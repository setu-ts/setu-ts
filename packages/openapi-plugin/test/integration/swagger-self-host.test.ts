import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { OpenApiPlugin } from '../../src/index.ts';
import type { IOpenApiService } from '../../src/index.ts';

let directory: string | undefined;
try {
  const mod = await import('swagger-ui-dist/absolute-path.js');
  directory = mod.default();
} catch {
  // The optional peer is absent: the refusal is covered by the unit seam.
}

describe.skipIf(directory === undefined)('real Swagger UI self-hosting', () => {
  it('serves the actual package bytes with types/cache headers and excludes its delivery routes', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ endpoint: '/api/docs/' })],
    });
    app.router.get('/hello', (ctx) => ctx.response.text('hello'));
    await app.start();
    try {
      const docs = await app.fetch(new Request('http://localhost/api/docs/'));
      expect(docs.status).toBe(200);
      expect(docs.headers.get('content-type')).toContain('text/html');
      const html = await docs.text();
      expect(html).not.toContain('integrity=');
      for (const [file, type] of [
        ['swagger-ui.css', 'text/css'],
        ['swagger-ui-bundle.js', 'application/javascript'],
        ['swagger-ui-standalone-preset.js', 'application/javascript'],
      ]) {
        const response = await app.fetch(new Request(`http://localhost/api/docs/${file}`));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(`${type}; charset=utf-8`);
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const expected = await readFile(`${directory}/${file}`);
        expect(bytes.length).toBe(expected.length);
        expect(createHash('sha384').update(bytes).digest('hex')).toBe(
          createHash('sha384').update(expected).digest('hex'),
        );
        expect(html).toContain(`/api/docs/${file}`);
      }
      const spec = app.services.get<IOpenApiService>(CAPABILITIES.OPENAPI).getSpec();
      expect(Object.keys(spec.paths as Record<string, unknown>)).toEqual(['/hello']);
      expect((await app.fetch(new Request('http://localhost/api/docs/other.js'))).status).toBe(404);
    } finally {
      await app.stop();
    }
  });
});

describe('external Swagger UI assets', () => {
  it('keeps an application route at an asset path in the spec', async () => {
    for (const assets of ['cdn', { baseUrl: '/static/swagger' }] as const) {
      const app = createApplication({
        plugins: [RuntimePlugin(), OpenApiPlugin({ swagger: { assets } })],
      });
      app.router.get('/docs/swagger-ui.css', (ctx) => ctx.response.text('app stylesheet'));
      await app.start();
      try {
        const spec = app.services.get<IOpenApiService>(CAPABILITIES.OPENAPI).getSpec();
        expect(Object.keys(spec.paths as Record<string, unknown>)).toEqual([
          '/docs/swagger-ui.css',
        ]);
        const response = await app.fetch(new Request('http://localhost/docs/swagger-ui.css'));
        expect(await response.text()).toBe('app stylesheet');
      } finally {
        await app.stop();
      }
    }
  });
});
