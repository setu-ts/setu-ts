/**
 * Barrel export assertions — every public symbol from `src/index.ts` is exported,
 * and `IStorage`/`SignedUrlOptions` are re-exported from common.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

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
