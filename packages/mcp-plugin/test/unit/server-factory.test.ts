import { UnusableArgumentError } from '../../src/errors.ts';
import { afterEach, it, expect, vi } from 'vitest';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createFakeRuntime } from '../../../auth-plugin/test/fixtures/fake-runtime.ts';
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
import type { FactoryDeps } from '../../src/sdk/server-factory.ts';

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
  const ctx = { app: { dispatch }, runtime: createFakeRuntime(0) } as unknown as IPluginContext;
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
    expect(dispatch).toHaveBeenLastCalledWith(expect.any(Request), {
      ip: '192.0.2.1',
      route: '/items/:id',
    });
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The real SDK registration surface, invoked directly so only the runtime clock drives calls. */
async function timedCall(dispatch: (request: Request) => Promise<Response>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const runtime = createFakeRuntime(0);
  const clearTimer = runtime.clearTimeout.bind(runtime);
  const schedule = vi.spyOn(runtime, 'setTimeout');
  const clear = vi.spyOn(runtime, 'clearTimeout');
  const register = vi.spyOn(McpServer.prototype, 'registerTool');
  let factory: Parameters<typeof createMcpHandler>[0] | undefined;
  const sdk = {
    McpServer,
    createMcpHandler: ((build, options) => {
      factory = build;
      return createMcpHandler(build, options);
    }) as typeof createMcpHandler,
  };
  const raw = new Request('http://test/mcp');
  CALL_CONTEXT.set(raw, { outer: createTestContext() });
  let innerSignal: AbortSignal | undefined;
  const innerRequest = vi.fn((...args: Parameters<FactoryDeps['innerRequest']>) => {
    innerSignal = args[3];
    return Promise.resolve(new Request('http://test/items/id', { signal: args[3] }));
  });
  const handler = await createServerFactory(
    { app: { dispatch }, runtime } as unknown as IPluginContext,
    [tool()],
    resolveOptions({ tools: [declaration], timeoutMs: 25 }),
    { loadSdk: () => Promise.resolve(sdk), innerRequest },
  );
  const server = await factory!({ era: 'modern', requestInfo: raw });
  const callback = register.mock.calls[0]![2];
  return {
    runtime,
    schedule,
    clear,
    clearTimer,
    innerRequest,
    signal: () => innerSignal,
    invoke: (signal = new AbortController().signal) =>
      Promise.resolve(callback({}, { mcpReq: { signal } } as Parameters<typeof callback>[1])),
    async close() {
      CALL_CONTEXT.delete(raw);
      await server.close();
      await handler.close();
    },
  };
}

const TIMED_OUT = { isError: true, content: [{ type: 'text', text: 'The tool timed out.' }] };
const CLIENT_ABORTED = { isError: true, content: [{ type: 'text', text: 'The tool failed.' }] };

it('times out a hung dispatch and aborts the inner request signal', async () => {
  const started = Promise.withResolvers<void>();
  let request: Request | undefined;
  const h = await timedCall((inner) => {
    request = inner;
    started.resolve();
    return new Promise<Response>((resolve) => {
      inner.signal.addEventListener(
        'abort',
        () => resolve(new Response('cooperative completion')),
        { once: true },
      );
    });
  });
  try {
    let result: Awaited<ReturnType<typeof h.invoke>> | undefined;
    const pending = h.invoke().then((value) => {
      result = value;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(24);
    expect(result).toBeUndefined();
    expect(request!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual(TIMED_OUT);
    await pending;
    expect(request!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.close();
  }
});

it('answers at the deadline when dispatch ignores its signal, and absorbs its late rejection', async () => {
  const dispatch = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const h = await timedCall(() => {
    started.resolve();
    return dispatch.promise;
  });
  try {
    let result: Awaited<ReturnType<typeof h.invoke>> | undefined;
    const pending = h.invoke().then((value) => {
      result = value;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(result).toEqual(TIMED_OUT);
    await pending;
    expect(h.signal()!.aborted).toBe(true);
    dispatch.reject(new Error('LATE SECRET'));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(TIMED_OUT);
  } finally {
    dispatch.resolve(new Response());
    await h.close();
  }
});

it('also races an unfinished result read against the same deadline', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const started = Promise.withResolvers<void>();
  const h = await timedCall(() => {
    started.resolve();
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/plain' } },
      ),
    );
  });
  try {
    let result: Awaited<ReturnType<typeof h.invoke>> | undefined;
    h.invoke().then((value) => {
      result = value;
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(result).toEqual(TIMED_OUT);
    expect(h.signal()!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(cancelled).toBe(true);
  } finally {
    if (!cancelled) stream?.close();
    await h.close();
  }
});

it('clears its timer and client listener after a fast call', async () => {
  const h = await timedCall(() =>
    Promise.resolve(new Response('fast', { headers: { 'content-type': 'text/plain' } })),
  );
  const client = new AbortController();
  try {
    const pending = h.invoke(client.signal);
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), 25);
    expect(vi.getTimerCount()).toBe(1);
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'fast' }] });
    expect(h.clear).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    client.abort();
    expect(h.signal()!.aborted).toBe(false);
  } finally {
    await h.close();
  }
});

it.each([false, true])(
  'cancels a client-aborted response read without leaking a cancel failure: %s',
  async (rejectCancel) => {
    const started = Promise.withResolvers<void>();
    const cancel = vi.fn(() =>
      rejectCancel ? Promise.reject(new Error('CANCEL SECRET')) : Promise.resolve(),
    );
    const h = await timedCall(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              started.resolve();
            },
            cancel,
          }),
        ),
      ),
    );
    const client = new AbortController();
    try {
      const pending = h.invoke(client.signal);
      await started.promise;
      await vi.advanceTimersByTimeAsync(0);
      client.abort();
      expect(await pending).toEqual(CLIENT_ABORTED);
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      await h.close();
    }
  },
);

it('answers a client abort as failed even when dispatch ignores the signal', async () => {
  const started = Promise.withResolvers<void>();
  const h = await timedCall(() => {
    started.resolve();
    return new Promise<Response>(() => {});
  });
  const client = new AbortController();
  try {
    let result: Awaited<ReturnType<typeof h.invoke>> | undefined;
    h.invoke(client.signal).then((value) => {
      result = value;
    });
    await started.promise;
    expect(h.signal()).not.toBe(client.signal);
    client.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(CLIENT_ABORTED);
    expect(h.signal()!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.close();
  }
});

it('does no inner work when the client was already aborted', async () => {
  const dispatch = vi.fn(() => Promise.resolve(new Response()));
  const h = await timedCall(dispatch);
  const client = new AbortController();
  client.abort();
  try {
    expect(await h.invoke(client.signal)).toEqual(CLIENT_ABORTED);
    expect(h.innerRequest).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.close();
  }
});

it.each(['client', 'deadline'] as const)(
  'keeps the first abort classification when %s fires first',
  async (first) => {
    const started = Promise.withResolvers<void>();
    const h = await timedCall(() => {
      started.resolve();
      return new Promise<Response>(() => {});
    });
    const client = new AbortController();
    try {
      let result: Awaited<ReturnType<typeof h.invoke>> | undefined;
      h.invoke(client.signal).then((value) => {
        result = value;
      });
      await started.promise;
      if (first === 'client') client.abort();
      vi.advanceTimersByTime(25);
      if (first === 'deadline') client.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toEqual(first === 'client' ? CLIENT_ABORTED : TIMED_OUT);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await h.close();
    }
  },
);

it('contains a runtime timer setup failure without leaking its message', async () => {
  const h = await timedCall(() => Promise.resolve(new Response('fast')));
  h.schedule.mockImplementation(() => {
    throw new Error('TIMER SECRET');
  });
  try {
    expect(await h.invoke()).toEqual(CLIENT_ABORTED);
    expect(h.innerRequest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.close();
  }
});

it('contains a timer cleanup failure without throwing into the SDK', async () => {
  const h = await timedCall(() => Promise.resolve(new Response('fast')));
  h.clear.mockImplementationOnce((handle) => {
    h.clearTimer(handle);
    throw new Error('CLEANUP SECRET');
  });
  try {
    expect(await h.invoke()).toEqual(CLIENT_ABORTED);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.close();
  }
});
