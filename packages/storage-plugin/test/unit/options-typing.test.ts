/**
 * Type-level tests for X8-11 — the storage options naming their bad key.
 *
 * Before `StoragePluginOptions` was discriminated, adding ONE unsupported key
 * to an otherwise valid literal made the compiler report EVERY property as
 * `Type 'string' is not assignable to type 'never'` and never named the
 * offending one: the union's first member was `MemoryProviderOptions =
 * Record<string, never>`, which accepts any object shape while requiring every
 * property to be `never`, so a literal matching no other member bound to it.
 * That read as "the plugin's options are untypeable" and cost real time.
 *
 * The assertions here are the COMPILATION itself — `deno check` covers `test/`,
 * so a `@ts-expect-error` that stops being an error fails the gate. The runtime
 * bodies exist only to give each case a home.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { StoragePlugin } from '../../src/plugin/storage-plugin.ts';
import type { StoragePluginOptions } from '../../src/interfaces/index.ts';

describe('StoragePluginOptions — discriminated on provider (X8-11)', () => {
  it('should accept every documented arm', () => {
    const configurations: readonly StoragePluginOptions[] = [
      {},
      { provider: 'memory' },
      { provider: 'local', options: { rootDir: '/data' } },
      { provider: 's3', options: { bucket: 'b', region: 'us-east-1' } },
      { provider: 'b2', options: { bucket: 'b' } },
      { provider: 'gcs', options: { bucket: 'b' } },
      { provider: 'azure', options: { containerName: 'c' } },
    ];
    expect(configurations).toHaveLength(7);
  });

  it('should reject an unknown option key, naming that key', () => {
    const configuration: StoragePluginOptions = {
      provider: 's3',
      options: {
        bucket: 'uploads',
        region: 'us-east-1',
        // The whole point of the fix: exactly ONE error, on THIS property,
        // rather than three errors blaming `bucket` and `region` as well.
        // @ts-expect-error forcePathStyle is not an S3 provider option
        forcePathStyle: true,
      },
    };
    expect(configuration.provider).toBe('s3');
  });

  it('should require bucket under the s3 arm', () => {
    const configuration: StoragePluginOptions = {
      provider: 's3',
      // @ts-expect-error the s3 arm requires `options.bucket`
      options: { region: 'us-east-1' },
    };
    expect(configuration.provider).toBe('s3');
  });

  it('should require containerName under the azure arm', () => {
    const configuration: StoragePluginOptions = {
      provider: 'azure',
      // @ts-expect-error the azure arm requires `options.containerName`
      options: { accountName: 'a' },
    };
    expect(configuration.provider).toBe('azure');
  });

  it('should require options at all under an arm that needs them', () => {
    // @ts-expect-error the gcs arm requires `options`
    const configuration: StoragePluginOptions = { provider: 'gcs' };
    expect(configuration.provider).toBe('gcs');
  });

  it('should reject an option belonging to a DIFFERENT provider arm', () => {
    const configuration: StoragePluginOptions = {
      provider: 'local',
      // @ts-expect-error `bucket` is an S3 option, not a local one
      options: { rootDir: '/data', bucket: 'b' },
    };
    expect(configuration.provider).toBe('local');
  });

  it('should keep the bare factory call compiling (memory stays the default)', () => {
    expect(StoragePlugin().name).toBe('storage-plugin');
    expect(StoragePlugin({}).name).toBe('storage-plugin');
  });
});
