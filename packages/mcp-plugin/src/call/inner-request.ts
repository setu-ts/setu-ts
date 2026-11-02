/** Maps flat tool arguments into an ordinary authenticated HTTP request. @module */
import type { IRuntimeServices } from '@setu-ts/common';
import type { CompiledTool } from '../compile/compile-tools.ts';
import type { CallContext } from '../sdk/server-factory.ts';
import { UnusableArgumentError } from '../errors.ts';
import { isRecord } from '../options.ts';
import { idempotencyKey } from './idempotency-key.ts';

/** Hop-by-hop, outer body, transport and caller-supplied retry headers are never forwarded. */
const STRIPPED_HEADERS = new Set([
  'content-length',
  'content-type',
  'transfer-encoding',
  'accept',
  'accept-encoding',
  'connection',
  'idempotency-key',
  'last-event-id',
]);

/** Builds the inner request; authentication and tenancy run again from forwarded headers. */
export async function innerRequest(
  tool: CompiledTool,
  args: unknown,
  call: CallContext,
  signal: AbortSignal,
  runtime: IRuntimeServices,
): Promise<Request> {
  if (!isRecord(args)) throw new UnusableArgumentError();
  let path = tool.declaration.route.path;
  const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) {
    const source = Object.hasOwn(tool.sources, name) ? tool.sources[name] : undefined;
    if (source === 'path') {
      const text = String(value);
      if (text === '' || text === '.' || text === '..') throw new UnusableArgumentError();
      path = path.replace(new RegExp(`:${name}(?=/|$)`, 'g'), encodeURIComponent(text));
    } else if (source === 'query') {
      for (const item of Array.isArray(value) ? value : [value]) query.append(name, String(item));
    } else if (source === 'body') body[name] = value;
    else throw new UnusableArgumentError();
  }
  for (const [name, source] of Object.entries(tool.sources))
    if (source === 'path' && !Object.hasOwn(args, name)) throw new UnusableArgumentError();
  const url = new URL(new URL(call.outer.request.url).origin + path);
  url.search = query.toString();
  const headers = new Headers();
  for (const [name, value] of call.outer.request.headers) {
    // Origin is deliberately kept: it has passed the outer check and the inner CSRF check needs it (§3.4).
    if (!STRIPPED_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('mcp-'))
      headers.append(name, value);
  }
  headers.set('accept', 'application/json');
  const hasBody =
    tool.hasBody && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.declaration.route.method);
  if (hasBody) headers.set('content-type', 'application/json');
  if (tool.idempotent)
    headers.set(
      'idempotency-key',
      await idempotencyKey(tool.declaration.name, args, runtime.subtle),
    );
  return new Request(url, {
    method: tool.declaration.route.method,
    headers,
    signal,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}
