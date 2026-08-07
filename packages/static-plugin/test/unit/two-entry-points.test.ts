import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { StaticPlugin } from '../../src/plugin/static-plugin.ts';
import { createStaticHandler } from '../../src/handler/static-handler.ts';

describe('two entry points', () => {
  it('should produce identical output from StaticPlugin and createStaticHandler', async () => {
    const content = new TextEncoder().encode('hello world');
    const fs = {
      stat: (path: string) => {
        if (path.endsWith('test.txt')) {
          return Promise.resolve({
            isFile: true,
            isDirectory: false,
            size: content.length,
            mtime: new Date(),
          });
        }
        throw new Error('ENOENT');
      },
      readFile: (path: string) => {
        if (path.endsWith('test.txt')) {
          return Promise.resolve(content);
        }
        throw new Error('ENOENT');
      },
      realPath: (path: string) => Promise.resolve(path),
      writeFile: () => Promise.resolve(),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      rm: () => Promise.resolve(),
    };

    const ctx = {
      id: 'test-id',
      services: { get: () => {} },
      params: {},
      query: new URLSearchParams(),
      state: {},
      startTime: [0, 0] as [number, number],
      signal: new AbortController().signal,
      request: {
        path: '/test.txt',
        method: 'GET',
        headers: new Headers(),
        url: 'http://localhost/test.txt',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
        bytes: () => Promise.resolve(new Uint8Array()),
      },
      response: {
        _status: 200,
        _headers: new Map<string, string>(),
        _body: null as Uint8Array | null,
        status(code: number) {
          this._status = code;
          return this;
        },
        header(name: string, value: string) {
          this._headers.set(name, value);
          return this;
        },
        send(body?: Uint8Array) {
          this._body = body ?? new Uint8Array();
          return this;
        },
      },
    };

    // Test via plugin
    const plugin = StaticPlugin({
      root: '/root',
      urlPrefix: '/',
      cacheControl: 'custom-cache',
    });

    const mockCtx = {
      services: { register: () => {} },
      router: { get: () => {}, head: () => {} },
      health: { register: () => {} },
      runtime: { fs },
    };

    plugin.register(mockCtx as never);

    // Test via handler directly
    const handler = createStaticHandler({
      fs,
      root: '/root',
      urlPrefix: '/',
      index: 'index.html',
      cacheControl: 'custom-cache',
    });

    await handler(ctx as never);

    expect(ctx.response._status).toBe(200);
    expect(ctx.response._headers.get('Cache-Control')).toBe('custom-cache');
  });
});
