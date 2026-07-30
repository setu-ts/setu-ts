/**
 * @module full-stack-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildFullStackPlugins, createFullStackApp } from '../../src/index.ts';
import type { FullStackStarterOptions } from '../../src/options.ts';
// CAPABILITIES not needed in this test file
import { buildMicroservicePlugins } from '@hono-enterprise/microservice-starter';
import type { IPlugin } from '@hono-enterprise/common';

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

  // Note: notifications test uses minimal valid shape - see issue tracking
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

  it('typed-fixture arms exercise all full-stack options', () => {
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
    expect(app).toBeDefined();
  });
});
