/** Classification of a call that failed before its response settled. @module */

/**
 * Canonical gRPC status numbers. Connect's Code enum cannot be imported here at
 * runtime because the optional Connect peer is loaded lazily.
 * @internal
 */
export const GRPC_CODE: Readonly<
  Record<
    | 'Canceled'
    | 'Unknown'
    | 'InvalidArgument'
    | 'DeadlineExceeded'
    | 'NotFound'
    | 'AlreadyExists'
    | 'PermissionDenied'
    | 'ResourceExhausted'
    | 'FailedPrecondition'
    | 'Aborted'
    | 'OutOfRange'
    | 'Unimplemented'
    | 'Internal'
    | 'Unavailable'
    | 'DataLoss'
    | 'Unauthenticated',
    number
  >
> = Object.freeze({
  Canceled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const);

const SERVER_FAULT_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.Unavailable,
  GRPC_CODE.Unimplemented,
  GRPC_CODE.Internal,
  GRPC_CODE.Unknown,
  GRPC_CODE.DataLoss,
  GRPC_CODE.DeadlineExceeded,
]);

const ANSWER_CODES: ReadonlySet<number> = new Set([
  GRPC_CODE.InvalidArgument,
  GRPC_CODE.NotFound,
  GRPC_CODE.AlreadyExists,
  GRPC_CODE.PermissionDenied,
  GRPC_CODE.Unauthenticated,
  GRPC_CODE.FailedPrecondition,
  GRPC_CODE.OutOfRange,
  GRPC_CODE.Aborted,
  GRPC_CODE.ResourceExhausted,
]);

/**
 * Reports only faults attributable to the selected instance.
 * @param error - The rejected call
 * @param signal - The caller's signal
 * @param isWireError - Whether Connect decoded this error from a server answer
 * @returns The discovery outcome, or no report for caller cancellation or local client faults
 */
export function callOutcome(
  error: unknown,
  signal: AbortSignal | undefined,
  isWireError: (error: unknown) => boolean,
): 'success' | 'failure' | undefined {
  if (signal?.aborted) return undefined;
  if (isRefusedStream(error)) return 'failure';
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const wire = isWireError(error);
  if (
    !wire &&
    code !== GRPC_CODE.DeadlineExceeded &&
    code !== GRPC_CODE.Canceled &&
    !hasInstanceEvidence(error)
  )
    return undefined;
  if (typeof code === 'number' && SERVER_FAULT_CODES.has(code)) return 'failure';
  if (code === GRPC_CODE.Canceled) return 'failure';
  if (typeof code === 'number' && wire && ANSWER_CODES.has(code)) return 'success';
  return 'failure';
}

/** Response headers or a system-error cause distinguish transport faults from local encoding faults. */
function hasInstanceEvidence(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { metadata } = error as { metadata?: unknown };
  if (metadata instanceof Headers && !metadata.keys().next().done) return true;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string') return true;
    current = record.cause;
  }
  return false;
}

/** connect-node's message for a `REFUSED_STREAM` reset code (`connectErrorFromH2ResetCode`). */
const CONNECT_NODE_REFUSED = 'http/2 stream closed with error code REFUSED_STREAM (0x7)';

/**
 * Whether a call failed because the server refused its HTTP/2 stream
 * (`REFUSED_STREAM`, RFC 9113 §8.7): the server did not process it, which a
 * server that has sent `GOAWAY` while shutting down does to a stream already on
 * the wire. connect-node maps the reset code to `Unavailable` when it reads it,
 * but reports the stream-error event Node raises for the same refusal as
 * `Internal`; the cause chain names it either way. A stream that could not be
 * opened because the session had already received `GOAWAY`
 * (`ERR_HTTP2_GOAWAY_SESSION`) is the same case: the request never left.
 *
 * @param error - The call's error
 * @returns `true` when some error in the cause chain is that refusal
 */
export function isRefusedStream(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { message, code, cause } = current as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof message === 'string') {
      // Node's stream error for the refusal, and connect-node's reading of the
      // reset code: exactly these two, so a server's own error message that
      // happens to name the code is never taken for a refusal and retried.
      if (code === 'ERR_HTTP2_STREAM_ERROR' && message.includes('NGHTTP2_REFUSED_STREAM')) {
        return true;
      }
      // The stream was never opened: the session had already received GOAWAY
      // (seen on Bun, whose node:http2 races the session manager's reconnect).
      if (code === 'ERR_HTTP2_GOAWAY_SESSION') return true;
      if (isLocalResetRefusal(current)) return true;
    }
    current = cause;
  }
  return false;
}

/**
 * connect-node's own reading of a `REFUSED_STREAM` reset code: exactly its
 * message, and no response metadata. A server's error that merely names the
 * code always arrives with the response headers, so it never matches (a server
 * that rethrows a downstream refusal ran its handler, and is not resent).
 */
function isLocalResetRefusal(error: object): boolean {
  const { rawMessage, metadata } = error as { rawMessage?: unknown; metadata?: unknown };
  return (
    rawMessage === CONNECT_NODE_REFUSED &&
    metadata instanceof Headers &&
    metadata.keys().next().done === true
  );
}
