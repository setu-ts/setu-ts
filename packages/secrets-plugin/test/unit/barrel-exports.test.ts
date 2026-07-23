import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as api from '../../src/index.ts';

describe('secrets-plugin barrel exports', () => {
  it('exports every documented value symbol', () => {
    const expected = [
      'SecretsPlugin',
      'SecretsService',
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

  it('SecretsPlugin produces a plugin with the secrets capability', () => {
    const plugin = api.SecretsPlugin();
    expect(plugin.name).toBe('secrets-plugin');
    expect(plugin.provides).toContain('secrets');
  });
});
