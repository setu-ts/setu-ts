import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ISecretManager } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

import { SecretsPlugin } from '../../src/index.ts';

describe('Secrets integration (through a real kernel app)', () => {
  it('resolves ISecretManager and reads an env secret back through the public surface', async () => {
    // runtime.env snapshots the process env at RuntimePlugin registration, so set
    // the variable before start(). Test files are the sanctioned env exception.
    Deno.env.set('INTEGRATION_DB_PASSWORD', 's3cret');
    try {
      const app = createApplication({
        plugins: [RuntimePlugin(), SecretsPlugin()],
      });
      await app.start();

      expect(app.services.has('secrets')).toBe(true);
      const secrets = app.services.get<ISecretManager>('secrets');

      expect(await secrets.get('integration/db/password')).toBe('s3cret');
      expect(await secrets.has('integration/db/password')).toBe(true);
      expect(await secrets.has('nope')).toBe(false);
      await expect(secrets.get('nope')).rejects.toThrow('Secret not found');

      // The env provider is read-only: rotate surfaces the documented throw.
      await expect(secrets.rotate('integration/db/password', 'x')).rejects.toThrow(
        'read-only',
      );

      await app.stop();
    } finally {
      Deno.env.delete('INTEGRATION_DB_PASSWORD');
    }
  });

  it('supports an injected cloud client end-to-end (aws-kms)', async () => {
    const store = new Map<string, string>([['api/key', 'v1']]);
    const client = {
      getSecretValue: (id: string): Promise<string | null> =>
        Promise.resolve(store.get(id) ?? null),
      putSecretValue: (id: string, value: string): Promise<void> => {
        store.set(id, value);
        return Promise.resolve();
      },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        SecretsPlugin({ provider: 'aws-kms', options: { client, cacheTtl: 0 } }),
      ],
    });
    await app.start();

    const secrets = app.services.get<ISecretManager>('secrets');
    expect(await secrets.get('api/key')).toBe('v1');

    // Rotate writes through the provider; read it back through the same surface.
    await secrets.rotate('api/key', 'v2');
    expect(await secrets.get('api/key')).toBe('v2');
    expect(store.get('api/key')).toBe('v2');

    await app.stop();
  });
});
