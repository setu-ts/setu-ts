import { afterEach, it, expect, vi } from 'vitest';
import { mcpToolMetadataOf } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestContext } from '@setu-ts/testing';
import {
  ApiOperation,
  Controller,
  DecoratorPlugin,
  Get,
  McpTool,
  Public,
} from '../../src/index.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';

afterEach(() => metadataStore.clear());

it('records only method metadata and preserves the declared fields', () => {
  @Controller('/orders')
  class C {
    @Get('/')
    @McpTool({ name: 'read', description: 'Read', title: 'Order', repeatable: true })
    read() {
      return {};
    }
    @Get('/other')
    other() {
      return {};
    }
  }
  expect(metadataStore.getRoutesFor(C).map((route) => route.mcpTool)).toEqual([
    { name: 'read', description: 'Read', title: 'Order', repeatable: true },
    undefined,
  ]);
  expect(() => McpTool()(C, { kind: 'class' } as unknown as ClassMethodDecoratorContext)).toThrow(
    'requires a method',
  );
});

it('appends one pass-through brand with explicit, operationId and method names', async () => {
  @Controller('/orders')
  class C {
    @Get('/explicit')
    @Public()
    @ApiOperation({ operationId: 'ignored', description: 'Schema description' })
    @McpTool({ name: 'explicit', description: 'Explicit', title: 'Display', repeatable: true })
    explicit() {
      return {};
    }

    @Get('/operation')
    @Public()
    @ApiOperation({ operationId: 'operation', summary: 'Read by operation' })
    @McpTool()
    operation() {
      return {};
    }

    @Get('/method')
    @Public()
    @McpTool({ description: 'Read by method' })
    method() {
      return {};
    }

    @Get('/plain')
    plain() {
      return {};
    }
  }
  const app = createApplication({
    plugins: [RuntimePlugin(), DecoratorPlugin({ controllers: [C] })],
  });
  try {
    await app.start();
    const routes = app.router.listRoutes();
    for (const [path, meta] of [
      [
        '/orders/explicit',
        { name: 'explicit', description: 'Explicit', title: 'Display', repeatable: true },
      ],
      ['/orders/operation', { name: 'operation' }],
      ['/orders/method', { name: 'method', description: 'Read by method' }],
    ] as const) {
      const route = routes.find((entry) => entry.path === path)!;
      const branded = route.definition.middleware!.filter(
        (fn) => mcpToolMetadataOf(fn) !== undefined,
      );
      expect(branded).toHaveLength(1);
      expect(mcpToolMetadataOf(branded[0]!)).toEqual(meta);
      expect(route.definition.schema?.security).toEqual([]);
      const next = vi.fn(() => Promise.resolve());
      await branded[0]!(createTestContext(), next);
      expect(next).toHaveBeenCalledOnce();
    }
    expect(
      routes.find((entry) => entry.path === '/orders/plain')!.definition.middleware,
    ).toBeUndefined();
  } finally {
    await app.stop();
  }
});
