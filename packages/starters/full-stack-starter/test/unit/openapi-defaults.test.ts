/**
 * The full-stack OpenAPI exclusions (M130 §3.9): page, asset and dev-proxy
 * routes stay out of `/openapi.json`, merged with the application's lists.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { fullStackOpenApiOptions } from '../../src/app.ts';
import { createFullStackApp } from '../../src/index.ts';

describe('fullStackOpenApiOptions', () => {
  it('adds the React Router owner and the Vite proxy path to the defaults', () => {
    expect(fullStackOpenApiOptions(undefined)).toEqual({
      excludeOwners: ['health-plugin', 'metrics-plugin', 'react-router-plugin'],
      exclude: ['/__vite/*'],
    });
  });

  it('merges application lists instead of replacing them, keeping other options', () => {
    const merged = fullStackOpenApiOptions({
      title: 'Shop',
      excludeOwners: ['my-plugin', 'react-router-plugin'],
      exclude: ['/internal'],
    });
    expect(merged).toEqual({
      title: 'Shop',
      excludeOwners: ['my-plugin', 'react-router-plugin'],
      exclude: ['/internal', '/__vite/*'],
    });
  });
});

describe('the composed full-stack document', () => {
  it('lists /api routes and no page, asset, dev-proxy, health or metrics route', async () => {
    const app = createFullStackApp({
      reactRouter: {
        serverBuildPath: './build/server',
        assetsDir: './build/client/assets',
        loadRequestHandler: () =>
          Promise.resolve({
            handler: () => Promise.resolve(new Response('<html></html>')),
            createLoadContext: () => ({ get: () => null, set: () => {} }),
          }),
      },
      openapi: { exclude: ['/api/hidden'] },
    });
    app.router.get('/api/products', (ctx) => ctx.response.json([]));
    app.router.get('/api/hidden', (ctx) => ctx.response.json([]));
    app.router.get('/__vite/*', (ctx) => ctx.response.text(''));
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(response.statusCode).toBe(200);
      const paths = Object.keys((JSON.parse(response.body) as { paths: object }).paths);
      expect(paths).toContain('/api/products');
      for (const absent of ['/api/hidden', '/__vite/{wildcard}', '/__vite/*', '/*', '/assets/*']) {
        expect(paths).not.toContain(absent);
      }
      expect(paths.some((p) => p.startsWith('/__vite') || p.startsWith('/assets'))).toBe(false);
      expect(paths.some((p) => p.startsWith('/health') || p === '/metrics')).toBe(false);
    } finally {
      await app.stop();
    }
  });
});
