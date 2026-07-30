/**
 * @module full-stack-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildFullStackPlugins, createFullStackApp } from '../src/index.ts';
import type { FullStackStarterOptions } from '../src/options.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import { buildMicroservicePlugins } from '../microservice-starter/src/microservice-app.ts';

describe('full-stack-starter / buildFullStackPlugins', () => {
  it('is a superset of microservice set', () => {
    const microNames = buildMicroservicePlugins().map((p) => p.name);
    const fullNames = buildFullStackPlugins().map((p) => p.name);
    // All microservice plugins should be present in full-stack
    for (const name of microNames) {
      expect(fullNames).toContain(name);
    }
  });

  it('adds cache, events, cqrs, scheduler, audit, secrets, storage, mail', () => {
    const plugins = buildFullStackPlugins();
    const names = plugins.map((p) => p.name);
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
    const names = plugins.map((p) => p.name);
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
    const names = plugins.map((p) => p.name);
    expect(names).toContain('feature-flags-plugin');
  });

  it('registers notifications when provided', () => {
    const opts: FullStackStarterOptions = {
      notifications: [
        { channel: 'email', to: 'test@example.com', subject: 'Test' },
      ],
    };
    const plugins = buildFullStackPlugins(opts);
    const names = plugins.map((p) => p.name);
    expect(names).toContain('notification-plugin');
  });
});

describe('full-stack-starter / createFullStackApp', () => {
  it('starts with inject() returning 200 for a simple route', async () => {
    const app = createFullStackApp();
    app.get('/hello', () => 'Hello world');

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  it('default composition claims bare CAPABILITIES.CACHE token', async () => {
    const app = createFullStackApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(true);
  });

  it('default composition claims bare CAPABILITIES.EVENTS token', async () => {
    const app = createFullStackApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.EVENTS)).toBe(true);
  });

  it('default composition claims bare CAPABILITIES.CQRS token', async () => {
    const app = createFullStackApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.CQRS)).toBe(true);
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
