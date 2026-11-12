/**
 * Construction options shared by every HTTP adapter.
 *
 * @module
 */

/**
 * Options every {@linkcode IHttpAdapter} implementation in this package
 * accepts, supplied by `RuntimePlugin` when it constructs one.
 *
 * They are grouped into an object rather than appended as another positional
 * parameter because the four adapters already take different leading arguments
 * (an injected serve host, a `ws` module, a WebSocket host), so a positional
 * addition would sit at a different index in each.
 *
 * @since 0.5.0
 */
export interface HttpAdapterOptions {
  /**
   * Maximum request-body size, in bytes, enforced where the body is actually
   * read. Omitted, the read is unbounded — the released behaviour.
   *
   * This is the layer a request header cannot switch off.
   * `HttpSecurityPlugin({ requestSize: { maxBodySize } })` refuses on a
   * declared `Content-Length` before anything is read, which is cheaper and
   * reports earlier; a chunked request declares no length, so only the read
   * itself can bound it. Set both to the same value: a higher one here admits
   * an undeclared body larger than `maxBodySize`.
   *
   * @since 0.5.0
   */
  readonly maxBodyBytes?: number;

  /**
   * Last-resort sink for a server-side fault the adapter cannot answer with a
   * response. Supplied by `RuntimePlugin`, which resolves it at call time: the
   * registered logger when there is one, else
   * `IRuntimeServices.reportError`. Omitted, the adapter stays silent.
   *
   * The record is already sanitized by the caller — a `serializeError` spread,
   * with no request data — so a sink that writes it verbatim cannot leak a
   * request payload.
   *
   * @param record - The already sanitized diagnostic
   * @since 0.10.0
   */
  readonly reportError?: (record: Readonly<Record<string, unknown>>) => void;

  /**
   * Serve HTTP/2 beside HTTP/1.1 on the same port. Supplied by `RuntimePlugin`
   * from {@linkcode RuntimeOptions.http2}; see there for each runtime.
   * @since 0.13.0
   */
  readonly http2?: true | Http2TlsOptions;
}

/**
 * TLS material for `RuntimePlugin({ http2: { key, cert } })`: HTTP/2 over TLS,
 * negotiated by ALPN, with HTTP/1.1 on the same port for clients that do not
 * offer `h2`.
 * @since 0.13.0
 */
export interface Http2TlsOptions {
  /** The private key, PEM-encoded. Never logged or reported. */
  readonly key: string;
  /** The certificate chain, PEM-encoded. */
  readonly cert: string;
}
