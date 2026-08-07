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

describe('@Optional injection (real container and real registry)', () => {
  it('injects undefined for an absent optional token via the real container', async () => {
    metadataStore.clear();

    @Injectable({ token: 'present-dep' })
    class PresentDep {
      readonly text = 'present';
    }

    @Controller('/optional-di')
    class OptionalController {
      constructor(
        @Inject('present-dep') readonly present: PresentDep,
        @Optional() @Inject('never-registered') readonly missing?: { text: string },
      ) {}

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
    class SuppliedController {
      constructor(
        @Optional() @Inject('sometimes-dep') readonly dep?: SometimesDep,
      ) {}

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
    class RegistryOptionalController {
      constructor(
        @Inject('registry-present') readonly present: RegistryPresent,
        @Optional() @Inject('registry-absent') readonly missing?: { text: string },
      ) {}

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
    class Holder {
      constructor(@Optional() @Inject('exploding-dep') readonly dep?: ExplodingDep) {}
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

  it('refuses @Optional on a parameter carrying no @Inject token', async () => {
    metadataStore.clear();

    @Injectable({ token: 'untokened' })
    class Untokened {
      constructor(@Optional() readonly dep?: object) {}
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ services: [Untokened] })],
    });

    await expect(app.start()).rejects.toThrow(/is @Optional but carries no @Inject token/);
  });

  it('refuses @Optional combined with the deprecated class-level @Inject list', async () => {
    metadataStore.clear();

    @Injectable({ token: 'mixed-forms' })
    @Inject('a')
    class MixedForms {
      constructor(@Optional() readonly dep?: object) {}
    }

    const app = createApplication({
      plugins: [RuntimePlugin(), DiPlugin(), DecoratorPlugin({ services: [MixedForms] })],
    });

    await expect(app.start()).rejects.toThrow(/cannot express per-argument optionality/);
  });
});
