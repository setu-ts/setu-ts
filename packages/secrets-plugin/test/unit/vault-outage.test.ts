import { describe, expect, it } from 'vitest';
import { HashiCorpVaultProvider } from '../../src/providers/vault.ts';
import { SecretProviderUnavailableError } from '../../src/errors.ts';

describe('Vault 5xx is an outage', () => {
  for (const status of [500, 503, 599, 403, 404]) {
    it(`read/write HTTP ${status}`, async () => {
      const provider = new HashiCorpVaultProvider({
        address: 'http://vault.test',
        token: 'test',
        http: () => Promise.resolve(new Response('', { status })),
      });
      await provider.connect();
      if (status >= 500) {
        await expect(provider.get('k')).rejects.toBeInstanceOf(SecretProviderUnavailableError);
        await expect(provider.set('k', 'v')).rejects.toBeInstanceOf(SecretProviderUnavailableError);
      } else {
        if (status === 404) expect(await provider.get('k')).toBeNull();
        else await expect(provider.get('k')).rejects.toThrow(`HTTP ${status}`);
        const error = await provider.set('k', 'v').catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SecretProviderUnavailableError);
        expect(error).toMatchObject({ message: expect.stringContaining(`HTTP ${status}`) });
      }
      await provider.disconnect();
    });
  }
});
