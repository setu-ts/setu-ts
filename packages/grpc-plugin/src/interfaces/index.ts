/**
 * Plugin options for `GrpcPlugin`.
 *
 * @module
 */

import type { ConnectRuntime } from './connect-runtime.ts';

/**
 * Options for the gRPC plugin.
 *
 * @since 0.3.0
 */
export interface GrpcPluginOptions {
  /**
   * Base path under which gRPC/Connect services are served.
   * Defaults to the root (`'/'`, M70i). A gRPC-family client derives its path
   * from the fully-qualified method name alone and has no prefix option, so a
   * prefixed default puts every procedure at an address no such client asks
   * for. At the root, unknown paths fall through to Hono and only registered
   * procedure paths are claimed. This makes Connect and gRPC-Web reachable at
   * their natural addresses; native `application/grpc` is served there too where
   * the connection carries trailers (Node and Bun with `RuntimePlugin({ http2 })`)
   * and refused with a Trailers-Only `UNIMPLEMENTED` elsewhere. Pass
   * `'/grpc'` to restore the pre-M70i prefix.
   */
  basePath?: string;

  /**
   * Whether to enable server reflection (v1).
   * Defaults to `true`.
   */
  reflection?: boolean;

  /**
   * Whether to enable the gRPC Health v1 service (bridged to M20 health plugin).
   * Defaults to `true`.
   */
  health?: boolean;

  /**
   * Initial services to register. Each entry contains a service definition
   * and an optional implementation object.
   */
  services?: Array<{
    definition: unknown;
    implementation?: unknown;
  }>;

  /**
   * Injected Connect runtime module(s). When provided, avoids the lazy import.
   * Used by tests to avoid network dependencies.
   */
  connectModule?: ConnectRuntime;

  /**
   * Application-supplied Connect interceptors, threaded into
   * `createConnectRouter({ interceptors })` (M70f §3.7). The plugin's built-in
   * handler-error logging wraps each application service's implementation
   * (innermost), so a handler throw is logged before an application interceptor
   * observes it. Absent: no application interceptors are installed.
   */
  interceptors?: readonly unknown[];

  /**
   * The largest request message a procedure accepts, in bytes. Defaults to
   * 4 MiB, the default receive limit of
   * grpc-go and grpc-js. Forwarded to Connect's `readMaxBytes`, which applies
   * it per message on enveloped protocols (gRPC, gRPC-Web, Connect streaming)
   * and to the whole body of a unary Connect request; a larger message is
   * refused with `RESOURCE_EXHAUSTED`.
   *
   * This is the bound on a client- or bidi-streaming request, whose body the
   * kernel streams to the procedure (M139b): `RuntimePlugin({ maxBodyBytes })`
   * is a total, which would end every long-lived stream, so it bounds only the
   * buffered bodies of unary and server-streaming calls. An integer from 1 to
   * `0xffffffff`; anything else throws at `GrpcPlugin()`.
   *
   * @since 0.13.0
   */
  readMaxBytes?: number;
}

/**
 * The default {@linkcode GrpcPluginOptions.readMaxBytes}: 4 MiB. Internal —
 * not exported from the package barrel.
 */
export const DEFAULT_READ_MAX_BYTES: number = 4 * 1024 * 1024;
