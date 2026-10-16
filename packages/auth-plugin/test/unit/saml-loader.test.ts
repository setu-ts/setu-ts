/**
 * The inject-or-lazy SAML library loader (M100f plan §3.1).
 */
import { describe, expect, it, vi } from 'vitest';

import { adaptSamlModule, loadSaml, SAML_SPECIFIER } from '../../src/saml/loader.ts';
import { SamlRuntimeLoadError } from '../../src/errors.ts';

class FakeSaml {}

describe('SAML loader', () => {
  it('uses an injected module without importing', async () => {
    let imported = false;
    const SAML = await loadSaml({ SAML: FakeSaml }, () => {
      imported = true;
      return Promise.resolve({});
    });
    expect(SAML).toBe(FakeSaml);
    expect(imported).toBe(false);
  });

  it('uses the importer when nothing is injected', async () => {
    expect(await loadSaml(undefined, () => Promise.resolve({ SAML: FakeSaml }))).toBe(FakeSaml);
  });

  it('turns a failed import into SamlRuntimeLoadError naming the specifier and nodejs_compat', async () => {
    const cause = new Error('Could not resolve "crypto"');
    const error = await loadSaml(undefined, () => Promise.reject(cause)).catch((e) => e);
    expect(error).toBeInstanceOf(SamlRuntimeLoadError);
    expect(error.name).toBe('SamlRuntimeLoadError');
    expect(error.message).toContain(SAML_SPECIFIER);
    expect(error.message).toContain('nodejs_compat');
    expect(error.cause).toBe(cause);
  });

  it('refuses a module with no SAML constructor', () => {
    for (const module of [{}, { SAML: 'x' }, null, 'mod']) {
      expect(() => adaptSamlModule(module)).toThrow(SamlRuntimeLoadError);
    }
  });

  it('builds an error without a cause', () => {
    const error = new SamlRuntimeLoadError(SAML_SPECIFIER);
    expect(error.cause).toBeUndefined();
  });

  it('names the real specifier', () => {
    expect(SAML_SPECIFIER).toBe('@node-saml/node-saml');
  });
});

describe('importSamlModule — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { importSamlModule, loadSaml } = await import('../../src/saml/loader.ts');
    vi.doMock('@node-saml/node-saml', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await importSamlModule();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@node-saml/node-saml');
      expect(loadError.cause).toBeInstanceOf(Error);

      // The named wrapper keeps it as the cause.
      let wrapped: unknown;
      try {
        await loadSaml(undefined);
      } catch (error) {
        wrapped = error;
      }
      expect((wrapped as Error).name).toBe('SamlRuntimeLoadError');
      expect(((wrapped as Error & { cause: Error }).cause as Error).name).toBe(
        'OptionalDependencyUnavailableError',
      );
    } finally {
      vi.doUnmock('@node-saml/node-saml');
    }
  });
});
