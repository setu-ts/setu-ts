import { createPluginDevelopmentApp } from './src/app.ts';

const app = createPluginDevelopmentApp();
await app.start();
try {
  const response = await app.inject({ method: 'GET', url: 'http://example.test/greet/Ada' });
  if (
    response.statusCode !== 200 || response.json<{ message: string }>().message !== 'Hello, Ada!'
  ) {
    throw new Error('The custom plugin route did not resolve its capability.');
  }
} finally {
  await app.stop();
}
