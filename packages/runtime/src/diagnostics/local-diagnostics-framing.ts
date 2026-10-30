/**
 * The local diagnostics listener's shared refusal surface (M98b, M126): the
 * fixed error texts, the singleton-header set, the fixed refusal response and
 * the zero-body framing policy. Both runtime listeners and the dispatcher read
 * these from here, so neither listener file imports the dispatcher back.
 *
 * @module
 */

/**
 * The single fixed error every `listen` call rejects with on a platform this
 * transport does not support, and the message carried when a second listener
 * is requested while one is active. The plan fixes ONE message per refusal
 * family so error text cannot become a fingerprinting channel.
 *
 * @internal
 */
export const UNSUPPORTED_TRANSPORT_ERROR =
  'Local diagnostics listener: this runtime has no supported local transport. Only Deno and Node are supported in this version.';

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
 * The checks deliberately run before framework request mapping:
 * a refused request never constructs an `IRequest`, never reaches the
 * connector handler, and never has its body read (there is no body — that is
 * the point of the policy).
 *
 * @param request - The native request supplied by the listener
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
