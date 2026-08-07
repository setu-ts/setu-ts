import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { StaticPlugin } from '../../src/index.ts';

describe('StaticPlugin integration', () => {
  let app: ReturnType<typeof createApplication>;

  beforeEach(() => {
    app = createApplication({
      plugins: [RuntimePlugin(), StaticPlugin({ root: './test/fixtures' })],
    });
  });

  it('should serve a static file with 200', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(new Request('http://localhost/test.txt'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');

    await app.stop();
  });

  it('should return 404 for missing file', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(new Request('http://localhost/missing.txt'));
    expect(response.status).toBe(404);

    await app.stop();
  });

  it('should serve HEAD with empty body', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(new Request('http://localhost/test.txt', { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBeDefined();

    const body = await response.text();
    expect(body).toBe('');

    await app.stop();
  });

  it('should support conditional requests with ETag', async () => {
    await app.start({ port: 0 });

    // First request
    const response1 = await app.fetch(new Request('http://localhost/test.txt'));
    expect(response1.status).toBe(200);
    const etag = response1.headers.get('ETag');
    expect(etag).toBeDefined();

    // Second request with If-None-Match
    const response2 = await app.fetch(
      new Request('http://localhost/test.txt', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(response2.status).toBe(304);

    await app.stop();
  });

  it('should support Range requests', async () => {
    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/test.txt', {
        headers: { Range: 'bytes=0-4' },
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toContain('0-4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');

    await app.stop();
  });

  it('should serve SPA fallback', async () => {
    const appWithFallback = createApplication({
      plugins: [
        RuntimePlugin(),
        StaticPlugin({ root: './test/fixtures', fallback: 'index.html' }),
      ],
    });

    await appWithFallback.start({ port: 0 });

    const response = await appWithFallback.fetch(
      new Request('http://localhost/nonexistent', {
        headers: { Accept: 'text/html' },
      }),
    );
    expect(response.status).toBe(200);

    await appWithFallback.stop();
  });
});
