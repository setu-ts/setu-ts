import { expect, expectTypeOf, it } from 'vitest';
import { CAPABILITIES, createToken } from '@setu-ts/common';
import type { IContainer, IRequestContext } from '@setu-ts/common';
import { createContainer, DiPlugin } from '@setu-ts/di-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  Controller,
  Ctx,
  Custom,
  DecoratorPlugin,
  Get,
  Params,
  resolveParameters,
  Service,
} from '../../src/index.ts';
import type { ParamSource } from '../../src/index.ts';
import { findUnresolvableParameters } from '../../src/resolvers/parameter-resolver.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeRequestContext } from '../fixtures/fake-request-context.ts';

it('brands Service descriptors and classifies container availability without accepting a name collision', () => {
  const token = createToken<number>('value');
  const source = Service(token);
  expectTypeOf(source).toEqualTypeOf<ParamSource<number>>();
  expect(source.descriptor).toMatchObject({
    type: 'custom',
    customType: 'service',
    metadata: { token },
  });
  const param = { index: 0, ...source.descriptor };
  expect(findUnresolvableParameters([param], true)).toEqual([]);
  expect(findUnresolvableParameters([param], false)).toEqual([param]);
  const collision = { index: 0, ...Custom('service').descriptor };
  expect(findUnresolvableParameters([collision])).toEqual([collision]);
});

it('public resolveParameters uses forRequest and preserves a typed token', async () => {
  const token = createToken<{ id: number }>('request');
  const container = createContainer();
  container.register(token, { useFactory: () => ({ id: 7 }) }, { scope: 'scoped' });
  const base = createFakeRequestContext();
  const ctx: IRequestContext = {
    ...base,
    defer: () => {},
    services: {
      ...base.services,
      get<T extends object>(key: string): T {
        expect(key).toBe(CAPABILITIES.DI_CONTAINER);
        return container as unknown as T;
      },
    },
  };
  const args = await resolveParameters(ctx, [{ index: 0, ...Service(token).descriptor }]);
  expect(args).toEqual([{ id: 7 }]);
  expect(args[0]).toBe(container.forRequest(ctx).resolve(token));
});

it('the decorated wrapper and public resolver use the identical request scope under a scoped default', async () => {
  metadataStore.clear();
  const token = createToken<{ id: string }>('request');
  @Controller('/service')
  class Handler {
    @Get('/')
    @Params(Service(token), Ctx())
    read(service: { id: string }, ctx: IRequestContext): { id: string } {
      expect(service).toBe(ctx.state.get('expected'));
      return service;
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin({ defaultScope: 'scoped' }),
      {
        name: 'services',
        version: '1.0.0',
        dependencies: [CAPABILITIES.DI_CONTAINER],
        register(ctx) {
          ctx.container!.register(token, { useFactory: () => ({ id: ctx.runtime.uuid() }) });
          ctx.lifecycle.onRequest(async (request) => {
            const args = await resolveParameters(request, [
              { index: 0, ...Service(token).descriptor },
            ]);
            request.state.set('expected', args[0]);
            const scope = request.services
              .get<IContainer>(CAPABILITIES.DI_CONTAINER)
              .forRequest(request);
            expect(args[0]).toBe(scope.resolve(token));
          });
        },
      },
      DecoratorPlugin({ controllers: [Handler] }),
    ],
  });
  await app.start();
  try {
    const first = await app.inject({ method: 'GET', url: '/service' });
    const second = await app.inject({ method: 'GET', url: '/service' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).not.toBe(second.json<{ id: string }>().id);
  } finally {
    await app.stop();
  }
});
