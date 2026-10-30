import { describe, expect, it } from 'vitest';
import { z } from 'zod-v4';
import type { RouteInfo } from '@setu-ts/common';
import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';
import { OperationIdError } from '../../src/index.ts';

function route(path: string, operationId?: string): RouteInfo {
  return {
    method: 'GET',
    path,
    definition: {
      handler: (ctx) => ctx.response.json({}),
      ...(operationId !== undefined ? { schema: { operationId } } : {}),
    },
  };
}

describe('operation ids', () => {
  it('pins a no-declaration Zod 4 document', async () => {
    const shared = z.object({ name: z.string(), createdAt: z.date() });
    const routes: RouteInfo[] = [
      {
        method: 'POST',
        path: '/users',
        definition: {
          handler: (ctx) => ctx.response.json({}),
          schema: { body: shared, summary: 'Create', tags: ['Users'] },
        },
      },
      {
        method: 'PUT',
        path: '/users/:id',
        definition: {
          handler: (ctx) => ctx.response.json({}),
          schema: { body: shared, response: { 200: shared } },
        },
      },
      {
        method: 'GET',
        path: '/users/:id',
        definition: { handler: (ctx) => ctx.response.json({}) },
      },
      {
        method: 'GET',
        path: '/users/by-id',
        definition: { handler: (ctx) => ctx.response.json({}) },
      },
      {
        method: 'GET',
        path: '/users/by-id-2',
        definition: { handler: (ctx) => ctx.response.json({}) },
      },
      { method: 'GET', path: '/', definition: { handler: (ctx) => ctx.response.json({}) } },
      {
        method: 'GET',
        path: '/ignored',
        owner: 'health-plugin',
        definition: { handler: (ctx) => ctx.response.json({}) },
      },
    ];
    const generator = new OpenApiGenerator({ title: 'Baseline API', version: '1.0.0' });
    await expect(JSON.stringify(generator.generate(routes))).toMatchFileSnapshot(
      '../fixtures/no-declared-operation-ids.snap',
    );
  });

  it('uses a declared id verbatim and emits the declared description', () => {
    const generator = new OpenApiGenerator({});
    const declared: RouteInfo = {
      method: 'GET',
      path: '/users',
      definition: {
        handler: (ctx) => ctx.response.json({}),
        schema: { operationId: ' listUsers /V1 ', description: 'List all users.' },
      },
    };
    expect(generator.generate([declared]).paths['/users']?.get).toEqual({
      operationId: ' listUsers /V1 ',
      description: 'List all users.',
      responses: { 200: { description: 'Successful response' } },
    });
  });

  it('emits an empty declared description and derives the id when absent', () => {
    const result = new OpenApiGenerator({}).generate([
      {
        method: 'GET',
        path: '/users',
        definition: { handler: (ctx) => ctx.response.json({}), schema: { description: '' } },
      },
    ]);
    expect(result.paths['/users']?.get).toEqual({
      operationId: 'get-users',
      description: '',
      responses: { 200: { description: 'Successful response' } },
    });
  });

  it('reserves a declared id registered after the colliding derived route', () => {
    const generator = new OpenApiGenerator({});
    const routes = [
      route('/users'),
      route('/declared', 'get-users'),
      route('/suffix', 'get-users-2'),
    ];
    for (const ordered of [routes, [...routes].reverse(), routes]) {
      const result = generator.generate(ordered);
      expect(result.paths['/users']?.get?.operationId).toBe('get-users-3');
      expect(result.paths['/declared']?.get?.operationId).toBe('get-users');
      expect(result.paths['/suffix']?.get?.operationId).toBe('get-users-2');
    }
    expect(generator.generate([route('/users')]).paths['/users']?.get?.operationId).toBe(
      'get-users',
    );
  });

  it('names hoisted components and diagnostics from the declared id', () => {
    const shared = z.strictObject({ name: z.string(), callback: z.function() });
    const result = new OpenApiGenerator({}).generate([
      {
        method: 'POST',
        path: '/users',
        definition: {
          handler: (ctx) => ctx.response.json({}),
          schema: {
            operationId: 'createUsers',
            body: shared,
            response: { 200: shared },
          },
        },
      },
    ]);
    const op = result.paths['/users']?.post;
    expect(op?.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateUsersBody',
    });
    expect(result.components?.schemas).toHaveProperty('CreateUsersBody');
    expect(JSON.stringify(result)).not.toContain('PostUsersBody');
    expect(op?.['x-setu-unrepresentable']).toEqual([
      { at: 'createUsers', reason: "zod v4 type 'function' has no JSON Schema representation" },
    ]);
  });

  it.each([
    { routes: [route('/blank', ' \t')], reason: 'blank' },
    { routes: [route('/first', 'list'), route('/second', 'list')], reason: 'duplicate' },
  ])(
    'throws OperationIdError for $reason ids and recovers for the next call',
    ({ routes, reason }) => {
      const generator = new OpenApiGenerator({});
      expect(() => generator.generate(routes)).toThrow(OperationIdError);
      expect(() => generator.generate(routes)).toThrow(expect.objectContaining({ reason }));
      const schema = z.object({ value: z.string() });
      generator.addSchema('Recovery', schema);
      const recovered = generator.generate([route('/ok', 'ok')]);
      expect(recovered.paths['/ok']?.get?.operationId).toBe('ok');
      expect(recovered.components?.schemas).toHaveProperty('Recovery');
      expect(JSON.stringify(recovered)).not.toContain('count:');
    },
  );

  it('ignores excluded declared ids with custom path and owner options', () => {
    const result = new OpenApiGenerator({ exclude: ['/ignored'], excludeOwners: ['ops'] }).generate(
      [
        route('/users'),
        route('/ignored', 'get-users'),
        { ...route('/owned', 'get-users'), owner: 'ops' },
        { ...route('/health', 'health'), owner: 'health-plugin' },
      ],
    );
    expect(Object.keys(result.paths)).toEqual(['/users', '/health']);
    expect(result.paths['/users']?.get?.operationId).toBe('get-users');
  });
});
