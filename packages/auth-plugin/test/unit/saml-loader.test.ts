/**
 * The inject-or-lazy SAML library loader (M100f plan §3.1).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

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
    expect(SAML_SPECIFIER).toBe('npm:@node-saml/node-saml@^5');
  });
});
