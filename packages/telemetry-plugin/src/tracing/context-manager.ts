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
 * Lazily loads OTel's async-local-storage manager.
 *
 * @returns A context manager suitable for global registration
 * @internal
 */
export async function loadAsyncLocalStorageContextManager(): Promise<ContextManager> {
  const module = await import('npm:@opentelemetry/context-async-hooks@^2.0.0');
  return new module.AsyncLocalStorageContextManager();
}

/**
 * Registers a manager without allowing optional tracing support to prevent startup.
 *
 * @param api - OTel context API
 * @param factory - Injectable or lazy manager factory
 * @returns Whether an active context mechanism is available
 * @internal
 */
export async function registerContextManager(
  api: ContextManagerApi,
  factory: ContextManagerFactory,
): Promise<boolean> {
  try {
    const manager = await factory();
    return api.setGlobalContextManager(manager) || true;
  } catch {
    return false;
  }
}
