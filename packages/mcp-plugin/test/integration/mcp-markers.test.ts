import { afterEach, it, expect, vi } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, publicRoute, requireScopes } from '@setu-ts/auth-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import {
  ApiOperation,
  Controller,
  DecoratorPlugin,
  Get,
  Inject,
  Injectable,
  McpTool,
  Param,
  Params,
  Public,
  UseGuards,
  metadataStore,
} from '@setu-ts/decorator-plugin';
import { McpPlugin, mcpTool } from '../../src/index.ts';
import { clientFor, rpc } from './app.ts';

afterEach(() => metadataStore.clear());

it('discovers functional and DI controller tools, filters scopes, and re-enters the injected controller', async () => {
  const serviceCall = vi.fn((id: string) => ({ id, source: 'injected service' }));
  @Injectable({ token: 'orders-service' })
  class OrdersService {
    read(id: string) {
      return serviceCall(id);
    }
  }
  @Controller('/orders')
  @Inject('orders-service')
  class OrdersController {
    constructor(readonly orders: OrdersService) {}
    @Get('/:id')
    @McpTool()
    @ApiOperation({ operationId: 'read_order', summary: 'Read an order' })
    @UseGuards(requireScopes('orders:read'))
    @Params(Param('id'))
    read(id: string) {
      return this.orders.read(id);
    }
  }
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiPlugin(),
      AuthPlugin({
        jwt: { secret: 'm133-markers-secret-at-least-32-characters' },
        resourceServer: { resource: 'http://localhost', scopesSupported: ['orders:read'] },
      }),
      DecoratorPlugin({ controllers: [OrdersController], services: [OrdersService] }),
      McpPlugin({}),
    ],
  });
  app.router.get('/status', {
    middleware: [publicRoute(), mcpTool({ name: 'status', description: 'Read status' })],
    handler: (ctx) => ctx.response.json({ ok: true }),
  });
  await app.start();
  try {
    const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
    const allowed = await jwt.sign({ sub: 'reader', scope: 'orders:read' });
    const other = await jwt.sign({ sub: 'other', scope: 'orders:write' });
    for (const [token, expected] of [
      ['', ['status']],
      [other, ['status']],
      [allowed, ['read_order', 'status']],
    ] as const) {
      const { client } = await clientFor(
        app,
        'modern',
        token ? { authorization: 'Bearer ' + token } : {},
      );
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(expected);
        const status = await client.callTool({ name: 'status', arguments: {} });
        expect(status.isError).toBeUndefined();
        expect(status.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
        if (token === allowed) {
          const result = await client.callTool({ name: 'read_order', arguments: { id: 'one' } });
          expect(result.isError).toBeUndefined();
          expect(result.content).toEqual([
            { type: 'text', text: '{"id":"one","source":"injected service"}' },
          ]);
        } else expect(serviceCall).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    }
    expect(serviceCall).toHaveBeenCalledExactlyOnceWith('one');
    const denied = await rpc(
      app,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'read_order', arguments: { id: 'two' } },
      },
      { authorization: 'Bearer ' + other },
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('orders:read');
    await denied.text();
    expect(serviceCall).toHaveBeenCalledOnce();
  } finally {
    await app.stop();
  }
});

it('accepts decorator @Public as explicit intent and resolves the method name', async () => {
  @Controller('/public')
  class C {
    @Get('/')
    @Public()
    @McpTool({ description: 'Public status' })
    status() {
      return { public: true };
    }
  }
  const app = createApplication({
    plugins: [RuntimePlugin(), DecoratorPlugin({ controllers: [C] }), McpPlugin({})],
  });
  await app.start();
  const { client } = await clientFor(app);
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['status']);
    expect((await client.callTool({ name: 'status', arguments: {} })).content).toEqual([
      { type: 'text', text: '{"public":true}' },
    ]);
  } finally {
    await client.close();
    await app.stop();
  }
});

it.each(['marked', 'listed'] as const)(
  'refuses startup for a %s route without security intent',
  async (source) => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        McpPlugin(
          source === 'marked'
            ? {}
            : {
                tools: [
                  {
                    name: 'unsafe',
                    description: 'Unsafe',
                    route: { method: 'GET', path: '/unsafe' },
                  },
                ],
              },
        ),
      ],
    });
    app.router.get('/unsafe', {
      ...(source === 'marked'
        ? { middleware: [mcpTool({ name: 'unsafe', description: 'Unsafe' })] }
        : {}),
      handler: (ctx) => ctx.response.json({}),
    });
    try {
      await expect(app.start()).rejects.toThrow(
        'GET /unsafe: MCP route requires declared security intent.',
      );
    } finally {
      await app.stop();
    }
  },
);
