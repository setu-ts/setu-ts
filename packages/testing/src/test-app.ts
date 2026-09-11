import type { IPlugin } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';

/**
 * Hand-assembled arm of {@linkcode TestAppOptions}: the test names the plugins
 * it wants and gets nothing else.
 *
 * Use this for unit scope — a route, a middleware, one plugin in isolation.
 * For anything whose behaviour depends on how the application is composed,
 * prefer {@linkcode TestAppFromApp}, which builds from the project's own
 * composition root instead of a second, divergent one.
 *
 * @since 0.6.0
 */
export interface TestAppFromPlugins {
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
  /** Not available on this arm — supply `plugins` or `app`, never both. */
  app?: never;
  /** Not available on this arm — supply `plugins` or `app`, never both. */
  without?: never;
  /** Not available on this arm — supply `plugins` or `app`, never both. */
  overrides?: never;
}

/**
 * Composition-root arm of {@linkcode TestAppOptions}: the test starts from the
 * application the project actually ships and subtracts from it.
 *
 * This is the arm that makes a test app compose like a real one. Everything the
 * root registered — middleware, error handling, health indicators, route
 * ordering — is present, so a test observes the composition production has
 * rather than a second one assembled by hand.
 *
 * @since 0.6.0
 */
export interface TestAppFromApp {
  /**
   * An already-constructed, **not yet started** application — typically the
   * `createApp()` a scaffolded project exports from `setu.config.ts`, or a
   * starter factory's return value.
   *
   * `createTestApp` applies `without`, then `overrides`, then starts it.
   */
  app: IKernelApplication;
  /**
   * Plugin names to drop before `start()`, so their `register()` never runs
   * and any eager side effect inside it never happens.
   *
   * Throws naming the entry if the application holds no plugin with that name:
   * a silently ignored `without: ['databse']` would run the whole test against
   * the real plugin while reporting success. Repeated entries are de-duplicated,
   * so listing a name twice is not that error.
   */
  without?: readonly string[];
  /**
   * Plugins to append after `without` is applied — usually
   * {@linkcode overrideCapability} results, though any `IPlugin` is accepted.
   *
   * This exists because the default `autoStart: true` leaves no window between
   * construction and `start()` in which a caller could register them.
   */
  overrides?: readonly IPlugin[];
  /**
   * Whether to auto-start the application.
   *
   * @default true
   */
  autoStart?: boolean;
  /** Not available on this arm — supply `plugins` or `app`, never both. */
  plugins?: never;
}

/**
 * Options for {@linkcode createTestApp}.
 *
 * A union of two mutually exclusive arms, so supplying both `plugins` and `app`
 * is a compile error rather than a runtime throw.
 *
 * @since 0.1.0
 */
export type TestAppOptions = TestAppFromPlugins | TestAppFromApp;

/**
 * Creates a started test application that can be exercised via `inject()`
 * and `fetch()` without binding a socket.
 *
 * Two arms. Pass `plugins` to assemble one by hand, or pass `app` to build from
 * the project's own composition root and subtract from it — the latter is what
 * keeps a test app's composition honest, since anything the root registers
 * (error handling included) is present in the test too.
 *
 * @example
 * ```typescript
 * // Hand-assembled: unit scope.
 * import { createTestApp } from '@setu-ts/testing';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 *
 * const app = await createTestApp({ plugins: [RuntimePlugin()] });
 *
 * app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));
 * const res = await app.inject({ method: 'GET', url: '/users' });
 * console.log(res.statusCode); // 200
 * ```
 *
 * @example
 * ```typescript
 * // Composition root: the real app, minus the database, plus a fake mailer.
 * import { createTestApp, overrideCapability } from '@setu-ts/testing';
 * import { CAPABILITIES } from '@setu-ts/common';
 * import { createApp } from '../setu.config.ts';
 *
 * const app = await createTestApp({
 *   app: createApp(),
 *   without: ['database'],
 *   overrides: [overrideCapability(CAPABILITIES.MAIL, fakeMailer)],
 * });
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
 * @throws {Error} If `without` names a plugin the supplied `app` does not hold
 * @since 0.1.0
 */
export async function createTestApp(
  options?: TestAppOptions,
): Promise<IKernelApplication> {
  const autoStart = options?.autoStart ?? true;
  const app = options?.app ?? createApplication({ plugins: options?.plugins ?? [] });

  if (options?.app !== undefined) {
    // De-duplicated: `unregister` removes every plugin carrying the name, so a
    // repeated entry would find nothing on the second pass and throw "the
    // application holds no plugin with that name" — blaming the caller's
    // spelling for a harmless duplicate.
    for (const name of new Set(options.without ?? [])) {
      if (!app.unregister(name)) {
        throw new Error(
          `createTestApp: cannot exclude plugin '${name}' — the application holds no plugin ` +
            `with that name. Check the spelling against the composition root; an ignored ` +
            `exclusion would run the test against the real plugin.`,
        );
      }
    }
    for (const plugin of options.overrides ?? []) {
      app.register(plugin);
    }
  }

  if (autoStart) {
    await app.start();
  }

  return app;
}
