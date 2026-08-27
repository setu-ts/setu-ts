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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';

import { Controller, Get, Inject, Injectable, Optional } from '../../src/index.ts';
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
    @Inject('greeting-source')
    class GreetingService {
      constructor(readonly source: GreetingSource) {}

      greet(): string {
        return this.source.text;
      }
    }

    @Controller('/greet')
    @Inject('greeting-service')
    class GreetingController {
      constructor(readonly service: GreetingService) {}

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
    @Inject('registry-source')
    class RegistryController {
      constructor(readonly source: RegistrySource) {}

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

describe('@Optional injection (real container and real registry)', () => {
  it('injects undefined for an absent optional token via the real container', async () => {
    metadataStore.clear();

    @Injectable({ token: 'present-dep' })
    class PresentDep {
      readonly text = 'present';
    }

    @Controller('/optional-di')
    @Inject('present-dep', Optional('never-registered'))
    class OptionalController {
      constructor(readonly present: PresentDep, readonly missing?: { text: string }) {}

      @Get('/')
      read(): { present: string; missing: string | null } {
        return { present: this.present.text, missing: this.missing?.text ?? null };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        DecoratorPlugin({ services: [PresentDep], controllers: [OptionalController] }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/optional-di' });

    expect(response.statusCode).toBe(200);
    // Without @Optional the container throws "No provider registered" and the
    // app never serves this route at all.
    expect(JSON.parse(response.body as string)).toEqual({ present: 'present', missing: null });
  });

  it('injects the real instance when an optional token IS provided', async () => {
    metadataStore.clear();

    @Injectable({ token: 'sometimes-dep' })
    class SometimesDep {
      readonly text = 'supplied';
    }

    @Controller('/optional-supplied')
    @Inject(Optional('sometimes-dep'))
    class SuppliedController {
      constructor(readonly dep?: SometimesDep) {}

      @Get('/')
      read(): { value: string | null } {
        return { value: this.dep?.text ?? null };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        DecoratorPlugin({ services: [SometimesDep], controllers: [SuppliedController] }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/optional-supplied' });

    expect(JSON.parse(response.body as string)).toEqual({ value: 'supplied' });
  });

  it('honors @Optional identically on the registry path, with DiPlugin absent', async () => {
    metadataStore.clear();

    @Injectable({ token: 'registry-present' })
    class RegistryPresent {
      readonly text = 'present';
    }

    @Controller('/optional-registry')
    @Inject('registry-present', Optional('registry-absent'))
    class RegistryOptionalController {
      constructor(readonly present: RegistryPresent, readonly missing?: { text: string }) {}

      @Get('/')
      read(): { present: string; missing: string | null } {
        return { present: this.present.text, missing: this.missing?.text ?? null };
      }
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DecoratorPlugin({
          services: [RegistryPresent],
          controllers: [RegistryOptionalController],
        }),
      ],
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/optional-registry' });

    expect(response.statusCode).toBe(200);
    // Same assertion as the container case: one capability, both entry points.
    expect(JSON.parse(response.body as string)).toEqual({ present: 'present', missing: null });
  });

  it('propagates a construction error instead of masking it as absence', async () => {
    metadataStore.clear();

    @Injectable({ token: 'exploding-dep' })
    class ExplodingDep {
      constructor() {
        throw new Error('dependency blew up during construction');
      }
    }

    @Injectable({ token: 'holder' })
    @Inject(Optional('exploding-dep'))
    class Holder {
      constructor(readonly dep?: ExplodingDep) {}
    }

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        DecoratorPlugin({ services: [ExplodingDep, Holder] }),
      ],
    });

    await app.start();
    const container = app.services.get<{ resolve<T>(token: string): T }>('di-container');

    // @Optional means "absent", not "construction may fail" — a registered
    // token that throws while building must surface, not become undefined.
    expect(() => container.resolve<Holder>('holder')).toThrow(/blew up during construction/);
  });

  it('refuses an optional index the @Inject list does not name', () => {
    // Optional(token) sits in the position of the argument it describes, so it
    // cannot produce an out-of-range index. mergeCtorOptional is public store
    // API, though, so a direct caller can — and an index past the end of the
    // list would otherwise pass undefined for an argument no token names.
    metadataStore.clear();

    @Injectable({ token: 'untokened' })
    @Inject('a')
    class Untokened {
      constructor(readonly a: unknown, readonly dep?: object) {}
    }
    metadataStore.mergeCtorOptional(Untokened, 1);

    const app = createApplication({
      plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ services: [Untokened] })],
    });

    return expect(app.start()).rejects.toThrow(/the @Inject\(\.\.\.\) list names no token for it/);
  });
});
