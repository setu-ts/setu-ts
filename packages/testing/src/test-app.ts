import type { IPlugin } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';

/**
 * Options for {@linkcode createTestApp}.
 *
 * @since 0.1.0
 */
export interface TestAppOptions {
  /**
   * Plugins to pre-register before `start()`. **Must include a runtime
   * capability provider** (`RuntimePlugin()` or a mock providing
   * `CAPABILITIES.RUNTIME`) when `autoStart` is `true` — the kernel
   * throws otherwise.
   *
   * Defaults to `[]`, which is only usable with `autoStart: false`.
   */
  plugins?: IPlugin[];
  /**
   * Whether to auto-start the application.
   *
   * - `true` (default): calls `await app.start()` before returning.
   * - `false`: returns the un-started app, required both to register more
   *   plugins (`register()` throws once started) and to add global middleware
   *   (`middleware.add` throws after `start()` compiles the pipeline).
   *
   * @default true
   */
  autoStart?: boolean;
}

/**
 * Creates a started test application that can be exercised via `inject()`
 * and `fetch()` without binding a socket.
 *
 * Wraps `createApplication` with an automatic `start()` (no port), returning
 * the `IKernelApplication` so tests can call `app.inject({ method, url })`
 * or `app.fetch(request)` directly.
 *
 * @example
 * ```typescript
 * import { createTestApp } from '@setu-ts/testing';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 *
 * const app = await createTestApp({
 *   plugins: [RuntimePlugin()],
 * });
 *
 * app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));
 * const res = await app.inject({ method: 'GET', url: '/users' });
 * console.log(res.statusCode); // 200
 * ```
 *
 * @example
 * ```typescript
 * // Adding global middleware requires autoStart: false:
 * const app = await createTestApp({
 *   plugins: [RuntimePlugin()],
 *   autoStart: false,
 * });
 *
 * app.middleware.add(async (ctx, next) => { /* ... *\/ await next(); });
 * await app.start();
 * ```
 *
 * @param options - Test application options
 * @returns A started (or un-started) kernel application
 * @since 0.1.0
 */
export async function createTestApp(
  options?: TestAppOptions,
): Promise<IKernelApplication> {
  const opts = { autoStart: true, ...options };
  const app = createApplication({ plugins: opts.plugins ?? [] });

  if (opts.autoStart) {
    await app.start();
  }

  return app;
}
