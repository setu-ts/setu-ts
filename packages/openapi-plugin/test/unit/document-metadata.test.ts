import { describe, expect, it } from 'vitest';
import type { RouteInfo, RouteSchema } from '@setu-ts/common';
import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';

function route(method: RouteInfo['method'], schema: RouteSchema = {}): RouteInfo {
  return {
    method,
    path: '/users/:id',
    definition: { handler: (ctx) => ctx.response.json({}), schema },
  };
}

describe('OpenAPI document metadata', () => {
  it('copies every metadata field in specification order with only defined keys', () => {
    const result = new OpenApiGenerator({
      title: 'Users',
      version: '2',
      description: 'User API',
      termsOfService: 'https://example.com/terms',
      contact: { name: 'API team', url: 'https://example.com', email: 'api@example.com' },
      license: { name: 'Apache 2.0', identifier: 'Apache-2.0' },
      tags: [
        {
          name: 'users',
          description: 'Users',
          externalDocs: { url: 'https://example.com/users', description: 'Guide' },
        },
        { name: 'admin' },
      ],
      externalDocs: { url: 'https://example.com/docs', description: 'Docs' },
      servers: [{ url: '/' }],
      security: [],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    }).generate([]);
    expect(result.info).toEqual({
      title: 'Users',
      version: '2',
      description: 'User API',
      termsOfService: 'https://example.com/terms',
      contact: { name: 'API team', url: 'https://example.com', email: 'api@example.com' },
      license: { name: 'Apache 2.0', identifier: 'Apache-2.0' },
    });
    expect(Object.keys(result.info)).toEqual([
      'title',
      'version',
      'description',
      'termsOfService',
      'contact',
      'license',
    ]);
    expect(result.tags).toEqual([
      {
        name: 'users',
        description: 'Users',
        externalDocs: { url: 'https://example.com/users', description: 'Guide' },
      },
      { name: 'admin' },
    ]);
    expect(result.externalDocs).toEqual({ url: 'https://example.com/docs', description: 'Docs' });
    expect(Object.keys(result)).toEqual([
      'openapi',
      'info',
      'servers',
      'security',
      'paths',
      'components',
      'tags',
      'externalDocs',
    ]);
    expect(result.info.license).not.toHaveProperty('url');
    expect(result.tags?.[1]).not.toHaveProperty('description');
    expect(result.tags?.[1]).not.toHaveProperty('externalDocs');
  });

  it('preserves the pre-change document bytes when new fields are absent or false', () => {
    const baseline =
      '{"openapi":"3.1.0","info":{"title":"API","version":"1.0.0"},"paths":{"/users/{id}":{"get":{"operationId":"get-users-by-id","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"Successful response"}}}}}}';
    expect(JSON.stringify(new OpenApiGenerator({}).generate([route('GET')]))).toBe(baseline);
    expect(
      JSON.stringify(
        new OpenApiGenerator({ tags: [] }).generate([
          route('GET', { deprecated: false, excludeFromDocument: false }),
        ]),
      ),
    ).toBe(baseline);
  });

  it.each([
    { name: 'MIT', identifier: 'MIT' },
    { name: 'MIT', url: 'https://example.com/license' },
    { name: 'Proprietary' },
  ])('accepts license %j and omits absent keys', (license) => {
    expect(new OpenApiGenerator({ license }).generate([]).info).toEqual({
      title: 'API',
      version: '1.0.0',
      license,
    });
  });

  it('copies sparse metadata without undefined or unrecognized keys or shared objects', () => {
    const contact = { name: 'Team', extra: 'ignored' };
    const externalDocs = { url: '/docs', extra: 'ignored' };
    const tag = { name: 'users', externalDocs, extra: 'ignored' };
    const result = new OpenApiGenerator({ contact, externalDocs, tags: [tag] }).generate([]);
    expect(result.info.contact).toEqual({ name: 'Team' });
    expect(result.externalDocs).toEqual({ url: '/docs' });
    expect(result.tags).toEqual([{ name: 'users', externalDocs: { url: '/docs' } }]);
    expect(result.info.contact).not.toBe(contact);
    expect(result.externalDocs).not.toBe(externalDocs);
    expect(result.tags?.[0]).not.toBe(tag);
    expect(result.tags?.[0]?.externalDocs).not.toBe(externalDocs);
    expect(new OpenApiGenerator({ contact: {} }).generate([]).info.contact).toEqual({});
  });

  it.each([
    {
      options: { license: { name: 'MIT', identifier: 'MIT', url: '/license' } },
      reason: 'license-identifier-and-url',
      message: /identifier.*url.*OpenAPI 3\.1.*4\.8\.4/,
    },
    {
      options: { tags: [{ name: 'users' }, { name: 'users' }] },
      reason: 'duplicate-tag',
      message: /users/,
    },
  ])('refuses $reason at generator construction', ({ options, reason, message }) => {
    const construct = () => new OpenApiGenerator(options);
    expect(construct).toThrow(
      expect.objectContaining({ name: 'OpenApiDocumentOptionsError', reason }),
    );
    expect(construct).toThrow(message);
  });

  it('emits deprecated only for true', () => {
    for (const schema of [{ deprecated: true }, { deprecated: false }, {}]) {
      const operation = new OpenApiGenerator({}).generate([route('GET', schema)]).paths[
        '/users/{id}'
      ]?.get;
      if (schema.deprecated === true) expect(operation).toHaveProperty('deprecated', true);
      else expect(operation).not.toHaveProperty('deprecated');
    }
  });

  it('hides DELETE beside visible GET without claiming its duplicate id', () => {
    const result = new OpenApiGenerator({}).generate([
      route('GET', { operationId: 'readUser', tags: ['undeclared'] }),
      route('DELETE', { operationId: 'readUser', excludeFromDocument: true }),
    ]);
    expect(Object.keys(result.paths['/users/{id}']!)).toEqual(['get']);
    expect(result.paths['/users/{id}']?.get?.tags).toEqual(['undeclared']);
  });
});
