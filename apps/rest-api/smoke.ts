import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { issueDemoToken } from './src/auth/demo-token.ts';
import { createApp } from './setu.config.ts';

interface OpenApiDocument {
  readonly security?: unknown;
  readonly components?: { readonly securitySchemes?: Record<string, unknown> };
  readonly paths: Record<
    string,
    Record<string, { readonly parameters?: readonly { readonly schema?: unknown }[] }>
  >;
}

describe('rest-api example', () => {
  let app: IKernelApplication;
  let authorization: { authorization: string };

  before(async () => {
    app = createApp();
    await app.start();
    authorization = { authorization: `Bearer ${await issueDemoToken(app)}` };
  });

  after(async () => {
    await app.stop();
  });

  it('refuses an unauthenticated write', async () => {
    const response = await app.inject({ method: 'POST', url: '/todos', body: { title: 'x' } });

    assert.equal(response.statusCode, 401);
  });

  it('refuses an invalid body before creating anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/todos',
      headers: authorization,
      body: { title: '' },
    });

    assert.equal(response.statusCode, 400);
  });

  it('reads back a todo it created', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/todos',
      headers: authorization,
      body: { title: 'Write an example' },
    });
    assert.equal(created.statusCode, 201);
    const todo = created.json<{ id: string; title: string }>();

    const read = await app.inject({
      method: 'GET',
      url: `/todos/${todo.id}`,
      headers: authorization,
    });

    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), todo);
  });

  it('answers an unknown todo with a Problem Details 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/todos/missing',
      headers: authorization,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{ status: number }>().status, 404);
  });

  describe('the OpenAPI document', () => {
    let spec: OpenApiDocument;

    before(async () => {
      const response = await app.inject({ method: 'GET', url: '/openapi.json' });
      assert.equal(response.statusCode, 200);
      spec = response.json<OpenApiDocument>();
    });

    it('declares the bearer scheme Swagger UI needs for its Authorize button', () => {
      assert.ok(spec.components?.securitySchemes?.['bearerAuth']);
      assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
    });

    it('documents exactly the todo operations', () => {
      assert.deepEqual(Object.keys(spec.paths).sort(), ['/todos', '/todos/{id}']);
    });

    it('types the undeclared id path parameter as a string', () => {
      const parameter = spec.paths['/todos/{id}']?.['get']?.parameters?.[0];
      assert.deepEqual(parameter?.schema, { type: 'string' });
    });
  });
});
