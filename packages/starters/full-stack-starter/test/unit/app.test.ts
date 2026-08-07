/**
 * @module full-stack-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildFullStackPlugins, createFullStackApp } from '../../src/index.ts';
import type { FullStackStarterOptions } from '../../src/options.ts';
import { CAPABILITIES } from '@setu-ts/common';
import { buildMicroservicePlugins } from '@setu-ts/microservice-starter';
import type { IPlugin } from '@setu-ts/common';

describe('full-stack-starter / buildFullStackPlugins', () => {
  it('is a superset of microservice set', () => {
    const microNames = buildMicroservicePlugins().map((p: IPlugin) => p.name);
    const fullNames = buildFullStackPlugins().map((p: IPlugin) => p.name);
    // All microservice plugins should be present in full-stack
    for (const name of microNames) {
      expect(fullNames).toContain(name);
    }
  });

  it('adds cache, events, cqrs, scheduler, audit, secrets, storage, mail', () => {
    const plugins = buildFullStackPlugins();
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('cache-plugin');
    expect(names).toContain('events-plugin');
    expect(names).toContain('cqrs-plugin');
    expect(names).toContain('scheduler-plugin');
    expect(names).toContain('audit-plugin');
    expect(names).toContain('secrets-plugin');
    expect(names).toContain('storage-plugin');
    expect(names).toContain('mail-plugin');
  });

  it('gated arms are NOT registered by default', () => {
    const plugins = buildFullStackPlugins();
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).not.toContain('feature-flags-plugin');
    expect(names).not.toContain('notification-plugin');
    expect(names).not.toContain('multi-tenancy-plugin');
    expect(names).not.toContain('react-router-plugin');
  });

  it('registers featureFlags when provided', () => {
    const opts: FullStackStarterOptions = {
      featureFlags: { provider: 'memory' },
    };
    const plugins = buildFullStackPlugins(opts);
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('feature-flags-plugin');
  });

  // An empty `channels` map is the minimal shape `NotificationPluginOptions`
  // accepts. Configuring a real channel is the notification-plugin's own
  // concern; here the arm only needs to prove it is threaded through.
  it('registers notifications when provided', () => {
    const opts: FullStackStarterOptions = {
      notifications: {
        channels: {},
      },
    };
    const plugins = buildFullStackPlugins(opts);
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('notification-plugin');
  });

  it('registers multiTenancy when provided', () => {
    const opts: FullStackStarterOptions = {
      multiTenancy: { resolver: 'subdomain' },
    };
    const plugins = buildFullStackPlugins(opts);
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('multi-tenancy-plugin');
  });

  it('registers reactRouter when provided', () => {
    const opts: FullStackStarterOptions = {
      reactRouter: { serverBuildPath: './build' },
    };
    const plugins = buildFullStackPlugins(opts);
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('react-router-plugin');
  });
});

describe('full-stack-starter / createFullStackApp', () => {
  it('starts with inject() returning 200 for a simple route', async () => {
    const app = createFullStackApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  // §3.2.1: the default composition must claim the BARE cache token. If a starter
  // ever passed a `name` through, the instance would move to a derived token and
  // every consumer resolving CAPABILITIES.CACHE would fail at request time.
  it('default composition claims the bare CAPABILITIES.CACHE token', async () => {
    const app = createFullStackApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(true);
  });

  // The typed fixture is a compile-time check (a wrong shape fails `deno check`),
  // but the runtime assertion is what proves the arms are actually threaded through:
  // the app must BOOT under non-default options and register each capability.
  it('boots under NON-default arms and registers every full-stack capability', async () => {
    const opts: FullStackStarterOptions = {
      cache: { store: 'memory' },
      events: {},
      cqrs: {},
      scheduler: {},
      audit: { storage: 'memory' },
      secrets: { provider: 'env' },
      storage: { provider: 'memory' },
      mail: { provider: 'log' },
    };
    const app = createFullStackApp(opts);
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();

    expect(app.services.has(CAPABILITIES.CACHE)).toBe(true);
    expect(app.services.has(CAPABILITIES.EVENTS)).toBe(true);
    expect(app.services.has(CAPABILITIES.CQRS)).toBe(true);
    expect(app.services.has(CAPABILITIES.AUDIT)).toBe(true);
    expect(app.services.has(CAPABILITIES.SECRETS)).toBe(true);
    expect(app.services.has(CAPABILITIES.STORAGE)).toBe(true);
    expect(app.services.has(CAPABILITIES.MAIL)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
  it('inherits the realtime and di arms through both upstream tiers', () => {
    const names = buildFullStackPlugins({
      di: {},
      realtime: { websocket: {}, sse: {}, backplane: {} },
    }).map((p: IPlugin) => p.name);
    expect(names).toContain('di-plugin');
    expect(names).toContain('websocket-plugin');
    expect(names).toContain('sse-plugin');
    expect(names).toContain('realtime-backplane-plugin');
  });

  it('omits the inherited arms by default', () => {
    const names = buildFullStackPlugins().map((p: IPlugin) => p.name);
    expect(names).not.toContain('di-plugin');
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
  });

  // The M36 collision guard, extended by the four M36b plugins: with every arm
  // supplied, no plugin name and no capability token may appear twice.
  it('has no duplicate plugin name or capability provider with every arm supplied', () => {
    const plugins = buildFullStackPlugins({
      di: {},
      realtime: { websocket: {}, sse: {}, backplane: {} },
      featureFlags: { provider: 'config', options: { flags: {} } },
      multiTenancy: { resolver: 'header' },
    });
    const names = plugins.map((p: IPlugin) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const provided = plugins.flatMap((p: IPlugin) => p.provides ?? []);
    expect(new Set(provided).size).toBe(provided.length);
  });
});
