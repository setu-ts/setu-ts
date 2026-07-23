/**
 * Real-load tests for `loadRequestHandler` — drives the entire loader chain
 * (import of local ESM module → .default unwrap → npm:react-router import →
 * assembleHandler).
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { SsrRequestHandler } from '../../src/interfaces/index.ts';
import { loadRequestHandler } from '../../src/handler/server-build.ts';

describe('loadRequestHandler — real import path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: 'rr-plugin-test-' });
  });

  afterEach(() => {
    try {
      Deno.removeSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors.
    }
  });

  it('loads a module with a default export and returns a callable handler', async () => {
    // Create a minimal ESM module that exports a ServerBuild-like shape as default.
    const moduleContent = `
export default {
  routes: {},
  entry: { module: { default: async () => {} } },
  mode: 'production',
  serverManifest: {},
  bootstrapModules: [],
};
`;
    const modulePath = `${tmpDir}/server-build.mjs`;
    await Deno.writeTextFile(modulePath, moduleContent);

    const handler = await loadRequestHandler(modulePath, 'production');

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
    // We proved the load chain works: module import (.default unwrap) + rr import
    // + assembleHandler all succeeded. Invoking the handler would fail because our
    // build is minimal and RR validates routes deeply, so we stop here for coverage.
  });

  it('uses buildMod itself when no .default export exists (namespace-only module)', async () => {
    // Export without `.default` — the entire module namespace becomes the build.
    // This covers the right side of the ?? operator: buildMod default ?? buildMod
    const moduleContent = `
export const routes = {};
export const mode = 'production';
export const entry = { module: { default: async () => {} } };
`;
    const modulePath = `${tmpDir}/namespace-build.mjs`;
    await Deno.writeTextFile(modulePath, moduleContent);

    const handler = await loadRequestHandler(modulePath, 'production');

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('throws with meaningful message when the server build file cannot be loaded', async () => {
    const nonExistentPath = `${tmpDir}/does-not-exist.mjs`;

    await expect(
      loadRequestHandler(nonExistentPath, 'production'),
    ).rejects.toThrow('Failed to load React Router server build');
  });

  it('throws with meaningful message when react-router import fails', async () => {
    // Create a minimal valid server-build module.
    const moduleContent = `
export default {
  routes: {},
  entry: { module: { default: async () => {} } },
  mode: 'production',
  serverManifest: {},
  bootstrapModules: [],
};
`;
    const modulePath = `${tmpDir}/server-build.mjs`;
    await Deno.writeTextFile(modulePath, moduleContent);

    // Use the optional rrImportHook parameter to simulate a failed npm:react-router import.
    // This covers the catch block (lines 78-83) in server-build.ts where we throw about
    // the missing react-router package.
    await expect(
      loadRequestHandler(modulePath, 'production', {
        rrImportHook: (): Promise<Record<string, unknown>> => {
          throw new Error('Module not found: fake-react-router');
        },
      }),
    ).rejects.toThrow("Failed to import 'npm:react-router@7'");
  });

  it('default loadRequestHandler path unwraps .default from module namespace', async () => {
    // Same as test 1 but verifies that assembleHandler receives the unwrapped .default.
    const moduleContent = `
export default {
  routes: {},
  entry: { module: { default: async () => {} } },
  mode: 'production',
  serverManifest: {},
  bootstrapModules: [],
};
`;
    const modulePath = `${tmpDir}/server-build.mjs`;
    await Deno.writeTextFile(modulePath, moduleContent);

    // Use rrImportHook to capture what assembleHandler receives.
    let capturedBuild: unknown;
    const handler = await loadRequestHandler(modulePath, 'production', {
      rrImportHook: () =>
        Promise.resolve({
          // deno-lint-ignore no-explicit-any
          createRequestHandler: ((build: any, _mode: string) => {
            capturedBuild = build;
            return () => Promise.resolve(new Response('ok'));
          }) as unknown as (b: unknown, m: string) => SsrRequestHandler,
        }),
    });

    expect(handler).toBeDefined();
    // The assembled handler should receive the unwrapped .default (the object inside export default).
    expect(capturedBuild).toBeDefined();
    expect((capturedBuild as Record<string, unknown>)?.routes).toEqual({});
  });
});
