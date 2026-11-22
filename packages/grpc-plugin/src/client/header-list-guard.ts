/**
 * Stops a client call whose request header list is over the peer's advertised
 * HTTP/2 limit, so a caller's oversized headers are never counted against an
 * instance. Internal — not exported from the package barrel.
 *
 * @module
 */
import { GrpcHeaderListTooLargeError } from '../errors/grpc-errors.ts';

/** One encoder for every size computation. */
const ENCODER = new TextEncoder();

/** What Node reports for `maxHeaderListSize` when the peer advertised none. */
const NO_ADVERTISED_LIMIT = 4294967295;

/** The parts of a `node:http2` client stream the guard reads. */
export interface GuardedStreamLike {
  /** The headers Node sent, pseudo-headers included. */
  readonly sentHeaders?: Readonly<Record<string, unknown>>;
  /** The stream's session, carrying the peer's settings. */
  readonly session?: { readonly remoteSettings?: { readonly maxHeaderListSize?: number } } | null;
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
 * once with a {@linkcode GrpcHeaderListTooLargeError}. A peer that advertised
 * no limit gets no check: its own limit, if any, cannot be known in advance.
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
      if (size > limit) stream.destroy(new GrpcHeaderListTooLargeError(size, limit));
    }
    return stream;
  };
}
