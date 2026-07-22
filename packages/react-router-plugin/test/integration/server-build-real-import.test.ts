/**
 * Guarded REAL import test for `npm:react-router`.
 *
 * This is the single test that exercises the real `await import('npm:react-router')` path.
 * Skipped when the package is absent; when present, asserts the core export shape.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { assembleHandler } from '../../src/handler/server-build.ts';

describe('server-build-real-import', () => {
  it('real npm:react-router import resolves and has createRequestHandler', async () => {
    let createRequestHandler: ((b: unknown, m?: string) => unknown) | undefined;

    try {
      const rr = await import('npm:react-router');
      createRequestHandler = rr.createRequestHandler as
        | ((b: unknown, m?: string) => unknown)
        | undefined;
    } catch {
      // Package not installed in this environment — skip the test gracefully.
      throw new Error('SKIP: npm:react-router not available');
    }

    expect(createRequestHandler).toBeDefined();
    expect(typeof createRequestHandler).toBe('function');
  });

  it('default loadRequestHandler path works with synthetic ServerBuild (guarded)', async () => {
    let createRequestHandler: ((b: unknown, m?: string) => unknown) | undefined;

    try {
      const rr = await import('npm:react-router');
      createRequestHandler = rr.createRequestHandler as
        | ((b: unknown, m?: string) => unknown)
        | undefined;
    } catch {
      throw new Error('SKIP: npm:react-router not available');
    }

    expect(createRequestHandler).toBeDefined();

    // Create a synthetic "ServerBuild" mock for testing the assemble path.
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

    // Verify assembleHandler works with the real createRequestHandler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = assembleHandler(
      fakeBuild.default,
      createRequestHandler as any,
      'production',
    );
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });
});
