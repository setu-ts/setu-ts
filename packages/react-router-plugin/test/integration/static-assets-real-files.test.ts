/**
 * Real-file tests for static-asset handler — exercise `Deno.realPathSync`
 * containment branch via actual disk I/O.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, RouteHandler } from '@hono-enterprise/common';
import { createStaticAssetHandler } from '../../src/assets/static-assets.ts';

describe('static-assets — real files', () => {
  let tmpDir: string;
  let assetsDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: 'rr-plugin-static-test-' });
    assetsDir = `${tmpDir}/assets`;
    await Deno.mkdir(assetsDir);

    // Write real files.
    await Deno.writeTextFile(`${assetsDir}/app.js`, 'console.log(1)');
    await Deno.writeTextFile(`${assetsDir}/style.css`, 'body {}');
  });

  afterEach(() => {
    try {
      Deno.removeSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors.
    }
  });

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
            // Not used.
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

  it('serves a real .js file — exercises Deno.realPathSync containment branch', async () => {
    const fs: IFileSystem = {
      readFile: async (p: string) => {
        const bytes = await Deno.readFile(p);
        return bytes;
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/app.js', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('text/javascript');
    expect(mockResp.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(mockResp.sentBody).not.toBeNull();
  });

  it('returns 404 for a missing real file (fs.readFile rejects)', async () => {
    const fs: IFileSystem = {
      readFile: async (p: string) => {
        try {
          const bytes = await Deno.readFile(p);
          return bytes;
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) {
            throw new Error('ENOENT');
          }
          throw e;
        }
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/nonexistent.txt', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('returns 404 for a path containing .. traversal', async () => {
    const fs: IFileSystem = {
      readFile: async (p: string) => {
        const bytes = await Deno.readFile(p);
        return bytes;
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/../etc/passwd', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('returns 200 for a .css file served via real filesystem', async () => {
    const fs: IFileSystem = {
      readFile: async (p: string) => {
        const bytes = await Deno.readFile(p);
        return bytes;
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/style.css', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('text/css');
  });

  it('returns 404 when resolved path escapes assetsDir via real-path containment check', async () => {
    // Create an outside dir + symlink inside assets that points outside.
    const outsideDir = `${tmpDir}/outside`;
    await Deno.mkdir(outsideDir);
    await Deno.writeTextFile(`${outsideDir}/secret.txt`, 'leaked');

    const linkPath = `${assetsDir}/leaked.txt`;
    await Deno.symlink(outsideDir, linkPath);

    const fs: IFileSystem = {
      readFile: async (p: string) => {
        const bytes = await Deno.readFile(p);
        return bytes;
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    // Request /assets/leaked.txt → fullPath = assetsDir/leaked.txt → resolves to outsideDir via symlink
    // isWithin checks realTarget.startsWith(realBase + '/') which will be FALSE since
    // outsideDir is NOT under assetsDir. Covers lines 119-121.
    const ctx = buildMockCtx('/assets/leaked.txt', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(404);
  });

  it('serves a file with no extension — exercises extractExtension line 151', async () => {
    // Write a file with no dot in its name.
    await Deno.writeTextFile(`${assetsDir}/Makefile`, 'all: build');

    const fs: IFileSystem = {
      readFile: async (p: string) => {
        const bytes = await Deno.readFile(p);
        return bytes;
      },
    } as unknown as IFileSystem;

    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/Makefile', mockResp);

    await handler(ctx);

    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});
