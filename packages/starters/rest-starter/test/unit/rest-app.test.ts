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
