/**
 * The vector-store contract in common: the token, the eight named errors with
 * their status hints, and the tenant-separated record key.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  createCapabilityToken,
  httpStatusHintOf,
  vectorRecordKey,
  VectorCollectionMismatchError,
  VectorCollectionUnknownError,
  VectorDimensionError,
  VectorFilterError,
  VectorOperationUnsupportedError,
  VectorRecordError,
  VectorScopeInvalidError,
  VectorScopeRequiredError,
  VectorVersionConflictError,
} from '../../src/index.ts';
import type {
  IVectorStore,
  IVectorStoreAdapter,
  VectorCollectionSpec,
  VectorFilter,
  VectorMatch,
} from '../../src/index.ts';

describe('vector-store contract', () => {
  it('names the capability with a token the grammar accepts', () => {
    expect(CAPABILITIES.VECTOR_STORE).toBe('vector-store');
    expect(createCapabilityToken(CAPABILITIES.VECTOR_STORE)).toBe('vector-store');
  });

  it('brands caller errors 400 and serves a detail that never echoes the message', () => {
    for (const error of [
      new VectorScopeRequiredError(),
      new VectorScopeInvalidError('scope is longer than 64 bytes: tenant-secret'),
      new VectorFilterError("filter field 'secret-value' is not declared"),
      new VectorDimensionError('vector has 3 components, expected 4'),
      new VectorRecordError('record id is longer than 256 bytes'),
    ]) {
      const hint = httpStatusHintOf(error);
      expect(hint?.status, error.name).toBe(400);
      expect(hint?.detail).not.toContain('secret');
      expect(error).toBeInstanceOf(Error);
    }
    expect(new VectorScopeRequiredError().message).toBe(
      'A tenant is required to use the vector store.',
    );
  });

  it('brands configuration and backend refusals with their own statuses', () => {
    const unknown = new VectorCollectionUnknownError('missing');
    expect(unknown.name).toBe('VectorCollectionUnknownError');
    expect(unknown.message).toContain("'missing'");
    expect(httpStatusHintOf(unknown)?.status).toBe(500);
    expect(httpStatusHintOf(unknown)?.detail).not.toContain('missing');

    const unsupported = new VectorOperationUnsupportedError('vectorize cannot delete a scope');
    expect(unsupported.name).toBe('VectorOperationUnsupportedError');
    expect(httpStatusHintOf(unsupported)?.status).toBe(501);

    const conflict = new VectorVersionConflictError('memory: version 1 is older than 2');
    expect(conflict.name).toBe('VectorVersionConflictError');
    expect(httpStatusHintOf(conflict)).toMatchObject({ status: 409, title: 'Conflict' });
    // The served detail never echoes the versions or the source.
    expect(httpStatusHintOf(conflict)?.detail).toBe(
      'A newer version of this source is already stored.',
    );

    const mismatch = new VectorCollectionMismatchError(
      'documents has 768 dimensions, declared 1024',
    );
    expect(mismatch.name).toBe('VectorCollectionMismatchError');
    // A startup refusal, never served, so it carries no HTTP hint.
    expect(httpStatusHintOf(mismatch)).toBeUndefined();
  });

  it('keeps the data types assignable to the documented shapes', () => {
    const spec: VectorCollectionSpec = {
      name: 'documents',
      dimensions: 3,
      filterable: { tag: 'string', year: 'number', public: 'boolean' },
    };
    const filter: VectorFilter = {
      and: [
        { field: 'tag', op: 'in', value: ['a', 'b'] },
        { field: 'year', op: 'gte', value: 2020 },
        { field: 'public', op: 'eq', value: true },
      ],
    };
    const match: VectorMatch = { id: 'r1', score: 0.5, metadata: { tag: 'a' } };
    const scopes: Pick<IVectorStore, 'scopeFor'> = { scopeFor: () => 'tenant-a' };
    const adapter: Pick<IVectorStoreAdapter, 'name'> = { name: 'memory' };
    expect([
      spec.name,
      'and' in filter,
      match.id,
      scopes.scopeFor({} as never),
      adapter.name,
    ]).toEqual(['documents', true, 'r1', 'tenant-a', 'memory']);
  });
});

describe('vectorRecordKey', () => {
  const subtle = globalThis.crypto.subtle;

  it('returns a deterministic 64-character lowercase hex digest', async () => {
    const key = await vectorRecordKey(subtle, 'tenant-a', 'doc-1#0');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await vectorRecordKey(subtle, 'tenant-a', 'doc-1#0')).toBe(key);
  });

  it('separates scopes for the same id', async () => {
    expect(await vectorRecordKey(subtle, 'tenant-a', 'doc')).not.toBe(
      await vectorRecordKey(subtle, 'tenant-b', 'doc'),
    );
  });

  it('length-prefixes each part, so no split of the same characters collides', async () => {
    // Joined with a plain separator, both pairs would hash `a|1|b`.
    expect(await vectorRecordKey(subtle, 'a|1', 'b')).not.toBe(
      await vectorRecordKey(subtle, 'a', '1|b'),
    );
    expect(await vectorRecordKey(subtle, 'ab', 'c')).not.toBe(
      await vectorRecordKey(subtle, 'a', 'bc'),
    );
  });
});
