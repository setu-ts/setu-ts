import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf } from '@setu-ts/common';

import * as api from '../../src/index.ts';

describe('secrets-plugin barrel exports', () => {
  it('exports every documented value symbol', () => {
    const expected = [
      'SecretsPlugin',
      'SecretsService',
      'ReadOnlySecretProviderError',
      'EnvProvider',
      'AwsKmsProvider',
      'GcpSecretManagerProvider',
      'AzureKeyVaultProvider',
      'HashiCorpVaultProvider',
    ] as const;
    for (const name of expected) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    }
  });

  // X20-2 (M90f): the package's one error class is public surface — an
  // application's catch reaches it from the barrel, and dropping the
  // re-export leaves the provider's own tests green (the M56 defect class).
  it('exports ReadOnlySecretProviderError, branded 501', () => {
    const error = new api.ReadOnlySecretProviderError('EnvProvider');
    expect(error.name).toBe('ReadOnlySecretProviderError');
    expect(error.provider).toBe('EnvProvider');
    expect(httpStatusHintOf(error)?.status).toBe(501);
  });

  it('SecretsPlugin produces a plugin with the secrets capability', () => {
    const plugin = api.SecretsPlugin();
    expect(plugin.name).toBe('secrets-plugin');
    expect(plugin.provides).toContain('secrets');
  });
});
