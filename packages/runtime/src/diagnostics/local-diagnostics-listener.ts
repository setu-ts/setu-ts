/**
 * Runtime-owned local diagnostics listener (M98b) — the ONE extra loopback
 * port the RuntimePlugin can bind, consumed by the local diagnostics
 * connector plugin.
 *
 * WHY A PRIVATE SERVER INSTEAD OF THE APPLICATION ADAPTER. The application's
 * `IHttpAdapter` is stateful: `setHandler` installs ONE kernel handler and
 * `listen` binds its socket, so reusing or cloning it for a second listener
 * would detach the application's own handler. This module therefore owns a
 * private `Deno.serve` host through the same injectable seam the Deno HTTP
 * adapter uses — but it never exposes that host, an adapter, or a server
 * handle: the factory hands back only an idempotent `close()`, and the
 * connector supplies only its protocol handler (AI_GUIDELINES §4.3).
 *
 * Scope limits, enforced here so no caller can widen them: exactly ONE
 * active listener per factory, hostname fixed to `127.0.0.1`, port bounded
 * to `1024`–`65535`, and a zero-body policy checked on the native `Request`
 * BEFORE framework mapping. Deno-only in this version; every other platform
 * rejects `listen` with one fixed error before any bind.
 *
 * @module
 */

import type {
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  LocalDiagnosticsListenerOptions,
  RuntimePlatform,
} from '@setu-ts/common';
import {
  mapSnapshotToWebResponse,
  mapWebRequestToFrameworkRequest,
} from '../adapters/shared/fetch-mapping.ts';
import type { DenoServeHost } from '../adapters/deno/deno-http-adapter.ts';
import { defaultDenoServeHost } from '../adapters/deno/deno-http-adapter.ts';

/**
 * The single fixed error every `listen` call rejects with on a platform this
 * transport does not support, and the message carried when a second listener
 * is requested while one is active. The plan fixes ONE message per refusal
 * family so error text cannot become a fingerprinting channel.
 *
 * @internal
 */
export const UNSUPPORTED_TRANSPORT_ERROR =
  'Local diagnostics listener: this runtime has no supported local transport. Only Deno is supported in this version.';

/**
 * The fixed error for a port outside `1024`–`65535`.
 *
 * @internal
 */
export const INVALID_PORT_ERROR =
  'Local diagnostics listener: port must be an integer from 1024 to 65535.';

/**
 * The fixed error for a `listen` call while another listener is still open.
 *
 * @internal
 */
export const LISTENER_ALREADY_ACTIVE_ERROR =
  'Local diagnostics listener: another listener is already active on this factory.';

/**
 * Headers whose grammar contains no comma, so a comma inside the
 * `Headers`-coalesced value proves a duplicate header line was sent. Fetch
 * interfaces join duplicate lines with `, ` before this code can see them;
 * Deno does not expose raw header-line multiplicity after parsing, so this
 * coalescing check — plus the real-socket duplicate-header tests — is the
 * provable boundary, not a raw-wire claim.
 *
 * @internal
 */
export const SINGLETON_HEADER_NAMES: readonly string[] = [
  'host',
  'x-setu-session',
  'x-setu-sequence',
  'x-setu-instance',
  'x-setu-mac',
];

/**
 * The fixed headers every refusal carries, identical to the signed
 * protocol's response headers so a refusal and a signed answer are
 * indistinguishable by shape.
 *
 * @internal
 */
const REFUSAL_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/**
 * Builds one fixed, value-free refusal response. Unauthenticated refusals
 * are not signed (there is no shared secret to check them with) and carry no
 * reflected input — the native client treats an unverifiable response as a
 * connection failure.
 *
 * @param status - The HTTP status of the refusal
 * @param code - One fixed protocol error code
 * @returns The refusal response
 * @internal
 */
export function refusalResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ version: 1, error: code }), {
    status,
    headers: REFUSAL_HEADERS,
  });
}

/**
 * Applies the listener's zero-body and duplicate-singleton-header policy to
 * a native request BEFORE any framework mapping. Returns `null` when the
 * framing is acceptable.
 *
 * The checks deliberately run before {@linkcode mapWebRequestToFrameworkRequest}:
 * a refused request never constructs an `IRequest`, never reaches the
 * connector handler, and never has its body read (there is no body — that is
 * the point of the policy).
 *
 * @param request - The native request as `Deno.serve` handed it over
 * @returns The refusal to answer with, or `null` to proceed
 * @internal
 */
export function nativeFramingRefusal(request: Request): Response | null {
  const headers = request.headers;
  // Any Transfer-Encoding — including `identity` — declares (or implies) a
  // body-bearing framing this transport refuses outright.
  if (headers.get('transfer-encoding') !== null) {
    return refusalResponse(400, 'invalid-request');
  }
  const contentLength = headers.get('content-length');
  // Absent or exactly `0` are the only acceptable spellings; anything else —
  // `1`, `0,0` from a duplicate line, a non-numeric value — refuses.
  if (contentLength !== null && contentLength !== '0') {
    return refusalResponse(400, 'invalid-request');
  }
  for (const name of SINGLETON_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null && value.includes(',')) {
      return refusalResponse(400, 'invalid-request');
    }
  }
  return null;
}

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
      this.#closePromise = (server === null ? Promise.resolve() : server.shutdown().then(() =>
        undefined
      ))
        .then(() => {
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
class DenoLocalDiagnosticsListenerFactory implements ILocalDiagnosticsListenerFactory {
  #host: DenoServeHost;
  #active: DenoLocalDiagnosticsListener | null = null;

  constructor(host: DenoServeHost) {
    this.#host = host;
  }

  listen(options: LocalDiagnosticsListenerOptions): Promise<ILocalDiagnosticsListener> {
    // Validate BEFORE any bind: a refused call leaves no partial state.
    // Every refusal REJECTS the returned promise (a sync throw would break
    // callers written against the promised contract).
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535
    ) {
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

/**
 * The unsupported-platform implementation: every `listen` call rejects with
 * the one fixed error BEFORE any bind is attempted, and `closeActive` is a
 * no-op. Nothing in this class can open a socket.
 *
 * @internal
 */
class UnsupportedLocalDiagnosticsListenerFactory implements ILocalDiagnosticsListenerFactory {
  listen(): Promise<ILocalDiagnosticsListener> {
    return Promise.reject(new Error(UNSUPPORTED_TRANSPORT_ERROR));
  }

  closeActive(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Creates the local diagnostics listener factory for one platform.
 *
 * The RuntimePlugin calls this once per application at registration time and
 * registers the result under `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER`,
 * together with a close hook that releases any active listener on every
 * shutdown and failed-startup path.
 *
 * @param platform - The platform the RuntimePlugin resolved
 * @param host - Injected Deno serve host for testing; defaults to the real
 *   `Deno.serve` global on the Deno platform
 * @returns The factory: a real one-host factory on Deno, the refusing
 *   factory everywhere else
 * @internal
 */
export function createLocalDiagnosticsListenerFactory(
  platform: RuntimePlatform,
  host?: DenoServeHost,
): ILocalDiagnosticsListenerFactory & { closeActive(): Promise<void> } {
  if (platform !== 'deno') {
    return new UnsupportedLocalDiagnosticsListenerFactory();
  }
  return new DenoLocalDiagnosticsListenerFactory(host ?? defaultDenoServeHost);
}
