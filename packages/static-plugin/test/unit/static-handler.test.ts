import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createStaticHandler } from '../../src/handler/static-handler.ts';
import type { RouteHandler } from '@setu-ts/common';

describe('createStaticHandler', () => {
  let fs: ReturnType<typeof createFakeFs>;
  let ctx: ReturnType<typeof createFakeCtx>;

  function createFakeFs() {
    return {
      files: new Map<string, Uint8Array>(),
      dirs: new Set<string>(),
      stats: new Map<
        string,
        { isFile: boolean; isDirectory: boolean; size: number; mtime?: Date }
      >(),
      realPath: (path: string) => Promise.resolve(path),
      readFile: (path: string) => {
        const data = fs.files.get(path);
        if (!data) throw new Error('ENOENT');
        return Promise.resolve(data);
      },
      stat: (path: string) => {
        const stat = fs.stats.get(path);
        if (!stat) throw new Error('ENOENT');
        return Promise.resolve(stat);
      },
      writeFile: (path: string, data: Uint8Array) => {
        fs.files.set(path, data);
        fs.stats.set(path, { isFile: true, isDirectory: false, size: data.length });
        return Promise.resolve();
      },
      mkdir: (path: string) => {
        fs.dirs.add(path);
        fs.stats.set(path, { isFile: false, isDirectory: true, size: 0 });
        return Promise.resolve();
      },
      readdir: (path: string) => {
        const entries: string[] = [];
        for (const [key] of fs.stats) {
          if (key.startsWith(path + '/')) {
            entries.push(key.slice(path.length + 1).split('/')[0]);
          }
        }
        return Promise.resolve(entries);
      },
      rm: () => Promise.resolve(),
    };
  }

  function createFakeCtx(method = 'GET', headers: Record<string, string> = {}) {
    return {
      id: 'test-id',
      services: { get: () => {} },
      params: {},
      query: new URLSearchParams(),
      state: {},
      startTime: [0, 0] as [number, number],
      signal: new AbortController().signal,
      request: {
        path: '/',
        method,
        headers: new Headers(headers),
        url: 'http://localhost/',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        bytes: () => Promise.resolve(new Uint8Array()),
      },
      response: {
        _status: 200,
        _headers: new Map<string, string>(),
        _body: null as Uint8Array | ReadableStream<Uint8Array> | null,
        status(code: number) {
          this._status = code;
          return this;
        },
        header(name: string, value: string) {
          this._headers.set(name, value);
          return this;
        },
        send(body?: Uint8Array | ReadableStream<Uint8Array>) {
          this._body = body ?? new Uint8Array();
          return this;
        },
        stream(body: ReadableStream<Uint8Array>) {
          this._body = body;
          return this;
        },
        getSnapshot() {
          return {
            status: this._status,
            headers: Object.fromEntries(this._headers),
            body: this._body,
          };
        },
      },
    };
  }

  beforeEach(() => {
    fs = createFakeFs();
    ctx = createFakeCtx();
  });

  it('should return 200 with body for a valid file', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Content-Type')).toBe('text/plain');
  });

  it('should return 404 for a missing file', async () => {
    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/missing.txt';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(404);
  });

  it('should return 404 for path traversal', async () => {
    await fs.writeFile('/root/test.txt', new TextEncoder().encode('hello'));

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/../etc/passwd';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(404);
  });

  it('should return 416 for an unsatisfiable range', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=1000-2000');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(416);
    expect(ctx.response._headers.get('Content-Range')).toContain('*/11');
  });

  it('should stream a range when the file exceeds maxBufferBytes', async () => {
    const largeContent = new Uint8Array(Array.from({ length: 2_000_000 }, (_, i) => i % 256));
    await fs.writeFile('/root/large.bin', largeContent);

    const handler = createStaticHandler({
      fs: {
        ...fs,
        readStream: async (path: string, options?: { start?: number; end?: number }) => {
          await Promise.resolve();
          const data = fs.files.get(path)!;
          const start = options?.start ?? 0;
          const end = options?.end !== undefined ? options.end : data.length - 1;
          const slice = data.subarray(start, end + 1);
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          });
        },
      },
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      maxBufferBytes: 1_048_576,
    }) as RouteHandler;

    ctx.request.path = '/large.bin';
    ctx.request.headers.set('Range', 'bytes=0-99');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(206);
    expect(ctx.response._headers.get('Content-Range')).toBe('bytes 0-99/2000000');
    expect(ctx.response._headers.get('Content-Length')).toBe('100');
  });

  it('should return HEAD with empty body but same headers', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.method = 'HEAD';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._body).toEqual(new Uint8Array());
    expect(ctx.response._headers.get('Content-Length')).toBe('11');
  });

  it('should return 304 when ETag matches', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    // The fake fs does not set mtime, so ETag is W/"11" (size only).
    ctx.request.headers.set('If-None-Match', 'W/"11"');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(304);
  });

  it('should return 200 when range header is multi-range (comma)', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=0-4, 6-10');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
  });

  it('should return 206 for a valid range request', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=0-4');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(206);
    expect(ctx.response._headers.get('Content-Range')).toContain('0-4');
    expect(ctx.response._headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('should return 400 for an invalid URI encoding', async () => {
    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    // Invalid UTF-8 sequence that decodeURIComponent will reject
    ctx.request.path = '/%FF';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(400);
  });

  it('should serve fallback when file is missing and Accept includes text/html', async () => {
    const indexContent = new TextEncoder().encode('<html>fallback</html>');
    await fs.writeFile('/root/index.html', indexContent);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      fallback: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/missing.html';
    ctx.request.headers.set('Accept', 'text/html');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Content-Type')).toBe('text/html');
  });

  it('should not serve fallback for missing file without text/html Accept', async () => {
    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      fallback: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/missing.html';
    ctx.request.headers.set('Accept', 'application/json');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(404);
  });

  it('should serve fallback for HEAD request with text/html Accept', async () => {
    const indexContent = new TextEncoder().encode('<html>fallback</html>');
    await fs.writeFile('/root/index.html', indexContent);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      fallback: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/missing.html';
    ctx.request.method = 'HEAD';
    ctx.request.headers.set('Accept', 'text/html');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._body).toEqual(new Uint8Array());
  });

  it('should handle realPath throwing for non-existent root', async () => {
    const handler = createStaticHandler({
      fs: {
        ...fs,
        realPath: () => Promise.reject(new Error('ENOENT')),
      },
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(404);
  });

  it('should return 200 with ETag and Last-Modified when mtime is present', async () => {
    const content = new TextEncoder().encode('hello world');
    const mtime = new Date('2024-01-01T00:00:00.000Z');
    await fs.writeFile('/root/test.txt', content);
    // Update the stat to include mtime
    fs.stats.set('/root/test.txt', {
      isFile: true,
      isDirectory: false,
      size: 11,
      mtime,
    });

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('ETag')).toBe('W/"11-1704067200000"');
    expect(ctx.response._headers.get('Last-Modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
  });

  it('should return 200 without ETag when etag is disabled', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      etag: false,
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('If-None-Match', 'W/"11"');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._headers.get('ETag')).toBeUndefined();
  });

  it('should return 200 without handling Range when ranges is disabled', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      ranges: false,
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=0-4');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    // Range is ignored, full file is served
    expect(ctx.response._headers.get('Content-Range')).toBeUndefined();
    expect(ctx.response._headers.get('Content-Length')).toBe('11');
  });

  it('should ignore Range header when ranges is disabled', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      ranges: false,
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=0-4');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Content-Range')).toBeUndefined();
  });

  it('should return 304 for sidecar ETag match', async () => {
    const content = new TextEncoder().encode('hello world');
    const sidecarContent = new TextEncoder().encode('compressed');
    await fs.writeFile('/root/test.txt', content);
    await fs.writeFile('/root/test.txt.br', sidecarContent);

    // Set stats for both files
    fs.stats.set('/root/test.txt', { isFile: true, isDirectory: false, size: 11 });
    fs.stats.set('/root/test.txt.br', { isFile: true, isDirectory: false, size: 10 });

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Accept-Encoding', 'br');
    ctx.request.headers.set('If-None-Match', 'W/"10"');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(304);
    expect(ctx.response._headers.get('Content-Encoding')).toBe('br');
    expect(ctx.response._headers.get('Vary')).toBe('Accept-Encoding');
  });

  it('should serve full file when If-Range does not match ETag', async () => {
    const content = new TextEncoder().encode('hello world');
    await fs.writeFile('/root/test.txt', content);

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Range', 'bytes=0-4');
    ctx.request.headers.set('If-Range', 'W/"different"');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Content-Range')).toBeUndefined();
  });

  it('should serve file with contentEncoding and Vary header', async () => {
    const content = new TextEncoder().encode('hello world');
    const sidecarContent = new TextEncoder().encode('compressed');
    await fs.writeFile('/root/test.txt', content);
    await fs.writeFile('/root/test.txt.br', sidecarContent);

    fs.stats.set('/root/test.txt', { isFile: true, isDirectory: false, size: 11 });
    fs.stats.set('/root/test.txt.br', { isFile: true, isDirectory: false, size: 10 });

    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
    }) as RouteHandler;

    ctx.request.path = '/test.txt';
    ctx.request.headers.set('Accept-Encoding', 'br');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Content-Encoding')).toBe('br');
    expect(ctx.response._headers.get('Vary')).toBe('Accept-Encoding');
    expect(ctx.response._headers.get('Content-Type')).toBe('text/plain');
  });

  it('should stream HEAD response for large file with range', async () => {
    const largeContent = new Uint8Array(Array.from({ length: 2_000_000 }, (_, i) => i % 256));
    await fs.writeFile('/root/large.bin', largeContent);

    const handler = createStaticHandler({
      fs: {
        ...fs,
        readStream: async (path: string, options?: { start?: number; end?: number }) => {
          await Promise.resolve();
          const data = fs.files.get(path)!;
          const start = options?.start ?? 0;
          const end = options?.end !== undefined ? options.end : data.length - 1;
          const slice = data.subarray(start, end + 1);
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(slice);
              controller.close();
            },
          });
        },
      },
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      maxBufferBytes: 1_048_576,
    }) as RouteHandler;

    ctx.request.path = '/large.bin';
    ctx.request.method = 'HEAD';
    ctx.request.headers.set('Range', 'bytes=0-99');
    const result = await handler(ctx as never);

    expect(result).toBeDefined();
    expect(ctx.response._status).toBe(206);
    expect(ctx.response._body).toEqual(new Uint8Array());
    expect(ctx.response._headers.get('Content-Length')).toBe('100');
  });
});
