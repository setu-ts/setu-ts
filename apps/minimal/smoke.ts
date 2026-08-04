import { createMinimalApp } from './src/app.ts';

const app = createMinimalApp();
await app.start();
try {
  const response = await app.inject({ method: 'GET', url: 'http://example.test/' });
  if (response.statusCode !== 200 || response.body !== '{"hello":"world"}') {
    throw new Error(
      `Expected GET / to return 200 and the greeting, received ${response.statusCode}`,
    );
  }
} finally {
  await app.stop();
}
