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
});
