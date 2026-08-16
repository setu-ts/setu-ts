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
  /** The specifier that failed to import. */
  readonly specifier: string;

  constructor(specifier: string, installCommand: string, options?: ErrorOptions) {
    super(
      `Cannot load Connect runtime module: ${specifier}. ` +
        `Run: ${installCommand}`,
      options,
    );
    this.name = 'GrpcRuntimeLoadError';
    this.specifier = specifier;
  }
}

/**
 * Thrown when an embedded descriptor set cannot be decoded, or when a service
 * the plugin expects to find inside one is absent — i.e. the committed base64
 * constant is truncated, swapped, or regenerated against an incompatible proto.
 *
 * @since 0.3.0
 */
export class GrpcDescriptorError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`gRPC descriptor error: ${detail}`, options);
    this.name = 'GrpcDescriptorError';
  }
}

/**
 * Thrown when the adapter does not support the RPC interceptor seam
 * (i.e., `IHttpAdapter.setRpcHandler?` is not available) and an attempt
 * is made to handle a request directly through {@linkcode GrpcService.handleRequest}.
 *
 * @deprecated Since M70a nothing throws this. gRPC dispatch no longer depends
 * on any adapter capability: the kernel resolves `IGrpcService` from the
 * service registry and dispatches after the middleware pipeline, so
 * `handleRequest` is always serviceable and `IGrpcService.available` is
 * unconditionally `true`. Retained because the class is published surface
 * (AI_GUIDELINES §9.2); it will be removed in the next major release.
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
