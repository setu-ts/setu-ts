/**
 * Derived request schemas and owner exclusion, driven through a REAL kernel
 * application with the REAL plugins (M70m/X11-5, X11-8).
 *
 * The unit tests hand-brand their middleware, which cannot prove that
 * `@setu-ts/validation-plugin` and `@setu-ts/openapi-plugin` resolve the same
 * `Symbol.for` key — the one property the whole channel rests on. Only a real
 * app can. Likewise, the owner exclusion is only meaningful against the real
 * `HealthPlugin`/`MetricsPlugin`, whose route paths are configurable.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import { createApplication } from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { validateBody, validateQuery, ValidationPlugin } from '@setu-ts/validation-plugin';

import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';
import type { OpenApiDocument } from '../../src/generators/openapi-generator.ts';
import type { OpenApiPluginOptions } from '../../src/plugin/openapi-plugin.ts';

const PlaceOrder = z.object({ sku: z.string().min(1), qty: z.number() });
const ListQuery = z.object({ q: z.string(), page: z.string().optional() });

async function specFrom(
  options: OpenApiPluginOptions,
  extraPlugins: readonly IPlugin[] = [],
): Promise<OpenApiDocument> {
  const app = createApplication({
    plugins: [RuntimePlugin(), ValidationPlugin(), ...extraPlugins, OpenApiPlugin(options)],
  });
  app.router.post('/orders', {
    middleware: [validateBody(PlaceOrder)],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  app.router.get('/orders', {
    middleware: [validateQuery(ListQuery)],
    handler: (ctx) => ctx.response.json([]),
  });
  await app.start();
  try {
    const res = await app.fetch(new Request('http://localhost/openapi.json'));
    return await res.json() as OpenApiDocument;
  } finally {
    await app.stop();
  }
}

describe('derived request schemas through a real application', () => {
  it('documents a requestBody from the REAL validateBody middleware', async () => {
    const spec = await specFrom({ title: 'Orders', version: '1.0.0' });

    // The whole channel: `validation-plugin` brands, `openapi-plugin` reads,
    // and neither imports the other. A locally-created symbol on either side
    // would leave this `undefined`.
    expect(spec.paths['/orders']?.post?.requestBody?.content['application/json'].schema).toEqual({
      type: 'object',
      properties: { sku: { type: 'string', minLength: 1 }, qty: { type: 'number' } },
      required: ['sku', 'qty'],
    });
  });

  it('documents query parameters from the REAL validateQuery middleware', async () => {
    const spec = await specFrom({ title: 'Orders', version: '1.0.0' });

    expect(spec.paths['/orders']?.get?.parameters).toEqual([
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'string' } },
    ]);
  });

  it('documents the 400 those middlewares actually answer', async () => {
    const spec = await specFrom({ title: 'Orders', version: '1.0.0' });

    expect(spec.paths['/orders']?.post?.responses['400']).toEqual({
      description: 'Bad request',
    });
  });

  it('derives nothing when the option is turned off', async () => {
    const spec = await specFrom({
      title: 'Orders',
      version: '1.0.0',
      deriveRequestSchemas: false,
    });

    expect(spec.paths['/orders']?.post?.requestBody).toBeUndefined();
    expect(spec.paths['/orders']?.get?.parameters).toBeUndefined();
  });
});

describe('operational routes through a real application', () => {
  it('omits the real health and metrics endpoints by default', async () => {
    const spec = await specFrom({ title: 'Orders', version: '1.0.0' }, [
      HealthPlugin(),
      MetricsPlugin(),
    ]);

    expect(Object.keys(spec.paths).sort()).toEqual(['/orders']);
  });

  it('omits them when they are RENAMED, which a path list could not', async () => {
    // The property that makes owner-based exclusion correct rather than
    // merely convenient: these paths are configuration, not constants.
    const spec = await specFrom({ title: 'Orders', version: '1.0.0' }, [
      HealthPlugin({
        endpoints: { health: '/_ops/health', live: '/_ops/live', ready: '/_ops/ready' },
      }),
      MetricsPlugin({ endpoint: '/_ops/metrics' }),
    ]);

    expect(Object.keys(spec.paths).sort()).toEqual(['/orders']);
  });

  it('documents them again when excludeOwners is empty', async () => {
    const spec = await specFrom({ title: 'Orders', version: '1.0.0', excludeOwners: [] }, [
      HealthPlugin(),
      MetricsPlugin(),
    ]);

    expect(Object.keys(spec.paths).sort()).toEqual([
      '/health',
      '/live',
      '/metrics',
      '/orders',
      '/ready',
    ]);
  });
});
