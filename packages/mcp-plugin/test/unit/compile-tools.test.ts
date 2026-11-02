import { describe, it, expect } from 'vitest';
import { z } from 'zod-v4';
import {
  withIdempotencyMetadata,
  withSecurityMetadata,
  withValidationMetadata,
  withResponseMetadata,
} from '@setu-ts/common';
import type { MiddlewareFunction, RouteDefinition } from '@setu-ts/common';
import { compileTools } from '../../src/compile/compile-tools.ts';
import { mergeInput, toJsonSchema } from '../../src/compile/json-schema.ts';
import { declaration, tool } from '../fixtures.ts';
const validate = (target: 'body' | 'params' | 'query', schema: unknown) =>
  withValidationMetadata<MiddlewareFunction>(
    async (_ctx, next) => {
      await next();
    },
    { target, schema },
  );
const schema = (value: unknown) => ({ toJSONSchema: () => value });
const post = {
  ...declaration,
  route: { method: 'POST' as const, path: '/items/:id' },
  repeatable: true as const,
};
describe('tool compiler', () => {
  it('binds exact method/pattern and requires the route', () => {
    expect(() => compileTools([declaration], [])).toThrow('not registered');
    expect(() =>
      compileTools(
        [declaration],
        [
          {
            method: 'POST',
            path: declaration.route.path,
            definition: { handler: (ctx) => ctx.response.send() },
          },
        ],
      ),
    ).toThrow();
    expect(tool().schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });
  it('merges branded params/query/body, using the last brand, required union and body setting', () => {
    const compiled = tool(
      {
        middleware: [
          validate('params', z.object({ id: z.string().min(2) })),
          validate('query', z.object({ old: z.string() })),
          validate(
            'query',
            z.object({ q: z.string(), tags: z.array(z.string()), page: z.number().optional() }),
          ),
          validate('body', z.object({ value: z.boolean() }).passthrough()),
        ],
      },
      post,
    );
    expect(compiled.sources).toEqual({
      id: 'path',
      q: 'query',
      tags: 'query',
      page: 'query',
      value: 'body',
    });
    expect(compiled.schema.required).toEqual(['id', 'q', 'tags', 'value']);
    expect(compiled.schema.additionalProperties).toBe(false);
    expect(Object.isFrozen(compiled.schema)).toBe(true);
    expect((compiled.schema.properties as Record<string, unknown>).id).toMatchObject({
      minLength: 2,
    });
  });
  it.each([
    [new Map([['body', {}]]), 'Zod'],
    [
      new Map([
        [
          'body',
          {
            toJSONSchema() {
              throw new Error('no');
            },
          },
        ],
      ]),
      'convert',
    ],
    [new Map([['body', schema(null)]]), 'convert'],
    [new Map([['body', z.string()]]), 'object'],
    [new Map([['query', z.string()]]), 'object'],
    [new Map([['params', z.string()]]), 'object'],
    [new Map([['query', z.object({ id: z.string() })]]), 'collision'],
    [new Map([['body', z.object({ id: z.string() })]]), 'collision'],
    [
      new Map([
        ['query', z.object({ q: z.string() })],
        ['body', z.object({ q: z.string() })],
      ]),
      'collision',
    ],
    [new Map([['query', z.object({ q: z.object({ x: z.string() }) })]]), 'scalar'],
    [new Map([['query', z.object({ q: z.array(z.object({ x: z.string() })) })]]), 'scalar'],
    [
      new Map([
        ['body', schema({ type: 'object', properties: {}, $defs: {} })],
        ['query', schema({ type: 'object', properties: {}, $defs: {} })],
      ]),
      '$defs',
    ],
  ])('refuses input %j', (brands, message) => {
    expect(() => mergeInput('/items/:id', brands)).toThrow(message);
  });
  it('hoists definitions and ignores malformed required entries', () => {
    for (const source of ['body', 'query', 'params']) {
      const result = mergeInput(
        '/:id',
        new Map([
          [
            source,
            schema({
              type: 'object',
              properties: {},
              required: [1],
              $defs: { X: { type: 'string' } },
            }),
          ],
        ]),
      );
      expect(result.schema.$defs).toEqual({ X: { type: 'string' } });
    }
    expect(toJsonSchema(z.object({}), 'input').type).toBe('object');
  });
  it.each(['POST', 'PUT', 'PATCH'] as const)('refuses %s without body validation', (method) => {
    expect(() => tool({}, { ...post, route: { ...post.route, method } })).toThrow(
      'body validation',
    );
  });
  it.each(['POST', 'PATCH'] as const)('requires retry safety on %s', (method) => {
    const decl = { ...declaration, route: { ...declaration.route, method } };
    const middleware = [validate('body', z.object({ value: z.string() }))];
    expect(() => tool({ middleware }, decl)).toThrow('retry safety');
    expect(tool({ middleware }, { ...decl, repeatable: true }).annotations.idempotentHint).toBe(
      true,
    );
    expect(
      tool(
        {
          middleware: [
            ...middleware,
            withSecurityMetadata<MiddlewareFunction>(() => {}, { authenticated: true }),
            withIdempotencyMetadata<MiddlewareFunction>(() => {}, {
              idempotent: true,
              keyHeader: 'Idempotency-Key',
            }),
          ],
        },
        decl,
      ).idempotent,
    ).toBe(true);
  });
  it('advertises a closed schema even when the body schema allows extra properties', () => {
    const middleware = [validate('body', z.object({ value: z.string() }).loose())];
    expect(tool({ middleware }, post).schema.additionalProperties).toBe(false);
  });
  it('treats a final optional path parameter as not required', () => {
    const compiled = tool({}, { ...declaration, route: { method: 'GET', path: '/items/:id?' } });
    expect(compiled.sources).toEqual({ id: 'path' });
    expect(compiled.schema.required).toEqual([]);
  });
  it('records the idempotency key header and refuses a key MCP cannot supply', () => {
    const auth = withSecurityMetadata<MiddlewareFunction>(() => {}, { authenticated: true });
    const body = validate('body', z.object({ value: z.string() }));
    const decl = { ...declaration, route: { ...declaration.route, method: 'POST' as const } };
    const custom = tool(
      {
        middleware: [
          auth,
          body,
          withIdempotencyMetadata<MiddlewareFunction>(() => {}, {
            idempotent: true,
            keyHeader: 'X-Request-Key',
          }),
        ],
      },
      decl,
    );
    expect(custom.idempotencyKeyHeader).toBe('X-Request-Key');
    // A body-field or function key source leaves no header in the brand: a retry
    // through MCP would run the handler again, so startup refuses it.
    expect(() =>
      tool(
        {
          middleware: [
            auth,
            body,
            withIdempotencyMetadata<MiddlewareFunction>(() => {}, { idempotent: true }),
          ],
        },
        { ...decl, repeatable: true },
      ),
    ).toThrow('cannot supply a body-field or function idempotency key');
  });
  it.each(['GET', 'PUT', 'DELETE'] as const)('derives annotations for %s', (method) => {
    const c = tool(
      { middleware: method === 'PUT' ? [validate('body', z.object({}))] : [] },
      { ...declaration, route: { ...declaration.route, method } },
    );
    expect(c.annotations).toEqual({ readOnlyHint: method === 'GET', idempotentHint: true });
  });
  it('unions security even beside a public brand', () => {
    const guard = (authenticated: boolean, scopes?: string[]) =>
      withSecurityMetadata<MiddlewareFunction>(() => {}, {
        authenticated,
        ...(scopes === undefined ? {} : { scopes }),
      });
    const c = tool({ middleware: [guard(false), guard(true, ['b', 'a']), guard(true, ['a'])] });
    expect(c.authenticated).toBe(true);
    expect(c.requiredScopes).toEqual(['a', 'b']);
  });
  it.each([false, undefined])(
    'refuses idempotency without an authenticating brand, even with schema security: %s',
    (authenticated) => {
      const middleware: MiddlewareFunction[] = [
        withIdempotencyMetadata(() => {}, { idempotent: true, keyHeader: 'Idempotency-Key' }),
      ];
      if (authenticated !== undefined)
        middleware.push(withSecurityMetadata(() => {}, { authenticated }));
      expect(() => tool({ middleware, schema: { security: [{ bearerAuth: [] }] } })).toThrow(
        'authenticating security brand',
      );
    },
  );
  it('derives object output at the declared success status, bare or wrapped', () => {
    for (const wrap of [false, true]) {
      const output = z.object({ ok: z.boolean() });
      const handler = withResponseMetadata<RouteDefinition['handler']>(
        (ctx) => ctx.response.json({ ok: true }),
        { status: 201 },
      );
      const c = tool({
        handler,
        schema: { response: { 201: wrap ? { schema: output } : output } },
      });
      expect(c.outputSchema?.type).toBe('object');
      expect(c.outputValidator?.safeParse({ ok: true }).success).toBe(true);
    }
    expect(tool({ schema: { response: { 200: z.string() } } }).outputSchema).toBeUndefined();
    expect(
      tool({ schema: { response: { 200: { description: 'only' } } } }).outputSchema,
    ).toBeUndefined();
    expect(
      tool({ schema: { response: { 200: schema({ type: 'object', properties: {} }) } } })
        .outputSchema,
    ).toBeUndefined();
    expect(
      tool({ schema: { response: { 200: z.object({ created: z.date() }) } } }).outputSchema,
    ).toBeUndefined();
  });
});
