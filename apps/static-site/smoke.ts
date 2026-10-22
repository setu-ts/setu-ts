import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

const HASHED_ASSET = '/assets/app-a1b2c3d4.js';
const IMMUTABLE = 'public, max-age=31536000, immutable';

describe('static-site example', () => {
  let app: IKernelApplication;

  /** Requests a path and returns the response with its body read as bytes. */
  const get = async (path: string, init?: RequestInit) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, init));
    const body = new Uint8Array(await response.arrayBuffer());
    return { response, headers: response.headers, body, text: new TextDecoder().decode(body) };
  };

  before(async () => {
    // A tiny buffer limit sends every file down the streaming path rather than
    // the buffered one, so the stream implementation is what gets exercised.
    app = createApp({ maxBufferBytes: 4 });
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  describe('serving', () => {
    it('serves index.html with its content type', async () => {
      const { response, headers } = await get('/index.html');

      assert.equal(response.status, 200);
      assert.equal(headers.get('content-type'), 'text/html');
    });

    it('refuses path traversal', async () => {
      // An encoded separator survives URL parsing (`/../` would be normalized
      // away first); the plugin decodes it into `../package.json`, a real file
      // outside ./public.
      assert.equal((await get('/..%2fpackage.json')).response.status, 404);
    });
  });

  describe('conditional requests', () => {
    it('revalidates an unchanged file to 304', async () => {
      const etag = (await get('/index.html')).headers.get('etag');
      assert.ok(etag, 'no ETag was issued');

      const revalidated = await get('/index.html', { headers: { 'if-none-match': etag } });

      assert.equal(revalidated.response.status, 304);
    });
  });

  describe('SPA fallback', () => {
    it('serves index.html for an unknown page a browser asks for', async () => {
      const { response } = await get('/nonexistent', { headers: { accept: 'text/html' } });

      assert.equal(response.status, 200);
    });

    it('does not serve it for a missing script, which would arrive as HTML', async () => {
      const { response } = await get('/nonexistent.js', { headers: { accept: '*/*' } });

      assert.equal(response.status, 404);
    });
  });

  describe('HEAD', () => {
    it('answers with the length and no body', async () => {
      const { response, headers, body } = await get('/test.txt', { method: 'HEAD' });

      assert.equal(response.status, 200);
      assert.equal(headers.get('content-length'), '12');
      assert.equal(body.byteLength, 0);
    });
  });

  describe('resuming a download', () => {
    it('issues a strong ETag, without which If-Range is ignored', async () => {
      const { headers, text } = await get('/test.txt');

      assert.equal(text, 'hello world\n');
      assert.ok(!headers.get('etag')?.startsWith('W/'), `weak ETag: ${headers.get('etag')}`);
    });

    it('resumes from the requested byte with 206', async () => {
      const etag = (await get('/test.txt')).headers.get('etag') ?? '';

      const resumed = await get('/test.txt', { headers: { range: 'bytes=6-', 'if-range': etag } });

      assert.equal(resumed.response.status, 206);
      assert.equal(resumed.headers.get('content-range'), 'bytes 6-11/12');
      assert.equal(resumed.text, 'world\n');
    });

    it('sends the whole file when If-Range no longer matches', async () => {
      const stale = await get('/test.txt', {
        headers: { range: 'bytes=6-', 'if-range': '"999-1"' },
      });

      assert.equal(stale.response.status, 200);
    });

    it('answers 416 with the true size for a range past the end', async () => {
      const { response, headers } = await get('/test.txt', { headers: { range: 'bytes=9999-' } });

      assert.equal(response.status, 416);
      assert.equal(headers.get('content-range'), 'bytes */12');
    });
  });

  describe('precompressed assets', () => {
    it('marks a content-hashed asset immutable', async () => {
      assert.equal((await get(HASHED_ASSET)).headers.get('cache-control'), IMMUTABLE);
    });

    it('serves the brotli sidecar with the original type and cache policy', async () => {
      const identity = await get(HASHED_ASSET);
      const brotli = await get(HASHED_ASSET, { headers: { 'accept-encoding': 'br' } });
      const sidecarSize = (await stat(`./public${HASHED_ASSET}.br`)).size;

      assert.equal(brotli.headers.get('content-encoding'), 'br');
      assert.equal(brotli.headers.get('content-type'), 'text/javascript');
      assert.equal(brotli.headers.get('vary'), 'Accept-Encoding');
      assert.equal(brotli.headers.get('cache-control'), IMMUTABLE);
      assert.equal(brotli.body.byteLength, sidecarSize);
      // Two byte streams under one ETag would poison shared caches.
      assert.notEqual(brotli.headers.get('etag'), identity.headers.get('etag'));
    });

    it('honours an explicit br;q=0 over a wildcard', async () => {
      const refused = await get(HASHED_ASSET, { headers: { 'accept-encoding': 'br;q=0, *' } });

      assert.equal(refused.headers.get('content-encoding'), null);
    });
  });
});
