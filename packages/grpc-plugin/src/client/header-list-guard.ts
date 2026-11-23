/**
 * Enforces advertised HTTP/2 limits, distinguishing undersized peer limits
 * from oversized caller headers, and reclassifies large refusals when no limit
 * was known when the call started.
 * Internal — not exported from the package barrel.
 *
 * @module
 */
import { GrpcHeaderListTooLargeError } from '../errors/grpc-errors.ts';

/** One encoder for every size computation. */
const ENCODER = new TextEncoder();

/** Node's `maxHeaderListSize` default before SETTINGS or when no limit is advertised. */
const NO_ADVERTISED_LIMIT = 4294967295;

/**
 * Caller threshold when no header-list limit was known when the call started
 * and the stream is refused while its session is still open. On Node 24 the
 * client's own HTTP/2 library refuses to send a list over 64 KiB, resetting the
 * stream with REFUSED_STREAM before any frame reaches the peer (measured; the
 * smallest list refused was 65,660 octets); another peer may refuse a large list
 * itself, and grpc-go's server advertises its limit only when configured
 * (internal/transport/http2_server.go:205), so the client does not rely on the
 * peer advertising. Larger lists that are sent and answered remain allowed.
 * @internal
 */
export const UNADVERTISED_HEADER_LIST_LIMIT = 65536;

/**
 * When a list at or below this floor exceeds a peer's advertised limit, that peer
 * advertised less than any gRPC default, so the instance fails and the call can be
 * resent safely.
 * gRPC core's GRPC_ARG_MAX_METADATA_SIZE: "Defaults to maximum of 8 KB and"
 * 0.8 × the absolute limit (include/grpc/impl/channel_arg_names.h):
 * https://github.com/grpc/grpc/blob/master/include/grpc/impl/channel_arg_names.h
 * grpc-java's NettyChannelBuilder.maxInboundMetadataSize: "The default is 8 KiB":
 * https://grpc.github.io/grpc-java/javadoc/io/grpc/netty/NettyChannelBuilder.html
 * grpc-go defaults to 16 MiB (internal/transport/defaults.go):
 * https://github.com/grpc/grpc-go/blob/master/internal/transport/defaults.go
 * @internal
 */
export const ADVERTISED_LIMIT_FLOOR = 8192;

/** A locally stopped stream: this peer's advertised limit cannot fit normal headers. @internal */
export class PeerHeaderListLimitError extends Error {
  constructor(size: number, limit: number) {
    super(
      `The call's header list is ${size} octets, over the peer's ${limit}-octet advertised limit ` +
        '(HTTP/2 SETTINGS_MAX_HEADER_LIST_SIZE); the peer advertised less than any gRPC default.',
    );
    this.name = 'PeerHeaderListLimitError';
  }
}

/** Finds our local refusal within five cause objects, including Connect's wrapping. @internal */
export function findPeerHeaderListLimitError(error: unknown): PeerHeaderListLimitError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if (current instanceof PeerHeaderListLimitError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The parts of a `node:http2` client stream the guard reads. */
export interface GuardedStreamLike {
  /** The headers Node sent, pseudo-headers included. */
  readonly sentHeaders?: Readonly<Record<string, unknown>>;
  /** The stream's session, carrying the peer's settings. */
  readonly session?:
    | {
        readonly remoteSettings?: { readonly maxHeaderListSize?: number | undefined };
        readonly closed?: boolean;
        readonly destroyed?: boolean;
      }
    | null
    | undefined;
  /** The peer's stream reset code (REFUSED_STREAM is 7). */
  readonly rstCode?: number;
  /** Dispatches events to connect-node's stream listeners. */
  emit(event: string | symbol, ...args: unknown[]): boolean;
  /** Destroys the stream with an error. */
  destroy(error?: Error): void;
}

/** The session manager method the guard wraps. */
export interface GuardableSessionLike {
  request(...args: never[]): Promise<GuardedStreamLike>;
}

/**
 * A header list's size as RFC 7541 §4.1 defines it: for each field, the
 * name's and the value's octets plus 32. A multi-value field counts once per
 * value, as it is sent.
 *
 * @param headers - The header list, as `ClientHttp2Stream.sentHeaders` holds it
 * @returns The size in octets
 */
export function headerListSize(headers: Readonly<Record<string, unknown>>): number {
  let size = 0;
  for (const [name, value] of Object.entries(headers)) {
    const values = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const one of values) {
      if (one === undefined) continue;
      size += ENCODER.encode(name).length + ENCODER.encode(String(one)).length + 32;
    }
  }
  return size;
}

/**
 * Wraps a session manager's `request` so a stream whose sent header list is
 * over the peer's advertised `SETTINGS_MAX_HEADER_LIST_SIZE` is destroyed at
 * once. A list over {@linkcode ADVERTISED_LIMIT_FLOOR} gets the caller exemption
 * {@linkcode GrpcHeaderListTooLargeError} (no report or resend). At or below the
 * floor it gets {@linkcode PeerHeaderListLimitError}: an instance failure, with
 * unary calls resent once like a refused stream, because the peer advertised
 * less than any gRPC default. When no header-list limit was known when the call started,
 * only a REFUSED_STREAM on a list over {@linkcode UNADVERTISED_HEADER_LIST_LIMIT}
 * becomes that caller error; an accepted list is never stopped pre-emptively.
 * A refusal from a peer shutting down (its session closed or destroyed) stays
 * a refused stream and is resent.
 *
 * @param session - The session manager to guard
 */
export function guardHeaderList(session: GuardableSessionLike): void {
  const request = session.request.bind(session) as (...args: never[]) => Promise<GuardedStreamLike>;
  session.request = async (...args: never[]): Promise<GuardedStreamLike> => {
    const stream = await request(...args);
    const limit = stream.session?.remoteSettings?.maxHeaderListSize;
    if (typeof limit === 'number' && limit < NO_ADVERTISED_LIMIT) {
      const size = headerListSize(stream.sentHeaders ?? {});
      if (size > limit)
        stream.destroy(
          size <= ADVERTISED_LIMIT_FLOOR
            ? new PeerHeaderListLimitError(size, limit)
            : new GrpcHeaderListTooLargeError(size, limit),
        );
    } else if (limit === NO_ADVERTISED_LIMIT) {
      const size = headerListSize(stream.sentHeaders ?? {});
      if (size > UNADVERTISED_HEADER_LIST_LIMIT) guardUnadvertisedRefusal(stream, size);
    }
    return stream;
  };
}

/** Replace the refusal before any Connect callback can settle its sentinel. */
function guardUnadvertisedRefusal(stream: GuardedStreamLike, size: number): void {
  // Node detaches stream.session during destroy, before error/close dispatch.
  const session = stream.session;
  const emit = stream.emit;
  const destroy = stream.destroy;
  let replaced = false;
  let refusedByCaller: boolean | undefined;
  let refusal: GrpcHeaderListTooLargeError | undefined;
  const isCallerRefusal = (error: unknown): boolean => {
    // Decide only when a refusal is first seen, then keep write callbacks and
    // every later event on that decision even if the session changes state.
    if (refusedByCaller === undefined && isRefusal(stream, error))
      refusedByCaller = !session?.closed && !session?.destroyed;
    return refusedByCaller ?? false;
  };
  const callerError = (): GrpcHeaderListTooLargeError =>
    // Deliberately omit the original cause: isRefusedStream walks the whole
    // cause chain and would otherwise resend this caller fault.
    (refusal ??= new GrpcHeaderListTooLargeError(
      size,
      UNADVERTISED_HEADER_LIST_LIMIT,
      'unadvertised-refusal',
    ));
  stream.destroy = function (error?: Error): void {
    // Node's onStreamClose sets rstCode then calls destroy(). Its _destroy
    // settles pending write callbacks BEFORE emitting error, so replacing only
    // the event would let connect-node's sinkRequest see the native refusal.
    return destroy.call(this, isCallerRefusal(error) ? callerError() : error);
  };
  stream.emit = function (event: string | symbol, ...args: unknown[]): boolean {
    const refusedError = event === 'error' && isCallerRefusal(args[0]);
    if (refusedError || (event === 'close' && isCallerRefusal(undefined) && !replaced)) {
      replaced = true;
      if (event === 'error') return emit.call(this, event, callerError(), ...args.slice(1));
      // Node emits error before close; handle close-only runtimes too, before
      // connect-node's close listener translates rstCode into a retryable error.
      emit.call(this, 'error', callerError());
    }
    return emit.call(this, event, ...args);
  };
}

/** Node's REFUSED_STREAM reset or native error, independent of session state. */
function isRefusal(stream: GuardedStreamLike, error: unknown): boolean {
  return (
    stream.rstCode === 7 ||
    (error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_HTTP2_STREAM_ERROR' &&
      error.message.includes('NGHTTP2_REFUSED_STREAM'))
  );
}
