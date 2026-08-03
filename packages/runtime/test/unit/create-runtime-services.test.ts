/**
 * Tests for `createRuntimeServices` — the platform → adapter resolution shared
 * by `RuntimePlugin` and by callers that need runtime services before an
 * application exists.
 *
 * The delegation matters as much as the function: a copy of the resolution
 * inside the plugin would pass every test here while drifting from what
 * pre-`start()` callers get, so one test drives BOTH entry points against the
 * same injected factory.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  IPluginContext,
  IRuntimeServices,
  IServiceRegistry,
  RuntimePlatform,
} from '@hono-enterprise/common';

import {
  createRuntimeServices,
  type RuntimeAdapterFactories,
} from '../../src/adapters/shared/runtime-services-factory.ts';
import { RuntimePlugin } from '../../src/plugin/runtime-plugin.ts';

/**
 * A runtime services double that reports the platform it was built for, so a
 * test can tell WHICH factory produced the instance it is holding.
 */
function createFakeRuntimeServices(platform: RuntimePlatform): IRuntimeServices {
  return {
    platform: () => platform,
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => 'fake-uuid',
    randomBytes: (size: number) => new Uint8Array(size),
    subtle: {} as SubtleCrypto,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: () => ({} as unknown),
    clearTimeout: () => {},
    setInterval: () => ({} as unknown),
    clearInterval: () => {},
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
  };
}

/** Records how many times each platform's factory was invoked. */
function createRecordingAdapters(): {
  readonly adapters: RuntimeAdapterFactories;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const make = (platform: RuntimePlatform) => () => {
    calls.push(platform);
    return createFakeRuntimeServices(platform);
  };
  return {
    adapters: {
      deno: make('deno'),
      node: make('node'),
      bun: make('bun'),
      'cloudflare-workers': make('cloudflare-workers'),
    },
    calls,
  };
}

/**
 * The minimal plugin context `RuntimePlugin.register` actually touches.
 *
 * Narrowed deliberately: the plugin reads `ctx.services` and nothing else, so
 * standing up the other twelve `IPluginContext` members would assert nothing
 * and hide which surface the plugin depends on.
 */
function createRegistryContext(): {
  readonly ctx: IPluginContext;
  readonly registry: Map<string, unknown>;
} {
  const registry = new Map<string, unknown>();
  const services = {
    register(capability: string, value: unknown): void {
      registry.set(capability, value);
    },
    get(capability: string): unknown {
      return registry.get(capability);
    },
    has(capability: string): boolean {
      return registry.has(capability);
    },
  } as unknown as IServiceRegistry;

  return { ctx: { services } as unknown as IPluginContext, registry };
}

describe('createRuntimeServices | platform resolution', () => {
  it('builds services from the factory for the requested platform', () => {
    const { adapters, calls } = createRecordingAdapters();

    const services = createRuntimeServices({ platform: 'bun', adapters });

    expect(services.platform()).toBe('bun');
    expect(calls).toEqual(['bun']);
  });

  it('an explicit platform overrides detection', () => {
    const { adapters } = createRecordingAdapters();

    // The suite runs on Deno, so detection would yield 'deno' — asserting a
    // different platform is what proves the option is read.
    const services = createRuntimeServices({ platform: 'cloudflare-workers', adapters });

    expect(services.platform()).toBe('cloudflare-workers');
  });

  it('falls back to detection when no platform is given', () => {
    const { adapters } = createRecordingAdapters();

    const services = createRuntimeServices({ adapters });

    // This suite runs under Deno, which detectRuntime() identifies by its global.
    expect(services.platform()).toBe('deno');
  });

  it('throws by name when the resolved platform has no factory', () => {
    expect(() =>
      createRuntimeServices({
        platform: 'node',
        adapters: {
          deno: () => {
            throw new Error('should not be called');
          },
        },
      })
    ).toThrow('No runtime adapter factory for platform: node');
  });

  it('uses the built-in map when no adapters are injected', () => {
    // No injection: exercises the real default map rather than a fake one.
    const services = createRuntimeServices();

    expect(services.platform()).toBe('deno');
    expect(typeof services.uuid()).toBe('string');
  });
});

describe('createRuntimeServices | one implementation, two entry points', () => {
  it('RuntimePlugin registers services built by the same injected factory', () => {
    const { adapters, calls } = createRecordingAdapters();
    const { ctx, registry } = createRegistryContext();

    const plugin = RuntimePlugin({
      platform: 'bun',
      adapters,
      httpAdapters: {
        bun: () => ({
          setHandler: () => {},
          fetch: () => Promise.resolve(new Response(null)),
          listen: () => Promise.resolve(undefined),
          close: () => Promise.resolve(),
        }),
      },
    });
    plugin.register(ctx);

    const registered = registry.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    // Same factory, same platform: the plugin does not re-derive the mapping.
    expect(registered.platform()).toBe('bun');
    expect(calls).toEqual(['bun']);
  });

  it('both entry points report the same platform under the default map', () => {
    const { ctx, registry } = createRegistryContext();

    RuntimePlugin().register(ctx);
    const fromPlugin = registry.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    const standalone = createRuntimeServices();

    expect(standalone.platform()).toBe(fromPlugin.platform());
  });

  it('the two instances read the same environment', () => {
    // The documented consequence of building services outside the app: two
    // instances exist, and both must see the environment they were built over.
    Deno.env.set('HONOE_M36C_PROBE', 'shared');
    try {
      const { ctx, registry } = createRegistryContext();
      RuntimePlugin().register(ctx);

      const fromPlugin = registry.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
      const standalone = createRuntimeServices();

      expect(standalone.env['HONOE_M36C_PROBE']).toBe('shared');
      expect(fromPlugin.env['HONOE_M36C_PROBE']).toBe('shared');
    } finally {
      Deno.env.delete('HONOE_M36C_PROBE');
    }
  });

  it('env is a construction-time snapshot, not a live view', () => {
    // Pins the caveat the factory's JSDoc states, so the doc claim is verified
    // rather than asserted: a variable set after construction is not visible.
    const before = createRuntimeServices();
    Deno.env.set('HONOE_M36C_LATE', 'late');
    try {
      const after = createRuntimeServices();

      expect(before.env['HONOE_M36C_LATE']).toBeUndefined();
      expect(after.env['HONOE_M36C_LATE']).toBe('late');
    } finally {
      Deno.env.delete('HONOE_M36C_LATE');
    }
  });
});

describe('createRuntimeServices | Cloudflare Workers env passthrough', () => {
  it('populates env from the supplied Worker env', () => {
    // Without this, `runtime.env` is empty on Workers: there is no ambient
    // environment on the edge, so ConfigPlugin reads nothing.
    const services = createRuntimeServices({
      platform: 'cloudflare-workers',
      env: { API_KEY: 'secret', REGION: 'weur' },
    });

    expect(services.platform()).toBe('cloudflare-workers');
    expect(services.env).toEqual({ API_KEY: 'secret', REGION: 'weur' });
  });

  it('leaves env empty on Workers when none is supplied', () => {
    const services = createRuntimeServices({ platform: 'cloudflare-workers' });
    expect(Object.keys(services.env)).toEqual([]);
  });

  it('keeps object bindings out of the string-typed env', () => {
    const services = createRuntimeServices({
      platform: 'cloudflare-workers',
      env: { API_KEY: 'secret', CACHE_KV: { get: () => {} } },
    });

    expect(services.env).toEqual({ API_KEY: 'secret' });
  });

  it('ignores env on the ambient-environment platforms', () => {
    // Deno reads Deno.env; passing a Worker env must not shadow or corrupt it,
    // and must not be handed to a factory whose first parameter is a host.
    const services = createRuntimeServices({
      platform: 'deno',
      env: { HONOE_M52_NEVER: 'should not appear' },
    });

    expect(services.platform()).toBe('deno');
    expect(services.env['HONOE_M52_NEVER']).toBeUndefined();
  });
});

describe('RuntimePlugin | Cloudflare Workers env passthrough', () => {
  it('registers services whose env carries the Worker variables', () => {
    const { ctx, registry } = createRegistryContext();

    RuntimePlugin({
      platform: 'cloudflare-workers',
      env: { API_KEY: 'secret', CACHE_KV: { get: () => {} } },
    }).register(ctx);

    const services = registry.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    expect(services.env).toEqual({ API_KEY: 'secret' });
  });

  it('leaves env empty when the application passes none', () => {
    const { ctx, registry } = createRegistryContext();

    RuntimePlugin({ platform: 'cloudflare-workers' }).register(ctx);

    const services = registry.get(CAPABILITIES.RUNTIME) as IRuntimeServices;
    expect(Object.keys(services.env)).toEqual([]);
  });
});
