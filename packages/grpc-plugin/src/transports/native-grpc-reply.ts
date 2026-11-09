/**
 * Native `application/grpc` replies with real trailers (M139b §3.6).
 *
 * The native wire format ends every call with its status in HTTP/2 trailers.
 * Connect's universal handler produces them — `UniversalServerResponse.trailer`
 * — but `createFetchHandler` builds a fetch `Response`, which has nowhere to
 * put them, and drops them. This module keeps the universal response and
 * hands the kernel the body and the trailers separately, as an `RpcReply`; the
 * runtime adapter writes the trailers after the last chunk where the
 * connection can carry them.
 *
 * @module
 */
import type { RpcReply } from '@setu-ts/common';

import type { UniversalServerResponseLike } from '../interfaces/connect-runtime.ts';

/**
 * Turns a universal response into an `RpcReply` whose trailers resolve once
 * the body has been read to its end — the moment Connect has written the
 * call's final status into `trailer`.
 *
 * A body whose iterator throws errors the stream and rejects the trailers, so
 * the call is reset rather than ended as if it had succeeded. A cancelled
 * stream (the client went away) returns the iterator, which runs the
 * handler's `finally`, and rejects the trailers.
 *
 * @param universal - The universal handler's response
 * @returns The reply, always streamed
 */
export function nativeGrpcReply(universal: UniversalServerResponseLike): RpcReply {
  let resolveTrailers!: (trailers: Headers) => void;
  let rejectTrailers!: (reason: unknown) => void;
  const trailers = new Promise<Headers>((resolve, reject) => {
    resolveTrailers = resolve;
    rejectTrailers = reject;
  });
  // Observed here as well as by the kernel: a stream nobody reads to the end
  // must not surface its rejection as an unhandled one.
  trailers.catch(() => undefined);
  const iterator = universal.body?.[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<Uint8Array> | undefined;
      try {
        next = await iterator?.next();
      } catch (error) {
        rejectTrailers(error);
        throw error;
      }
      if (next !== undefined && next.done !== true) {
        controller.enqueue(next.value);
        return;
      }
      resolveTrailers(universal.trailer ?? new Headers());
      controller.close();
    },
    async cancel(reason) {
      rejectTrailers(reason);
      await iterator?.return?.();
    },
  });
  return {
    response: new Response(body, {
      status: universal.status,
      ...(universal.header === undefined ? {} : { headers: universal.header }),
    }),
    streaming: true,
    trailers,
  };
}
