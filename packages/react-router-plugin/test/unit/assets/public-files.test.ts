/**
 * M70n X5-5 — serving client-build ROOT files (`public/` copies) with
 * `must-revalidate`, behind the `publicFiles` option.
 *
 * Covers the handler directly (hit, miss fall-through, traversal refusal,
 * `realPath` symlink containment) and the plugin wiring (GET catch-all wraps
 * SSR only when the option is on; `publicFiles: false` reproduces today's
 * prefix-only behavior exactly).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, RouteHandler } from '@setu-ts/common';
import { createPublicFileHandler } from '../../../src/assets/static-assets.ts';
import { ReactRouterPlugin } from '../../../src/plugin/react-router-plugin.ts';
import { createFakeLoadContextFactory } from '../../fixtures/fake-handler.ts';

const MUST_REVALIDATE = 'public, max-age=0, must-revalidate';

interface MockResponse {
  status: number;
  headers: Map<string, string>;
  sentBody: Uint8Array | null;
  sentStream: ReadableStream<Uint8Array> | null;
  result: { __handlerResult: true };
}

function buildMockResponse(): MockResponse {
  return {
    status: 200,
    headers: new Map(),
    sentBody: null,
    sentStream: null,
    result: { __handlerResult: true },
  };
}

/** Drains a recorded stream to text, for asserting an SSR-mapped body. */
async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function buildMockCtx(
  path: string,
  mockResp: MockResponse,
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
        mockResp.headers.set(n, v);
        return this;
      },
      appendHeader(n: string, v: string) {
        mockResp.headers.set(n, v);
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
      stream(s: ReadableStream) {
        mockResp.sentStream = s;
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

/** In-memory IFileSystem keyed by full path; optional realPath indirection. */
function makeMapFs(
  fileMap: Record<string, Uint8Array>,
  realPathMap?: Record<string, string>,
): IFileSystem {
  const fs = {
    readFile: (p: string): Promise<Uint8Array> =>
      p in fileMap ? Promise.resolve(fileMap[p]) : Promise.reject(new Error('ENOENT')),
  };
  if (realPathMap !== undefined) {
    return {
      ...fs,
      realPath: (p: string): Promise<string> =>
        p in realPathMap ? Promise.resolve(realPathMap[p]) : Promise.reject(new Error('ENOENT')),
    } as IFileSystem;
  }
  return fs as IFileSystem;
}

describe('createPublicFileHandler', () => {
  const encoder = new TextEncoder();

  function makeHandler(
    fileMap: Record<string, Uint8Array>,
    realPathMap?: Record<string, string>,
  ) {
    return createPublicFileHandler({
      fs: makeMapFs(fileMap, realPathMap),
      assetsDir: '/client',
    });
  }

  it('serves a root-level file with must-revalidate and its content type', async () => {
    const handler = makeHandler({
      '/client/robots.txt': encoder.encode('User-agent: *'),
    });
    const mockResp = buildMockResponse();
    const result = await handler(buildMockCtx('/robots.txt', mockResp));

    expect(result).toEqual(mockResp.result);
    expect(mockResp.status).toBe(200);
    expect(mockResp.headers.get('Content-Type')).toBe('text/plain');
    expect(mockResp.headers.get('Cache-Control')).toBe(MUST_REVALIDATE);
    expect(new TextDecoder().decode(mockResp.sentBody ?? new Uint8Array())).toBe(
      'User-agent: *',
    );
  });

  it('returns undefined for a miss so the caller falls through to SSR', async () => {
    const handler = makeHandler({});
    const mockResp = buildMockResponse();
    const result = await handler(buildMockCtx('/favicon.ico', mockResp));

    expect(result).toBeUndefined();
    expect(mockResp.sentBody).toBeNull();
  });

  it('returns undefined for the bare root', async () => {
    const handler = makeHandler({ '/client/index.html': encoder.encode('hi') });
    const mockResp = buildMockResponse();

    expect(await handler(buildMockCtx('/', mockResp))).toBeUndefined();
    expect(await handler(buildMockCtx('', mockResp))).toBeUndefined();
  });

  it('refuses lexical traversal attempts', async () => {
    const handler = makeHandler({
      '/client/robots.txt': encoder.encode('x'),
      '/secrets.txt': encoder.encode('secret'),
    });
    const mockResp = buildMockResponse();

    const result = await handler(buildMockCtx('/../secrets.txt', mockResp));
    expect(result).toBeUndefined();
  });

  it('answers 400 for an undecodable request path', async () => {
    const handler = makeHandler({});
    const mockResp = buildMockResponse();

    const result = await handler(buildMockCtx('/%zz.txt', mockResp));
    expect(result).toEqual(mockResp.result);
    expect(mockResp.status).toBe(400);
  });

  it('enforces the realPath containment guard against an escaping symlink', async () => {
    // `/client/evil.txt` resolves OUTSIDE the canonical root even though a
    // naive readFile would succeed — the guard must refuse it.
    const handler = makeHandler(
      {
        '/client/robots.txt': encoder.encode('ok'),
        '/client/evil.txt': encoder.encode('should never be served'),
      },
      {
        '/client': '/srv/app/client',
        '/client/robots.txt': '/srv/app/client/robots.txt',
        '/client/evil.txt': '/etc/passwd',
      },
    );

    const hitResp = buildMockResponse();
    expect(await handler(buildMockCtx('/robots.txt', hitResp))).toBeDefined();

    const escapeResp = buildMockResponse();
    const escaped = await handler(buildMockCtx('/evil.txt', escapeResp));
    expect(escaped).toBeUndefined();
  });

  it('still serves when realPath is absent (lexical-guard-only runtimes)', async () => {
    const handler = makeHandler({
      '/client/robots.txt': encoder.encode('no-real-path'),
    });
    const mockResp = buildMockResponse();

    expect(await handler(buildMockCtx('/robots.txt', mockResp))).toBeDefined();
    expect(mockResp.headers.get('Cache-Control')).toBe(MUST_REVALIDATE);
  });
});

describe('ReactRouterPlugin publicFiles wiring', () => {
  const encoder = new TextEncoder();

  interface PluginHarness {
    readonly getHandlers: Array<{ pattern: string; handler: unknown }>;
    readonly assetPatterns: string[];
    register(options: Record<string, unknown>): Promise<void>;
  }

  /** Registers the plugin against a fake context that CAPTURES GET handlers. */
  function makeHarness(
    fileMap: Record<string, Uint8Array>,
    warnings?: Array<{ message: string; meta?: Record<string, unknown> }>,
  ): PluginHarness {
    const getHandlers: Array<{ pattern: string; handler: unknown }> = [];
    const assetPatterns: string[] = [];
    const registered = new Map<string, unknown>();

    const routerApi = {
      get(pattern: string, handler: unknown): void {
        getHandlers.push({ pattern, handler });
        if (pattern.startsWith('/assets')) assetPatterns.push(pattern);
      },
      post(): void {},
      put(): void {},
      patch(): void {},
      delete(): void {},
      head(): void {},
      options(): void {},
      group(): void {},
    };

    return {
      getHandlers,
      assetPatterns,
      async register(options: Record<string, unknown>): Promise<void> {
        const plugin = ReactRouterPlugin(options as never);
        await plugin.register({
          runtime: { uuid: () => 'id', fs: makeMapFs(fileMap) },
          logger: warnings === undefined ? undefined : {
            warn: (message: string, meta?: Record<string, unknown>): void => {
              warnings.push(meta === undefined ? { message } : { message, meta });
            },
          },
          services: {
            has: (t: string): boolean => registered.has(t),
            get: <T>(t: string): T => registered.get(t) as T,
            register: <T>(t: string, s: T): void => {
              registered.set(t, s);
            },
          },
          health: { register(): void {} },
          lifecycle: { onClose(): void {} },
          router: routerApi,
        } as never);
      },
    };
  }

  // Realistic Vite layout: hashed bundles under `<root>/assets/`, `public/`
  // copies at the `<root>` itself.
  const baseOptions = {
    serverBuildPath: './build/server/index.js',
    assetsDir: '/srv/app/build/client/assets',
    loadRequestHandler: (_path: string, _mode: string) =>
      Promise.resolve({
        handler: () =>
          Promise.resolve(
            new Response('<html>ssr</html>', {
              headers: { 'content-type': 'text/html' },
            }),
          ),
        createLoadContext: createFakeLoadContextFactory(),
      }),
  };

  it('serves a build-root file ahead of the SSR catch-all by default', async () => {
    const harness = makeHarness({
      // `public/robots.txt` is copied to the client-build ROOT — the PARENT of
      // the assets dir, NOT inside it.
      '/srv/app/build/client/robots.txt': encoder.encode('User-agent: *'),
    });
    await harness.register(baseOptions);

    const catchAll = harness.getHandlers.find((r) => r.pattern === '/*');
    expect(catchAll).toBeDefined();

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/robots.txt', mockResp);
    const result = await (catchAll?.handler as RouteHandler)(ctx);

    expect(result).toEqual(mockResp.result);
    expect(mockResp.headers.get('Cache-Control')).toBe(MUST_REVALIDATE);
    expect(new TextDecoder().decode(mockResp.sentBody ?? new Uint8Array())).toBe(
      'User-agent: *',
    );
    // The hashed-asset route is unchanged.
    expect(harness.assetPatterns).toContain('/assets/*');
  });

  // M70n code review: `clientBuildRoot` derives the served root by chopping the
  // last path segment. Three inputs derive a root that CONTAINS the whole
  // application rather than the build output, and the containment guard cannot
  // catch them — containment holds, the root itself is wrong. Each case below
  // serves a real file from the widened root WITHOUT the refusal.
  describe('degenerate derived roots are refused', () => {
    async function catchAllFor(
      assetsDir: string,
      fileMap: Record<string, Uint8Array>,
      warnings?: Array<{ message: string; meta?: Record<string, unknown> }>,
    ): Promise<{ handler: RouteHandler; harness: PluginHarness }> {
      const harness = makeHarness(fileMap, warnings);
      await harness.register({ ...baseOptions, assetsDir });
      const catchAll = harness.getHandlers.find((r) => r.pattern === '/*');
      return { handler: catchAll?.handler as RouteHandler, harness };
    }

    it("refuses '.' — does not serve the process working directory", async () => {
      // './assets' derives '.', so a cwd file is one unauthenticated GET away.
      const { handler } = await catchAllFor('./assets', {
        './.env': encoder.encode('SESSION_SECRET=super-secret'),
      });
      const mockResp = buildMockResponse();
      await handler(buildMockCtx('/.env', mockResp));

      expect(mockResp.sentBody).toBeNull();
      expect(mockResp.sentStream).not.toBeNull();
      expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    });

    it("refuses '' — does not serve the filesystem root", async () => {
      // '/assets' derives '', so `${''}/${'etc/passwd'}` is an absolute read.
      const { handler } = await catchAllFor('/assets', {
        '/etc/passwd': encoder.encode('root:x:0:0'),
      });
      const mockResp = buildMockResponse();
      await handler(buildMockCtx('/etc/passwd', mockResp));

      expect(mockResp.sentBody).toBeNull();
      expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    });

    it('refuses an assetsDir that names no parent at all', async () => {
      const { handler } = await catchAllFor('assets', {
        'assets/robots.txt': encoder.encode('User-agent: *'),
      });
      const mockResp = buildMockResponse();
      await handler(buildMockCtx('/robots.txt', mockResp));

      expect(mockResp.sentBody).toBeNull();
      expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    });

    it("refuses '..' — does not serve a directory ABOVE the working directory", async () => {
      // '../assets' derives '..'. Broader than the cwd case, same mechanism.
      const { handler } = await catchAllFor('../assets', {
        '../secrets.txt': encoder.encode('token'),
      });
      const mockResp = buildMockResponse();
      await handler(buildMockCtx('/secrets.txt', mockResp));

      expect(mockResp.sentBody).toBeNull();
      expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    });

    it('names the refused assetsDir instead of failing silently', async () => {
      const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
      await catchAllFor('./assets', {}, warnings);

      const warned = warnings.find((w) => w.message.includes('client-build root'));
      expect(warned).toBeDefined();
      expect(warned?.meta?.assetsDir).toBe('./assets');
    });

    it('still derives a real parent for a normal build layout', async () => {
      const { handler } = await catchAllFor('/srv/app/build/client/assets', {
        '/srv/app/build/client/robots.txt': encoder.encode('User-agent: *'),
      });
      const mockResp = buildMockResponse();
      await handler(buildMockCtx('/robots.txt', mockResp));

      expect(new TextDecoder().decode(mockResp.sentBody ?? new Uint8Array())).toBe(
        'User-agent: *',
      );
    });
  });

  it('falls through to SSR for a root miss', async () => {
    const harness = makeHarness({});
    await harness.register(baseOptions);

    const catchAll = harness.getHandlers.find((r) => r.pattern === '/*');
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/products/42', mockResp);

    await (catchAll?.handler as RouteHandler)(ctx);

    // The SSR bridge answered: the html body was streamed onto the response.
    expect(mockResp.sentStream).not.toBeNull();
    expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    expect(mockResp.headers.get('Cache-Control')).toBeUndefined();
  });

  it('publicFiles: false reproduces prefix-only behavior', async () => {
    const harness = makeHarness({
      '/srv/app/build/client/robots.txt': encoder.encode('User-agent: *'),
    });
    await harness.register({ ...baseOptions, publicFiles: false });

    const catchAll = harness.getHandlers.find((r) => r.pattern === '/*');
    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/robots.txt', mockResp);

    await (catchAll?.handler as RouteHandler)(ctx);

    // The existing root file is NOT intercepted — SSR answers instead.
    expect(mockResp.sentStream).not.toBeNull();
    expect(await streamText(mockResp.sentStream!)).toContain('ssr');
    expect(mockResp.headers.get('Cache-Control')).toBeUndefined();
  });

  it('still serves asset files from the assets dir under the asset prefix', async () => {
    const harness = makeHarness({
      '/srv/app/build/client/assets/app-A9acsx54.js': encoder.encode('console.log(1)'),
    });
    await harness.register(baseOptions);

    const assetRoute = harness.assetPatterns.length > 0
      ? harness.getHandlers.find((r) => r.pattern === '/assets/*')
      : undefined;
    expect(assetRoute).toBeDefined();

    const mockResp = buildMockResponse();
    const ctx = buildMockCtx('/assets/app-A9acsx54.js', mockResp);
    await (assetRoute?.handler as RouteHandler)(ctx);

    expect(mockResp.sentBody).not.toBeNull();
    expect(new TextDecoder().decode(mockResp.sentBody ?? new Uint8Array())).toBe(
      'console.log(1)',
    );
    expect(mockResp.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});
