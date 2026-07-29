/**
 * Wire encoding for {@linkcode RealtimeFrame} payloads.
 *
 * A WebSocket frame is `string | Uint8Array`, but the backplane transports
 * agree only on JSON-serializable values: a message broker hands the payload to
 * a serializer, and Redis pub/sub carries strings.
 *
 * These live in `common` rather than in the backplane plugin because all three
 * packages that touch the wire — the backplane itself, the WebSocket plugin
 * that encodes, and any custom transport — need the identical representation,
 * and no plugin may import another. They are pure, zero-dependency, and
 * web-standard (`btoa`/`atob`), so they carry no runtime behavior beyond the
 * transform, and run unchanged on all four supported runtimes.
 *
 * @module
 * @since 0.2.0
 */

/** A payload as it travels the backplane. */
export interface EncodedPayload {
  /** The payload as a string. */
  readonly data: string;
  /** True when {@linkcode EncodedPayload.data} is base64-encoded binary. */
  readonly binary?: boolean;
}

/**
 * Encodes a WebSocket payload for the wire.
 *
 * Text passes through unchanged; binary is base64-encoded, because a
 * `Uint8Array` survives neither `JSON.stringify` nor a Redis pub/sub channel
 * intact.
 *
 * @param data - The local payload
 * @returns The encoded payload
 * @example
 * ```typescript
 * encodeFrameData('hi');                        // { data: 'hi' }
 * encodeFrameData(new Uint8Array([1, 2, 3]));   // { data: 'AQID', binary: true }
 * ```
 * @since 0.2.0
 */
export function encodeFrameData(data: string | Uint8Array): EncodedPayload {
  if (typeof data === 'string') {
    return { data };
  }
  // btoa takes a binary string, so each byte becomes one code unit first.
  // Chunked to stay well clear of the argument-count limit on large frames.
  let binaryString = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < data.length; index += CHUNK) {
    binaryString += String.fromCharCode(...data.subarray(index, index + CHUNK));
  }
  return { data: btoa(binaryString), binary: true };
}

/**
 * Decodes a payload received from the wire back into its local form.
 *
 * @param payload - The encoded payload
 * @returns The original `string` or `Uint8Array`
 * @example
 * ```typescript
 * decodeFrameData({ data: 'AQID', binary: true }); // Uint8Array([1, 2, 3])
 * ```
 * @since 0.2.0
 */
export function decodeFrameData(payload: EncodedPayload): string | Uint8Array {
  if (payload.binary !== true) {
    return payload.data;
  }
  const binaryString = atob(payload.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
}
