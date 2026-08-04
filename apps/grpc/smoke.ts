import { createEchoClient, createGrpcApp } from './src/app.ts';

function unusedPort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (!('port' in address)) throw new Error('Expected a TCP listener.');
  return address.port;
}

const app = createGrpcApp();
const port = unusedPort();
await app.start({ port });
try {
  const client = createEchoClient(`http://127.0.0.1:${port}/grpc`);
  const response = await client.echo({ message: 'from the example' });
  if (response.response !== 'echo: from the example') {
    throw new Error(
      'The descriptor-backed Connect client did not decode the Echo response.',
    );
  }
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  if (!health.ok) {
    throw new Error(
      'The co-hosted HTTP route did not answer over the same listener.',
    );
  }
} finally {
  await app.stop();
}
