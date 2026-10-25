import { expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { Controller, DecoratorPlugin, Get, Inject, Injectable, Optional } from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

it('finding 2: @Optional resolves its dependency from the resolving scope', async () => {
  metadataStore.clear();
  @Injectable({ token: 'request-dep', scope: 'scoped' })
  class RequestDep {}
  @Injectable({ token: 'optional-holder', scope: 'scoped' })
  @Inject(Optional('request-dep'))
  class OptionalHolder {
    constructor(readonly dep?: RequestDep) {}
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      DecoratorPlugin({ services: [RequestDep, OptionalHolder] }),
    ],
  });
  app.router.get('/optional', (ctx) => {
    const root = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    const scope = root.forRequest(ctx);
    return ctx.response.json({
      same: scope.resolve<OptionalHolder>('optional-holder').dep === scope.resolve('request-dep'),
    });
  });
  await app.start();
  try {
    const root = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    const scope = root.createScope();
    const holder = scope.resolve<OptionalHolder>('optional-holder');
    expect(holder.dep).toBe(scope.resolve('request-dep'));
    expect((await app.inject({ method: 'GET', url: '/optional' })).json()).toEqual({ same: true });
  } finally {
    await app.stop();
  }
});

it('registers controllers explicitly as singletons under a scoped container default and aliases class identity', async () => {
  metadataStore.clear();
  let constructions = 0;
  @Controller('/singleton-controller')
  @Injectable({ scope: 'scoped' })
  class Handler {
    constructor() {
      constructions++;
    }
    @Get('/')
    read(): string {
      return 'ok';
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin({ defaultScope: 'scoped' }),
      DecoratorPlugin({ controllers: [Handler], services: [Handler] }),
    ],
  });
  await app.start();
  try {
    const container = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    expect(container.resolve(Handler)).toBe(container.resolve('Handler'));
    expect(container.createScope().resolve(Handler)).toBe(container.resolve(Handler));
    expect(constructions).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/singleton-controller' })).statusCode).toBe(
      200,
    );
  } finally {
    await app.stop();
  }
});

it('fails boot for a captive controller with the Service parameter migration hint', async () => {
  metadataStore.clear();
  @Injectable({ token: 'request', scope: 'scoped' })
  class RequestService {}
  @Controller('/captive')
  @Inject('request')
  class CaptiveController {
    constructor(readonly request: RequestService) {}
    @Get('/')
    read(): string {
      return 'bad';
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      DecoratorPlugin({ services: [RequestService], controllers: [CaptiveController] }),
    ],
  });
  await expect(app.start()).rejects.toThrow(
    /captive: CaptiveController → request.*@Params\(Service/,
  );
});
