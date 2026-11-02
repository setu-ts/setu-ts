/** Bounded response reading and the complete route-to-tool result table. @module */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { CompiledTool } from '../compile/compile-tools.ts';
import { isRecord } from '../options.ts';

/** A fixed error result; internal exceptions never become SDK callback errors. */
export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Maps an inner response without following redirects or exposing server errors. */
export async function mapResult(
  response: Response,
  tool: CompiledTool,
  maxResultBytes: number,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    const cancel = (): void => {
      // Cancellation must not throw from the signal listener or expose a source error.
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResultBytes) {
          await reader.cancel();
          return toolError('The tool result is too large.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const status = response.status;
  if (status >= 500) return toolError('The tool failed.');
  if (status >= 300 && status < 400)
    return toolError('The tool answered with a redirect, which is not followed.');
  const media = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const json = media === 'application/json' || media.endsWith('+json');
  let value: unknown;
  if (json && text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      return toolError(status >= 400 ? `The request was refused (${status}).` : 'The tool failed.');
    }
  }
  if (status >= 400) {
    if (json && isRecord(value)) {
      const title =
        typeof value.title === 'string'
          ? value.title
          : typeof value.error === 'string'
            ? value.error
            : undefined;
      if (title !== undefined) {
        let message = title + (typeof value.detail === 'string' ? `: ${value.detail}` : '');
        if (Array.isArray(value.errors))
          for (const error of value.errors) {
            if (
              isRecord(error) &&
              typeof error.field === 'string' &&
              typeof error.message === 'string'
            )
              message += `\n${error.field}: ${error.message}`;
          }
        return toolError(message);
      }
    }
    return toolError(`The request was refused (${status}).`);
  }
  if (text.length === 0) return { content: [{ type: 'text', text: '' }] };
  if (json) {
    if (tool.outputSchema !== undefined) {
      if (!tool.outputValidator!.safeParse(value).success || !isRecord(value))
        return toolError('The tool returned a result that does not match its output schema.');
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  if (media.startsWith('text/')) return { content: [{ type: 'text', text }] };
  return toolError('The tool returned a result type it cannot deliver.');
}
