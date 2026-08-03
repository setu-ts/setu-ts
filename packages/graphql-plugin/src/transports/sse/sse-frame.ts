/**
 * SSE frame encoding for GraphQL-over-SSE (distinct-connections mode).
 *
 * Wire grammar from graphql-sse PROTOCOL.md:
 * - `event: next\ndata: <JSON>\n\n` for execution results
 * - `event: complete\ndata: \n\n` with mandatory empty `data:` field
 * - `:keep-alive\n\n` for heartbeat comments
 *
 * @module
 * @since 0.3.0
 */

const encoder = new TextEncoder();

/**
 * Encode a `next` SSE event carrying a GraphQL execution result.
 *
 * @param data - The execution result to serialize
 * @returns The encoded SSE event bytes
 */
export function encodeSseEvent(data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return encoder.encode(`data: ${json}\n\n`);
}

/**
 * Encode a `complete` SSE event with the mandatory empty `data:` field.
 *
 * Native `EventSource` never fires the listener without a `data:` field,
 * so the empty value is required by the protocol.
 *
 * @returns The encoded complete event bytes
 */
export function encodeSseComplete(): Uint8Array {
  return encoder.encode('event: complete\ndata: \n\n');
}

/**
 * Encode a keep-alive comment.
 *
 * @returns The encoded comment bytes
 */
export function encodeSseComment(): Uint8Array {
  return encoder.encode(':keep-alive\n\n');
}
