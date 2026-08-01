/**
 * Integration tests for plugin registration against a real kernel application.
 *
 * Everything here goes through `createApplication` + the real `RuntimePlugin`,
 * so the capability is resolved and typed the way an application would resolve
 * and type it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { HealthCheckResult, IServiceDiscovery } from '@hono-enterprise/common';

import {
  DiscoveryUnavailableError,
  SelfRegistrationNotSupportedError,
  ServiceDiscoveryPlugin,
} from '../../src/index.ts';
import type { DiscoveryProvider } from '../../src/index.ts';
import { createFakeProvider, instance } from '../fixtures/fakes.ts';

const STATIC_SERVICES = {
  billing: [
    { host: '10.0.0.1', port: 8080 },
    { host: '10.0.0.2', port: 8080 },
  ],
};

/** Captures the health indicators an application registers. */
function healthCapture(): {
  plugin: ReturnType<typeof RuntimePlugin>;
  check: (name: string) => Promise<HealthCheckResult>;
} {
  const indicators = new Map<string, () => Promise<HealthCheckResult>>();
  const plugin = {
    name: 'health-capture',
    version: '0.0.0',
    provides: [CAPABILITIES.HEALTH_INDICATOR],
    register(ctx: {
      health: { register: (n: string, fn: () => Promise<HealthCheckResult>) => void };
    }): void {
      const original = ctx.health.register.bind(ctx.health);
      ctx.health.register = (n, fn) => {
        indicators.set(n, fn);
        original(n, fn);
      };
    },
  } as unknown as ReturnType<typeof RuntimePlugin>;

  return {
    plugin,
    check: (name: string) => {
      const fn = indicators.get(name);
      if (fn === undefined) {
        throw new Error(`no indicator registered as '${name}'`);
      }
      return fn();
    },
  };
}

describe('ServiceDiscoveryPlugin — registration', () => {
  it('registers the capability, typed as IServiceDiscovery', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'static', services: STATIC_SERVICES }),
      ],
    });
    await app.start();

    expect(app.services.has(CAPABILITIES.SERVICE_DISCOVERY)).toBe(true);
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    expect(typeof discovery.resolve).toBe('function');

    await app.stop();
  });

  it('exercises all five contract methods through the resolved capability', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'static', services: STATIC_SERVICES }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    const instances = await discovery.resolve('billing');
    expect(instances.map((i) => i.host)).toEqual(['10.0.0.1', '10.0.0.2']);

    const picked = await discovery.pick('billing');
    expect(picked?.host).toBe('10.0.0.1');

    expect(await discovery.resolveUrl('billing', '/invoices'))
      .toBe('http://10.0.0.2:8080/invoices');

    // report() is fire-and-forget; the ejection test below proves it acts.
    discovery.report(instances[0], 'success');

    const unsubscribe = await discovery.watch('billing', () => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();

    await app.stop();
  });

  it('ejects an instance after reported failures and picks the survivor', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'static',
          services: STATIC_SERVICES,
          strategy: 'random',
          ejection: { failureThreshold: 2 },
        }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    const [first, second] = await discovery.resolve('billing');
    discovery.report(first, 'failure');
    discovery.report(first, 'failure');

    for (let i = 0; i < 10; i++) {
      expect((await discovery.pick('billing'))?.id).toBe(second.id);
    }

    await app.stop();
  });
});

describe('ServiceDiscoveryPlugin — health indicator', () => {
  it("reports 'up' after a successful resolve", async () => {
    const health = healthCapture();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        health.plugin,
        ServiceDiscoveryPlugin({ provider: 'static', services: STATIC_SERVICES }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    await discovery.resolve('billing');

    const result = await health.check('service-discovery');
    expect(result.status).toBe('up');
    expect(result.data).toEqual({
      provider: 'static',
      cachedServices: 1,
      watchedServices: 0,
      ejectedInstances: 0,
      degraded: false,
    });

    await app.stop();
  });

  it("reports 'degraded' after a provider failure with a warm cache", async () => {
    const provider = createFakeProvider([instance({ id: 'a' })]);
    const health = healthCapture();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        health.plugin,
        ServiceDiscoveryPlugin({ provider: 'custom', discovery: provider, cacheTtlMs: 0 }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    await discovery.resolve('billing');
    expect((await health.check('service-discovery')).status).toBe('up');

    provider.failWith(new Error('backend down'));
    await discovery.resolve('billing');

    const result = await health.check('service-discovery');
    expect(result.status).toBe('degraded');
    expect((result.data as { degraded: boolean }).degraded).toBe(true);

    await app.stop();
  });

  it('throws DiscoveryUnavailableError on a cold provider failure', async () => {
    const provider = createFakeProvider([]);
    provider.failWith(new Error('backend down'));
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'custom', discovery: provider }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    await expect(discovery.resolve('billing')).rejects.toThrow(DiscoveryUnavailableError);
    await app.stop();
  });
});

describe('ServiceDiscoveryPlugin — shutdown', () => {
  it('onClose unsubscribes an active watch', async () => {
    const provider = createFakeProvider([instance({ id: 'a' })]);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'custom', discovery: provider }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    await discovery.watch('billing', () => {});
    expect(provider.unsubscribeCalls).toBe(0);

    await app.stop();
    expect(provider.unsubscribeCalls).toBe(1);
  });
});

describe('ServiceDiscoveryPlugin — selfRegistration guards', () => {
  const selfRegistration = { serviceName: 'orders', address: '10.0.0.7', port: 3000 };

  it('refuses selfRegistration on the static arm', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'static', services: {}, selfRegistration }),
      ],
    });
    await expect(app.start()).rejects.toThrow(SelfRegistrationNotSupportedError);
  });

  it('refuses selfRegistration on the kubernetes arm', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'kubernetes',
          namespace: 'default',
          apiServer: 'https://api',
          token: 't',
          selfRegistration,
        }),
      ],
    });
    await expect(app.start()).rejects.toThrow(SelfRegistrationNotSupportedError);
  });

  it('refuses selfRegistration on the dns arm', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'dns', mode: 'srv', selfRegistration }),
      ],
    });
    await expect(app.start()).rejects.toThrow(SelfRegistrationNotSupportedError);
  });

  it('refuses selfRegistration on a custom provider that cannot register', async () => {
    const own: DiscoveryProvider = {
      kind: 'own',
      resolve: () => Promise.resolve([]),
      watch: () => Promise.resolve(() => {}),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'custom', discovery: own, selfRegistration }),
      ],
    });
    await expect(app.start()).rejects.toThrow(SelfRegistrationNotSupportedError);
  });

  it('accepts selfRegistration on a custom provider that can register', async () => {
    const registered: string[] = [];
    const own: DiscoveryProvider = {
      kind: 'own',
      resolve: () => Promise.resolve([]),
      watch: () => Promise.resolve(() => {}),
      registerSelf: (r) => {
        registered.push(r.serviceName);
        return Promise.resolve();
      },
      deregisterSelf: () => Promise.resolve(),
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'custom', discovery: own, selfRegistration }),
      ],
    });
    await app.start();
    expect(registered).toEqual(['orders']);
    await app.stop();
  });
});

describe('ServiceDiscoveryPlugin — startup failures', () => {
  it('the kubernetes arm throws at start() when no API server is discoverable', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({ provider: 'kubernetes', namespace: 'default', token: 't' }),
      ],
    });
    await expect(app.start()).rejects.toThrow('KUBERNETES_SERVICE_HOST');
  });

  it('the dns arm throws at start() when the runtime supplies no resolver', async () => {
    // The Deno adapter DOES supply one, so this drives the Workers shape
    // through a runtime whose services omit the key.
    const app = createApplication({
      plugins: [
        {
          name: 'no-dns-runtime',
          version: '0.0.0',
          provides: [CAPABILITIES.RUNTIME],
          register(ctx: { services: { register: (t: string, s: object) => void } }): void {
            const services = { ...noDnsRuntime() };
            ctx.services.register(CAPABILITIES.RUNTIME, services);
          },
        },
        ServiceDiscoveryPlugin({ provider: 'dns', mode: 'srv' }),
      ],
    });
    await expect(app.start()).rejects.toThrow(DiscoveryUnavailableError);
  });
});

/** Runtime services with the `dns` key omitted, as the Workers adapter does. */
function noDnsRuntime(): Record<string, unknown> {
  return {
    platform: () => 'cloudflare-workers',
    version: () => 'test',
    hostname: () => 'worker',
    uuid: () => 'uuid',
    randomBytes: (n: number) => new Uint8Array(n),
    subtle: {} as SubtleCrypto,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as number),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as number),
    env: {},
    exit: () => {
      throw new Error('exit');
    },
  };
}
