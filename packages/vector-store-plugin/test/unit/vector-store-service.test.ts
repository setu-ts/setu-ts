/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The service validates every call before the adapter runs, and `scopeFor`
 * resolves the scope from the request's tenant or a fixed scope. The recording
 * adapter implements the full `IVectorStoreAdapter` signature, so a refused
 * call is proven to have made no adapter call at all.
 */
import { describe, expect, it } from 'vitest';
import {
  VectorCollectionUnknownError,
  VectorDimensionError,
  VectorFilterError,
  VectorRecordError,
  VectorScopeInvalidError,
  VectorScopeRequiredError,
} from '@setu-ts/common';
import type {
  IRequestContext,
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorMatch,
  VectorQuery,
  VectorRecord,
} from '@setu-ts/common';
import { resolveCollections } from '../../src/services/collection-spec.ts';
import { VectorStoreService } from '../../src/services/vector-store-service.ts';

type Call = { readonly method: string; readonly args: readonly unknown[] };

function recordingAdapter(): IVectorStoreAdapter & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: 'recording',
    calls,
    async open(...args) {
      calls.push({ method: 'open', args });
    },
    async ensureCollection(...args: [VectorCollectionSpec]) {
      calls.push({ method: 'ensureCollection', args });
    },
    async upsert(...args: [VectorCollectionSpec, string, readonly VectorRecord[]]) {
      calls.push({ method: 'upsert', args });
    },
    async replaceSource(...args: [VectorCollectionSpec, string, string, readonly VectorRecord[]]) {
      calls.push({ method: 'replaceSource', args });
    },
    async query(
      ...args: [VectorCollectionSpec, string, VectorQuery]
    ): Promise<readonly VectorMatch[]> {
      calls.push({ method: 'query', args });
      return [{ id: 'r1', score: 1, metadata: {} }];
    },
    async delete(...args: [VectorCollectionSpec, string, readonly string[]]) {
      calls.push({ method: 'delete', args });
    },
    async deleteScope(...args: [VectorCollectionSpec, string]) {
      calls.push({ method: 'deleteScope', args });
    },
  };
}

const collections = resolveCollections([
  { name: 'documents', dimensions: 3, filterable: { tag: 'string', year: 'number' } },
]);

function ctxWithTenant(id?: string): IRequestContext {
  return { request: id === undefined ? {} : { tenant: { id } } } as unknown as IRequestContext;
}

describe('VectorStoreService', () => {
  it('passes validated copies and the frozen spec to the adapter', async () => {
    const adapter = recordingAdapter();
    const service = new VectorStoreService(adapter, collections, 'required');
    await service.upsert('documents', 'tenant-a', [
      { id: 'r1', vector: [1, 0, 0], metadata: { tag: 'a' } },
    ]);
    await service.replaceSource('documents', 'tenant-a', 's1', [
      { id: 'r2', vector: [0, 1, 0], sourceId: 's1' },
    ]);
    expect(
      await service.query('documents', 'tenant-a', {
        vector: [1, 1, 0],
        topK: 5,
        minScore: 0.1,
        filter: { field: 'tag', op: 'eq', value: 'a' },
      }),
    ).toEqual([{ id: 'r1', score: 1, metadata: {} }]);
    await service.query('documents', 'tenant-a', { vector: [1, 1, 0], topK: 50 });
    await service.delete('documents', 'tenant-a', ['r1']);
    await service.deleteScope('documents', 'tenant-a');
    expect(adapter.calls.map((call) => call.method)).toEqual([
      'upsert',
      'replaceSource',
      'query',
      'query',
      'delete',
      'deleteScope',
    ]);
    const spec = collections.get('documents')!.spec;
    expect(
      adapter.calls.every((call) => call.args[0] === spec && call.args[1] === 'tenant-a'),
    ).toBe(true);
    expect(adapter.calls[2]!.args[2]).toEqual({
      vector: [1, 1, 0],
      topK: 5,
      filter: { field: 'tag', op: 'eq', value: 'a' },
      minScore: 0.1,
    });
    expect(adapter.calls[3]!.args[2]).toEqual({ vector: [1, 1, 0], topK: 50 });
  });

  it('makes no adapter call for an empty upsert or delete', async () => {
    const adapter = recordingAdapter();
    const service = new VectorStoreService(adapter, collections, 'required');
    await service.upsert('documents', 'tenant-a', []);
    await service.delete('documents', 'tenant-a', []);
    expect(adapter.calls).toEqual([]);
  });

  it.each<
    [string, (service: VectorStoreService) => Promise<unknown>, new (...args: never[]) => Error]
  >([
    [
      'an undeclared collection',
      (s) => s.query('missing', 't', { vector: [1, 0, 0], topK: 1 }),
      VectorCollectionUnknownError,
    ],
    [
      'a non-string collection',
      (s) => s.deleteScope(3 as unknown as string, 't'),
      VectorCollectionUnknownError,
    ],
    ['an invalid scope', (s) => s.upsert('documents', '', []), VectorScopeInvalidError],
    [
      'a wrong-length vector',
      (s) => s.upsert('documents', 't', [{ id: 'r', vector: [1, 0] }]),
      VectorDimensionError,
    ],
    [
      'a record without its sourceId',
      (s) => s.replaceSource('documents', 't', 's1', [{ id: 'r', vector: [1, 0, 0] }]),
      VectorRecordError,
    ],
    [
      'a record with another sourceId',
      (s) =>
        s.replaceSource('documents', 't', 's1', [{ id: 'r', vector: [1, 0, 0], sourceId: 's2' }]),
      VectorRecordError,
    ],
    ['an invalid sourceId', (s) => s.replaceSource('documents', 't', '', []), VectorRecordError],
    [
      'a non-object query',
      (s) => s.query('documents', 't', null as unknown as VectorQuery),
      VectorRecordError,
    ],
    ['topK 0', (s) => s.query('documents', 't', { vector: [1, 0, 0], topK: 0 }), VectorRecordError],
    [
      'topK 51',
      (s) => s.query('documents', 't', { vector: [1, 0, 0], topK: 51 }),
      VectorRecordError,
    ],
    [
      'topK 1.5',
      (s) => s.query('documents', 't', { vector: [1, 0, 0], topK: 1.5 }),
      VectorRecordError,
    ],
    [
      'minScore NaN',
      (s) => s.query('documents', 't', { vector: [1, 0, 0], topK: 1, minScore: Number.NaN }),
      VectorRecordError,
    ],
    [
      'minScore 2',
      (s) => s.query('documents', 't', { vector: [1, 0, 0], topK: 1, minScore: 2 }),
      VectorRecordError,
    ],
    [
      'a zero query vector',
      (s) => s.query('documents', 't', { vector: [0, 0, 0], topK: 1 }),
      VectorDimensionError,
    ],
    [
      'an undeclared filter field',
      (s) =>
        s.query('documents', 't', {
          vector: [1, 0, 0],
          topK: 1,
          filter: { field: 'secret', op: 'eq', value: 'x' },
        }),
      VectorFilterError,
    ],
    [
      'too many ids',
      (s) =>
        s.delete(
          'documents',
          't',
          Array.from({ length: 1001 }, (_, i) => `r${i}`),
        ),
      VectorRecordError,
    ],
  ])('refuses %s before any adapter call', async (_label, call, error) => {
    const adapter = recordingAdapter();
    const service = new VectorStoreService(adapter, collections, 'required');
    await expect(call(service)).rejects.toThrow(error);
    expect(adapter.calls).toEqual([]);
  });
});

describe('VectorStoreService.scopeFor', () => {
  it('returns the request tenant under required tenancy', () => {
    const service = new VectorStoreService(recordingAdapter(), collections, 'required');
    expect(service.scopeFor(ctxWithTenant('tenant-a'))).toBe('tenant-a');
  });

  it('throws without a tenant under required tenancy', () => {
    const service = new VectorStoreService(recordingAdapter(), collections, 'required');
    expect(() => service.scopeFor(ctxWithTenant())).toThrow(VectorScopeRequiredError);
  });

  it('refuses a tenant id that is not a valid scope', () => {
    const service = new VectorStoreService(recordingAdapter(), collections, 'required');
    expect(() => service.scopeFor(ctxWithTenant('x'.repeat(65)))).toThrow(VectorScopeInvalidError);
  });

  it('always returns the fixed scope, whatever the tenant', () => {
    const service = new VectorStoreService(recordingAdapter(), collections, { fixed: 'shared' });
    expect(service.scopeFor(ctxWithTenant())).toBe('shared');
    // A tenant whose id equals another value never selects its own rows here.
    expect(service.scopeFor(ctxWithTenant('tenant-a'))).toBe('shared');
  });

  it('refuses an invalid fixed scope', () => {
    expect(() => new VectorStoreService(recordingAdapter(), collections, { fixed: '' })).toThrow(
      VectorScopeInvalidError,
    );
  });
});
