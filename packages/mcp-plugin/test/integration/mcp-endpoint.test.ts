import { brandErrorResponder } from '@setu-ts/common';
import type { MiddlewareFunction } from '@setu-ts/common';
import { it, expect } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IPluginContext } from '@setu-ts/common';
import { McpPlugin } from '../../src/index.ts';
import { appFor, clientFor, rpcResult } from './app.ts';
import { BASE, declaration } from '../fixtures.ts';
it.each(['GET', 'DELETE'])('answers 405 for %s', async (method) => {
  const app = await appFor();
  try {
    const r = await app.fetch(new Request(`${BASE}/mcp`, { method }));
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  } finally {
    await app.stop();
  }
});
it('checks Origin before reading a malformed body', async () => {
  const app = await appFor();
  try {
    const r = await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: 'bad',
      }),
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'Forbidden' });
  } finally {
    await app.stop();
  }
});
it('leaves parse errors to the SDK', async () => {
  const app = await appFor();
  try {
    const r = await app.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: 'bad',
      }),
    );
    expect((await rpcResult(r)).error).toMatchObject({ code: -32700 });
  } finally {
    await app.stop();
  }
});
it.each(['legacy', 'modern'] as const)(
  'lists through the real %s client and preserves SSE',
  async (mode) => {
    const app = await appFor({ instructions: 'Use tools' });
    const { client, responses } = await clientFor(app, mode);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['read']);
      // The tool set is fixed at bootstrap, so no list-change notifications are promised.
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
      if (mode === 'legacy')
        expect(
          responses.some((r) => r.headers.get('content-type')?.includes('text/event-stream')),
        ).toBe(true);
    } finally {
      await client.close();
      await app.stop();
    }
  },
);
it('refuses startup when a route cannot bind', async () => {
  const app = createApplication({
    plugins: [RuntimePlugin(), McpPlugin({ tools: [declaration] })],
  });
  await expect(app.start()).rejects.toThrow('not registered');
  await app.stop();
});
it('refuses a non-kernel application without dispatch', async () => {
  let bootstrap: (() => void | Promise<void>) | undefined;
  const plugin = McpPlugin({ tools: [declaration] });
  plugin.register({
    app: {},
    router: { get() {}, post() {}, delete() {} },
    lifecycle: {
      onBootstrap(fn: () => void | Promise<void>) {
        bootstrap = fn;
      },
      onShutdown() {},
    },
  } as unknown as IPluginContext);
  await expect(bootstrap!()).rejects.toThrow('dispatch');
});

it.each(['stream', 'bytes', 'empty'] as const)(
  'preserves a custom %s error responder',
  async (shape) => {
    const middleware: MiddlewareFunction = async (_ctx, next) => {
      await next();
    };
    brandErrorResponder(middleware, {
      respond(target, init) {
        target.response.status(init.status);
        if (shape === 'stream')
          target.response.stream(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('refused'));
                c.close();
              },
            }),
          );
        else if (shape === 'bytes') target.response.send(new TextEncoder().encode('refused'));
        else target.response.send();
      },
    });
    const app = await appFor({}, {}, [
      {
        name: 'custom-errors',
        version: '1',
        register(ctx) {
          ctx.middleware.add(middleware);
        },
      },
    ]);
    try {
      const response = await app.fetch(
        new Request(`${BASE}/mcp`, {
          method: 'POST',
          headers: { origin: 'https://evil.test' },
          body: 'bad',
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(shape === 'empty' ? '' : 'refused');
    } finally {
      await app.stop();
    }
  },
);

it('keeps adversarial path values on the bound route through the real kernel router', async () => {
  let privateCalls = 0;
  const app = createApplication({
    plugins: [RuntimePlugin(), McpPlugin({ tools: [declaration] })],
  });
  app.router.get('/items/:id', {
    schema: { security: [] },
    handler: (ctx) => ctx.response.json({ id: ctx.params.id }),
  });
  app.router.get('/private', (ctx) => {
    privateCalls++;
    return ctx.response.json({ secret: true });
  });
  await app.start();
  const { client } = await clientFor(app);
  try {
    for (const id of ['', '.', '..'])
      expect((await client.callTool({ name: 'read', arguments: { id } })).isError).toBe(true);
    for (const id of ['%2F', '/', '%2e%2e', '../private', '%2e%2e/private']) {
      const result = await client.callTool({ name: 'read', arguments: { id } });
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ id }) }]);
    }
    expect(privateCalls).toBe(0);
  } finally {
    await client.close();
    await app.stop();
  }
});
