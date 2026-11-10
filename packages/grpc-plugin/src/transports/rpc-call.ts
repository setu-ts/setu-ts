/**
 * Conversions between the kernel's plain RPC objects and Connect's universal
 * ones (M139b §3.11). Internal — not exported from the package barrel.
 *
 * The kernel hands the plugin an `RpcCall` and takes back an `RpcReply`; no
 * fetch `Request` or `Response` is built on that path. Building them — the
 * `Request`, its header copy and body stream, then a `Response` read back
 * through `arrayBuffer()` — was the largest share of an RPC's CPU. The fetch
 * forms survive only at `GrpcService.handleRequest`, whose contract
 * is a `Request` in and a `Response` out.
 *
 * @module
 */
import type { RpcCall, RpcReply } from '@setu-ts/common';

import type {
  UniversalServerRequestLike,
  UniversalServerResponseLike,
} from '../interfaces/connect-runtime.ts';

/**
 * A body as the async iterable a universal request carries.
 *
 * @param body - The whole body, or a stream of it
 * @returns The iterable: one chunk, none for an empty body, or the stream's
 */
export function bodyIterable(
  body: Uint8Array | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (body instanceof ReadableStream) {
    return streamIterable(body);
  }
  return bytesIterable(body);
}

async function* bytesIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  if (bytes.length > 0) yield bytes;
}

async function* streamIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The universal request for a call.
 *
 * @param call - The kernel's call
 * @param signal - The call's cancellation signal, from `RpcTransport`
 * @returns The universal request
 */
export function universalRequest(call: RpcCall, signal?: AbortSignal): UniversalServerRequestLike {
  return {
    httpVersion: '',
    method: call.method,
    url: call.url,
    header: call.headers,
    body: bodyIterable(call.body),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * The reply for a universal response that carries no trailers (Connect and
 * gRPC-Web, whose status travels in the body).
 *
 * A single response message is gathered into one `Uint8Array`; a streaming
 * reply becomes a `ReadableStream`, so each message is written as Connect
 * produces it.
 *
 * @param universal - The universal handler's response
 * @param streaming - Whether the procedure streams its response
 * @returns The reply
 */
export async function replyFromUniversal(
  universal: UniversalServerResponseLike,
  streaming: boolean,
): Promise<RpcReply> {
  const headers = universal.header ?? new Headers();
  if (universal.body === undefined) {
    return { status: universal.status, headers, body: null, streaming: false };
  }
  if (streaming) {
    return { status: universal.status, headers, body: iterableStream(universal.body), streaming };
  }
  return { status: universal.status, headers, body: await gather(universal.body), streaming };
}

async function gather(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.length;
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * An async iterable as a `ReadableStream` pulled one chunk at a time. A
 * cancelled stream (the client went away) returns the iterator, which runs the
 * handler's `finally`.
 *
 * @param body - The iterable
 * @returns The stream
 */
export function iterableStream(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * A plain-text reply, as `new Response(text, { status })` would answer.
 *
 * @param status - The HTTP status
 * @param text - The body text
 * @returns The reply
 */
export function textReply(status: number, text: string): RpcReply {
  return {
    status,
    headers: new Headers({ 'content-type': 'text/plain;charset=UTF-8' }),
    body: new TextEncoder().encode(text),
    streaming: false,
  };
}

/**
 * A fetch `Request` as a call, for `GrpcService.handleRequest`.
 *
 * @param request - The request
 * @param streamsRequest - Whether the procedure streams its request; its body
 *   is then passed through as a stream rather than read whole
 * @returns The call
 */
export async function callFromRequest(request: Request, streamsRequest: boolean): Promise<RpcCall> {
  const body =
    streamsRequest && request.body !== null
      ? request.body
      : new Uint8Array(await request.arrayBuffer());
  return {
    method: request.method,
    url: request.url,
    path: new URL(request.url).pathname,
    headers: request.headers,
    body,
  };
}

/**
 * A reply as a fetch `Response`, for `GrpcService.handleRequest`.
 * Trailers have nowhere to go on a `Response` and are dropped, which is why
 * `handleRequest` dispatches with `{ trailers: false }`.
 *
 * @param reply - The reply
 * @returns The response
 */
export function responseFromReply(reply: RpcReply): Response {
  return new Response(reply.body as BodyInit | null, {
    status: reply.status,
    headers: reply.headers,
  });
}
