/**
 * Real-kernel interop between `DiPlugin` and `DecoratorPlugin`.
 *
 * The fake-container tests in `decorator-plugin.test.ts` prove the provider
 * shape this plugin builds; they cannot prove that the real container resolves
 * it, nor that `ctx.container` is populated by the time this plugin's
 * `register()` runs. That ordering is a consequence of two priorities declared
 * in different packages (`DiPlugin` at NORMAL, `DecoratorPlugin` at LOW), so it
 * is guarded here rather than assumed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { DiPlugin } from '@hono-enterprise/di-plugin';

import { Controller, Get, Inject, Injectable } from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

describe('DecoratorPlugin ↔ DiPlugin interop (real kernel)', () => {
  it('resolves a parameter-injected service through the real container', async () => {
    metadataStore.clear();

    @Injectable({ token: 'greeting-source' })
    class GreetingSource {
      readonly text = 'hello from the container';
    }

    @Injectable({ token: 'greeting-service' })
    class GreetingService {
      constructor(@Inject('greeting-source') readonly source: GreetingSource) {}

      greet(): string {
        return this.source.text;
      }
    }

    @Controller('/greet')
    class GreetingController {
      constructor(@Inject('greeting-service') readonly service: GreetingService) {}

      @Get('/')
      greet(): { message: string } {
        return { message: this.service.greet() };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        DecoratorPlugin({
          services: [GreetingSource, GreetingService],
          controllers: [GreetingController],
        }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/greet' });

    expect(response.statusCode).toBe(200);
    // Proves the whole chain: container-resolved source → service → controller.
    expect(JSON.parse(response.body as string)).toEqual({
      message: 'hello from the container',
    });
  });

  it('serves the same composition through the registry when DiPlugin is absent', async () => {
    metadataStore.clear();

    @Injectable({ token: 'registry-source' })
    class RegistrySource {
      readonly text = 'hello from the registry';
    }

    @Controller('/registry')
    class RegistryController {
      constructor(@Inject('registry-source') readonly source: RegistrySource) {}

      @Get('/')
      read(): { message: string } {
        return { message: this.source.text };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({
          services: [RegistrySource],
          controllers: [RegistryController],
        }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/registry' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({
      message: 'hello from the registry',
    });
  });

  it('honors @Injectable scope through the real container', async () => {
    metadataStore.clear();

    let constructed = 0;

    @Injectable({ token: 'counter', scope: 'transient' })
    class Counter {
      constructor() {
        constructed += 1;
      }
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ services: [Counter] })],
    });

    await app.start();

    const container = app.services.get<{ resolve<T>(token: string): T }>('di-container');
    container.resolve<Counter>('counter');
    container.resolve<Counter>('counter');

    // A transient provider constructs per resolve; a singleton would report 1.
    expect(constructed).toBe(2);
  });
});
