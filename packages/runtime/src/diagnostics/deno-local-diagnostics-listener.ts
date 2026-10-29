import type {
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  LocalDiagnosticsListenerOptions,
} from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../adapters/shared/fetch-mapping.ts';
import type { DenoServeHost } from '../adapters/deno/deno-http-adapter.ts';
import {
  INVALID_PORT_ERROR,
  LISTENER_ALREADY_ACTIVE_ERROR,
  nativeFramingRefusal,
  refusalResponse,
} from './local-diagnostics-framing.ts';

/**
 * The concrete Deno listener handle. `close()` is idempotent and
 * concurrency-safe: every call stores and awaits the same shutdown promise.
 *
 * @internal
 */
class DenoLocalDiagnosticsListener implements ILocalDiagnosticsListener {
  #server: { shutdown(): Promise<void> } | null;
  #onClosed: () => void;
  #closePromise: Promise<void> | null = null;

  constructor(server: { shutdown(): Promise<void> }, onClosed: () => void) {
    this.#server = server;
    this.#onClosed = onClosed;
  }

  async close(): Promise<void> {
    if (this.#closePromise === null) {
      const server = this.#server;
      this.#server = null;
      this.#closePromise = (
        server === null ? Promise.resolve() : server.shutdown().then(() => undefined)
      ).then(() => {
        // Whatever path closed this listener — connector revoke, the
        // RuntimePlugin close hook, or a direct close — the factory must
        // release its one-active slot exactly once.
        this.#onClosed();
      });
    }
    await this.#closePromise;
  }
}

/**
 * The Deno implementation of {@linkcode ILocalDiagnosticsListenerFactory}.
 *
 * @internal
 */
export class DenoLocalDiagnosticsListenerFactory implements ILocalDiagnosticsListenerFactory {
  #host: DenoServeHost;
  #active: DenoLocalDiagnosticsListener | null = null;

  constructor(host: DenoServeHost) {
    this.#host = host;
  }

  listen(options: LocalDiagnosticsListenerOptions): Promise<ILocalDiagnosticsListener> {
    // Validate BEFORE any bind: a refused call leaves no partial state.
    // Every refusal REJECTS the returned promise (a sync throw would break
    // callers written against the promised contract).
    if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) {
      return Promise.reject(new Error(INVALID_PORT_ERROR));
    }
    if (this.#active !== null) {
      return Promise.reject(new Error(LISTENER_ALREADY_ACTIVE_ERROR));
    }
    let server: { shutdown(): Promise<void> };
    try {
      server = this.#host.serve({
        port: options.port,
        hostname: '127.0.0.1',
        fetch: (request) => this.#handleNative(request, options),
        // Omitted when the caller supplies none, so the default banner
        // stands rather than the bind becoming silent.
        ...(options.onListen !== undefined ? { onListen: options.onListen } : {}),
      });
    } catch (error) {
      // A port conflict (or any OS bind refusal) fails closed.
      return Promise.reject(error);
    }
    const listener = new DenoLocalDiagnosticsListener(server, () => {
      this.#active = null;
    });
    this.#active = listener;
    return Promise.resolve(listener);
  }

  /**
   * Closes the active listener, if one is open. Used by the RuntimePlugin's
   * close hook so every shutdown and failed-startup path releases the port.
   *
   * @internal
   */
  closeActive(): Promise<void> {
    if (this.#active === null) {
      return Promise.resolve();
    }
    const listener = this.#active;
    this.#active = null;
    return listener.close();
  }

  /**
   * The native fetch handler `Deno.serve` calls. Framing refusals run before
   * mapping; everything else maps to the framework request, hands it to the
   * connector's protocol handler, and maps the framework response's snapshot
   * back onto the wire. A handler that throws answers one fixed anonymous
   * refusal — the raw error never escapes and is never logged here.
   */
  async #handleNative(
    request: Request,
    options: LocalDiagnosticsListenerOptions,
  ): Promise<Response> {
    const refusal = nativeFramingRefusal(request);
    if (refusal !== null) {
      return refusal;
    }
    const frameworkRequest = mapWebRequestToFrameworkRequest(request);
    try {
      const frameworkResponse = await options.handler(frameworkRequest);
      return mapSnapshotToWebResponse(frameworkResponse.snapshot());
    } catch {
      // Value-free: no error text, no cause, no stack leaves this process
      // boundary. The signed protocol's own errors are built inside the
      // handler; this arm only covers an unexpected internal failure.
      return refusalResponse(503, 'unavailable');
    }
  }
}
