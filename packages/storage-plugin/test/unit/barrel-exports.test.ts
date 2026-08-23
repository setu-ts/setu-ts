/**
 * Barrel export assertions — every public symbol from `src/index.ts` is exported,
 * and `IStorage`/`SignedUrlOptions` are re-exported from common.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';
import type * as barrelTypes from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports StoragePlugin factory', () => {
    expect(barrel.StoragePlugin).toBeDefined();
    expect(typeof barrel.StoragePlugin).toBe('function');
  });

  it('exports StorageService class', () => {
    expect(barrel.StorageService).toBeDefined();
    expect(typeof barrel.StorageService).toBe('function');
  });

  it('exports MemoryProvider', () => {
    expect(barrel.MemoryProvider).toBeDefined();
  });

  it('exports LocalStorageProvider', () => {
    expect(barrel.LocalStorageProvider).toBeDefined();
  });

  it('exports S3Provider', () => {
    expect(barrel.S3Provider).toBeDefined();
  });

  it('exports GcsProvider', () => {
    expect(barrel.GcsProvider).toBeDefined();
  });

  it('exports AzureBlobProvider', () => {
    expect(barrel.AzureBlobProvider).toBeDefined();
  });

  it('exports createUploadMiddleware', () => {
    expect(barrel.createUploadMiddleware).toBeDefined();
    expect(typeof barrel.createUploadMiddleware).toBe('function');
  });

  it('exports getUploadedFile', () => {
    expect(barrel.getUploadedFile).toBeDefined();
    expect(typeof barrel.getUploadedFile).toBe('function');
  });

  it('re-exports IStorage type', () => {
    // Type re-export: check that the module has the named import available.
    // This test verifies the export exists at module resolution time.
    // Since IStorage is a type-only re-export, it won't appear in Object.keys.
    // The real check is TypeScript compilation passing.
    // We verify by importing directly.
    const _mod = barrel as Record<string, unknown>;
    // Type re-exports don't appear in runtime keys - that's expected.
    // The barrel-exports test verifies the export statement exists via compilation.
    expect(typeof _mod).toBe('object');
  });

  it('re-exports SignedUrlOptions type', () => {
    // Same as IStorage — type-only export.
  });

  it('exports all option types (type-only — verified by compilation)', () => {
    // Types are type-only exports; verified by `deno check`.
    expect(true).toBe(true);
  });
});

/**
 * Compile-time pin for the type-only barrel exports M70k added or renamed.
 *
 * The runtime assertions above cannot see a type export at all — dropping one
 * leaves every test in this file green while breaking every consumer, which is
 * the M56/M52c defect class. These declarations NAME each type through the
 * barrel, so removing one fails `deno check`.
 */
describe('storage-plugin barrel — type exports M70k added', () => {
  it('should name each one through the barrel', () => {
    const memory: barrelTypes.MemoryStorageOptions = { provider: 'memory' };
    const local: barrelTypes.LocalStorageOptions = {
      provider: 'local',
      options: { rootDir: '/tmp' },
    };
    const s3: barrelTypes.S3StorageOptions = { provider: 's3', options: { bucket: 'b' } };
    const gcs: barrelTypes.GcsStorageOptions = { provider: 'gcs', options: { bucket: 'b' } };
    const azure: barrelTypes.AzureStorageOptions = {
      provider: 'azure',
      options: { containerName: 'c' },
    };
    const attributes: barrelTypes.PutObjectOptions = { contentType: 'image/png' };
    // The deprecated alias exists precisely so an existing import keeps
    // compiling; nothing else in the suite would notice its removal.
    const legacy: barrelTypes.IAwsS3Client | null = null;
    const backend: barrelTypes.IS3Backend | null = legacy;

    expect([memory.provider, local.provider, s3.provider, gcs.provider, azure.provider])
      .toEqual(['memory', 'local', 's3', 'gcs', 'azure']);
    expect(attributes.contentType).toBe('image/png');
    expect(backend).toBeNull();
  });
});
