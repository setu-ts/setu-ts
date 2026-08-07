// deno-lint-ignore-file no-console
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '@setu-ts/static-plugin';

async function main() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      StaticPlugin({
        root: './public',
        urlPrefix: '/',
      }),
    ],
  });

  await app.start({ port: 0 });

  // Test 1: Serve a static file
  const response1 = await app.fetch(new Request('http://localhost/index.html'));
  if (response1.status !== 200) {
    console.error('FAIL: Expected 200 for index.html, got', response1.status);
    Deno.exit(1);
  }

  // Test 2: Conditional request with ETag
  const response2 = await app.fetch(new Request('http://localhost/index.html'));
  const etag = response2.headers.get('ETag');
  if (!etag) {
    console.error('FAIL: Expected ETag header');
    Deno.exit(1);
  }

  const response3 = await app.fetch(
    new Request('http://localhost/index.html', {
      headers: { 'If-None-Match': etag },
    }),
  );
  if (response3.status !== 304) {
    console.error('FAIL: Expected 304 for conditional request, got', response3.status);
    Deno.exit(1);
  }

  // Test 3: SPA fallback
  const response4 = await app.fetch(
    new Request('http://localhost/nonexistent', {
      headers: { Accept: 'text/html' },
    }),
  );
  if (response4.status !== 200) {
    console.error('FAIL: Expected 200 for SPA fallback, got', response4.status);
    Deno.exit(1);
  }

  await app.stop();
  console.log('All smoke tests passed');
}

await main();
