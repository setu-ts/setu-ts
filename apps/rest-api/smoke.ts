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
} finally {
  await app.stop();
}
