/**
 * @module rest-starter unit tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createRestApp, buildRestPlugins } from '../../src/index.ts';
import type { RestStarterOptions } from '../../src/options.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IRequestContext } from '@hono-enterprise/common';

// Simple route handler that returns a string body
function simpleHandler(ctx: IRequestContext) {
  return ctx.response.json({ ok: true });
}

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
});

describe('rest-starter / createRestApp', () => {
  // Note: inject() requires app.start() to be called first
  it('starts with inject() returning 200 for a simple route', async () => {
    const app = createRestApp();
    app.router.get('/hello', (ctx) => {
      ctx.response.headers.set('content-type', 'text/plain');
      return ctx.response.send('Hello world');
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: 'http://localhost/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  it('registers DATABASE capability when database arm is provided', async () => {
    const app = createRestApp({
      database: { type: 'memory' },
    });
    app.router.get('/test', (ctx) => ctx.response.send('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(true);
  });

  it('does NOT register DATABASE capability when database arm is omitted', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.send('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(false);
  });
});
