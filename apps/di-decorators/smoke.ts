import { createDiDecoratorsApp } from './src/app.ts';

const app = createDiDecoratorsApp();
await app.start();
try {
  const greeting = await app.inject({
    method: 'GET',
    url: 'http://example.test/greetings/',
  });
  if (
    greeting.statusCode !== 200 ||
    greeting.json<{ greeting: string }>().greeting !== 'Hello, decorators!'
  ) {
    throw new Error('The decorated route did not answer through its injected service.');
  }

  const lifetimes = await app.inject({ method: 'GET', url: 'http://example.test/lifetimes' });
  const result = lifetimes.json<{
    singletonShared: boolean;
    scopeRetainsInstance: boolean;
    scopesAreDistinct: boolean;
  }>();
  if (
    lifetimes.statusCode !== 200 || !result.singletonShared || !result.scopeRetainsInstance ||
    !result.scopesAreDistinct
  ) {
    throw new Error('The DI container did not preserve singleton and scoped lifetimes.');
  }
} finally {
  await app.stop();
}
