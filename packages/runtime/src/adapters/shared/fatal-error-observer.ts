/**
 * Observers for an error that is about to end the process, behind
 * `IRuntimeServices.onFatalError`. Each observes only: the process still ends
 * as it would have, with the runtime's own exit code and report.
 *
 * @module
 */
import type { FatalErrorOrigin } from '@setu-ts/common';

/** A fatal-error handler as `IRuntimeServices.onFatalError` takes it. */
export type FatalErrorHandler = (error: unknown, origin: FatalErrorOrigin) => void;

/** The `process` surface the process-event observer needs. */
export interface ProcessEventHost {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
}

/** The global event surface Deno's observer needs. */
export interface GlobalEventHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * A set of handlers whose shared process listeners exist only while the set
 * is non-empty, so starting many applications in one process never piles
 * listeners onto it.
 *
 * @param install - Adds the process listeners; returns their removal
 * @returns The `onFatalError` implementation, and the notifier the listeners call
 */
function handlerSet(install: (notify: FatalErrorHandler) => () => void): {
  subscribe: (handler: FatalErrorHandler) => () => void;
} {
  const handlers = new Set<FatalErrorHandler>();
  let uninstall: (() => void) | undefined;
  const notify: FatalErrorHandler = (error, origin) => {
    for (const handler of handlers) {
      try {
        handler(error, origin);
      } catch {
        // A handler that throws must never change how the process ends.
      }
    }
  };
  return {
    subscribe(handler) {
      // A function wrapper, so subscribing the same handler twice gives two
      // independent subscriptions.
      const entry: FatalErrorHandler = (error, origin) => handler(error, origin);
      handlers.add(entry);
      uninstall ??= install(notify);
      return () => {
        if (!handlers.delete(entry)) return;
        if (handlers.size === 0) {
          uninstall?.();
          uninstall = undefined;
        }
      };
    },
  };
}

/**
 * Node's observer: `uncaughtExceptionMonitor` sees both a thrown error and,
 * under Node's default `--unhandled-rejections=throw`, an unhandled rejection
 * (origin `'unhandledRejection'`), without changing the crash.
 *
 * @param proc - The process
 * @returns The `onFatalError` implementation
 */
export function createNodeFatalErrorObserver(
  proc: ProcessEventHost,
): (handler: FatalErrorHandler) => () => void {
  return handlerSet((notify) => {
    const monitor = (error: unknown, origin: unknown): void => {
      notify(error, origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException');
    };
    proc.on('uncaughtExceptionMonitor', monitor as (...args: unknown[]) => void);
    return () => proc.off('uncaughtExceptionMonitor', monitor as (...args: unknown[]) => void);
  }).subscribe;
}

/**
 * Bun's observer. Bun's `uncaughtExceptionMonitor` sees thrown errors but
 * never a rejection, and a Bun `unhandledRejection` listener suppresses the
 * crash (measured on Bun 1.4.5: the process lived and exited 0). So the
 * rejection listener reports and then, when it is the only
 * `unhandledRejection` listener, rethrows the reason, which crashes the
 * process as Bun would have. When the application registered its own
 * listener it chose not to crash, and nothing is rethrown. The rethrown
 * reason is remembered so the monitor does not report the crash twice.
 *
 * @param proc - The process
 * @returns The `onFatalError` implementation
 */
export function createBunFatalErrorObserver(
  proc: ProcessEventHost,
): (handler: FatalErrorHandler) => () => void {
  return handlerSet((notify) => {
    const rethrown = new WeakSet<object>();
    const monitor = (error: unknown): void => {
      if (typeof error === 'object' && error !== null && rethrown.has(error)) return;
      notify(error, 'uncaughtException');
    };
    const rejection = (reason: unknown): void => {
      notify(reason, 'unhandledRejection');
      if (proc.listenerCount('unhandledRejection') !== 1) return;
      const thrown =
        typeof reason === 'object' && reason !== null
          ? reason
          : new Error(`Unhandled rejection: ${String(reason)}`);
      rethrown.add(thrown);
      throw thrown;
    };
    proc.on('uncaughtExceptionMonitor', monitor as (...args: unknown[]) => void);
    proc.on('unhandledRejection', rejection as (...args: unknown[]) => void);
    return () => {
      proc.off('uncaughtExceptionMonitor', monitor as (...args: unknown[]) => void);
      proc.off('unhandledRejection', rejection as (...args: unknown[]) => void);
    };
  }).subscribe;
}

/**
 * Deno's observer: the global `error` and `unhandledrejection` events,
 * without `preventDefault()`, so the process still exits 1 (measured on Deno
 * 2.9.6).
 *
 * @param target - The global scope
 * @returns The `onFatalError` implementation
 */
export function createDenoFatalErrorObserver(
  target: GlobalEventHost,
): (handler: FatalErrorHandler) => () => void {
  return handlerSet((notify) => {
    const onError = (event: Event): void => {
      notify((event as ErrorEvent).error, 'uncaughtException');
    };
    const onRejection = (event: Event): void => {
      notify((event as PromiseRejectionEvent).reason, 'unhandledRejection');
    };
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
    return () => {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    };
  }).subscribe;
}

/**
 * The `onFatalError` host member for a process object, or nothing when the
 * object cannot add, remove and count listeners (an injected test double
 * that only listens for signals).
 *
 * @param proc - The process object a host builder was given
 * @param create - The runtime's observer factory
 * @returns `{ onFatalError }`, or an empty object
 */
export function processFatalErrors(
  proc: object,
  create: (proc: ProcessEventHost) => (handler: FatalErrorHandler) => () => void,
): { onFatalError?: (handler: FatalErrorHandler) => () => void } {
  const candidate = proc as Partial<ProcessEventHost>;
  if (
    typeof candidate.on !== 'function' ||
    typeof candidate.off !== 'function' ||
    typeof candidate.listenerCount !== 'function'
  ) {
    return {};
  }
  return { onFatalError: create(proc as ProcessEventHost) };
}
