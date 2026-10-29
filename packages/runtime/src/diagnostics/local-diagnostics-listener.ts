/**
 * Runtime-owned local diagnostics listener (M98b) — the ONE extra loopback
 * port the RuntimePlugin can bind, consumed by the local diagnostics
 * connector plugin.
 *
 * WHY A PRIVATE SERVER INSTEAD OF THE APPLICATION ADAPTER. The application's
 * `IHttpAdapter` is stateful: `setHandler` installs ONE kernel handler and
 * `listen` binds its socket, so reusing or cloning it for a second listener
 * would detach the application's own handler. This module therefore owns a
 * private Deno or Node server through runtime-specific injectable hosts.
 * It never exposes that host, an adapter, or a server
 * handle: the factory hands back only an idempotent `close()`, and the
 * connector supplies only its protocol handler (AI_GUIDELINES §4.3).
 *
 * Scope limits, enforced here so no caller can widen them: exactly ONE
 * active listener per factory, hostname fixed to `127.0.0.1`, port bounded
 * to `1024`–`65535`, and a zero-body policy checked on the native `Request`
 * BEFORE framework mapping. Deno and Node are supported; every other platform
 * rejects `listen` with one fixed error before any bind.
 *
 * @module
 */

import type {
  ILocalDiagnosticsListener,
  ILocalDiagnosticsListenerFactory,
  RuntimePlatform,
} from '@setu-ts/common';
import type { DenoServeHost } from '../adapters/deno/deno-http-adapter.ts';
import { defaultDenoServeHost } from '../adapters/deno/deno-http-adapter.ts';
import { DenoLocalDiagnosticsListenerFactory } from './deno-local-diagnostics-listener.ts';
import { NodeLocalDiagnosticsListenerFactory } from './node-local-diagnostics-listener.ts';
import type { NodeListenerHost } from './node-local-diagnostics-listener.ts';

export {
  INVALID_PORT_ERROR,
  LISTENER_ALREADY_ACTIVE_ERROR,
  nativeFramingRefusal,
  refusalResponse,
  SINGLETON_HEADER_NAMES,
  UNSUPPORTED_TRANSPORT_ERROR,
} from './local-diagnostics-framing.ts';
import { UNSUPPORTED_TRANSPORT_ERROR } from './local-diagnostics-framing.ts';

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
 * @param nodeHost - Injected Node HTTP host and stderr writer for testing
 * @returns A real factory on Deno or Node, the refusing factory everywhere else
 * @internal
 */
export function createLocalDiagnosticsListenerFactory(
  platform: RuntimePlatform,
  host?: DenoServeHost,
  nodeHost?: NodeListenerHost,
): ILocalDiagnosticsListenerFactory & { closeActive(): Promise<void> } {
  if (platform === 'deno')
    return new DenoLocalDiagnosticsListenerFactory(host ?? defaultDenoServeHost);
  if (platform === 'node') return new NodeLocalDiagnosticsListenerFactory(nodeHost);
  return new UnsupportedLocalDiagnosticsListenerFactory();
}
