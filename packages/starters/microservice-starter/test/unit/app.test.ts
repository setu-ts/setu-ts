/**
 * @module microservice-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildMicroservicePlugins, createMicroserviceApp } from '../../src/index.ts';
import type { MicroserviceStarterOptions } from '../../src/options.ts';
import { CAPABILITIES, type IPlugin } from '@hono-enterprise/common';
// Imported via the bare specifier, the same way `src/app.ts` imports it,
// so this test also exercises the cross-starter specifier the published package
// depends on — a relative path into the sibling package would not.
import { buildRestPlugins } from '@hono-enterprise/rest-starter';

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

  // The typed fixture is a compile-time check (a wrong shape fails `deno check`),
  // but the runtime assertion is what proves the arms are actually threaded through:
  // the app must BOOT under non-default options and register each capability.
  it('boots under NON-default arms and registers every microservice capability', async () => {
    const opts: MicroserviceStarterOptions = {
      messaging: { broker: 'memory' },
      queue: { adapter: 'memory' },
      resilience: { defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' } },
      telemetry: { exporter: 'console' },
    };
    const app = createMicroserviceApp(opts);
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();

    expect(app.services.has(CAPABILITIES.MESSAGING)).toBe(true);
    expect(app.services.has(CAPABILITIES.QUEUE)).toBe(true);
    expect(app.services.has(CAPABILITIES.RESILIENCE)).toBe(true);
    expect(app.services.has(CAPABILITIES.TELEMETRY)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
  it('inherits the realtime and di arms from the REST tier', () => {
    const names = buildMicroservicePlugins({
      di: {},
      realtime: { websocket: {}, sse: {}, backplane: {} },
    }).map((p) => p.name);
    expect(names).toContain('di-plugin');
    expect(names).toContain('websocket-plugin');
    expect(names).toContain('sse-plugin');
    expect(names).toContain('realtime-backplane-plugin');
  });

  it('omits the inherited arms by default', () => {
    const names = buildMicroservicePlugins().map((p) => p.name);
    expect(names).not.toContain('di-plugin');
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
  });

  // The 'messaging' backplane transport throws on the REST tier, which supplies no
  // broker; here it succeeds, because this tier always registers MessagingPlugin.
  it("boots with a 'messaging' backplane transport, which the REST tier cannot", async () => {
    const app = createMicroserviceApp({
      realtime: { sse: {}, backplane: { transport: 'messaging' } },
    });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();

    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(true);
    expect(app.services.has(CAPABILITIES.MESSAGING)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
});
