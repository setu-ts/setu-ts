import { it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { z } from 'zod-v4';
import { withValidationMetadata } from '@setu-ts/common';
import type { IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';
import { innerRequest } from '../../src/call/inner-request.ts';
import { tool, declaration } from '../fixtures.ts';
const runtime = { subtle: webcrypto.subtle } as unknown as IRuntimeServices;
const validate = (target: 'body' | 'query', schema: unknown) =>
  withValidationMetadata<MiddlewareFunction>(() => {}, { target, schema });
const call = {
  outer: createTestContext({
    request: {
      url: 'https://app.test/mcp',
      headers: new Headers({
        authorization: 'Bearer caller',
        'x-tenant-id': 'tenant',
        origin: 'https://app.test',
        'mcp-protocol-version': '2026',
        'Mcp-Param-test': 'bad',
        'last-event-id': 'bad',
        'idempotency-key': 'outer',
        'content-length': '123',
        'content-type': 'text/plain',
        'transfer-encoding': 'chunked',
        accept: 'text/event-stream',
        'accept-encoding': 'gzip',
        connection: 'keep-alive',
        'accept-language': 'en-IN',
        'x-custom': 'forwarded',
      }),
    },
  }),
};
it('splits URL/query/body, encodes path values and filters the full transport header table', async () => {
  const c = tool(
    {
      middleware: [
        validate('query', z.object({ q: z.string(), tags: z.array(z.string()) })),
        validate('body', z.object({ name: z.string() })),
      ],
    },
    { ...declaration, route: { method: 'POST', path: '/items/:id' }, repeatable: true },
  );
  const controller = new AbortController();
  const r = await innerRequest(
    c,
    { id: 'a/b %2F', q: 'x & y', tags: ['a', 'b'], name: 'Ada' },
    call,
    controller.signal,
    runtime,
  );
  expect(r.url).toBe('https://app.test/items/a%2Fb%20%252F?q=x+%26+y&tags=a&tags=b');
  expect(await r.json()).toEqual({ name: 'Ada' });
  expect(Object.fromEntries(r.headers)).toEqual({
    accept: 'application/json',
    'accept-language': 'en-IN',
    authorization: 'Bearer caller',
    'content-type': 'application/json',
    origin: 'https://app.test',
    'x-tenant-id': 'tenant',
    'x-custom': 'forwarded',
  });
  controller.abort();
  expect(r.signal.aborted).toBe(true);
  expect(call.outer.request.headers.get('idempotency-key')).toBe('outer');
  expect(r.headers.has('idempotency-key')).toBe(false);
});
it.each(['', '.', '..'])('refuses path %s', async (id) => {
  await expect(
    innerRequest(tool(), { id }, call, new AbortController().signal, runtime),
  ).rejects.toThrow();
});
it.each(['%2e%2e', '%2F', '/', 'a?b', 'a#b'])(
  'keeps path argument %s within one encoded segment',
  async (id) => {
    const r = await innerRequest(tool(), { id }, call, new AbortController().signal, runtime);
    expect(new URL(r.url).pathname).toBe('/items/' + encodeURIComponent(id));
  },
);
it.each([null, [], { id: 'x', extra: 1 }, {}])('refuses unusable arguments %j', async (args) => {
  await expect(
    innerRequest(tool(), args, call, new AbortController().signal, runtime),
  ).rejects.toThrow();
});
it('uses query scalars, sends DELETE bodies when branded, and derives branded keys', async () => {
  const middleware = [
    validate('body', z.object({ x: z.string() })),
    validate('query', z.object({ n: z.number() })),
  ];
  const c = {
    ...tool({ middleware }, { ...declaration, route: { method: 'DELETE', path: '/items/:id' } }),
    idempotent: true,
    idempotencyKeyHeader: 'Idempotency-Key',
  };
  const r = await innerRequest(
    c,
    { id: 'x', n: 2, x: 'y' },
    call,
    new AbortController().signal,
    runtime,
  );
  expect(r.url).toBe('https://app.test/items/x?n=2');
  expect(await r.json()).toEqual({ x: 'y' });
  expect(r.headers.get('idempotency-key')).toMatch(/^mcp-[A-Za-z0-9_-]{43}$/);
  const get = await innerRequest(tool(), { id: 'x' }, call, new AbortController().signal, runtime);
  expect(get.headers.has('content-type')).toBe(false);
  expect(get.body).toBeNull();
});

it('fills a final optional path parameter, or drops its segment when omitted', async () => {
  const c = tool({}, { ...declaration, route: { method: 'GET', path: '/items/:id?' } });
  const given = await innerRequest(c, { id: 'a b' }, call, new AbortController().signal, runtime);
  expect(new URL(given.url).pathname).toBe('/items/a%20b');
  const omitted = await innerRequest(c, {}, call, new AbortController().signal, runtime);
  expect(new URL(omitted.url).pathname).toBe('/items');
});

it("sends the derived key in the route's own header, replacing a caller-sent value", async () => {
  const c = {
    ...tool(
      { middleware: [validate('body', z.object({ x: z.string() }))] },
      { ...declaration, route: { method: 'PUT', path: '/items' } },
    ),
    idempotent: true,
    idempotencyKeyHeader: 'X-Request-Key',
  };
  const outer = {
    outer: createTestContext({
      request: {
        url: 'https://api.test/mcp',
        headers: new Headers({ 'x-request-key': 'caller-chosen' }),
      },
    }),
  };
  const r = await innerRequest(c, { x: 'y' }, outer, new AbortController().signal, runtime);
  expect(r.headers.get('x-request-key')).toMatch(/^mcp-/);
  expect(r.headers.get('idempotency-key')).toBeNull();
});
