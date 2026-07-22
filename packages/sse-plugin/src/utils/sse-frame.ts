/**
 * Pure SSE wire-format encoder — internal seam.
 *
 * Encodes {@linkcode SseMessage} objects into the exact byte-for-byte string
 * shape expected on the wire (CLAUDE.md self-review: spec-shaped output
 * asserted field-by-field). Not exported from `src/index.ts`; tested directly
 * via relative import.
 *
 * @module
 * @since 0.1.0
 */

import type { SseMessage } from '@hono-enterprise/common';

/**
 * Encodes an SSE message into the wire-format string.
 *
 * Field order: `id:`, `event:`, `data:` (one `data:` line per line of payload),
 * `retry:`, terminated by a blank line. Omitted fields emit **no** line.
 * String data is taken literally and split on `\n` into multiple `data:` lines;
 * any non-string is `JSON.stringify`-ed. `undefined` data throws `TypeError`.
 *
 * @param msg - The message to encode
 * @returns The encoded SSE frame string
 * @throws {TypeError} If `data` is `undefined`
 * @example
 * ```typescript
 * encodeSseMessage({ id: '1', event: 'tick', data: { n: 1 } })
 * // → 'id: 1\nevent: tick\ndata: {"n":1}\n\n'
 * ```
 * @since 0.1.0
 */
export function encodeSseMessage(msg: SseMessage): string {
  let result = '';

  if (msg.id !== undefined) {
    result += `id: ${msg.id}\n`;
  }

  if (msg.event !== undefined) {
    result += `event: ${msg.event}\n`;
  }

  if (msg.data === undefined) {
    throw new TypeError('SSE message data must not be undefined');
  }

  const dataLines = typeof msg.data === 'string'
    ? msg.data.split('\n')
    : [JSON.stringify(msg.data)];
  for (const line of dataLines) {
    result += `data: ${line}\n`;
  }

  if (msg.retry !== undefined) {
    result += `retry: ${msg.retry}\n`;
  }

  result += '\n';
  return result;
}

/**
 * Encodes a plain-text SSE comment frame.
 *
 * Comments are used for keep-alive heartbeats (`: heartbeat\n\n`).
 *
 * @param text - The comment text
 * @returns The encoded comment frame
 * @since 0.1.0
 */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}
