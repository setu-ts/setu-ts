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
  /** Node's `process.setUncaughtExceptionCaptureCallback` is set: it handles a throw. */
  hasUncaughtExceptionCaptureCallback?(): boolean;
}

/**
 * Whether the application handles a thrown error itself, so the process
 * survives it: its own `uncaughtException` listener, or a capture callback
 * (`process.setUncaughtExceptionCaptureCallback`), which Node runs after the
 * monitor without any listener.
 */
function handlesThrows(proc: ProcessEventHost): boolean {
  return (
    proc.listenerCount('uncaughtException') > 0 ||
    proc.hasUncaughtExceptionCaptureCallback?.() === true
  );
}

/** The global event surface Deno's observer needs. */
export interface GlobalEventHost {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** The `onFatalError` implementation a factory returns. */
type Subscribe = (handler: FatalErrorHandler) => () => void;

/**
 * One observer per process object and mechanism. Every runtime services
 * object built over the same process shares it, so two of them in one process
 * add one listener, not two — which is what lets the Bun observer tell its
 * own `unhandledRejection` listener from the application's.
 */
const observers = new WeakMap<object, Map<string, Subscribe>>();

/**
 * Returns the observer already built for this process object and mechanism,
 * or builds it.
 *
 * @param target - The process object or global scope
 * @param kind - Which mechanism
 * @param build - Builds the observer once
 * @returns The shared observer
 */
function shared(target: object, kind: string, build: () => Subscribe): Subscribe {
  let byKind = observers.get(target);
  if (byKind === undefined) {
    byKind = new Map();
    observers.set(target, byKind);
  }
  let subscribe = byKind.get(kind);
  if (subscribe === undefined) {
    subscribe = build();
    byKind.set(kind, subscribe);
  }
  return subscribe;
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
 * (origin `'unhandledRejection'`), without changing the crash. An error the
 * application's own `uncaughtException` listener handles is not reported: the
 * process survives it.
 *
 * @param proc - The process
 * @returns The `onFatalError` implementation
 */
export function createNodeFatalErrorObserver(
  proc: ProcessEventHost,
): (handler: FatalErrorHandler) => () => void {
  return shared(proc, 'node', () => nodeObserver(proc));
}

/** Builds the Node observer for {@linkcode createNodeFatalErrorObserver}. */
function nodeObserver(proc: ProcessEventHost): Subscribe {
  return handlerSet((notify) => {
    const monitor = (error: unknown, origin: unknown): void => {
      // The monitor also fires when the application's own `uncaughtException`
      // listener is about to handle the error, and the process survives that.
      if (handlesThrows(proc)) return;
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
 * `unhandledRejection` listener, removes itself and raises the reason again
 * as a fresh rejection: with no listener left, Bun ends the process exactly
 * as it would have (exit 1, its own `error:` line). A rethrow would land in an
 * application `uncaughtException` listener, which Bun never hands a rejection
 * to (measured: such a listener does not keep a rejecting Bun process alive).
 * When the application registered its own rejection listener it chose not to
 * crash, and nothing is reported or raised; nor is a thrown error the
 * application's own `uncaughtException` listener handles. This assumes Bun's
 * default `--unhandled-rejections` mode: under `warn` or `none` the process
 * survives, so the first rejection is reported as fatal and, the listener
 * having removed itself, no later one is observed.
 *
 * @param proc - The process
 * @param raise - Raises the reason as a fresh rejection; a seam for tests
 * @returns The `onFatalError` implementation
 */
export function createBunFatalErrorObserver(
  proc: ProcessEventHost,
  raise: (reason: unknown) => void = raiseRejection,
): (handler: FatalErrorHandler) => () => void {
  return shared(proc, 'bun', () => bunObserver(proc, raise));
}

/** Raises a reason as a fresh, unhandled rejection. */
function raiseRejection(reason: unknown): void {
  void Promise.reject(reason);
}

/** Builds the Bun observer for {@linkcode createBunFatalErrorObserver}. */
function bunObserver(proc: ProcessEventHost, raise: (reason: unknown) => void): Subscribe {
  return handlerSet((notify) => {
    const monitor = (error: unknown): void => {
      // The application's own `uncaughtException` listener keeps it alive.
      if (handlesThrows(proc)) return;
      notify(error, 'uncaughtException');
    };
    const rejection = (reason: unknown): void => {
      // Another listener is the application's own: it chose not to crash, so
      // nothing is ending and nothing is reported or raised.
      if (proc.listenerCount('unhandledRejection') !== 1) return;
      notify(reason, 'unhandledRejection');
      proc.off('unhandledRejection', rejection as (...args: unknown[]) => void);
      raise(reason);
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
 * 2.9.6). It cannot see whether a listener registered after it will call
 * `preventDefault()`, so on Deno an error the application then suppresses is
 * still reported.
 *
 * @param target - The global scope
 * @returns The `onFatalError` implementation
 */
export function createDenoFatalErrorObserver(
  target: GlobalEventHost,
): (handler: FatalErrorHandler) => () => void {
  return shared(target, 'deno', () => denoObserver(target));
}

/** Builds the Deno observer for {@linkcode createDenoFatalErrorObserver}. */
function denoObserver(target: GlobalEventHost): Subscribe {
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
