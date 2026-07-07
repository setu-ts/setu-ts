/**
 * Fake {@linkcode ILifecycleApi} that records hook registrations for
 * assertions and allows tests to run them on demand.
 *
 * @module
 */
import type { ILifecycleApi, IRequestContext } from '@hono-enterprise/common';

/** A recorded lifecycle hook keyed by phase. */
export type LifecycleHook =
  | { readonly phase: 'onRegister'; readonly fn: () => void | Promise<void> }
  | { readonly phase: 'onInit'; readonly fn: () => void | Promise<void> }
  | { readonly phase: 'onBootstrap'; readonly fn: () => void | Promise<void> }
  | { readonly phase: 'onRequest'; readonly fn: (ctx: IRequestContext) => void | Promise<void> }
  | { readonly phase: 'onResponse'; readonly fn: (ctx: IRequestContext) => void | Promise<void> }
  | {
    readonly phase: 'onError';
    readonly fn: (error: Error, ctx: IRequestContext) => void | Promise<void>;
  }
  | { readonly phase: 'onShutdown'; readonly fn: () => void | Promise<void> }
  | { readonly phase: 'onClose'; readonly fn: () => void | Promise<void> };

/**
 * Creates a fake lifecycle API that records every hook registration.
 *
 * @returns The API and the recorded hooks
 */
export function createFakeLifecycle(): {
  readonly api: ILifecycleApi;
  readonly hooks: LifecycleHook[];
} {
  const hooks: LifecycleHook[] = [];
  const api: ILifecycleApi = {
    onRegister(fn) {
      hooks.push({ phase: 'onRegister', fn });
    },
    onInit(fn) {
      hooks.push({ phase: 'onInit', fn });
    },
    onBootstrap(fn) {
      hooks.push({ phase: 'onBootstrap', fn });
    },
    onRequest(fn) {
      hooks.push({ phase: 'onRequest', fn });
    },
    onResponse(fn) {
      hooks.push({ phase: 'onResponse', fn });
    },
    onError(fn) {
      hooks.push({ phase: 'onError', fn });
    },
    onShutdown(fn) {
      hooks.push({ phase: 'onShutdown', fn });
    },
    onClose(fn) {
      hooks.push({ phase: 'onClose', fn });
    },
  };
  return { api, hooks };
}
