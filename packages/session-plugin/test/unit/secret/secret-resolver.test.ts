/**
 * Unit tests for secret resolution.
 *
 * Every branch is driven, including a secrets manager that THROWS — that is the
 * real shape of a missing secret, since `ISecretManager.get` rejects rather than
 * returning null, and it is the branch the environment fallback depends on.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ISecretManager } from '@hono-enterprise/common';

import { SessionSecretMissingError } from '../../../src/errors.ts';
import { MIN_SECRET_LENGTH, resolveSecrets } from '../../../src/secret/secret-resolver.ts';
import { FakeRegistry } from '../../fixtures/context.ts';

const LONG = 'a'.repeat(MIN_SECRET_LENGTH);
const OTHER = 'b'.repeat(MIN_SECRET_LENGTH);

/** A secret manager whose behaviour per name is scripted. */
function manager(values: Record<string, string | Error>): ISecretManager {
  return {
    get: (name: string) => {
      const value = values[name];
      if (value === undefined) {
        return Promise.reject(new Error(`no secret '${name}'`));
      }
      if (value instanceof Error) {
        return Promise.reject(value);
      }
      return Promise.resolve(value);
    },
    has: (name: string) => Promise.resolve(typeof values[name] === 'string'),
    rotate: () => Promise.resolve(),
  };
}

describe('resolveSecrets', () => {
  it('prefers an explicit string secret over everything else', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({ SESSION_SECRET: OTHER }));

    const secrets = await resolveSecrets({ secret: LONG }, {
      services: registry,
      env: { SESSION_SECRET: OTHER },
    });

    expect(secrets).toEqual([LONG]);
  });

  it('accepts an explicit rotation list in order', async () => {
    const secrets = await resolveSecrets({ secret: [LONG, OTHER] }, {
      services: new FakeRegistry(),
      env: {},
    });
    expect(secrets).toEqual([LONG, OTHER]);
  });

  it('reads from the secrets manager when no explicit secret is given', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({ SESSION_SECRET: LONG }));

    const secrets = await resolveSecrets({}, { services: registry, env: {} });
    expect(secrets).toEqual([LONG]);
  });

  it('honours a custom secret name', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({ 'app/session': LONG }));

    const secrets = await resolveSecrets({ secretName: 'app/session' }, {
      services: registry,
      env: {},
    });
    expect(secrets).toEqual([LONG]);
  });

  it('falls back to the environment when the manager THROWS', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({}));

    // The branch that makes a dev machine work against a production provider.
    const secrets = await resolveSecrets({}, {
      services: registry,
      env: { SESSION_SECRET: LONG },
    });
    expect(secrets).toEqual([LONG]);
  });

  it('falls back to the environment when the manager returns an empty string', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({ SESSION_SECRET: '' }));

    const secrets = await resolveSecrets({}, {
      services: registry,
      env: { SESSION_SECRET: LONG },
    });
    expect(secrets).toEqual([LONG]);
  });

  it('reads the environment when no secrets capability is registered', async () => {
    const secrets = await resolveSecrets({}, {
      services: new FakeRegistry(),
      env: { SESSION_SECRET: LONG },
    });
    expect(secrets).toEqual([LONG]);
  });

  it('splits a comma-separated environment value into a rotation list', async () => {
    const secrets = await resolveSecrets({}, {
      services: new FakeRegistry(),
      env: { SESSION_SECRET: `${LONG}, ${OTHER}` },
    });
    expect(secrets).toEqual([LONG, OTHER]);
  });

  it('ignores empty entries in a comma-separated value', async () => {
    const secrets = await resolveSecrets({}, {
      services: new FakeRegistry(),
      env: { SESSION_SECRET: `${LONG},,` },
    });
    expect(secrets).toEqual([LONG]);
  });

  it('throws when nothing supplies a secret', async () => {
    await expect(
      resolveSecrets({}, { services: new FakeRegistry(), env: {} }),
    ).rejects.toThrow(SessionSecretMissingError);
  });

  it('treats an empty environment value as absent', async () => {
    await expect(
      resolveSecrets({}, { services: new FakeRegistry(), env: { SESSION_SECRET: '' } }),
    ).rejects.toThrow(SessionSecretMissingError);
  });

  it('names the variable it looked for', async () => {
    await expect(
      resolveSecrets({ secretName: 'MY_SECRET' }, { services: new FakeRegistry(), env: {} }),
    ).rejects.toThrow('MY_SECRET');
  });

  it('rejects a secret shorter than the minimum', async () => {
    await expect(
      resolveSecrets({ secret: 'too-short' }, { services: new FakeRegistry(), env: {} }),
    ).rejects.toThrow(SessionSecretMissingError);
  });

  it('reports which entry of a rotation list is too short', async () => {
    await expect(
      resolveSecrets({ secret: [LONG, 'nope'] }, { services: new FakeRegistry(), env: {} }),
    ).rejects.toThrow('index 1');
  });

  it('rejects a short secret from the environment', async () => {
    await expect(
      resolveSecrets({}, { services: new FakeRegistry(), env: { SESSION_SECRET: 'short' } }),
    ).rejects.toThrow('environment variable SESSION_SECRET');
  });

  it('rejects a short secret from the secrets manager', async () => {
    const registry = new FakeRegistry();
    registry.register(CAPABILITIES.SECRETS, manager({ SESSION_SECRET: 'short' }));

    await expect(
      resolveSecrets({}, { services: registry, env: {} }),
    ).rejects.toThrow('secrets manager');
  });

  it('rejects an empty explicit list', async () => {
    await expect(
      resolveSecrets({ secret: [] }, { services: new FakeRegistry(), env: {} }),
    ).rejects.toThrow('empty secret list');
  });

  it('accepts a secret exactly at the minimum length', async () => {
    const secrets = await resolveSecrets({ secret: 'x'.repeat(MIN_SECRET_LENGTH) }, {
      services: new FakeRegistry(),
      env: {},
    });
    expect(secrets.length).toBe(1);
  });
});
