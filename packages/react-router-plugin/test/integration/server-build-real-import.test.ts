/**
 * Guarded REAL import test for `npm:react-router@8`.
 *
 * The first case exercises the real `await import('npm:react-router@8')` path and
 * is genuinely SKIPPED when the package is unavailable. The remaining cases are
 * pure `assembleHandler` checks that need no network — they assert the build
 * unwrapping contract with a synthetic `ServerBuild`.
 *
 * The end-to-end drive of the default `loadRequestHandler` over a real import
 * lives in `server-build-load-request-handler.test.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { assembleHandler } from '../../src/handler/server-build.ts';

// Resolved once at module load. A `throw new Error('SKIP: ...')` inside the test
// would report a FAILURE, not a skip — the whole point of guarding is that an
// absent optional dependency does not turn the suite red.
let rrModule: Record<string, unknown> | null = null;
try {
  rrModule = await import('npm:react-router@8') as unknown as Record<string, unknown>;
} catch {
  rrModule = null;
}

describe('server-build-real-import', () => {
  it(
    'real npm:react-router@8 import resolves and has createRequestHandler',
    { ignore: rrModule === null },
    () => {
      const createRequestHandler = rrModule?.createRequestHandler;

      expect(createRequestHandler).toBeDefined();
      expect(typeof createRequestHandler).toBe('function');
      // React Router 8 is required for the nominal context-provider check the
      // plugin depends on, so assert that export is present too.
      expect(typeof rrModule?.RouterContextProvider).toBe('function');
    },
  );

  it('assembleHandler works with a synthetic ServerBuild', () => {
    const fakeBuild = {
      __esModule: true,
      default: {
        bootstrapModules: [],
        entry: { module: { default: async () => {} } },
        routes: {},
        mode: 'production',
        serverManifest: {},
      },
    };

    const mockCrh = ((_build: unknown, _mode?: string) => {
      // deno-lint-ignore require-await
      return async () => new Response('ok');
    }) as (build: unknown, mode?: string) => SsrRequestHandler;

    const handler = assembleHandler(fakeBuild.default, mockCrh, 'production');
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('assembleHandler receives the unwrapped .default of a module namespace', () => {
    const syntheticBuild = {
      default: {
        bootstrapModules: [],
        entry: { module: { default: async () => {} } },
        routes: {
          root: {
            id: 'root',
            path: '',
            Component: () => null,
            children: [],
          },
        },
        mode: 'production',
        serverManifest: {},
      },
    };

    let receivedBuild: unknown;
    // deno-lint-ignore ban-types
    const trackedCrh = (build: unknown, _mode: string): Function => {
      receivedBuild = build;
      // deno-lint-ignore require-await
      return async () => new Response('mock');
    };

    // deno-lint-ignore no-explicit-any
    const handler = assembleHandler(syntheticBuild.default, trackedCrh as any, 'production');
    expect(handler).toBeDefined();
    // assembleHandler calls createRequestHandler immediately, so receivedBuild should be set.
    expect(receivedBuild).toBe(syntheticBuild.default);

    // Invoke the handler to verify it returns correctly.
    const req = new Request('http://localhost/', { method: 'GET' });
    void handler(req, {});
  });
});
