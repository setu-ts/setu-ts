import { createRestExampleApp, issueDemoToken } from './src/app.ts';

const app = createRestExampleApp();
await app.start();
try {
  const token = await issueDemoToken(app);
  if (token.length === 0) {
    throw new Error('The authentication capability did not issue a JWT.');
  }
  const unauthorized = await app.inject({
    method: 'POST',
    url: 'http://example.test/todos',
    body: { title: 'Unauthenticated writes must fail' },
  });
  if (unauthorized.statusCode !== 401) {
    throw new Error(
      `Expected unauthenticated POST /todos to return 401, received ${unauthorized.statusCode}`,
    );
  }
  const headers = { authorization: `Bearer ${token}` };
  const create = await app.inject({
    method: 'POST',
    url: 'http://example.test/todos',
    headers,
    body: { title: 'Write an example' },
  });
  if (create.statusCode !== 201) {
    throw new Error(
      `Expected POST /todos to return 201, received ${create.statusCode}`,
    );
  }
  const todo = create.json<{ id: string; title: string }>();
  const read = await app.inject({
    method: 'GET',
    url: `http://example.test/todos/${todo.id}`,
    headers,
  });
  if (
    read.statusCode !== 200 ||
    read.json<{ title: string }>().title !== todo.title
  ) {
    throw new Error('The written todo was not readable through the REST API.');
  }
  const openapi = await app.inject({
    method: 'GET',
    url: 'http://example.test/openapi.json',
  });
  if (openapi.statusCode !== 200 || !openapi.body?.includes('/todos')) {
    throw new Error(
      'The OpenAPI document did not include the served todo routes.',
    );
  }

  // The document has to be usable, not merely present: a client (human in
  // Swagger UI, or generated from this spec) must be able to authenticate,
  // must not be handed the documentation endpoints as API operations, and must
  // get a typed path parameter rather than `any`.
  const spec = openapi.json<{
    security?: unknown;
    components?: { securitySchemes?: Record<string, unknown> };
    paths: Record<string, Record<string, { parameters?: { schema?: unknown }[] }>>;
  }>();

  if (spec.components?.securitySchemes?.bearerAuth === undefined) {
    throw new Error(
      'The OpenAPI document declared no bearerAuth scheme, so Swagger UI would ' +
        'render no Authorize button and every protected route would be untryable.',
    );
  }
  if (JSON.stringify(spec.security) !== JSON.stringify([{ bearerAuth: [] }])) {
    throw new Error(
      `Expected a document-level bearerAuth requirement, received ${JSON.stringify(spec.security)}`,
    );
  }

  const documented = Object.keys(spec.paths).sort();
  const selfDocumented = documented.filter((path) => path === '/openapi.json' || path === '/docs');
  if (selfDocumented.length > 0) {
    throw new Error(
      `The OpenAPI document listed its own delivery endpoints as API operations: ${
        selfDocumented.join(', ')
      }`,
    );
  }
  if (JSON.stringify(documented) !== JSON.stringify(['/todos', '/todos/{id}'])) {
    throw new Error(
      `Expected exactly the two todo operations to be documented, received ${
        documented.join(', ')
      }`,
    );
  }

  const idParam = spec.paths['/todos/{id}']?.get?.parameters?.[0];
  if (JSON.stringify(idParam?.schema) !== JSON.stringify({ type: 'string' })) {
    throw new Error(
      `Expected the id path parameter to be typed as a string, received ${
        JSON.stringify(idParam?.schema)
      }`,
    );
  }
} finally {
  await app.stop();
}
