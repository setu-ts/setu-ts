import { it, expect } from 'vitest';
import { withSecurityMetadata } from '@setu-ts/common';
import type { RouteInfo, RouteSchema, RouteMcpToolMetadata } from '@setu-ts/common';
import { publicRoute, requireAuth, requireScopes } from '@setu-ts/auth-plugin';
import { validateBody } from '@setu-ts/validation-plugin';
import { z } from 'zod-v4';
import { mcpTool } from '../../src/index.ts';
import { McpPluginConfigurationError } from '../../src/errors.ts';
import { resolveOptions } from '../../src/options.ts';
import { discoverTools } from '../../src/compile/discovery.ts';
import { compileTools } from '../../src/compile/compile-tools.ts';
import { declaration } from '../fixtures.ts';

function marked(meta: RouteMcpToolMetadata = {}, schema: RouteSchema = {}): RouteInfo {
  return {
    method: 'GET',
    path: '/marked',
    definition: {
      handler: (ctx) => ctx.response.json({ ok: true }),
      middleware: [publicRoute(), mcpTool(meta)],
      schema,
    },
  };
}
const identity = { name: 'read', description: 'Read' };
const options = resolveOptions({});

it.each([
  [identity, { operationId: 'fallback', description: 'Fallback', summary: 'Summary' }, identity],
  [
    {},
    { operationId: 'schema', description: 'Description', summary: 'Summary' },
    { name: 'schema', description: 'Description' },
  ],
  [{}, { operationId: 'schema', summary: 'Summary' }, { name: 'schema', description: 'Summary' }],
  [{ name: 'explicit' }, { description: 'Schema' }, { name: 'explicit', description: 'Schema' }],
  [
    { description: 'Explicit' },
    { operationId: 'schema' },
    { name: 'schema', description: 'Explicit' },
  ],
  [
    { ...identity, title: 'Display', repeatable: true },
    {},
    { ...identity, title: 'Display', repeatable: true },
  ],
] as const)('resolves marker %j with schema %j', (meta, schema, resolved) => {
  expect(discoverTools([marked(meta, schema)], options)).toEqual([
    { ...resolved, route: { method: 'GET', path: '/marked' } },
  ]);
});

const refusalRows: readonly [string, () => readonly RouteInfo[], typeof options][] = [
  ['missing name', () => [marked({ description: 'Read' })], options],
  ['missing description', () => [marked({ name: 'read' })], options],
  ['empty description', () => [marked({ name: 'read', description: ' ' })], options],
  ['invalid name', () => [marked({ ...identity, name: 'bad name' })], options],
  ['65 character name', () => [marked({ ...identity, name: 'a'.repeat(65) })], options],
  [
    'two markers',
    () => {
      const route = marked(identity);
      return [
        {
          ...route,
          definition: {
            ...route.definition,
            middleware: [publicRoute(), mcpTool(identity), mcpTool(identity)],
          },
        },
      ];
    },
    options,
  ],
  [
    'marked and listed',
    () => [marked(identity)],
    resolveOptions({
      tools: [{ ...declaration, name: 'listed', route: { method: 'GET', path: '/marked' } }],
    }),
  ],
  [
    'duplicate across markers',
    () => [marked(identity), { ...marked(identity), path: '/other' }],
    options,
  ],
  [
    'duplicate across list and marker',
    () => [marked(identity)],
    resolveOptions({ tools: [declaration] }),
  ],
  ['HEAD marker', () => [{ ...marked(identity), method: 'HEAD' }], options],
  ['OPTIONS marker', () => [{ ...marked(identity), method: 'OPTIONS' }], options],
  [
    'security intent for marker',
    () => {
      const route = marked(identity);
      return [{ ...route, definition: { ...route.definition, middleware: [mcpTool(identity)] } }];
    },
    options,
  ],
  [
    'security intent for listed route',
    () => [{ ...marked(identity), definition: { handler: (ctx) => ctx.response.json({}) } }],
    resolveOptions({ tools: [{ ...declaration, route: { method: 'GET', path: '/marked' } }] }),
  ],
  ['no tools', () => [], options],
];
it.each(refusalRows)(
  'refuses %s with a configuration error naming the route',
  (_label, routes, resolved) => {
    const entries = routes();
    expect(() => discoverTools(entries, resolved)).toThrow(McpPluginConfigurationError);
    if (entries.length > 0) {
      const refused = entries.at(-1)!;
      expect(() => discoverTools(entries, resolved)).toThrow(`${refused.method} ${refused.path}`);
    }
  },
);

it.each([
  ['authenticated brand', [requireAuth()], {}],
  ['scope brand', [requireScopes('orders:read')], {}],
  ['publicRoute', [publicRoute()], {}],
  [
    'foreign security producer',
    [withSecurityMetadata((_ctx, next) => next(), { authenticated: false })],
    {},
  ],
  ['schema security empty', [], { security: [] }],
  ['schema security declared', [], { security: [{ bearerAuth: [] }] }],
] as const)('accepts declared security intent: %s', (_label, guards, schema) => {
  const route = marked(identity, schema);
  const routes = [
    { ...route, definition: { ...route.definition, middleware: [...guards, mcpTool(identity)] } },
  ];
  expect(discoverTools(routes, options)).toHaveLength(1);
  const listed = [{ ...route, definition: { ...route.definition, middleware: [...guards] } }];
  expect(
    discoverTools(
      listed,
      resolveOptions({ tools: [{ ...declaration, route: { method: 'GET', path: '/marked' } }] }),
    ),
  ).toHaveLength(1);
});

it('merges listed and marked tools, ignores unmarked routes, and accepts a 64 character name', () => {
  const listed = {
    ...marked(),
    path: declaration.route.path,
    definition: {
      handler: (ctx: Parameters<RouteInfo['definition']['handler']>[0]) => ctx.response.json({}),
      schema: { security: [] },
    },
  };
  const routes = [
    marked({ ...identity, name: 'a'.repeat(64) }),
    listed,
    { ...listed, path: '/ignored', definition: { ...listed.definition, schema: {} } },
  ];
  const result = discoverTools(routes, resolveOptions({ tools: [declaration] }));
  expect(result.map((item) => item.name)).toEqual(['read', 'a'.repeat(64)]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(compileTools(result, routes)).toHaveLength(2);
});

it('leaves missing listed bindings to the existing compiler', () => {
  const tools = discoverTools([], resolveOptions({ tools: [declaration] }));
  expect(() => compileTools(tools, [])).toThrow('not registered');
});

it.each(['body', 'retry', 'collision'] as const)(
  'uses the existing compiler for the %s refusal for both sources',
  (failure) => {
    const middleware = [publicRoute()];
    if (failure !== 'body') middleware.push(validateBody(z.object({ id: z.string() })));
    const route = {
      ...marked(identity),
      method: 'POST' as const,
      path: '/items/:id',
      definition: { ...marked(identity).definition, middleware },
    };
    const decl = {
      ...identity,
      route: { method: 'POST' as const, path: route.path },
      ...(failure === 'collision' ? { repeatable: true as const } : {}),
    };
    const message =
      failure === 'body' ? 'body validation' : failure === 'retry' ? 'retry safety' : 'collision';
    expect(() =>
      compileTools(discoverTools([route], resolveOptions({ tools: [decl] })), [route]),
    ).toThrow(new RegExp(message, 'i'));
    const withMarker = {
      ...route,
      definition: {
        ...route.definition,
        middleware: [
          ...middleware,
          mcpTool({
            ...identity,
            ...(failure === 'collision' ? { repeatable: true as const } : {}),
          }),
        ],
      },
    };
    expect(() => compileTools(discoverTools([withMarker], options), [withMarker])).toThrow(
      new RegExp(message, 'i'),
    );
  },
);
