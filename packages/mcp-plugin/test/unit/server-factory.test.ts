import { UnusableArgumentError } from '../../src/errors.ts';
import { it, expect, vi } from 'vitest';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { IPluginContext, IPrincipal } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import {
  CALL_CONTEXT,
  createServerFactory,
  passThroughSchema,
} from '../../src/sdk/server-factory.ts';
import { resolveOptions } from '../../src/options.ts';
import { declaration, tool } from '../fixtures.ts';
import { z } from 'zod-v4';

it('carries a pass-through StandardSchemaWithJSON for both IO directions', async () => {
  const json = { type: 'object', properties: {} };
  const s = passThroughSchema(json)['~standard'];
  expect(s.version).toBe(1);
  expect(s.vendor).toBe('setu-ts');
  expect(await s.validate({ x: 1 })).toEqual({ value: { x: 1 } });
  expect(s.jsonSchema.input({ target: 'draft-2020-12' })).toBe(json);
  expect(s.jsonSchema.output({ target: 'draft-2020-12' })).toBe(json);
});
it('builds per-request visible servers with private cache hints and consumes the never-throw callback', async () => {
  const captured: ConstructorParameters<typeof McpServer>[1][] = [];
  const SpyServer = new Proxy(McpServer, {
    construct(target, args: ConstructorParameters<typeof McpServer>) {
      captured.push(args[1]);
      return new target(...args);
    },
  });
  const register = vi.spyOn(McpServer.prototype, 'registerTool');
  let callbackContext: Parameters<Parameters<typeof createMcpHandler>[0]>[0] | undefined;
  const sdk = {
    McpServer: SpyServer,
    createMcpHandler: ((factory, options) =>
      createMcpHandler((context) => {
        callbackContext = context;
        return factory(context);
      }, options)) as typeof createMcpHandler,
  };
  const dispatch = vi.fn(() =>
    Promise.resolve(
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    ),
  );
  const innerRequest = vi.fn(() => Promise.resolve(new Request('http://test/items/id')));
  const options = resolveOptions({
    tools: [{ ...declaration, title: 'Read' }],
    instructions: 'Use this',
  });
  const entry = tool(
    { schema: { response: { 200: z.object({ ok: z.boolean() }) } } },
    options.tools[0],
  );
  const hidden = { ...entry, declaration: { ...declaration, name: 'hidden' }, authenticated: true };
  const ctx = { app: { dispatch } } as unknown as IPluginContext;
  const handler = await createServerFactory(ctx, [entry, hidden], options, {
    loadSdk: () => Promise.resolve(sdk),
    innerRequest,
  });
  const request = (method: string, args?: unknown, principal?: IPrincipal, ip?: string) => {
    const raw = new Request('http://test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: method === 'tools/call' ? { name: 'read', arguments: args } : {},
      }),
    });
    CALL_CONTEXT.set(raw, {
      outer: createTestContext({
        request: {
          ...(principal === undefined ? {} : { user: principal }),
          ...(ip === undefined ? {} : { ip }),
        },
      }),
    });
    return raw;
  };
  const result = async (raw: Request) => {
    const response = await handler.fetch(raw, { parsedBody: JSON.parse(await raw.clone().text()) });
    const text = await response.text();
    return JSON.parse(
      text.startsWith('event:') ? text.split('data: ')[1]!.split('\n')[0]! : text,
    ) as { result: Record<string, unknown> };
  };
  try {
    const list = await result(request('tools/list'));
    expect(list.result.tools).toHaveLength(1);
    expect(callbackContext?.authInfo).toBeUndefined();
    expect(register).toHaveBeenCalledWith(
      'read',
      expect.objectContaining({ title: 'Read', outputSchema: expect.any(Object) }),
      expect.any(Function),
    );
    expect(captured[0]).toMatchObject({
      instructions: 'Use this',
      cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } },
    });
    expect((await result(request('tools/call', {}, undefined, '192.0.2.1'))).result).toMatchObject({
      structuredContent: { ok: true },
    });
    expect(dispatch).toHaveBeenLastCalledWith(expect.any(Request), { ip: '192.0.2.1' });
    expect(innerRequest.mock.calls).toHaveLength(1);
    dispatch.mockRejectedValueOnce(new Error('SECRET'));
    expect((await result(request('tools/call', {}))).result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The tool failed.' }],
    });
    innerRequest.mockRejectedValueOnce(new UnusableArgumentError());
    expect((await result(request('tools/call', {}))).result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The tool received an argument it cannot use.' }],
    });
    expect(
      (await result(request('tools/list', undefined, { id: 'one', roles: [] }))).result.tools,
    ).toHaveLength(2);
    const unmapped = new Request('http://test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect((await result(unmapped)).result.tools).toHaveLength(0);
  } finally {
    register.mockRestore();
    await handler.close();
  }
});
