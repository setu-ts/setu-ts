import { freePort } from '../smoke-helpers.ts';
import { createEchoClient, createGrpcApp } from './src/app.ts';

const app = createGrpcApp();
const port = await freePort();
await app.start({ port });
try {
  // M70i: `basePath` defaults to the ROOT, so a Connect client points at the
  // origin. Ordinary Hono routes (`/health` below) are untouched — at the root
  // the plugin claims only registered procedure paths.
  const client = createEchoClient(`http://127.0.0.1:${port}`);
  const response = await client.echo({ message: 'from the example' });
  if (response.response !== 'echo: from the example') {
    throw new Error('The descriptor-backed Connect client did not decode the Echo response.');
  }
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  if (!health.ok) {
    throw new Error('The co-hosted HTTP route did not answer over the same listener.');
  }
} finally {
  await app.stop();
}
