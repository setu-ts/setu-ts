import { createDemoApp } from './src/app.ts';

const app = createDemoApp();
await app.start();
try {
  const response = await app.inject({
    method: 'POST',
    url: 'http://example.test/graphql',
    body: { query: '{ hello }' },
  });
  if (response.statusCode !== 200 || !response.body?.includes('hello')) {
    throw new Error('The GraphQL endpoint did not answer a basic query.');
  }
} finally {
  await app.stop();
}
