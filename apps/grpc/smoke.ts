import { createGrpcApp } from './src/app.ts';

const app = createGrpcApp();
await app.start();
try {
  const rpc = await app.fetch(
    new Request('http://example.test/grpc/example.EchoService/Echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'from the example' }),
    }),
  );
  const body = await rpc.json() as { response?: string };
  if (rpc.status !== 200 || body.response !== 'echo: from the example') {
    throw new Error('The descriptor-backed Connect service did not return its decoded response.');
  }
  const health = await app.inject({ method: 'GET', url: 'http://example.test/health' });
  if (health.statusCode !== 200) throw new Error('The co-hosted HTTP route did not answer.');
} finally {
  await app.stop();
}
