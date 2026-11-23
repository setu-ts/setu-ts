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
    super(`Cannot load Connect runtime module: ${specifier}. ` + `Run: ${installCommand}`, options);
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

/**
 * A client call whose request header list exceeds both the peer's advertised
 * limit and 8 KiB, or the client's threshold when no header-list limit was known
 * when the call started and the stream is refused (on Node the client's HTTP/2
 * library refuses to send a list over 64 KiB, before any frame reaches the peer). At or under 8 KiB, exceeding an
 * advertised limit instead counts against the instance; unary calls are resent
 * once within the remaining deadline: that peer advertised less than any gRPC default.
 * For an advertised HTTP/2 `SETTINGS_MAX_HEADER_LIST_SIZE`, the call is stopped before
 * the peer processes it (a call started before the session holds the peer's
 * SETTINGS, such as the first on a new session, is not checked). If no header-list
 * limit was known when the call started, a list over the client's 64 KiB threshold
 * becomes this error only when the stream is refused (by the client's HTTP/2 library
 * on Node, or by a peer); a call that is sent and answered is unaffected.
 * It is never reported against the instance, and it is not sent
 * to another one: the headers are the caller's to shrink. It reaches the caller
 * as the `cause` of the call's `ConnectError`.
 * A refusal from a peer shutting down (its session closed or destroyed) stays
 * a refused stream and is resent.
 *
 * Sizes follow RFC 7541 §4.1: each field counts its name and value octets plus
 * 32.
 * @since 0.14.0
 */
export class GrpcHeaderListTooLargeError extends Error {
  /** The request's header list size, in octets. */
  readonly size: number;
  /** The peer's advertised limit, or the client's threshold when no limit was known, in octets. */
  readonly limit: number;

  /**
   * @param size - The sent header list's RFC 7541 §4.1 size, in octets
   * @param limit - The advertised limit, or 65536 for a refusal when no limit was known
   * @param reason - Selects the client-threshold message when no limit was known when the call started
   */
  constructor(size: number, limit: number, reason?: 'unadvertised-refusal') {
    super(
      reason === 'unadvertised-refusal'
        ? `The call's header list is ${size} octets, over the client's ${limit}-octet threshold; ` +
            "no header-list limit was known when the call started and the client's HTTP/2 library refused to send it. Send fewer or smaller headers."
        : `The call's header list is ${size} octets, over the ${limit} the peer accepts ` +
            '(HTTP/2 SETTINGS_MAX_HEADER_LIST_SIZE); send fewer or smaller headers.',
    );
    this.name = 'GrpcHeaderListTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

/**
 * A client call whose stream the server reset with HTTP/2 `ENHANCE_YOUR_CALM`
 * (RFC 9113 §7: the peer judged this client's behaviour as generating excessive
 * load, as Node's server does for more than 128 header fields or too many
 * concurrent streams). The call is never reported against the instance, whatever
 * it sent, and is not sent to another one. It reaches the caller as the `cause`
 * of a `ConnectError` with code `ResourceExhausted` (grpc-go's mapping of the
 * code); the original stream error is its own `cause`.
 * @since 0.14.0
 */
export class GrpcExcessiveLoadError extends Error {
  /** @param cause - The stream error the reset produced */
  constructor(cause?: unknown) {
    super(
      "The server reset the call with HTTP/2 ENHANCE_YOUR_CALM: it judged this client's behaviour " +
        'excessive (for example too many header fields or concurrent streams). The call was not ' +
        'resent and is not counted against the instance.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'GrpcExcessiveLoadError';
  }
}
