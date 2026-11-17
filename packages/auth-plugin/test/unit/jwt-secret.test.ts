import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, AuthPluginConfigurationError } from '../../src/index.ts';
import { jwtAlgorithm, resolveJwtSecret, validateJwtSecret } from '../../src/secret/jwt-secret.ts';
import { JwtService } from '../../src/services/jwt-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const LONG = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

describe('JWT_SECRET resolution', () => {
  it('uses the option before the manager, config and environment', async () => {
    const services = createApplication().services;
    services.register(CAPABILITIES.SECRETS, {
      get: () => {
        throw new Error('must not read');
      },
      has: () => Promise.resolve(true),
      rotate: async () => {},
    });
    expect(await resolveJwtSecret({ secret: LONG }, services, { JWT_SECRET: OTHER })).toBe(LONG);
  });

  it.each(['secret', 'config', 'env'] as const)(
    'uses %s at its precedence step',
    async (source) => {
      const services = createApplication().services;
      if (source === 'secret')
        services.register(CAPABILITIES.SECRETS, {
          get: () => Promise.resolve(LONG),
          has: () => Promise.resolve(true),
          rotate: async () => {},
        });
      if (source !== 'env')
        services.register(CAPABILITIES.CONFIG, {
          get: <T>() => (source === 'config' ? LONG : OTHER) as T,
          getOrThrow: <T>() => LONG as T,
          has: () => true,
        });
      expect(
        await resolveJwtSecret({}, services, { JWT_SECRET: source === 'env' ? LONG : OTHER }),
      ).toBe(LONG);
    },
  );

  it.each(['empty', 'throws'] as const)('falls through an %s manager to config', async (mode) => {
    const services = createApplication().services;
    services.register(CAPABILITIES.SECRETS, {
      get: () => {
        if (mode === 'throws') throw new Error('absent');
        return Promise.resolve('');
      },
      has: () => Promise.resolve(false),
      rotate: async () => {},
    });
    services.register(CAPABILITIES.CONFIG, {
      get: <T>() => LONG as T,
      getOrThrow: <T>() => LONG as T,
      has: () => true,
    });
    expect(await resolveJwtSecret({}, services, {})).toBe(LONG);
  });

  it.each(['', 42, undefined])('falls through absent/non-string config %s', async (value) => {
    const services = createApplication().services;
    services.register(CAPABILITIES.CONFIG, {
      get: <T>() => value as T,
      getOrThrow: <T>() => value as T,
      has: () => value !== undefined,
    });
    expect(await resolveJwtSecret({}, services, { JWT_SECRET: LONG })).toBe(LONG);
  });

  it('never looks up a secret for RS256 keys or an explicit RS256 algorithm', async () => {
    const services = createApplication().services;
    expect(
      await resolveJwtSecret({ privateKey: 'private', publicKey: 'public' }, services, {}),
    ).toBeUndefined();
    expect(
      await resolveJwtSecret(
        { algorithm: 'RS256', privateKey: 'private', publicKey: 'public', secret: 'unused' },
        services,
        {},
      ),
    ).toBeUndefined();
  });

  it.each([
    [{ secret: LONG, privateKey: 'private', publicKey: 'public' }, 'HS256'],
    [{ privateKey: 'private', publicKey: 'public' }, 'RS256'],
    [{ privateKey: 'private' }, 'RS256'],
    [{ publicKey: 'public' }, 'RS256'],
    [{}, 'HS256'],
    [{ algorithm: 'RS256' as const, secret: LONG }, 'RS256'],
  ])(
    'infers the algorithm with an explicit secret winning over key material (%o)',
    (options, expected) => {
      expect(jwtAlgorithm(options)).toBe(expected);
    },
  );

  it('refuses a lone RS256 key rather than falling back to JWT_SECRET', () => {
    expect(() =>
      resolveJwtSecret({ privateKey: 'private' }, createApplication().services, {
        JWT_SECRET: LONG,
      }),
    ).toThrow(/RS256 requires both/);
  });

  it.each([{}, { privateKey: 'private' }, { publicKey: 'public' }])(
    'refuses incomplete explicit RS256 keys without falling back to JWT_SECRET',
    (keys) => {
      expect(() =>
        resolveJwtSecret({ algorithm: 'RS256', ...keys }, createApplication().services, {
          JWT_SECRET: LONG,
        }),
      ).toThrow(AuthPluginConfigurationError);
    },
  );

  it.each([undefined, '', 'x'.repeat(31), new Uint8Array(31)])(
    'refuses missing and short keys',
    (secret) => {
      expect(() => validateJwtSecret(secret)).toThrow(AuthPluginConfigurationError);
      expect(() => validateJwtSecret(secret)).toThrow(/JWT_SECRET.*32 bytes.*RFC 7518/);
      expect(
        () =>
          new JwtService(createFakeRuntime(), {
            algorithm: 'HS256',
            ...(secret === undefined ? {} : { secret }),
          }),
      ).toThrow(AuthPluginConfigurationError);
    },
  );

  it.each([LONG, new Uint8Array(32), 'é'.repeat(16)])(
    'accepts exactly 32 UTF-8 or raw bytes',
    (secret) => {
      expect(validateJwtSecret(secret)).toBe(secret);
      expect(
        () => new JwtService(createFakeRuntime(), { algorithm: 'HS256', secret }),
      ).not.toThrow();
    },
  );

  it.each(['config', 'secrets'] as const)(
    'orders after %s, then signs through the resolved key',
    async (source) => {
      const auth = AuthPlugin({ jwt: {} });
      expect(auth.optionalDependencies).toEqual(
        expect.arrayContaining([CAPABILITIES.CONFIG, CAPABILITIES.SECRETS]),
      );
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          auth,
          {
            name: 'test-config',
            version: '1',
            provides: [source === 'config' ? CAPABILITIES.CONFIG : CAPABILITIES.SECRETS],
            register(ctx) {
              if (source === 'config') {
                ctx.services.register(CAPABILITIES.CONFIG, {
                  get: <T>() => LONG as T,
                  getOrThrow: <T>() => LONG as T,
                  has: () => true,
                });
              } else {
                ctx.services.register(CAPABILITIES.SECRETS, {
                  get: () => Promise.resolve(LONG),
                  has: () => Promise.resolve(true),
                  rotate: async () => {},
                });
              }
            },
          },
        ],
      });
      try {
        await app.start();
        const jwt = app.services.get(CAPABILITIES.JWT);
        const token = await jwt.sign({ sub: 'alice' });
        expect(await jwt.verify(token)).toMatchObject({ sub: 'alice' });
      } finally {
        await app.stop();
      }
    },
  );

  it('AuthPlugin refuses a short option at registration', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), AuthPlugin({ jwt: { secret: 'x'.repeat(31) } })],
    });
    try {
      await expect(app.start()).rejects.toThrow(/JWT_SECRET/);
    } finally {
      await app.stop();
    }
  });
});
