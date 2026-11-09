import { describe, expect, it } from 'vitest';
import type { IRequestContext } from '@setu-ts/common';
import { CSRF_EXEMPT_STATE_KEY } from '@setu-ts/common';
import { csrfExempt } from '../../src/serve/csrf-exempt.ts';
import { McpPlugin } from '../../src/index.ts';
import type { IPluginContext, MiddlewareFunction, MiddlewareOptions } from '@setu-ts/common';

describe('M139a exact MCP CSRF marker', () => {
  it('registers the marker at priority 320 under its fixed name', async () => {
    const added: { fn: MiddlewareFunction; options?: MiddlewareOptions }[] = [];
    const ctx = {
      middleware: {
        add: (fn: MiddlewareFunction, options?: MiddlewareOptions) =>
          added.push({ fn, ...(options === undefined ? {} : { options }) }),
      },
      lifecycle: { onBootstrap: () => {}, onShutdown: () => {} },
      router: { get: () => {}, delete: () => {}, post: () => {} },
    } as unknown as IPluginContext;
    await McpPlugin({ tools: [], path: '/custom' }).register(ctx);
    expect(added).toHaveLength(1);
    expect(added[0]!.options).toEqual({ name: 'mcp-csrf-exempt', priority: 320 });
  });
  it.each([
    ['POST', '/mcp', true],
    ['GET', '/mcp', false],
    ['POST', '/mcp/', false],
    ['POST', '/mcp/extra', false],
    ['POST', '/MCP', false],
    ['POST', '/%6Dcp', false],
    ['POST', '/custom', false],
  ] as const)('%s %s exempt: %j', async (method, path, exempt) => {
    const ctx = { state: new Map(), request: { method, path } } as unknown as IRequestContext;
    let continued = false;
    await csrfExempt('/mcp')(ctx, () => {
      continued = true;
      return Promise.resolve();
    });
    expect(ctx.state.get(CSRF_EXEMPT_STATE_KEY)).toBe(exempt ? true : undefined);
    expect(continued).toBe(true);
  });
  it('uses a configured custom path', async () => {
    const ctx = {
      state: new Map(),
      request: { method: 'POST', path: '/custom' },
    } as unknown as IRequestContext;
    await csrfExempt('/custom')(ctx, () => Promise.resolve());
    expect(ctx.state.get(CSRF_EXEMPT_STATE_KEY)).toBe(true);
  });
});
