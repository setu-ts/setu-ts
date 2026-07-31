/**
 * Errors specific to the gRPC plugin.
 *
 * @module
 */

/**
 * Thrown when any of the Connect runtime modules cannot be imported.
 * Carries the exact specifier that failed and the suggested install command.
 *
 * @since 0.3.0
 */
export class GrpcRuntimeLoadError extends Error {
  constructor(specifier: string, installCommand: string) {
    super(
      `Cannot load Connect runtime module: ${specifier}. ` +
        `Run: ${installCommand}`,
    );
    this.name = 'GrpcRuntimeLoadError';
  }
}

/**
 * Thrown when the adapter does not support the RPC interceptor seam
 * (i.e., `IHttpAdapter.setRpcHandler?` is not available) and an attempt
 * is made to handle a request directly through {@linkcode GrpcService.handleRequest}.
 *
 * @since 0.3.0
 */
export class GrpcUnavailableError extends Error {
  constructor() {
    super(
      'gRPC is unavailable — the HTTP adapter does not support the RPC ' +
        'interceptor seam. Ensure the runtime adapter implements ' +
        'IHttpAdapter.setRpcHandler?',
    );
    this.name = 'GrpcUnavailableError';
  }
}