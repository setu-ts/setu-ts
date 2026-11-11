/**
 * M139b §3.13: `@Module({ providers })` takes factory entries beside classes.
 * With a real DI container the entry is a container provider a class injects;
 * without one it is built once against the service registry.
 *
 * @module
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createToken } from '@setu-ts/common';
import type { ModuleFactoryProvider } from '@setu-ts/common';
import { DiContainer } from '@setu-ts/di-plugin';

import { Inject, Injectable } from '../../src/decorators/injection.ts';
import { Module } from '../../src/decorators/module.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

interface Greeter {
  greet(name: string): string;
}

const GREETER = createToken<Greeter>('greeter');

beforeEach(() => {
  metadataStore.clear();
});

describe('@Module factory providers with a DI container', () => {
  it('registers the entry under its token, and a class injects it', async () => {
    let built = 0;
    // `@Inject` names string tokens, so a class injects an entry provided under one.
    const greeter: ModuleFactoryProvider<Greeter> = {
      provide: 'greeter',
      useFactory: (prefix: string) => {
        built++;
        return { greet: (name) => `${prefix}, ${name}` };
      },
      inject: ['prefix'],
      scope: 'singleton',
    };

    @Injectable({ token: 'welcome' })
    @Inject('greeter')
    class Welcome {
      constructor(readonly greeter: Greeter) {}
    }

    @Module({ providers: [Welcome, greeter] })
    class FeatureModule {}

    const container = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    container.register('prefix', { useValue: 'hello' });
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);

    expect(container.resolve<Welcome>('welcome').greeter.greet('ada')).toBe('hello, ada');
    expect(container.resolve('greeter')).toBe(container.resolve('greeter'));
    expect(built).toBe(1);
  });

  it('registers an entry under a typed token, which the container resolves', async () => {
    @Module({ providers: [{ provide: GREETER, useFactory: () => ({ greet: () => 'typed' }) }] })
    class FeatureModule {}
    const container = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);
    expect(container.resolve(GREETER).greet('x')).toBe('typed');
  });

  it('keeps a provider already registered under the token (a test override)', async () => {
    const override: Greeter = { greet: () => 'override' };
    @Module({
      providers: [{ provide: GREETER, useFactory: () => ({ greet: () => 'factory' }) }],
    })
    class FeatureModule {}

    const container = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    container.register(GREETER, { useValue: override });
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);
    expect(container.resolve(GREETER)).toBe(override);
  });

  it('passes the scope through, and none when omitted', async () => {
    @Module({
      providers: [
        { provide: 'transient-thing', useFactory: () => ({}), scope: 'transient' },
        { provide: 'default-thing', useFactory: () => ({}) },
      ],
    })
    class FeatureModule {}

    const container = new DiContainer({ defaultScope: 'singleton', autoRegister: false });
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);
    expect(container.resolve('transient-thing')).not.toBe(container.resolve('transient-thing'));
    expect(container.resolve('default-thing')).toBe(container.resolve('default-thing'));
  });
});

describe('@Module factory providers without a container', () => {
  it('builds the entry once from the registry, before the classes that inject it', async () => {
    @Injectable({ token: 'welcome' })
    @Inject('greeter')
    class Welcome {
      constructor(readonly greeter: Greeter) {}
    }

    @Module({
      providers: [
        Welcome,
        {
          provide: 'greeter',
          useFactory: (prefix: string, absent: unknown) => ({
            greet: (name: string) => `${prefix}, ${name}${absent === undefined ? '' : '!'}`,
          }),
          inject: ['prefix', { token: 'absent', optional: true }],
        },
      ],
    })
    class FeatureModule {}

    const { ctx, services } = createFakeContext();
    ctx.services.register('prefix', 'hi' as unknown as object);
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);
    const welcome = services.get('welcome')?.[0] as Welcome;
    expect(welcome.greeter.greet('ada')).toBe('hi, ada');
  });

  it('keeps a value already registered under the token', async () => {
    @Module({ providers: [{ provide: 'greeter', useFactory: () => ({ greet: () => 'factory' }) }] })
    class FeatureModule {}
    const { ctx, services } = createFakeContext();
    const existing = { greet: () => 'existing' };
    ctx.services.register('greeter', existing);
    await DecoratorPlugin({ modules: [FeatureModule] }).register(ctx);
    expect(services.get('greeter')).toEqual([existing]);
  });

  it.each([
    [
      'a typed token as the entry',
      { provide: GREETER, useFactory: () => ({}) },
      "@Module provider 'greeter' is a typed token, which only a DI container resolves; register DiPlugin, or provide it under a string token",
    ],
    [
      'a typed token as a dependency',
      { provide: 'greeter', useFactory: () => ({}), inject: [GREETER] },
      "@Module provider 'greeter' injects a typed token or a class, which only a DI container resolves; register DiPlugin",
    ],
    [
      'a required dependency that is not registered',
      { provide: 'greeter', useFactory: () => ({}), inject: ['missing'] },
      "@Module provider 'greeter' injects 'missing', which is not registered",
    ],
  ])('refuses %s', async (_label, entry, message) => {
    @Module({ providers: [entry as ModuleFactoryProvider] })
    class FeatureModule {}
    const { ctx } = createFakeContext();
    await expect(DecoratorPlugin({ modules: [FeatureModule] }).register(ctx)).rejects.toThrow(
      new TypeError(message),
    );
  });
});
