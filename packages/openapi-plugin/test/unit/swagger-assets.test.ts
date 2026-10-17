import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { OpenApiPlugin, swaggerUiHtml } from '../../src/index.ts';
import type { OpenApiPluginOptions, SwaggerOptions } from '../../src/index.ts';
import { resolveSwaggerAssets } from '../../src/ui/swagger-ui.ts';

vi.mock('swagger-ui-dist/absolute-path.js', () => {
  throw new Error('simulated missing optional package');
});

const hashes = [
  'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW',
  'sha384-h00llMzD1afyNow1pDmnZKlHsUZgp9KE9HXLFXF2CvbwsBY0+WBO4f75SfGwvM4K',
  'sha384-My2aDM4r2Mbm3ybHcubKm9O9U8FEjvF/O5nGvE9YK5dzqOTbWEKa79RPJ1krdMaF',
];
const files = ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js'];

describe('Swagger asset options', () => {
  it('resolves defaults and accepts each mode', () => {
    for (const option of [true, false, {}, { assets: 'self' }] as const)
      expect(resolveSwaggerAssets(option)).toBe('self');
    expect(resolveSwaggerAssets({ assets: 'cdn' })).toBe('cdn');
    for (const baseUrl of ['https://assets.example.com/ui/', 'http://localhost/ui/', '/ui/', '/']) {
      expect(resolveSwaggerAssets({ assets: { baseUrl } })).toEqual({
        baseUrl: baseUrl.replace(/\/+$/, ''),
      });
    }
  });

  it('refuses every invalid mode at plugin construction', () => {
    for (const swagger of [
      null,
      1,
      'cdn',
      [],
      { assets: 'unknown' },
      { assets: null },
      { assets: 1 },
      { assets: {} },
      ...[
        'relative',
        '//other.test/ui',
        'javascript:alert(1)',
        'ftp://other.test/ui',
        'https://',
        '',
      ].map((baseUrl) => ({ assets: { baseUrl } })),
    ])
      expect(() => OpenApiPlugin({ swagger } as unknown as OpenApiPluginOptions)).toThrow(
        TypeError,
      );
  });

  it('uses local asset URLs with no integrity attributes by default', () => {
    const html = swaggerUiHtml({ specUrl: '/openapi.json', endpoint: '/api/docs/' });
    for (const file of files) expect(html).toContain(`/api/docs/${file}`);
    expect(html).not.toContain('unpkg');
    expect(html).not.toContain('integrity=');
    expect(html).not.toContain('crossorigin=');
  });

  for (const assets of [
    'cdn',
    { baseUrl: 'https://assets.example.com/ui/' },
    { baseUrl: '/ui' },
  ] satisfies NonNullable<SwaggerOptions['assets']>[]) {
    it(`uses pinned SRI and crossorigin for ${JSON.stringify(assets)}`, () => {
      const html = swaggerUiHtml({ specUrl: '/openapi.json', assets });
      const base =
        assets === 'cdn'
          ? 'https://unpkg.com/swagger-ui-dist@5.33.3'
          : assets.baseUrl.replace(/\/+$/, '');
      for (let i = 0; i < files.length; i++) {
        expect(html).toContain(
          `="${base}/${files[i]}" integrity="${hashes[i]}" crossorigin="anonymous"`,
        );
      }
      expect(html.match(/integrity=/g)).toHaveLength(3);
    });
  }

  it('escapes the custom base URL attribute', () => {
    expect(swaggerUiHtml({ specUrl: '/spec', assets: { baseUrl: '/ui/"&<>' } })).toContain(
      '/ui/&quot;&amp;&lt;&gt;/swagger-ui.css',
    );
  });

  it('rejects a missing package with a named startup error and both remedies', async () => {
    const plugin = OpenApiPlugin();
    const app = createApplication({ plugins: [RuntimePlugin(), plugin] });
    await expect(app.start()).rejects.toThrow('swagger-ui-dist');
    // Drive register directly too, to inspect the original named error rather
    // than the kernel's startup wrapper.
    const { createNodeRuntimeServices } = await import('@setu-ts/runtime');
    const fresh = createApplication();
    const ctx = {
      runtime: createNodeRuntimeServices(),
      app: fresh,
      services: fresh.services,
      router: fresh.router,
      lifecycle: { onInit: () => {} },
    };
    const failure = await Promise.resolve(plugin.register(ctx as never)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: 'OptionalDependencyUnavailableError',
      dependency: 'swagger-ui-dist',
    });
    expect((failure as Error).message).toContain('Install swagger-ui-dist');
    expect((failure as Error).message).toContain("swagger: { assets: 'cdn' }");
  });

  it('refuses self-hosting without runtime.fs and names both external modes', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin({ platform: 'cloudflare-workers' }), OpenApiPlugin()],
    });
    const failure = await app.start().catch((error: unknown) => error);
    expect((failure as Error).message).toContain('runtime.fs');
    expect((failure as Error).message).toContain("assets: 'cdn'");
    expect((failure as Error).message).toContain('baseUrl');
  });

  for (const assets of ['cdn', { baseUrl: '/assets' }] as const) {
    it(`boots without a filesystem or dependency import for ${JSON.stringify(assets)}`, async () => {
      const app = createApplication({
        plugins: [
          RuntimePlugin({ platform: 'cloudflare-workers' }),
          OpenApiPlugin({ swagger: { assets } }),
        ],
      });
      await app.start();
      try {
        const docs = await app.inject({ method: 'GET', url: '/docs' });
        expect(docs.statusCode).toBe(200);
        expect(docs.body).toContain('integrity="sha384-');
        expect((await app.inject({ method: 'GET', url: '/docs/swagger-ui.css' })).statusCode).toBe(
          404,
        );
      } finally {
        await app.stop();
      }
    });
  }
});
