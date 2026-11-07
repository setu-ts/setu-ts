import { createConnection } from 'node:net';
import { it, expect, vi } from 'vitest';
import { z } from 'zod-v4';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IJwtService,
  IRuntimeServices,
  MiddlewareFunction,
  RouteHandler,
  TimerHandle,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, publicRoute, requireAuth } from '@setu-ts/auth-plugin';
import { IdempotencyPlugin, idempotent } from '@setu-ts/idempotency-plugin';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { unusedPort } from '../../../../test/node-helpers.ts';
import { McpPlugin, mcpTool } from '../../src/index.ts';
import { clientFor } from './app.ts';

/** Raw Host and Origin fields must reach the real Node listener unchanged. */
function rawPost(port: number, origin: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('Raw MCP probe timed out.')));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.once('connect', () =>
      socket.write(
        [
          'POST /mcp HTTP/1.1',
          'Host: rebind.attacker.example:' + port,
          ...(origin === null ? [] : ['Origin: ' + origin]),
          'Content-Type: application/json',
          'Accept: application/json, text/event-stream',
          'Content-Length: 8',
          'Connection: close',
          '',
          'not-json',
        ].join('\r\n'),
      ),
    );
  });
}

it('O17 refuses rebinding Host plus Origin on a real loopback listener before parsing', async () => {
  const port = await unusedPort();
  const listed = 'http://127.0.0.1:' + port;
  const app = createApplication({
    plugins: [RuntimePlugin(), McpPlugin({ allowedOrigins: [listed] })],
  });
  app.router.get('/value', {
    middleware: [publicRoute(), mcpTool({ name: 'value', description: 'Read value' })],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  await app.start({ port, hostname: '127.0.0.1' });
  try {
    const rebinding = await rawPost(port, 'http://rebind.attacker.example:' + port);
    expect(rebinding).toMatch(/^HTTP\/1\.1 403 /);
    expect(rebinding).toContain('Forbidden');
    expect(rebinding).not.toContain('-32700');
    for (const origin of [listed, null]) {
      const control = await rawPost(port, origin);
      expect(control).not.toMatch(/^HTTP\/1\.1 403 /);
      expect(control).toContain('-32700');
    }
  } finally {
    await app.stop();
  }
});

it.each([false, true])(
  'O18 idempotency requires an authenticating brand: %s',
  async (authenticated) => {
    const app = createApplication({
      plugins: [RuntimePlugin(), IdempotencyPlugin(), ValidationPlugin(), McpPlugin({})],
    });
    app.router.post('/write', {
      middleware: [
        publicRoute(),
        ...(authenticated ? [requireAuth()] : []),
        validateBody(z.object({})),
        idempotent({ principal: 'optional' }),
        mcpTool({ name: 'write', description: 'Write' }),
      ],
      handler: (ctx) => ctx.response.json({ ok: true }),
    });
    try {
      if (authenticated) await expect(app.start()).resolves.toBeUndefined();
      else
        await expect(app.start()).rejects.toThrow(
          'MCP idempotency requires an authenticating security brand: POST /write',
        );
    } finally {
      await app.stop();
    }
  },
);

it('O18 identical arguments replay only within the same principal', async () => {
  let writes = 0;
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: 'm133-audit-secret-at-least-32-characters' } }),
      IdempotencyPlugin(),
      ValidationPlugin(),
      McpPlugin({}),
    ],
  });
  const body = validateBody(z.object({ value: z.string() }));
  app.router.post('/write', {
    middleware: [
      requireAuth(),
      body,
      idempotent({ principal: 'optional' }),
      mcpTool({ name: 'write', description: 'Write' }),
    ],
    handler: (ctx) => ctx.response.json({ user: ctx.request.user!.id, writes: ++writes }),
  });
  await app.start();
  try {
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    for (const [user, count] of [
      ['one', 1],
      ['two', 2],
    ] as const) {
      const token = await jwt.sign({ sub: user });
      const { client } = await clientFor(app, 'modern', { authorization: 'Bearer ' + token });
      try {
        const result = await client.callTool({ name: 'write', arguments: { value: 'same' } });
        expect(result.isError).toBeUndefined();
        expect(result.content).toEqual([
          { type: 'text', text: JSON.stringify({ user, writes: count }) },
        ]);
        expect(
          await client.callTool({ name: 'write', arguments: { value: 'same' } }),
        ).toMatchObject(result);
      } finally {
        await client.close();
      }
    }
    expect(writes).toBe(2);
  } finally {
    await app.stop();
  }
});

it.each(['static sibling', 'MCP endpoint'] as const)(
  'O19 pins dynamic tools away from the %s',
  async (target) => {
    const sibling = vi.fn<RouteHandler>((ctx) => ctx.response.json({ exported: true }));
    const siblingMiddleware = vi.fn<MiddlewareFunction>(async (_ctx, next) => {
      await next();
    });
    const app = createApplication({
      plugins: [RuntimePlugin(), ValidationPlugin(), McpPlugin({})],
    });
    app.router.get('/files/:name', {
      middleware: [publicRoute(), mcpTool({ name: 'files', description: 'Read file' })],
      handler: (ctx) => ctx.response.json({ name: ctx.params.name }),
    });
    app.router.get('/files/export', { middleware: [siblingMiddleware], handler: sibling });
    app.router.post('/:slug', {
      middleware: [
        publicRoute(),
        validateBody(z.object({})),
        mcpTool({ name: 'post', description: 'Post', repeatable: true }),
      ],
      handler: (ctx) =>
        ctx.response.json({
          slug: ctx.params.slug,
          key: ctx.request.headers.get('idempotency-key'),
        }),
    });
    await app.start();
    const endpoint = app.router
      .listRoutes()
      .find((route) => route.method === 'POST' && route.path === '/mcp')!;
    const endpointHandler = vi.spyOn(endpoint.definition, 'handler');
    const { client } = await clientFor(app);
    try {
      const refused = {
        isError: true,
        content: [{ type: 'text', text: 'Not Found' }],
      };
      if (target === 'static sibling') {
        expect(
          await client.callTool({ name: 'files', arguments: { name: 'export' } }),
        ).toMatchObject(refused);
        expect(sibling).not.toHaveBeenCalled();
        expect(siblingMiddleware).not.toHaveBeenCalled();
        expect(
          (await client.callTool({ name: 'files', arguments: { name: 'plain' } })).content,
        ).toEqual([{ type: 'text', text: '{"name":"plain"}' }]);
      } else {
        const before = endpointHandler.mock.calls.length;
        expect(await client.callTool({ name: 'post', arguments: { slug: 'mcp' } })).toMatchObject(
          refused,
        );
        expect(endpointHandler).toHaveBeenCalledTimes(before + 1);
        expect(
          (await client.callTool({ name: 'post', arguments: { slug: 'plain' } })).content,
        ).toEqual([{ type: 'text', text: '{"slug":"plain","key":null}' }]);
      }
    } finally {
      await client.close();
      await app.stop();
    }
  },
);

it('O20 cancels a trickling stream at the deadline and reads a fast stream fully', async () => {
  let pulls = 0;
  let ended = false;
  let timer: TimerHandle | undefined;
  let wake: (() => void) | undefined;
  let close: () => void = () => {};
  const cancel = vi.fn();
  const fastCancel = vi.fn();
  const app = createApplication({ plugins: [RuntimePlugin(), McpPlugin({ timeoutMs: 150 })] });
  app.router.get('/slow', {
    middleware: [publicRoute(), mcpTool({ name: 'slow', description: 'Slow stream' })],
    handler: (ctx) =>
      ctx.response.header('content-type', 'text/plain').stream(
        new ReadableStream<Uint8Array>({
          start(controller) {
            close = () => {
              if (ended) return;
              ended = true;
              if (timer !== undefined) runtime.clearTimeout(timer);
              wake?.();
              controller.close();
            };
          },
          async pull(controller) {
            pulls++;
            await new Promise<void>((resolve) => {
              wake = resolve;
              timer = runtime.setTimeout(resolve, 20);
            });
            if (!ended) controller.enqueue(new Uint8Array([65]));
          },
          cancel() {
            ended = true;
            if (timer !== undefined) runtime.clearTimeout(timer);
            wake?.();
            cancel();
          },
        }),
      ),
  });
  app.router.get('/fast', {
    middleware: [publicRoute(), mcpTool({ name: 'fast', description: 'Fast stream' })],
    handler: (ctx) =>
      ctx.response.header('content-type', 'text/plain').stream(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const value of [65, 66, 67]) controller.enqueue(new Uint8Array([value]));
            controller.close();
          },
          cancel: fastCancel,
        }),
      ),
  });
  await app.start();
  const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const { client } = await clientFor(app);
  try {
    expect(await client.callTool({ name: 'slow', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The tool timed out.' }],
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    const stopped = pulls;
    expect(stopped).toBeGreaterThan(1);
    await new Promise<void>((resolve) => runtime.setTimeout(resolve, 100));
    expect(pulls).toBe(stopped);
    expect(await client.callTool({ name: 'fast', arguments: {} })).toMatchObject({
      content: [{ type: 'text', text: 'ABC' }],
    });
    expect(fastCancel).not.toHaveBeenCalled();
  } finally {
    close();
    await client.close();
    await app.stop();
  }
});
