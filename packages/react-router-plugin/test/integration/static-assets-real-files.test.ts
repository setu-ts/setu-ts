/**
 * Real-file tests for the static-asset handler — serve real files from disk and
 * assert content-type, caching, missing-file 404, lexical `..` rejection, and
 * (via a real `IFileSystem.realPath`) symlink-safe containment: a symlink inside
 * the assets root pointing OUTSIDE it is not served.
 *
 * The injected `IFileSystem` here wraps `Deno` I/O (test-only); the handler
 * reads and canonicalizes exclusively through that interface.
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

  // Real filesystem-backed IFileSystem: reads and canonicalizes via Deno.
  // Both throw for missing paths, which the handler maps to 404.
  function makeRealFs(): IFileSystem {
    return {
      readFile: (p: string) => Deno.readFile(p),
      realPath: (p: string) => Deno.realPath(p),
    } as unknown as IFileSystem;
  }

  it('serves a real .js file from disk with the correct content-type', async () => {
    const fs = makeRealFs();

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
    const fs = makeRealFs();

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
    const fs = makeRealFs();

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
    const fs = makeRealFs();

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

  it('serves a file with no extension as application/octet-stream', async () => {
    // Write a file with no dot in its name.
    await Deno.writeTextFile(`${assetsDir}/Makefile`, 'all: build');

    const fs = makeRealFs();

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

  it('serves the same handler twice — second request reuses the cached canonical root', async () => {
    const fs = makeRealFs();
    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const first = buildMockResponse();
    await handler(buildMockCtx('/assets/app.js', first));
    expect(first.status).toBe(200);

    // Second request through the SAME handler: exercises the cached-realBase path.
    const second = buildMockResponse();
    await handler(buildMockCtx('/assets/style.css', second));
    expect(second.status).toBe(200);
    expect(second.headers.get('Content-Type')).toBe('text/css');
  });

  it('returns 404 for a symlink inside assets that points to a file OUTSIDE (realPath containment)', async () => {
    // A secret file outside the assets root, and a symlink inside it that
    // targets that secret. Lexical `..` checks cannot catch this; realPath can.
    const outsideDir = `${tmpDir}/outside`;
    await Deno.mkdir(outsideDir);
    await Deno.writeTextFile(`${outsideDir}/secret.txt`, 'leaked');
    await Deno.symlink(`${outsideDir}/secret.txt`, `${assetsDir}/leaked.txt`);

    const fs = makeRealFs();
    const handler = createStaticAssetHandler({
      fs,
      assetsDir,
      assetUrlPrefix: '/assets/',
    });

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/leaked.txt', mockResp);

    await handler(ctx);

    // Containment check resolves the symlink target outside assetsDir → 404,
    // and the secret is never read/sent.
    expect(mockResp.status).toBe(404);
    expect(mockResp.sentBody).toBeNull();
  });
});
