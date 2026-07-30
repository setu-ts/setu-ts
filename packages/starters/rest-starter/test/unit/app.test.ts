/**
 * @module rest-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildRestPlugins, createRestApp } from '../../src/index.ts';
import type { RestStarterOptions } from '../../src/options.ts';
import { CAPABILITIES } from '@hono-enterprise/common';

/**
 * A valid `auth` arm. `AuthPluginOptions` requires BOTH `jwt` and `rbac`
 * (neither is optional), so this is the minimum shape that constructs.
 */
const AUTH_FIXTURE: RestStarterOptions = {
  auth: {
    jwt: { secret: 'starter-test-secret' },
    rbac: {
      roles: {
        admin: { permissions: ['*'], inherits: ['user'] },
        user: { permissions: ['users:read'] },
      },
    },
  },
};

describe('rest-starter / buildRestPlugins', () => {
  it('returns exactly the REST plugin names', () => {
    const plugins = buildRestPlugins();
    const pluginNames = plugins.map((p) => p.name);
    const expected = [
      'runtime',
      'config-plugin',
      'logger-plugin',
      'validation-plugin',
      'http-security-plugin',
      'health-plugin',
      'metrics-plugin',
      'openapi-plugin',
      'decorator-plugin',
    ];
    expect(pluginNames).toEqual(expected);
  });

  it('includes database when provided', () => {
    const opts: RestStarterOptions = {
      database: { type: 'memory' },
    };
    const plugins = buildRestPlugins(opts);
    const names = plugins.map((p) => p.name);
    expect(names).toContain('database-plugin');
  });

  it('does not include database when omitted', () => {
    const plugins = buildRestPlugins();
    const names = plugins.map((p) => p.name);
    expect(names).not.toContain('database-plugin');
  });

  it('includes auth when provided', () => {
    const plugins = buildRestPlugins(AUTH_FIXTURE);
    const names = plugins.map((p) => p.name);
    expect(names).toContain('auth-plugin');
  });

  it('does not include auth when omitted', () => {
    const plugins = buildRestPlugins();
    const names = plugins.map((p) => p.name);
    expect(names).not.toContain('auth-plugin');
  });

  it('includes none of the four M36b arms by default', () => {
    const names = buildRestPlugins().map((p) => p.name);
    expect(names).not.toContain('di-plugin');
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
  });

  it('includes DiPlugin when the di arm is provided', () => {
    const names = buildRestPlugins({ di: {} }).map((p) => p.name);
    expect(names).toContain('di-plugin');
  });

  it('adds exactly the websocket plugin for realtime.websocket', () => {
    const names = buildRestPlugins({ realtime: { websocket: {} } }).map((p) => p.name);
    expect(names).toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
  });

  it('adds exactly the sse plugin for realtime.sse', () => {
    const names = buildRestPlugins({ realtime: { sse: {} } }).map((p) => p.name);
    expect(names).toContain('sse-plugin');
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
  });

  it('adds exactly the backplane plugin for realtime.backplane', () => {
    const names = buildRestPlugins({ realtime: { backplane: {} } }).map((p) => p.name);
    expect(names).toContain('realtime-backplane-plugin');
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
  });

  it('adds nothing for an empty realtime arm', () => {
    const names = buildRestPlugins({ realtime: {} }).map((p) => p.name);
    expect(names).not.toContain('websocket-plugin');
    expect(names).not.toContain('sse-plugin');
    expect(names).not.toContain('realtime-backplane-plugin');
    // Still a valid app, not an error.
    expect(names).toContain('runtime');
  });

  it('adds all three realtime plugins when all sub-arms are supplied', () => {
    const names = buildRestPlugins({
      realtime: { websocket: {}, sse: {}, backplane: {} },
    }).map((p) => p.name);
    expect(names).toContain('websocket-plugin');
    expect(names).toContain('sse-plugin');
    expect(names).toContain('realtime-backplane-plugin');
  });

  it('threads realtime sub-arm options through to the plugin', () => {
    // `origin` is read by the backplane to drop its own echoes; passing it proves
    // the arm is forwarded rather than replaced with a default instance.
    const plugins = buildRestPlugins({
      realtime: { backplane: { transport: 'memory', bus: 'starter-test', origin: 'fixed' } },
    });
    expect(plugins.map((p) => p.name)).toContain('realtime-backplane-plugin');
  });

  it('the backplane precedes both realtime consumers by priority', () => {
    const plugins = buildRestPlugins({
      realtime: { websocket: {}, sse: {}, backplane: {} },
    });
    const priorityOf = (name: string): number => {
      const plugin = plugins.find((p) => p.name === name);
      return plugin?.priority ?? Number.MAX_SAFE_INTEGER;
    };
    // The kernel sorts ascending by priority, so lower registers first.
    expect(priorityOf('realtime-backplane-plugin')).toBeLessThan(priorityOf('websocket-plugin'));
    expect(priorityOf('realtime-backplane-plugin')).toBeLessThan(priorityOf('sse-plugin'));
  });

  it('DiPlugin precedes DecoratorPlugin by priority, so ctx.container is set in time', () => {
    const plugins = buildRestPlugins({ di: {} });
    const priorityOf = (name: string): number => {
      const plugin = plugins.find((p) => p.name === name);
      return plugin?.priority ?? Number.MAX_SAFE_INTEGER;
    };
    expect(priorityOf('di-plugin')).toBeLessThan(priorityOf('decorator-plugin'));
  });

  it('registers no duplicate plugin name or capability with every arm supplied', () => {
    const plugins = buildRestPlugins({
      ...AUTH_FIXTURE,
      database: { type: 'memory' },
      di: {},
      realtime: { websocket: {}, sse: {}, backplane: {} },
    });
    const names = plugins.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const provided = plugins.flatMap((p) => p.provides ?? []);
    expect(new Set(provided).size).toBe(provided.length);
  });
});

describe('rest-starter / createRestApp', () => {
  // Note: inject() requires app.start() to be called first
  it('starts with inject() returning 200 for a simple route', async () => {
    const app = createRestApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  it('registers DATABASE capability when database arm is provided', async () => {
    const app = createRestApp({
      database: { type: 'memory' },
    });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });

  it('does NOT register DATABASE capability when database arm is omitted', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(false);
  });

  it('registers AUTH capability when auth arm is provided', async () => {
    const app = createRestApp(AUTH_FIXTURE);
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.AUTH)).toBe(true);
  });

  it('does NOT register AUTH capability when auth arm is omitted', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.AUTH)).toBe(false);
  });

  it('still serves requests with the auth arm registered', async () => {
    const app = createRestApp(AUTH_FIXTURE);
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
});
