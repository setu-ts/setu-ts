/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The plugin through a real kernel application: option validation when it is
 * created, the adapter lifecycle during registration (resolve, open, ensure
 * every collection, close at shutdown), and a startup that fails when the
 * backend cannot be prepared.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices, IVectorStore, IVectorStoreAdapter } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MemoryVectorStore, VectorStorePlugin } from '../../src/index.ts';

const collections = [
  { name: 'documents', dimensions: 2, filterable: { tag: 'string' as const } },
  { name: 'notes', dimensions: 3 },
];

class LifecycleAdapter extends MemoryVectorStore implements IVectorStoreAdapter {
  readonly events: string[] = [];
  runtime: IRuntimeServices | undefined;
  failEnsure = false;

  override async open(runtime?: IRuntimeServices): Promise<void> {
    this.runtime = runtime;
    this.events.push('open');
  }

  override async ensureCollection(spec: Parameters<MemoryVectorStore['ensureCollection']>[0]) {
    this.events.push(`ensure:${spec.name}`);
    if (this.failEnsure) throw new Error('backend unreachable');
    await super.ensureCollection(spec);
  }

  override async close(): Promise<void> {
    this.events.push('close');
  }
}

describe('VectorStorePlugin', () => {
  it('opens the adapter, ensures each collection in order, serves, and closes at shutdown', async () => {
    const adapter = new LifecycleAdapter();
    const app = createApplication({
      plugins: [RuntimePlugin(), VectorStorePlugin({ adapter, collections })],
    });
    await app.start();
    try {
      expect(adapter.events).toEqual(['open', 'ensure:documents', 'ensure:notes']);
      expect(adapter.runtime).toBeDefined();
      const store = app.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      await store.upsert('documents', 'tenant-a', [
        { id: 'r1', vector: [1, 0], metadata: { tag: 'x' } },
      ]);
      expect((await store.query('documents', 'tenant-a', { vector: [1, 0], topK: 1 }))[0]!.id).toBe(
        'r1',
      );
    } finally {
      await app.stop();
    }
    expect(adapter.events.at(-1)).toBe('close');
  });

  it('resolves a synchronous or asynchronous adapter factory with the runtime', async () => {
    for (const async of [false, true]) {
      const adapter = new LifecycleAdapter();
      let seen: IRuntimeServices | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          VectorStorePlugin({
            adapter: (runtime) => {
              seen = runtime;
              return async ? Promise.resolve(adapter) : adapter;
            },
            collections,
          }),
        ],
      });
      await app.start();
      await app.stop();
      expect(seen).toBeDefined();
      expect(adapter.events).toEqual(['open', 'ensure:documents', 'ensure:notes', 'close']);
    }
  });

  it('fails startup when a collection cannot be ensured, and closes the opened adapter', async () => {
    const adapter = new LifecycleAdapter();
    adapter.failEnsure = true;
    const app = createApplication({
      plugins: [RuntimePlugin(), VectorStorePlugin({ adapter, collections })],
    });
    await expect(app.start()).rejects.toThrow('backend unreachable');
    // A failed start runs only the close hooks; stop() is never reached.
    expect(adapter.events).toEqual(['open', 'ensure:documents', 'close']);
  });

  it('refuses a factory that resolves to something other than an adapter', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        VectorStorePlugin({ adapter: () => ({}) as IVectorStoreAdapter, collections }),
      ],
    });
    await expect(app.start()).rejects.toThrow('must implement IVectorStoreAdapter');
    await app.stop().catch(() => undefined);
  });

  it('serves scopeFor under a fixed scope', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        VectorStorePlugin({
          adapter: new MemoryVectorStore(),
          collections,
          tenancy: { fixed: 'shared' },
        }),
      ],
    });
    await app.start();
    try {
      const store = app.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      expect(store.scopeFor({ request: {} } as never)).toBe('shared');
    } finally {
      await app.stop();
    }
  });

  it.each([
    ['no options', undefined, 'options are required'],
    ['no collections', { adapter: new MemoryVectorStore(), collections: [] }, 'non-empty array'],
    ['a non-adapter', { adapter: {}, collections }, 'missing open'],
    ['a null adapter', { adapter: null, collections }, 'missing adapter'],
    [
      'a bad tenancy',
      { adapter: new MemoryVectorStore(), collections, tenancy: 'optional' },
      'tenancy must be',
    ],
    [
      'an invalid fixed scope',
      { adapter: new MemoryVectorStore(), collections, tenancy: { fixed: '' } },
      'scope must be',
    ],
  ])('refuses %s when created', (_label, options, message) => {
    expect(() => VectorStorePlugin(options as never)).toThrow(message);
  });

  it('declares one instance providing the vector-store token', () => {
    const plugin = VectorStorePlugin({ adapter: new MemoryVectorStore(), collections });
    expect(plugin.name).toBe('vector-store-plugin');
    expect(plugin.provides).toEqual([CAPABILITIES.VECTOR_STORE]);
    expect(plugin.dependencies).toEqual([CAPABILITIES.RUNTIME]);
  });
});
