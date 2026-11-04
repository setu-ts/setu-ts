/**
 * The store through a real kernel app composed with `MultiTenancyPlugin`: the
 * route takes its scope from `scopeFor(ctx)`, so two tenants writing the same
 * id never see each other's rows, a tenant-less request is a 400 before any
 * adapter call, and a `{ fixed }` scope serves every request from one scope.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPluginContext, IRequestContext, IVectorStore } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MemoryVectorStore, VectorStorePlugin } from '../../src/index.ts';
import type { VectorStoreTenancy } from '../../src/index.ts';

const collections = [{ name: 'documents', dimensions: 2, filterable: { tag: 'string' as const } }];

function app(tenancy?: VectorStoreTenancy) {
  const adapter = new MemoryVectorStore();
  const calls: string[] = [];
  const query = adapter.query.bind(adapter);
  adapter.query = (...args) => {
    calls.push(`query:${args[1]}`);
    return query(...args);
  };
  const application = createApplication({
    plugins: [
      RuntimePlugin(),
      MultiTenancyPlugin({ resolver: 'header', required: false }),
      VectorStorePlugin({ adapter, collections, ...(tenancy === undefined ? {} : { tenancy }) }),
      {
        name: 'documents-routes',
        version: '1.0.0',
        dependencies: [CAPABILITIES.VECTOR_STORE],
        register(ctx: IPluginContext): void {
          const store = ctx.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
          ctx.router.post('/documents', async (c: IRequestContext) => {
            const body = await c.request.json<{ id: string; vector: number[]; tag: string }>();
            await store.upsert('documents', store.scopeFor(c), [
              { id: body.id, vector: body.vector, metadata: { tag: body.tag } },
            ]);
            return c.response.status(204).send();
          });
          ctx.router.get('/search', async (c: IRequestContext) => {
            const matches = await store.query('documents', store.scopeFor(c), {
              vector: [1, 0],
              topK: 5,
            });
            return c.response.json(matches.map((m) => [m.id, m.metadata['tag']]));
          });
        },
      },
    ],
  });
  // The status hint on VectorScopeRequiredError reaches the client through
  // the exceptions error handler, as in every generated application.
  application.middleware.add(errorHandler({ format: 'rfc9457' }), {
    priority: 0,
    name: 'error-handler',
  });
  return { calls, app: application };
}

function write(target: ReturnType<typeof app>['app'], tenant: string, tag: string) {
  return target.inject({
    method: 'POST',
    url: 'http://localhost/documents',
    headers: { 'x-tenant-id': tenant, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'doc', vector: [1, 0], tag }),
  });
}

describe('vector store in a tenant-resolving app', () => {
  it('keeps two tenants writing the same id apart', async () => {
    const { app: target } = app();
    await target.start();
    try {
      expect((await write(target, 'acme', 'acme-tag')).statusCode).toBe(204);
      expect((await write(target, 'globex', 'globex-tag')).statusCode).toBe(204);
      for (const tenant of ['acme', 'globex']) {
        const res = await target.inject({
          method: 'GET',
          url: 'http://localhost/search',
          headers: { 'x-tenant-id': tenant },
        });
        expect(res.json()).toEqual([['doc', `${tenant}-tag`]]);
      }
    } finally {
      await target.stop();
    }
  });

  it('answers a tenant-less request with 400 before the adapter is called', async () => {
    const { app: target, calls } = app();
    await target.start();
    try {
      const res = await target.inject({ method: 'GET', url: 'http://localhost/search' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ detail: string }>().detail).toBe(
        'This request is not associated with a tenant.',
      );
      expect(calls).toEqual([]);
    } finally {
      await target.stop();
    }
  });

  it('serves every request from the fixed scope, tenant or not', async () => {
    const { app: target, calls } = app({ fixed: 'shared' });
    await target.start();
    try {
      await write(target, 'acme', 'one');
      const tenantless = await target.inject({ method: 'GET', url: 'http://localhost/search' });
      expect(tenantless.json()).toEqual([['doc', 'one']]);
      expect(calls).toEqual(['query:shared']);
    } finally {
      await target.stop();
    }
  });
});
