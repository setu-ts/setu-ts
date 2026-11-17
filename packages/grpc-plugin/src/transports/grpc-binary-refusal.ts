/**
 * Native gRPC-binary refusal (M70i §3.3).
 *
 * The native `application/grpc` wire format signals completion in HTTP/2
 * **trailers**. Since M139b they are written where the adapter can — the Node
 * adapter on an HTTP/2 connection — and native calls are served there. Every
 * other connection (HTTP/1.1, Deno, Workers, `inject()`) has no trailer
 * mechanism, so a native client pointed at it would never get a legal
 * response; this refusal is what it gets instead.
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

import type { RpcReply } from '@setu-ts/common';

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

/** The Trailers-Only refusal's headers, shared by its two forms. */
const TRAILERS_ONLY_UNIMPLEMENTED_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/grpc',
  'grpc-status': '12',
  'grpc-message':
    'native gRPC (application/grpc) is not supported by this server; ' +
    'use Connect (application/connect+json or application/connect+proto) ' +
    'or gRPC-Web (application/grpc-web+json or application/grpc-web+proto)',
};

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
  return new Response(null, { status: 200, headers: TRAILERS_ONLY_UNIMPLEMENTED_HEADERS });
}

/**
 * The same refusal as an `RpcReply`, for the dispatch path (M139b §3.11).
 *
 * @returns The refusal reply.
 */
export function trailersOnlyUnimplementedReply(): RpcReply {
  return {
    status: 200,
    headers: new Headers(TRAILERS_ONLY_UNIMPLEMENTED_HEADERS),
    body: null,
  };
}
