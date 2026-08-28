/** @module Context-manager setup for active OTel spans. */

/** Minimal shape accepted by OTel's global context registration API. @internal */
export interface ContextManager {
  enable(): unknown;
  disable(): unknown;
}

/** OTel context surface used by the loader. @internal */
export interface ContextManagerApi {
  setGlobalContextManager(manager: ContextManager): boolean;
}

/** Injectable lazy-loader seam. @internal */
export type ContextManagerFactory = () => Promise<ContextManager>;

/**
 * The result of attempting to make OTel spans active.
 *
 * `activated: true` means nested spans will parent correctly. `adopted` says
 * which manager carries the context: `'registered'` when this plugin installed
 * one, `'existing'` when the host application had already installed its own —
 * `setGlobalContextManager` refuses the second registration, but the host's
 * manager propagates context just as well, so activation is still available.
 *
 * @internal
 */
export type ContextManagerOutcome =
  | { readonly activated: true; readonly adopted: 'registered' | 'existing' }
  | { readonly activated: false; readonly reason: string };

/** The `npm:` specifier the context-manager loader resolves. */
const CONTEXT_MANAGER_SPECIFIER = 'npm:@opentelemetry/context-async-hooks@^2.0.0';

/**
 * Lazily loads OTel's async-local-storage manager.
 *
 * The specifier is a **literal** at the `import()` call — the only form that
 * survives JSR's static npm-compatibility rewrite and loads on Node or Bun
 * (M70e / X7-3).
 *
 * @returns A context manager suitable for global registration
 * @throws {Error} If `@opentelemetry/context-async-hooks` cannot be resolved
 * @internal
 */
export async function loadAsyncLocalStorageContextManager(): Promise<ContextManager> {
  const module = await import('npm:@opentelemetry/context-async-hooks@^2.0.0');
  return new module.AsyncLocalStorageContextManager();
}

/**
 * Registers a context manager so OTel spans can become active.
 *
 * Never throws: span activation is an enhancement, so a runtime without
 * `node:async_hooks` (or an application that did not install the optional
 * package) degrades to unnested spans rather than failing startup. The caller
 * reports the returned outcome.
 *
 * `enable()` is deliberately not called — `AsyncLocalStorageContextManager`
 * creates its store in its constructor, verified by probe, and OTel's
 * `setGlobalContextManager` does not require an enabled manager.
 *
 * @param api - OTel context API carrying `setGlobalContextManager`
 * @param factory - Injectable or lazy manager factory
 * @returns Whether an active-context mechanism is available, and why not when it is not
 * @internal
 */
export async function registerContextManager(
  api: ContextManagerApi,
  factory: ContextManagerFactory,
): Promise<ContextManagerOutcome> {
  let manager: ContextManager;
  try {
    manager = await factory();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      activated: false,
      reason: `${CONTEXT_MANAGER_SPECIFIER} could not be loaded: ${detail}`,
    };
  }
  // A `false` return means a manager was already registered — by the host
  // application, or by an earlier TelemetryPlugin in the same process. That
  // manager carries the context, so activation is available in both cases; the
  // two are reported apart rather than collapsed.
  //
  // The call is guarded as well as the factory: OTel's own implementation logs
  // and returns `false` on conflict rather than throwing, but this function's
  // contract is that activation cannot prevent startup, and that has to hold
  // for a host that has replaced the global API surface too.
  try {
    const registered = api.setGlobalContextManager(manager);
    return { activated: true, adopted: registered ? 'registered' : 'existing' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { activated: false, reason: `context manager registration failed: ${detail}` };
  }
}
