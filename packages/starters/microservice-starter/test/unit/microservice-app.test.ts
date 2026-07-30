/**
 * @module microservice-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildMicroservicePlugins, createMicroserviceApp } from '../../src/index.ts';
import type { MicroserviceStarterOptions } from '../../src/options.ts';
import { CAPABILITIES, type IPlugin } from '@hono-enterprise/common';
import { buildRestPlugins } from '../../../rest-starter/src/rest-app.ts';

describe('microservice-starter / buildMicroservicePlugins', () => {
  it('is a superset of REST set', () => {
    const restNames = buildRestPlugins().map((p: IPlugin) => p.name);
    const microNames = buildMicroservicePlugins().map((p: IPlugin) => p.name);
    // All REST plugins should be present in microservice
    for (const name of restNames) {
      expect(microNames).toContain(name);
    }
  });

  it('adds messaging, queue, resilience, telemetry', () => {
    const plugins = buildMicroservicePlugins();
    const names = plugins.map((p: IPlugin) => p.name);
    expect(names).toContain('messaging-plugin');
    expect(names).toContain('queue-plugin');
    expect(names).toContain('resilience-plugin');
    expect(names).toContain('telemetry-plugin');
  });

  it('default composition claims bare CAPABILITIES.MESSAGING token', async () => {
    const app = createMicroserviceApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.MESSAGING)).toBe(true);
  });

  it('default composition claims bare CAPABILITIES.QUEUE token', async () => {
    const app = createMicroserviceApp();
    await app.start();
    expect(app.services.has(CAPABILITIES.QUEUE)).toBe(true);
  });
});

describe('microservice-starter / createMicroserviceApp', () => {
  it('starts with inject() returning 200 for a simple route', async () => {
    const app = createMicroserviceApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  it('typed-fixture arms exercise all four microservice options', () => {
    // These are compile-time checks — typed fixtures ensure correct shapes
    const opts: MicroserviceStarterOptions = {
      messaging: { broker: 'memory' },
      queue: { adapter: 'memory' },
      resilience: { defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' } },
      telemetry: { exporter: 'console' },
    };
    // The type ensures correctness — no runtime assert needed
    const app = createMicroserviceApp(opts);
    expect(app).toBeDefined();
  });
});
