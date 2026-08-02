/**
 * The barrel must expose exactly the documented public surface — and must NOT
 * expose the concrete registry, which would commit the package to a class shape
 * when the contract is the interface (AI_GUIDELINES §1.6).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('cloudflare-plugin barrel', () => {
  it('exports every documented runtime value', () => {
    expect(typeof barrel.CloudflarePlugin).toBe('function');
    expect(typeof barrel.KvCacheStore).toBe('function');
    expect(typeof barrel.KvSessionStore).toBe('function');
    expect(typeof barrel.R2Storage).toBe('function');
    expect(typeof barrel.isKvNamespace).toBe('function');
    expect(typeof barrel.isR2Bucket).toBe('function');
    expect(typeof barrel.WorkersQueue).toBe('function');
    expect(typeof barrel.createQueueHandler).toBe('function');
    expect(typeof barrel.WorkersCron).toBe('function');
    expect(typeof barrel.createScheduledHandler).toBe('function');
    expect(typeof barrel.cacheApiMiddleware).toBe('function');
    expect(typeof barrel.assessCacheability).toBe('function');
  });

  it('exports errors that are real Error subclasses with stable names', () => {
    const absent = barrel.CloudflareBindingMissingError.absent('X', ['Y']);
    expect(absent).toBeInstanceOf(Error);
    expect(absent.name).toBe('CloudflareBindingMissingError');

    const unsupported = new barrel.CloudflareUnsupportedError('nope');
    expect(unsupported).toBeInstanceOf(Error);
    expect(unsupported.name).toBe('CloudflareUnsupportedError');

    const missing = new barrel.CloudflareObjectNotFoundError('a.bin');
    expect(missing).toBeInstanceOf(Error);
    expect(missing.name).toBe('CloudflareObjectNotFoundError');
    expect(missing.message).toContain('a.bin');
  });

  it('does not export the internal registry or the envelope codec', () => {
    const names = Object.keys(barrel);
    for (
      const internal of [
        'BindingRegistry',
        'encodeEnvelope',
        'decodeEnvelope',
        'encodeJobEnvelope',
        'isJobEnvelope',
        'runBounded',
        'resolveCacheApi',
      ]
    ) {
      expect(names).not.toContain(internal);
    }
  });
});
