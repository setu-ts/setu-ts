/**
 * Request schemas derived from branded validation middleware (M70m/X11-5).
 *
 * A route carrying `validateBody(schema)` used to contribute NOTHING to the
 * document, so the generated client for an API's only write took no argument
 * and 400'd against the live server. These tests pin what the brand now
 * contributes, and — just as importantly — what it does not.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z } from 'npm:zod@^3.24.0';
import type { MiddlewareFunction, RouteInfo, ValidationTarget } from '@setu-ts/common';
import { withValidationMetadata } from '@setu-ts/common';

import { OpenApiGenerator } from '../../src/generators/openapi-generator.ts';

/** A branded passthrough standing in for a `validateXxx(...)` middleware. */
function branded(target: ValidationTarget, schema: unknown): MiddlewareFunction {
  return withValidationMetadata(async (_ctx, next) => {
    await next();
  }, { target, schema });
}

/** An unbranded middleware — the control for "derives nothing". */
function plain(): MiddlewareFunction {
  return async (_ctx, next) => {
    await next();
  };
}

function route(
  method: RouteInfo['method'],
  path: string,
  definition: Partial<RouteInfo['definition']> = {},
): RouteInfo {
  return {
    method,
    path,
    definition: {
      handler: () => {
        throw new Error('not used');
      },
      ...definition,
    },
  };
}

const generator = () => new OpenApiGenerator({ title: 'T', version: '1' });

describe('deriveRequestSchemas', () => {
  it('fills requestBody from a body brand, preserving constraints', () => {
    const schema = z.object({ sku: z.string().min(1), qty: z.number() });
    const doc = generator().generate([
      route('POST', '/orders', { middleware: [branded('body', schema)] }),
    ]);

    const body = doc.paths['/orders']?.post?.requestBody;
    expect(body?.required).toBe(true);
    expect(body?.content['application/json'].schema).toEqual({
      type: 'object',
      properties: { sku: { type: 'string', minLength: 1 }, qty: { type: 'number' } },
      required: ['sku', 'qty'],
    });
  });

  it('fills query parameters from a query brand, with required from the Zod shape', () => {
    const schema = z.object({ q: z.string(), page: z.string().optional() });
    const doc = generator().generate([
      route('GET', '/orders', { middleware: [branded('query', schema)] }),
    ]);

    expect(doc.paths['/orders']?.get?.parameters).toEqual([
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'page', in: 'query', required: false, schema: { type: 'string' } },
    ]);
  });

  it('fills header parameters from a headers brand', () => {
    const schema = z.object({ 'x-tenant': z.string() });
    const doc = generator().generate([
      route('GET', '/orders', { middleware: [branded('headers', schema)] }),
    ]);

    expect(doc.paths['/orders']?.get?.parameters).toEqual([
      { name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } },
    ]);
  });

  it('types a path parameter from a params brand instead of defaulting to string', () => {
    const schema = z.object({ id: z.number() });
    const doc = generator().generate([
      route('GET', '/orders/:id', { middleware: [branded('params', schema)] }),
    ]);

    expect(doc.paths['/orders/{id}']?.get?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'number' } },
    ]);
  });

  it('derives NOTHING from a cookies brand', () => {
    // Two independent reasons (plan §3.3): `RouteSchema` has no `cookies`
    // field, and `@setu-ts/sdk`'s generator THROWS on an `in: 'cookie'`
    // parameter — so emitting one would turn a working document into a
    // hard codegen failure for every consumer of it.
    const doc = generator().generate([
      route('GET', '/orders', { middleware: [branded('cookies', z.object({ sid: z.string() }))] }),
    ]);

    expect(doc.paths['/orders']?.get?.parameters).toBeUndefined();
    expect(doc.paths['/orders']?.get?.requestBody).toBeUndefined();
  });

  it('derives nothing from unbranded middleware', () => {
    const doc = generator().generate([
      route('POST', '/orders', { middleware: [plain()] }),
    ]);

    expect(doc.paths['/orders']?.post?.requestBody).toBeUndefined();
  });

  it('lets a DECLARED schema win, per field', () => {
    const declaredBody = z.object({ declared: z.string() });
    const brandedBody = z.object({ derived: z.string() });
    const brandedQuery = z.object({ q: z.string() });
    const doc = generator().generate([
      route('POST', '/orders', {
        schema: { body: declaredBody },
        middleware: [branded('body', brandedBody), branded('query', brandedQuery)],
      }),
    ]);

    const op = doc.paths['/orders']?.post;
    // Declared body wins…
    expect(
      Object.keys(
        op?.requestBody?.content['application/json'].schema.properties ?? {},
      ),
    ).toEqual(['declared']);
    // …while the query, which is NOT declared, is still derived.
    expect(op?.parameters?.map((p) => p.name)).toEqual(['q']);
  });

  it('keeps the FIRST brand when a route carries two for one target', () => {
    const first = z.object({ first: z.string() });
    const second = z.object({ second: z.string() });
    const doc = generator().generate([
      route('POST', '/orders', { middleware: [branded('body', first), branded('body', second)] }),
    ]);

    expect(
      Object.keys(
        doc.paths['/orders']?.post?.requestBody?.content['application/json'].schema.properties ??
          {},
      ),
    ).toEqual(['first']);
  });

  it('documents a 400 for a derived route', () => {
    // The middleware genuinely answers 400 when validation fails, and Redocly
    // flags every operation carrying no 4XX.
    const doc = generator().generate([
      route('POST', '/orders', { middleware: [branded('body', z.object({}))] }),
    ]);

    expect(doc.paths['/orders']?.post?.responses['400']).toEqual({ description: 'Bad request' });
  });

  it('leaves a route that declares its own 400 alone', () => {
    const doc = generator().generate([
      route('POST', '/orders', {
        schema: { response: { 400: z.object({ error: z.string() }) } },
        middleware: [branded('body', z.object({}))],
      }),
    ]);

    expect(doc.paths['/orders']?.post?.responses['400']?.description).toBe('Bad request');
    expect(doc.paths['/orders']?.post?.responses['400']?.content).toBeDefined();
  });

  it('adds no 400 to a route that derives nothing', () => {
    const doc = generator().generate([route('GET', '/orders')]);

    expect(doc.paths['/orders']?.get?.responses['400']).toBeUndefined();
  });

  it('reproduces the pre-M70m document when deriveRequestSchemas is false', () => {
    const routes = [
      route('POST', '/orders', {
        middleware: [branded('body', z.object({ sku: z.string() }))],
      }),
    ];
    const off = new OpenApiGenerator({
      title: 'T',
      version: '1',
      deriveRequestSchemas: false,
    }).generate(routes);

    expect(off.paths['/orders']?.post).toEqual({
      operationId: 'post-orders',
      responses: { '200': { description: 'Successful response' } },
    });
  });
});

describe('excludeOwners', () => {
  it('drops routes owned by health-plugin and metrics-plugin by default', () => {
    const doc = generator().generate([
      { ...route('GET', '/health'), owner: 'health-plugin' },
      { ...route('GET', '/metrics'), owner: 'metrics-plugin' },
      { ...route('GET', '/orders'), owner: 'my-plugin' },
      route('GET', '/invoices'),
    ]);

    expect(Object.keys(doc.paths).sort()).toEqual(['/invoices', '/orders']);
  });

  it('drops a RENAMED operational endpoint, which a path list could not', () => {
    const doc = generator().generate([
      { ...route('GET', '/_internal/status'), owner: 'health-plugin' },
    ]);

    expect(Object.keys(doc.paths)).toEqual([]);
  });

  it('documents everything again when passed an empty list', () => {
    const doc = new OpenApiGenerator({ title: 'T', version: '1', excludeOwners: [] })
      .generate([{ ...route('GET', '/health'), owner: 'health-plugin' }]);

    expect(Object.keys(doc.paths)).toEqual(['/health']);
  });

  it('honours a caller-supplied owner list', () => {
    const doc = new OpenApiGenerator({ title: 'T', version: '1', excludeOwners: ['my-plugin'] })
      .generate([
        { ...route('GET', '/health'), owner: 'health-plugin' },
        { ...route('GET', '/orders'), owner: 'my-plugin' },
      ]);

    expect(Object.keys(doc.paths)).toEqual(['/health']);
  });
});
