/**
 * A10-1 — a zod v4 REQUEST body must be documented in the input view.
 *
 * The defect: `#transformZod4` passed `io: 'output'` for every schema, so a
 * request body was documented as the shape the server holds AFTER parsing. One
 * running application then contradicted itself — it accepted a body omitting a
 * `.default()` field while its own `/openapi.json` listed that field as
 * `required` — and a `.transform()` field documented as `{}`, silently.
 *
 * Every assertion here drives a real kernel application, and the server
 * behaviour is asserted beside the document, because the defect is a
 * DISAGREEMENT between the two: a test that read only the document could not
 * see it.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { z as z4 } from 'npm:zod@^4.4.0';
import { z as z3 } from 'npm:zod@^3.24.0';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IKernelApplication } from '@setu-ts/kernel';

import { OpenApiPlugin } from '../../src/plugin/openapi-plugin.ts';

/** The document shape these tests read. */
interface Spec {
  paths: Record<string, {
    post?: {
      requestBody?: { content: { 'application/json': { schema: SchemaLike } } };
      responses: Record<string, { content?: { 'application/json'?: { schema: SchemaLike } } }>;
    };
    get?: { parameters?: { name: string; required?: boolean; schema?: SchemaLike }[] };
  }>;
  components?: { schemas?: Record<string, SchemaLike> };
}

interface SchemaLike {
  type?: string;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  additionalProperties?: unknown;
  $ref?: string;
}

/** Reads the served document. */
async function specOf(app: IKernelApplication): Promise<Spec> {
  const response = await app.inject({ method: 'GET', url: 'http://localhost/openapi.json' });
  expect(response.statusCode).toBe(200);
  return response.json<Spec>();
}

describe('A10-1 — request bodies are documented in the input view', () => {
  it('does not require a field the server defaults, and the server proves it', async () => {
    const Signup = z4.object({
      name: z4.string(),
      plan: z4.string().default('free'),
    });

    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });
    app.router.post('/signup', {
      // Parses with the SAME schema the document is built from, which is what
      // makes the two halves comparable.
      handler: async (ctx) => ctx.response.status(201).json(Signup.parse(await ctx.request.json())),
      schema: { body: Signup, response: { 201: Signup } },
    });
    await app.start();

    // The server accepts a body with no `plan` and supplies the default.
    const created = await app.inject({
      method: 'POST',
      url: 'http://localhost/signup',
      body: { name: 'Ada' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ plan: string }>().plan).toBe('free');

    const spec = await specOf(app);
    const body = spec.paths['/signup']?.post?.requestBody?.content['application/json'].schema;
    // THE DEFECT: `required` was `['name', 'plan']`, so a generated client took
    // `plan` as a required argument for a field the server defaults.
    expect(body?.required).toEqual(['name']);
    // And the strictness marker is absent, because `z4.object` STRIPS an
    // unknown key rather than rejecting it — asserted against the server below.
    expect(body).not.toHaveProperty('additionalProperties');

    const withExtra = await app.inject({
      method: 'POST',
      url: 'http://localhost/signup',
      body: { name: 'Ada', extra: 'ignored' },
    });
    expect(withExtra.statusCode).toBe(201);
    expect(withExtra.json<Record<string, unknown>>()).not.toHaveProperty('extra');

    // The RESPONSE keeps the output view: after parsing, `plan` is always
    // present and unknown keys are gone, which is what a client reading a
    // response can rely on.
    const response = spec.paths['/signup']?.post?.responses['201']?.content?.['application/json']
      ?.schema;
    expect(response?.required).toEqual(['name', 'plan']);
    expect(response?.additionalProperties).toBe(false);
    await app.stop();
  });

  it('documents a transformed field by what the client sends, not by what it becomes', async () => {
    const Body = z4.object({ slug: z4.string().transform((value) => value.length) });
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });
    app.router.post('/posts', { handler: (ctx) => ctx.response.json({}), schema: { body: Body } });
    await app.start();

    const body = (await specOf(app)).paths['/posts']?.post?.requestBody
      ?.content['application/json'].schema;
    // THE DEFECT: this was `{}` — the output of a transform is unrepresentable
    // in JSON Schema, so the output view documented nothing at all, silently.
    expect(body?.properties?.slug).toEqual({ type: 'string' });
    await app.stop();
  });

  it('keeps a strict schema strict, so the fix does not widen what a client may send', async () => {
    const Body = z4.strictObject({ id: z4.string() });
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });
    app.router.post('/strict', { handler: (ctx) => ctx.response.json({}), schema: { body: Body } });
    await app.start();

    const body = (await specOf(app)).paths['/strict']?.post?.requestBody
      ?.content['application/json'].schema;
    // `z4.strictObject` REJECTS an unknown key, so the marker is correct here
    // and survives the input view — the fix removes it only where the server
    // does not enforce it.
    expect(body?.additionalProperties).toBe(false);
    expect(Body.safeParse({ id: 'x', extra: 1 }).success).toBe(false);
    await app.stop();
  });

  it('treats query parameters as input too', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
    });
    app.router.get('/search', {
      handler: (ctx) => ctx.response.json({}),
      schema: { query: z4.object({ q: z4.string(), page: z4.string().default('1') }) },
    });
    await app.start();

    const parameters = (await specOf(app)).paths['/search']?.get?.parameters ?? [];
    const byName = Object.fromEntries(parameters.map((p) => [p.name, p]));
    expect(byName.q?.required).toBe(true);
    // A query parameter the server defaults is one the client may omit.
    expect(byName.page?.required).toBeFalsy();
    await app.stop();
  });

  it(
    'leaves zod v3 documents unchanged, which is what closes the majors disagreement',
    async () => {
      const Signup = z3.object({ name: z3.string(), plan: z3.string().default('free') });
      const app = createApplication({
        plugins: [RuntimePlugin(), OpenApiPlugin({ title: 'T', version: '1' })],
      });
      app.router.post('/v3', { handler: (ctx) => ctx.response.json({}), schema: { body: Signup } });
      await app.start();

      const body = (await specOf(app)).paths['/v3']?.post?.requestBody
        ?.content['application/json'].schema;
      // v3 hand-walks `_def` and has no `io` concept: what it emits is already
      // the input view, and always was. So after the fix the two majors agree
      // on a request body, which is the half A10-1 named.
      expect(body?.required).toEqual(['name']);
      expect(body).not.toHaveProperty('additionalProperties');
      await app.stop();
    },
  );
});
