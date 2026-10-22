/**
 * Swagger UI self-hosts by default, which needs `runtime.fs`. Workers has none,
 * so the starter's default composition must pick the pinned CDN assets there
 * or every default application refuses to start on Workers.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { composeRestPlugins, openApiOptionsFor } from '../../src/app.ts';

/** Replaces the starter's detecting `RuntimePlugin()` with one forced to Workers. */
function onWorkers(plugins: readonly IPlugin[]): IPlugin[] {
  return plugins.map((p) =>
    p.name === 'runtime' ? RuntimePlugin({ platform: 'cloudflare-workers' }) : p,
  );
}

describe('rest-starter / OpenAPI assets per platform', () => {
  it('selects the CDN on Workers when no Swagger mode was chosen', () => {
    expect(openApiOptionsFor(undefined, 'cloudflare-workers')).toEqual({
      swagger: { assets: 'cdn' },
    });
    expect(openApiOptionsFor({ endpoint: '/api/docs' }, 'cloudflare-workers')).toEqual({
      endpoint: '/api/docs',
      swagger: { assets: 'cdn' },
    });
  });

  it('keeps a disabled UI and an explicit asset mode on Workers', () => {
    for (const swagger of [
      false,
      { assets: 'self' },
      { assets: { baseUrl: '/swagger' } },
    ] as const) {
      expect(openApiOptionsFor({ swagger }, 'cloudflare-workers')).toEqual({ swagger });
    }
  });

  it('selects the CDN on Workers for a Swagger value naming no asset mode', () => {
    for (const swagger of [true, {}] as const) {
      expect(openApiOptionsFor({ swagger }, 'cloudflare-workers')).toEqual({
        swagger: { assets: 'cdn' },
      });
    }
  });

  it('leaves every server runtime on the self-hosted default', () => {
    for (const platform of ['deno', 'node', 'bun'] as const) {
      expect(openApiOptionsFor(undefined, platform)).toBeUndefined();
      expect(openApiOptionsFor({ endpoint: '/x' }, platform)).toEqual({ endpoint: '/x' });
    }
  });

  it('boots a default composition on Workers and serves /docs from the CDN', async () => {
    const app = createApplication({
      plugins: onWorkers(composeRestPlugins({}, 'cloudflare-workers')),
    });
    await app.start();
    try {
      const docs = await app.fetch(new Request('http://localhost/docs'));
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain('https://unpkg.com/swagger-ui-dist@5.33.3/');
    } finally {
      await app.stop();
    }
  });

  it('cannot boot the self-hosted default on Workers (the defect)', async () => {
    const app = createApplication({
      plugins: onWorkers(
        composeRestPlugins({ openapi: { swagger: { assets: 'self' } } }, 'cloudflare-workers'),
      ),
    });
    await expect(app.start()).rejects.toThrow();
    await app.stop().catch(() => undefined);
  });
});
