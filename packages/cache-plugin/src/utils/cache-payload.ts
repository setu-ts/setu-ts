/**
 * Internal encode/decode helpers for cached response payloads.
 *
 * Converts between the `IResponse.snapshot()` shape and a JSON-safe
 * {@linkcode CachedResponsePayload} that can be stored in any backend
 * (Memory, Redis, Noop). Binary bodies are base64-encoded so that JSON
 * stores do not corrupt them.
 *
 * @module
 * @internal
 */
import type { CachedResponsePayload } from '../interfaces/index.ts';

/**
 * Encode an IResponse snapshot into a serializable {@linkcode CachedResponsePayload}.
 *
 * - `Uint8Array` bodies are base64-encoded and flagged with `bodyEncoding: 'base64'`.
 * - String bodies are stored as-is (no encoding flag).
 * - `null` body passes through as `null`.
 * - Headers are copied from the `Headers` object into an array of `[name, value]` pairs.
 *
 * @param snapshot - The response snapshot from `ctx.response.snapshot()`
 * @returns A JSON-safe payload suitable for cache storage
 */
export function encodePayload(snapshot: {
  status: number;
  headers: Headers;
  body: Uint8Array | string | null;
}): CachedResponsePayload {
  const headers: Array<[string, string]> = [];
  snapshot.headers.forEach((value, name) => {
    headers.push([name, value]);
  });

  if (snapshot.body instanceof Uint8Array) {
    return {
      status: snapshot.status,
      headers,
      body: btoa(bin2base64(snapshot.body)),
      bodyEncoding: 'base64',
    };
  }

  if (typeof snapshot.body === 'string') {
    return {
      status: snapshot.status,
      headers,
      body: snapshot.body,
    };
  }

  return {
    status: snapshot.status,
    headers,
    body: null,
  };
}

/**
 * Decode a {@linkcode CachedResponsePayload} back to the shape needed for
 * response replay.
 *
 * - Payloads with `bodyEncoding: 'base64'` are decoded to `Uint8Array`.
 * - String bodies pass through unchanged as `string`.
 * - `null` body returns `null`.
 *
 * @param payload - The cached payload retrieved from the store
 * @returns Object with status, headers array, and body bytes or string
 */
export function decodePayload(payload: CachedResponsePayload): {
  status: number;
  headers: Array<[string, string]>;
  bodyBytes: Uint8Array | string | null;
} {
  if (payload.bodyEncoding === 'base64' && typeof payload.body === 'string') {
    return {
      status: payload.status,
      headers: payload.headers,
      bodyBytes: base642bin(atob(payload.body)),
    };
  }

  return {
    status: payload.status,
    headers: payload.headers,
    bodyBytes: payload.body,
  };
}

/**
 * Convert a `Uint8Array` to a binary string suitable for `btoa()`.
 *
 * `btoa()` in the web-standard API only accepts 8-bit clean strings, but
 * `new TextDecoder()` is lossy for arbitrary byte values. This helper
 * converts each byte to a character code to produce a safe input.
 *
 * @param bytes - The binary data
 * @returns A binary string safe for `btoa()`
 */
function bin2base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    chunks.push(String.fromCharCode(bytes[i]));
  }
  return chunks.join('');
}

/**
 * Convert a binary string (from `atob()`) back to `Uint8Array`.
 *
 * @param binaryString - The binary string produced by `atob()`
 * @returns The decoded bytes
 */
function base642bin(binaryString: string): Uint8Array {
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
