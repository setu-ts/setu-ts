/**
 * Tests for the static asset handler.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, RouteHandler } from '@hono-enterprise/common';
import { createStaticAssetHandler } from '../../src/assets/static-assets.ts';

describe('static-assets', () => {
  function buildMockResponse(): {
    status: number;
    headers: Map<string, string>;
    setCookies: string[];
    sentBody: Uint8Array | null;
    result: { __handlerResult: true };
  } {
    return {
      status: 200,
      headers: new Map(),
      setCookies: [],
      sentBody: null,
      result: { __handlerResult: true },
    };
  }

  function buildMockCtx(
    path: string,
    mockResp: ReturnType<typeof buildMockResponse>,
  ): Parameters<RouteHandler>[0] {
    const controller = new AbortController();
    return {
      id: 'r1',
      request: {
        method: 'GET' as const,
        url: `http://localhost${path}`,
        path,
        headers: new Headers(),
        json: () => ({}),
        text: () => '',
        bytes: () => new Uint8Array(),
      },
      response: {
        status(c: number) {
          mockResp.status = c;
          return this;
        },
        header(n: string, v: string) {
          if (n.toLowerCase() === 'set-cookie') {
            // Not used — Set-Cookie goes through appendHeader.
          } else {
            mockResp.headers.set(n, v);
          }
          return this;
        },
        appendHeader(n: string, v: string) {
          if (n === 'Set-Cookie') mockResp.setCookies.push(v);
          return this;
        },
        send(b?: Uint8Array | undefined) {
          mockResp.sentBody = b ?? null;
          return mockResp.result;
        },
        json(_b: unknown) {
          return mockResp.result;
        },
        text(_b: string) {
          return mockResp.result;
        },
        redirect(_u: string) {
          return mockResp.result;
        },
        stream(_s: ReadableStream) {
          return mockResp.result;
        },
        snapshot() {
          return { streaming: false, body: null };
        },
      } as never,
      services: {} as never,
      params: {},
      query: {},
      state: new Map(),
      startTime: 0,
      signal: controller.signal,
    } as never;
  }

  it('returns 200 with correct Content-Type for .js file', async () => {
    const fileMap: Record<string, Uint8Array> = {};
    fileMap['/assets/app.js'] = new TextEncoder().encode('console.log(1)');
    const fs = {
      readFile: (p: string) =>
        fileMap[p] ?? (() => {
          throw new Error('ENOENT');
        })(),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/app.js', mockResp);
    const result = await handler(ctx);

    expect(result).toEqual(mockResp.result);
    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('text/javascript');
    expect(mockResp.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(mockResp.sentBody).not.toBeNull();
  });

  it('sets Cache-Control immutable on successful CSS asset response', async () => {
    const fileMap: Record<string, Uint8Array> = {};
    fileMap['/assets/style.css'] = new TextEncoder().encode('body {}');
    const fs = {
      readFile: (p: string) =>
        fileMap[p] ?? (() => {
          throw new Error('ENOENT');
        })(),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/style.css', mockResp);

    await handler(ctx);

    expect(mockResp.headers.get('Content-Type')).toBe('text/css');
    expect(mockResp.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('returns correct Content-Type per extension', async () => {
    const testCases: [string, string][] = [
      ['/assets/index.html', 'text/html'],
      ['/assets/data.json', 'application/json'],
      ['/assets/logo.svg', 'image/svg+xml'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/assets/image.png', 'image/png'],
      ['/assets/unknown.xyz', 'application/octet-stream'],
    ];

    for (const [urlPath, expectedType] of testCases) {
      const fileMap: Record<string, Uint8Array> = {};
      const filePath = urlPath.replace('http://localhost', '');
      fileMap[filePath] = new TextEncoder().encode('test');
      const fs = {
        readFile: (p: string) =>
          fileMap[p] ?? (() => {
            throw new Error('ENOENT');
          })(),
      } as unknown as IFileSystem;

      const handler = createStaticAssetHandler({
        fs,
        assetsDir: '/assets',
        assetUrlPrefix: '/assets/',
      });
      const mockResp = buildMockResponse();
      const ctx = buildMockCtx(urlPath, mockResp);

      await handler(ctx);

      expect(mockResp.headers.get('Content-Type'), `contentType for ${urlPath}`)
        .toBe(expectedType);
    }
  });

  it('returns 404 when file is missing (readFile rejects)', async () => {
    const fs = {
      readFile: () => {
        throw new Error('ENOENT');
      },
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/missing.txt', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('is a valid function (structural check)', () => {
    const fs = { readFile: () => Promise.resolve(new Uint8Array()) } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/a',
      assetUrlPrefix: '/a/',
    });
    expect(typeof handler).toBe('function');
  });

  it('returns 400 on malformed decoded path', async () => {
    const fs = {
      readFile: () => Promise.resolve(new TextEncoder().encode('ok')),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    // Path with invalid URI encoding
    const ctx = buildMockCtx('/assets/%ZZbroken', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(400);
  });

  it('returns 404 for empty relative path after stripping prefix', async () => {
    const fs = {
      readFile: () => Promise.resolve(new TextEncoder().encode('ok')),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('returns 404 for path containing .. traversal (string check)', async () => {
    const fs = {
      readFile: () => Promise.resolve(new TextEncoder().encode('ok')),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/../../etc/passwd', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('returns 404 for path with multiple .. traversal (string containment check)', async () => {
    const fs = {
      readFile: () => Promise.resolve(new TextEncoder().encode('ok')),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    // Requests containing `..` are rejected by the traversal guard before any
    // filesystem read — this verifies that early-exit path.
    const ctx = buildMockCtx('/assets/../../../etc/hostname', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('serves known file when fs returns content', async () => {
    const fileMap: Record<string, Uint8Array> = {};
    fileMap['/assets/test.html'] = new TextEncoder().encode('<html></html>');
    const fs = {
      readFile: (p: string) =>
        fileMap[p] ?? (() => {
          throw new Error('ENOENT');
        })(),
    } as unknown as IFileSystem;
    const handler = createStaticAssetHandler({
      fs,
      assetsDir: '/assets',
      assetUrlPrefix: '/assets/',
    });
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/test.html', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('text/html');
  });
});
