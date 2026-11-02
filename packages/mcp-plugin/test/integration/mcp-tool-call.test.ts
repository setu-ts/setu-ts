import { it, expect } from 'vitest';
import { z } from 'zod-v4';
import { CAPABILITIES, respondWithError } from '@setu-ts/common';
import type { IJwtService, IPlugin, IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireAuth, requireRole, rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { IdempotencyPlugin, idempotent } from '@setu-ts/idempotency-plugin';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { McpPlugin } from '../../src/index.ts';
import { clientFor, rpc } from './app.ts';

async function build() {
  const events: string[] = [];
  let writes = 0;
  let roleCalls = 0;
  let reached = 0;
  let aborted = false;
  let notify: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const plumbing: IPlugin = {
    name: 'app-controls',
    version: '1',
    register(ctx) {
      ctx.middleware.add(errorHandler(), { priority: 0 });
      ctx.middleware.add(
        async (c, next) => {
          const tenant = c.request.headers.get('x-tenant-id');
          if (tenant !== null) c.request.tenant = { id: tenant };
          await next();
        },
        { priority: 40 },
      );
      ctx.lifecycle.onResponse((c) => {
        events.push('audit:' + c.request.path + ':' + c.request.tenant?.id);
      });
    },
  };
  const tool = (name: string, method: 'GET' | 'POST', path: string) => ({
    name,
    description: name,
    route: { method, path },
  });
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: 'm133-integration-secret-at-least-32-characters' } }),
      IdempotencyPlugin(),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      plumbing,
      McpPlugin({
        tools: [
          tool('write', 'POST', '/work/:id'),
          tool('fail', 'GET', '/fail'),
          tool('limited', 'GET', '/limited'),
          tool('waiting', 'GET', '/waiting'),
          tool('tenant', 'GET', '/tenants/:id'),
          tool('role', 'GET', '/role'),
        ],
      }),
    ],
  });
  const record: MiddlewareFunction = async (c, next) => {
    events.push('guard:' + c.request.user?.id + ':' + c.request.tenant?.id);
    await next();
  };
  const body = validateBody(z.object({ name: z.string() }));
  app.router.post('/work/:id', {
    middleware: [requireAuth(), record, body, idempotent({ namespace: 'm133-work' })],
    handler(c) {
      writes++;
      return c.response.json({
        name: body.value(c).name,
        user: c.request.user?.id,
        tenant: c.request.tenant?.id,
        id: c.params.id,
        writes,
      });
    },
  });
  app.router.get('/fail', () => {
    throw new Error('INTERNAL SECRET');
  });
  app.router.get('/limited', {
    middleware: [rateLimitMiddleware({ windowMs: 60000, max: 1 })],
    handler: (c) => c.response.json({ ok: true }),
  });
  app.router.get('/waiting', async (c) => {
    notify();
    await new Promise<void>((resolve) => {
      if (c.signal.aborted) resolve();
      else c.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    aborted = c.signal.aborted;
    return c.response.json({ aborted });
  });
  app.router.get('/tenants/:id', {
    middleware: [
      requireAuth(),
      async (c, next) => {
        if (c.params.id !== c.request.tenant?.id || c.request.tenant.id !== 't1') {
          respondWithError(c, { status: 403, title: 'Forbidden' });
          return;
        }
        await next();
      },
    ],
    handler: (c) => {
      reached++;
      return c.response.json({ ok: true });
    },
  });
  app.router.get('/role', {
    middleware: [requireRole('admin')],
    handler: (c) => {
      roleCalls++;
      return c.response.json({ ok: true });
    },
  });
  await app.start();
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  const token = await jwt.sign({ sub: 'caller' });
  return {
    app,
    events,
    token,
    started,
    writes: () => writes,
    roleCalls: () => roleCalls,
    aborted: () => aborted,
    reached: () => reached,
  };
}
it('re-enters guard, validation, tenant and audit as the same caller, and retries a POST once', async () => {
  const h = await build();
  const { client } = await clientFor(h.app, 'modern', {
    authorization: `Bearer ${h.token}`,
    'x-tenant-id': 't1',
  });
  try {
    const args = { id: 'x', name: 'Ada' };
    const first = await client.callTool({ name: 'write', arguments: args });
    const second = await client.callTool({ name: 'write', arguments: args });
    expect(second).toEqual(first);
    expect(h.writes()).toBe(1);
    expect(first.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ name: 'Ada', user: 'caller', tenant: 't1', id: 'x', writes: 1 }),
      },
    ]);
    expect(h.events.filter((x) => x === 'guard:caller:t1')).toHaveLength(2);
    expect(h.events).toContain('audit:/work/x:t1');
    const invalid = await client.callTool({ name: 'write', arguments: { id: 'x', name: 2 } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('name:');
    expect(h.writes()).toBe(1);
  } finally {
    await client.close();
    await h.app.stop();
  }
});
it('redacts thrown handlers, maps rate limits and leaves role guards on the route', async () => {
  const h = await build();
  const { client } = await clientFor(h.app, 'modern', { authorization: `Bearer ${h.token}` });
  try {
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('role');
    expect(await client.callTool({ name: 'fail', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The tool failed.' }],
    });
    expect((await client.callTool({ name: 'limited', arguments: {} })).isError).toBeUndefined();
    const limited = await client.callTool({ name: 'limited', arguments: {} });
    expect(limited.isError).toBe(true);
    expect(JSON.stringify(limited)).toContain('The request was refused (429).');
    expect((await client.callTool({ name: 'role', arguments: {} })).isError).toBe(true);
    expect(h.roleCalls()).toBe(0);
  } finally {
    await client.close();
    await h.app.stop();
  }
});
it('requires a credential again on the inner request and refuses another tenant path', async () => {
  const h = await build();
  const { client } = await clientFor(h.app, 'modern', {
    authorization: `Bearer ${h.token}`,
    'x-tenant-id': 't1',
  });
  try {
    expect(
      (await client.callTool({ name: 'tenant', arguments: { id: 't1' } })).isError,
    ).toBeUndefined();
    expect((await client.callTool({ name: 'tenant', arguments: { id: 't2' } })).isError).toBe(true);
    expect(h.reached()).toBe(1);
    const direct = await h.app.fetch(
      new Request('http://localhost/tenants/t2', {
        headers: { authorization: `Bearer ${h.token}`, 'x-tenant-id': 't1' },
      }),
    );
    expect(direct.status).toBe(403);
    await direct.text();
    const anonymous = await rpc(
      h.app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'tenant', arguments: { id: 't1' } },
      },
      { 'x-tenant-id': 't1' },
    );
    expect(anonymous.status).toBe(401);
    await anonymous.text();
  } finally {
    await client.close();
    await h.app.stop();
  }
});
it('stripping the inner credential makes the guarded call anonymous', async () => {
  const h = await build();
  // Add the stripping middleware at construction in a separate application: the outer call still authenticates.
  await h.app.stop();
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: 'm133-negative-control-secret-at-least-32' } }),
      {
        name: 'strip',
        version: '1',
        register(ctx) {
          ctx.middleware.add(
            async (c, next) => {
              if (c.request.path !== '/mcp') c.request.headers.delete('authorization');
              await next();
            },
            { priority: 200 },
          );
        },
      },
      McpPlugin({
        tools: [
          { name: 'secret', description: 'secret', route: { method: 'GET', path: '/secret' } },
        ],
      }),
    ],
  });
  let calls = 0;
  app.router.get('/secret', {
    middleware: [requireAuth()],
    handler: (c) => {
      calls++;
      return c.response.json({ ok: true });
    },
  });
  await app.start();
  const token = await app.services.get<IJwtService>(CAPABILITIES.JWT).sign({ sub: 'caller' });
  const { client } = await clientFor(app, 'modern', { authorization: `Bearer ${token}` });
  try {
    expect((await client.listTools()).tools).toHaveLength(1);
    expect((await client.callTool({ name: 'secret', arguments: {} })).isError).toBe(true);
    expect(calls).toBe(0);
  } finally {
    await client.close();
    await app.stop();
  }
});
it('propagates the client request abort to the inner route signal', async () => {
  const h = await build();
  const controller = new AbortController();
  try {
    const pending = rpc(
      h.app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'waiting', arguments: {} } },
      {},
      controller.signal,
    );
    await h.started;
    controller.abort();
    const response = await pending;
    await response.text();
    expect(h.aborted()).toBe(true);
  } finally {
    await h.app.stop();
  }
});

it('times out a tool call and aborts the route context signal', async () => {
  const release = Promise.withResolvers<void>();
  let aborted = false;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      McpPlugin({
        timeoutMs: 20,
        tools: [
          {
            name: 'deadline',
            description: 'Wait for the per-call deadline',
            route: { method: 'GET', path: '/deadline' },
          },
        ],
      }),
    ],
  });
  app.router.get('/deadline', async (ctx) => {
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
    aborted = ctx.signal.aborted;
    return ctx.response.json({ aborted });
  });
  await app.start();
  const { client } = await clientFor(app);
  const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  // A bounded negative control: without the plugin deadline, release the route so the failing test can stop its app.
  const safety = runtime.setTimeout(() => release.resolve(), 1000);
  try {
    const result = await client.callTool({ name: 'deadline', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'The tool timed out.' }]);
    expect(aborted).toBe(true);
  } finally {
    runtime.clearTimeout(safety);
    release.resolve();
    await client.close();
    await app.stop();
  }
});
