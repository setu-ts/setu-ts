/**
 * Native gRPC-binary refusal (M70i §3.3).
 *
 * The native `application/grpc` wire format signals completion in HTTP/2
 * **trailers**. The Fetch `Response` has no trailer mechanism, and the whole
 * framework serves through Hono's `fetch` entry point (M23), so no runtime
 * adapter can emit trailers. A native client pointed at this server therefore
 * never gets a legal response.
 *
 * M70i repairs the default `basePath` to the root (§3.2), which makes the
 * server **reachable** by native clients for the first time — so the number
 * of people meeting the cryptic "missing status" failure goes up, not down.
 * The fix is the protocol's own answer to "no trailers available": a
 * **Trailers-Only** response, where the status lives in the HTTP header block
 * instead of a trailer section. Every conformant client renders one as a
 * clean `Unimplemented: <message>`.
 *
 * @module
 */

/**
 * The exact set of content types that ARE native gRPC. The check is an exact
 * essence match — deliberately NOT `startsWith('application/grpc')`, which
 * would also match `application/grpc-web+proto` and refuse the working
 * browser format (gRPC-Web carries its trailers in the body).
 *
 * `application/grpc-web` and its `+proto`/`+json` variants are explicitly
 * excluded; Connect's `application/connect+*` types never appear here.
 */
const NATIVE_GRPC_MEDIA_TYPES = new Set([
  'application/grpc',
  'application/grpc+proto',
  'application/grpc+json',
]);

/**
 * Whether a request `content-type` header names the native gRPC wire format.
 *
 * Parses the media type's essence (lowercased, parameters and whitespace
 * stripped) and matches the exact set `application/grpc`,
 * `application/grpc+proto`, `application/grpc+json`. `application/grpc-web…`
 * is **not** native — it is the working browser format and must pass through
 * untouched.
 *
 * @param contentType - The request's `content-type` header value, or `null`.
 * @returns `true` only for the three native gRPC media types.
 */
export function isNativeGrpcContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  // The essence is everything before the first parameter (`;`), lowercased
  // and trimmed. `application/GRPC; charset=x` and `application/grpc ` both
  // normalize to `application/grpc`.
  const essence = contentType.split(';')[0]!.trim().toLowerCase();
  return NATIVE_GRPC_MEDIA_TYPES.has(essence);
}

/**
 * Builds the Trailers-Only refusal for a native `application/grpc` request.
 *
 * HTTP `200` with `content-type: application/grpc`, a `grpc-status: 12`
 * (UNIMPLEMENTED) header and a `grpc-message` naming the formats that DO
 * work, and an empty body. Trailers-Only is the gRPC protocol's own way to
 * report a status without a trailer section: the status lives in the HTTP
 * header block, which is exactly the capability a fetch `Response` has.
 *
 * @returns The refusal {@linkcode Response}.
 */
export function trailersOnlyUnimplemented(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-type': 'application/grpc',
      'grpc-status': '12',
      'grpc-message': 'native gRPC (application/grpc) is not supported by this server; ' +
        'use Connect (application/connect+json or application/connect+proto) ' +
        'or gRPC-Web (application/grpc-web+json or application/grpc-web+proto)',
    },
  });
}
