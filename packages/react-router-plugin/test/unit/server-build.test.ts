import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * Tests for server-build loader and pure assembleHandler seam.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { ReactRouterPluginOptions, SsrRequestHandler } from '../../src/interfaces/index.ts';
import {
  assembleHandler,
  assertSsrRuntime,
  createLoadContextFactory,
  loadRequestHandler,
} from '../../src/handler/server-build.ts';
import { createFakeLoadContextFactory, createSimpleFakeHandler } from '../fixtures/fake-handler.ts';

describe('server-build', () => {
  it('assembleHandler returns a handler that calls createRequestHandler(build, mode)', () => {
    let factoryCalled = false;
    let capturedBuild: unknown = null;
    let capturedMode: string | undefined = undefined;

    const fakeBuild = { __type: 'ServerBuild' };
    const fakeRRResponse = new Response('<html>ok</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    const createRequestHandler = (build: unknown, mode?: string): SsrRequestHandler => {
      factoryCalled = true;
      capturedBuild = build;
      capturedMode = mode;
      // eslint-disable-next-line require-await
      return async (_request, _context) => fakeRRResponse;
    };

    const handler = assembleHandler(fakeBuild, createRequestHandler, 'production');

    // assembleHandler calls createRequestHandler immediately, so factoryCalled is true.
    expect(factoryCalled).toBe(true);
    expect(capturedBuild).toBe(fakeBuild);
    expect(capturedMode).toBe('production');

    const fakeRequest = new Request('http://localhost/', { method: 'GET' });
    void handler(fakeRequest, {});

    expect(factoryCalled).toBe(true);
    expect(capturedBuild).toBe(fakeBuild);
    expect(capturedMode).toBe('production');
  });

  it('assembleHandler forwards request and loadContext to the created handler', () => {
    let receivedRequest: Request | null = null;
    let receivedContext: unknown = null;

    const createRequestHandler = () => {
      // eslint-disable-next-line require-await
      return async (request: Request, context: unknown) => {
        receivedRequest = request;
        receivedContext = context;
        return new Response('ok');
      };
    };

    const handler = assembleHandler({}, createRequestHandler, 'development');
    const testRequest = new Request('http://localhost/test', {
      method: 'POST',
      body: 'data',
    });
    const testContext = { services: {}, user: { name: 'admin' } };

    void handler(testRequest, testContext);

    expect(receivedRequest).toBe(testRequest);
    expect(receivedRequest!.method).toBe('POST');
    expect(receivedContext).toBe(testContext);
  });

  it('error propagates when createRequestHandler factory throws', () => {
    const erringFactory = (): never => {
      throw new Error('RR factory failed');
    };

    try {
      assembleHandler({}, erringFactory, 'production');
      expect(true).toBe(false);
    } catch (e) {
      expect(e instanceof Error && e.message).toBe('RR factory failed');
    }
  });

  it('createSimpleFakeHandler returns a handler that always resolves with the given response', async () => {
    const expectedResponse = new Response('fixed', { status: 418 });
    const handler = createSimpleFakeHandler(expectedResponse);
    const request = new Request('http://localhost/test');
    const result = await handler(request, createFakeLoadContextFactory()());

    expect(result).toBe(expectedResponse);
    const text = await result.text();
    expect(text).toBe('fixed');
  });

  it('createSimpleFakeHandler rejects a plain-object context like the real handler', async () => {
    // Guards the fixture itself: a double that accepted any context is what let
    // the RouterContextProvider defect ship green.
    const handler = createSimpleFakeHandler(new Response('unused'));

    await expect(handler(new Request('http://localhost/'), {})).rejects.toThrow(
      'Invalid `context` value provided to `handleRequest`',
    );
  });

  it('createLoadContextFactory builds a fresh provider instance per call', () => {
    class FakeProvider {
      get() {}
      set() {}
    }

    const factory = createLoadContextFactory({ RouterContextProvider: FakeProvider });
    const a = factory();
    const b = factory();

    expect(a).toBeInstanceOf(FakeProvider);
    expect(b).toBeInstanceOf(FakeProvider);
    expect(a).not.toBe(b);
  });

  it('createLoadContextFactory throws when RouterContextProvider is missing', () => {
    expect(() => createLoadContextFactory({})).toThrow("exposes no 'RouterContextProvider' export");
  });

  it('createLoadContextFactory throws when RouterContextProvider is not callable', () => {
    expect(() => createLoadContextFactory({ RouterContextProvider: 'nope' })).toThrow(
      "exposes no 'RouterContextProvider' export",
    );
  });

  it('assertSsrRuntime returns the runtime when both members are functions', () => {
    const runtime = {
      // eslint-disable-next-line require-await
      handler: async () => new Response('ok'),
      createLoadContext: createFakeLoadContextFactory(),
    };

    expect(assertSsrRuntime(runtime)).toBe(runtime);
  });

  it('assertSsrRuntime rejects a bare handler and names the pre-0.2.0 shape', () => {
    // eslint-disable-next-line require-await
    const legacy = async () => new Response('ok');

    expect(() => assertSsrRuntime(legacy)).toThrow(
      'a bare request handler function (the pre-0.2.0 shape)',
    );
  });

  it('assertSsrRuntime rejects an object missing createLoadContext and lists its keys', () => {
    expect(() => assertSsrRuntime({ handler: () => {} })).toThrow('an object with keys [handler]');
  });

  it('assertSsrRuntime rejects a runtime whose handler is not a function', () => {
    expect(() => assertSsrRuntime({ handler: 'nope', createLoadContext: () => {} })).toThrow(
      'must resolve to { handler, createLoadContext }',
    );
  });

  it('assertSsrRuntime rejects null and undefined by name', () => {
    expect(() => assertSsrRuntime(null)).toThrow('but got null');
    expect(() => assertSsrRuntime(undefined)).toThrow('but got undefined');
  });

  it('assertSsrRuntime names a primitive by type', () => {
    expect(() => assertSsrRuntime(42)).toThrow('a number');
  });

  it('loadRequestHandler throws when the module has no createRequestHandler', async () => {
    // A real build module, so the failure is attributable to the rr module.
    const tmp = await tempDir({ prefix: 'rr-crh-' });
    try {
      const buildPath = `${tmp}/build.mjs`;
      await nodeFs.writeFile(buildPath, 'export default { routes: {} };');

      await expect(
        loadRequestHandler(buildPath, 'production', {
          rrImportHook: () => Promise.resolve({ RouterContextProvider: class {} }),
        }),
      ).rejects.toThrow("exposes no 'createRequestHandler' export");
    } finally {
      await nodeFs.rm(tmp, { recursive: true });
    }
  });

  it('loadRequestHandler rejects when server build path does not exist', async () => {
    const nonExistentPath = './__non_existent_build_path_for_test__';
    await expect(loadRequestHandler(nonExistentPath, 'production')).rejects.toThrow(
      'Failed to load React Router server build',
    );
  });
});

// ── M113d §3.10 — the module arm ─────────────────────────────────────────────

describe('loadRequestHandler — the module arm (M113d §3.10)', () => {
  const fakeRR = (): Record<string, unknown> =>
    ({
      createRequestHandler: (build: unknown, mode: string) =>
        (_request: Request) => Promise.resolve(new Response(`${mode}:${String(build)}`)),
      RouterContextProvider: class {},
    }) as unknown as Record<string, unknown>;

  it('produces the same handler and context factory from a module as from a path', async () => {
    const tmp = await tempDir({ prefix: 'rr-module-arm-' });
    try {
      const buildPath = `${tmp}/build.mjs`;
      await nodeFs.writeFile(
        buildPath,
        'export default { routes: {} };\n',
      );
      const byPath = await loadRequestHandler(buildPath, 'production', {
        rrImportHook: () => Promise.resolve(fakeRR()),
      });
      const byModule = await loadRequestHandler('<serverBuild>', 'production', {
        rrImportHook: () => Promise.resolve(fakeRR()),
        serverBuild: { default: { routes: {} } },
      });
      expect(typeof byPath.handler).toBe('function');
      expect(typeof byModule.handler).toBe('function');
      expect(typeof byPath.createLoadContext).toBe('function');
      expect(typeof byModule.createLoadContext).toBe('function');
      // The same build object reaches createRequestHandler: the served string
      // names the mode and the build, identical on both arms.
      const responseA = await (byPath.handler as SsrRequestHandler)(
        new Request('http://localhost/'),
        {},
      );
      const responseB = await (byModule.handler as SsrRequestHandler)(
        new Request('http://localhost/'),
        {},
      );
      expect(await responseA.text()).toBe(await responseB.text());
    } finally {
      await nodeFs.rm(tmp, { recursive: true });
    }
  });

  it('unwraps a default-export module, and uses a bare namespace as-is', async () => {
    const unwrapped = await loadRequestHandler('<serverBuild>', 'production', {
      rrImportHook: () => Promise.resolve(fakeRR()),
      serverBuild: { default: { routes: {} } },
    });
    const bare = await loadRequestHandler('<serverBuild>', 'production', {
      rrImportHook: () => Promise.resolve(fakeRR()),
      serverBuild: { routes: {} },
    });
    expect(typeof unwrapped.handler).toBe('function');
    expect(typeof bare.handler).toBe('function');
  });
});

describe('ReactRouterPluginOptions — the arms are exclusive at the type level (M113d §3.10)', () => {
  it('refuses neither arm and both arms at compile time', () => {
    function arms(): ReadonlyArray<ReactRouterPluginOptions> {
      return [
        // @ts-expect-error — supplying NEITHER serverBuildPath nor serverBuild is a compile error.
        {},
        // @ts-expect-error — supplying BOTH is a compile error: exactly one arm.
        { serverBuildPath: 'https://example.test/build/server/index.js', serverBuild: {} },
      ];
    }
    expect(typeof arms).toBe('function');
  });
});
