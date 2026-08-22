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
   * Defaults to `/grpc`. Requests outside this prefix fall through to Hono.
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
}
