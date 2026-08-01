/**
 * Newline-delimited JSON reader for the Kubernetes watch stream.
 *
 * A watch response is chunked `application/json` carrying one object per line,
 * and chunk boundaries fall wherever the network puts them — routinely in the
 * middle of an object. Buffering until a newline arrives is what makes the
 * reader correct rather than intermittently broken under load.
 *
 * @module
 */

/**
 * Yields one parsed JSON value per newline-terminated line.
 *
 * A trailing partial line at end-of-stream is discarded: it is by definition
 * an incomplete object, and parsing it would throw on a stream that simply
 * ended mid-write. A line that is complete but unparseable is skipped for the
 * same reason — a watch must survive one malformed frame rather than tearing
 * down and re-LISTing.
 *
 * @param stream - The chunked response body
 * @param signal - Ends the generator when aborted
 * @yields Each parsed line, in order
 * @since 0.2.0
 */
export async function* readJsonLines(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted === true) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line !== '') {
          const parsed = tryParse(line);
          if (parsed.ok) {
            yield parsed.value;
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    // Releasing the lock lets the caller cancel the underlying response; not
    // doing it leaves the body locked to a reader nobody holds any more.
    reader.releaseLock();
  }
}

/** Parses a line, reporting failure rather than throwing. */
function tryParse(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}
