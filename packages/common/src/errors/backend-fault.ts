/**
 * Backend-fault classification: whether a thrown driver error means the request
 * was NOT applied (503) or MAY HAVE BEEN applied (504).
 *
 * `QueueService.add`, the realtime-backplane `publish` and the messaging
 * `publish` all throw the raw driver error when the Redis (or other) backend
 * fails. Before this module each reached `errorHandler` as a plain `Error` and
 * was answered as a masked `500`, which tells the caller nothing: the X88-5 runs
 * showed every 500'd job had in fact been applied, so a `500` that reads "the
 * server failed" is wrong. `toBackendFault` classifies the thrown shape and
 * wraps it in one of two branded errors, keeping the original as `cause` for
 * the log (never served, because a driver message can quote a key or value).
 *
 * The classification is MEASURED, not inferred (M131a §3.6): with ioredis 5.11.1
 * and node-redis 6.3.0 against a stopped (closed port) and a paused Redis 7,
 * the thrown shapes are:
 *
 * - stopped, ioredis: `MaxRetriesPerRequestError` / "Reached the max retries per
 *   request limit (which is 1). Refer to \"maxRetriesPerRequest\" option for
 *   details.", or "Command timed out" when the command bound is shorter than
 *   the retry budget.
 * - stopped, node-redis: first command `Error` / "Redis connection failed:
 *   connect ECONNREFUSED 127.0.0.1:<port>" (cause.code `ECONNREFUSED`) →
 *   503; later commands `Error` / "Command timed out" (node-redis has no retry
 *   budget, so a queued command waits for the bound).
 * - paused, both: `Error` / "Command timed out" — the command was dispatched on
 *   an open socket to a server that answers only when unpaused, so it MAY HAVE
 *   BEEN applied → 504.
 *
 * The retry and timeout shapes on a stopped server are decided by the caller's
 * `unsent` (below): no socket opened between dispatch and failure → 503.
 *
 * Only those measured shapes enter the table; anything unrecognised passes
 * through unchanged (the masked `500`), because an unrecognised fault is not
 * proven to be either safe.
 *
 * Some shapes do not say on their own whether the command left the process.
 * ioredis rejects every queued command with `MaxRetriesPerRequestError` or
 * "Connection is closed." when it gives up on a connection — including
 * commands already written to the socket before it dropped (its `flushQueue`
 * empties the sent-command queue too), and a reset or broken pipe can arrive
 * after the server ran the command. A command made while the client is
 * disconnected is not safe either: the driver queues it and writes it after the
 * next reconnect, and the connection can drop again with the command applied
 * (audit finding, M131a). So the caller says whether the command provably was
 * never written (`unsent`, from {@linkcode watchConnection}: disconnected at
 * dispatch, no reconnect since, still disconnected at the failure) — then the
 * request was not applied (503); otherwise it may have been (504).
 *
 * @module
 */
import { isConnectionFaultCode } from './connection-fault.ts';
import { withHttpStatusHint } from './status-hint.ts';

/**
 * The two backend-fault classes, discriminated by whether the request was
 * applied.
 */
export type BackendFault = BackendUnavailableError | BackendOutcomeUnknownError;

/**
 * Thrown when a backend call was refused before it could be applied: the
 * connection was never established, the offline queue rejected the command, or
 * the client is closed. The request did **not** happen, so repeating it
 * unchanged is safe.
 *
 * The response is `503 Service Unavailable` with a fixed `detail`; the driver
 * error is kept as `cause` for the log and never served.
 *
 * @example
 * ```typescript
 * import { toBackendFault } from '@setu-ts/common';
 *
 * try {
 *   await queue.add('jobs', payload);
 * } catch (error) {
 *   const fault = toBackendFault(error, 'queue-plugin: enqueue');
 *   if (fault instanceof BackendUnavailableError) {
 *     // The job was not applied; retry is safe.
 *   }
 * }
 * ```
 *
 * @since 0.12.0
 */
export class BackendUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'BackendUnavailableError';

  /**
   * The source label the producer named (e.g. `queue-plugin: enqueue`),
   * for the log.
   */
  readonly source: string;

  /**
   * @param source - The source label, for the log
   * @param options - The driver error as `cause`
   */
  constructor(source: string, options: { cause: unknown }) {
    super(`${source}: the backend refused the request before it could be applied`, {
      cause: options.cause,
    });
    this.source = source;
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The request was not applied.',
    });
  }
}

/**
 * Thrown when a backend call was dispatched but its answer never came back
 * within the bound: the command may have reached the backend and been applied.
 * Repeating it unchanged risks a duplicate, so the caller must use an
 * idempotency key.
 *
 * The response is `504 Gateway Timeout` with a fixed `detail`; the driver error
 * is kept as `cause` for the log and never served.
 *
 * @since 0.12.0
 */
export class BackendOutcomeUnknownError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'BackendOutcomeUnknownError';

  /**
   * The source label the producer named, for the log.
   */
  readonly source: string;

  /**
   * @param source - The source label, for the log
   * @param options - The driver error as `cause`
   */
  constructor(source: string, options: { cause: unknown }) {
    super(`${source}: the backend did not answer; the request may have been applied`, {
      cause: options.cause,
    });
    this.source = source;
    withHttpStatusHint(this, {
      status: 504,
      title: 'Gateway Timeout',
      detail: 'The backend did not answer; the request may have been applied.',
    });
  }
}

/** Maximum number of objects inspected, including the original error. */
const MAX_CAUSE_DEPTH = 5;

/**
 * What one object in the cause chain says: refused before sending, sent with no
 * answer, or a lost connection whose outcome depends on the state at dispatch.
 */
type BackendFaultKind = 'unavailable' | 'outcome-unknown' | 'connection-lost';

/** Network codes a command already on the socket can also fail with. */
const IN_FLIGHT_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * What the caller knew when it dispatched the failed call.
 *
 * @since 0.12.0
 */
export interface BackendFaultContext {
  /**
   * Whether the failed command provably was never written to the backend.
   * Decides a lost-connection fault: `true` → not applied (503); `false` or
   * omitted → may have been applied (504).
   */
  readonly unsent?: boolean;
}

/**
 * Classifies one object in a thrown error's cause chain.
 *
 * A command timeout (`Command timed out`) and a lost connection (`ECONNRESET`,
 * `EPIPE`, `ETIMEDOUT`, `MaxRetriesPerRequestError`, "Connection is closed.",
 * "Socket closed unexpectedly") are decided by the caller's `unsent`: each can
 * follow a command already written, or one queued that never left. A refusal before sending
 * (the other connection-fault codes, ioredis's disabled offline queue, or a
 * client that is closed / offline / never connected) is unavailable.
 *
 * @param entry - One object in the cause chain
 * @returns The classification, or `undefined` when the object is unrecognised
 */
function classify(entry: Record<string, unknown>): BackendFaultKind | undefined {
  const name = entry.name;
  const message = typeof entry.message === 'string' ? entry.message : '';
  // The bound expired with no answer. On an open socket (a paused server) the
  // command was sent and may have run; a command queued while disconnected is
  // written on the next socket. So, like a lost connection, it is decided by
  // whether any socket opened between dispatch and failure: node-redis has no
  // retry budget, so this is how a STOPPED server fails on it (M131a re-audit).
  if (message === 'Command timed out') return 'connection-lost';
  // Lost connection: a command may already have been on the socket.
  const code = typeof entry.code === 'string' ? entry.code : entry.errno;
  if (typeof code === 'string' && IN_FLIGHT_CODES.has(code)) return 'connection-lost';
  if (name === 'MaxRetriesPerRequestError') return 'connection-lost';
  if (
    name === 'Error' &&
    (message === 'Connection is closed.' || message === 'Socket closed unexpectedly')
  ) {
    return 'connection-lost';
  }
  // 503: refused before sending — the connection never reached the backend.
  if (isConnectionFaultCode(entry.code) || isConnectionFaultCode(entry.errno)) return 'unavailable';
  if (
    name === 'Error' &&
    (message === "Stream isn't writeable and enableOfflineQueue options is false" ||
      message === 'The client is closed' ||
      message === 'The client is offline' ||
      message === 'Connection timeout')
  ) {
    return 'unavailable';
  }
  return undefined;
}

/**
 * Walks a thrown value's cause chain (bounded, cycle-safe) and returns the
 * first recognised classification.
 *
 * @param error - The thrown value, possibly wrapping a driver error as cause
 * @returns The classification, or `undefined` when no measured shape appears
 */
function classifyChain(error: unknown): BackendFaultKind | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    try {
      const entry = current as Record<string, unknown>;
      const kind = classify(entry);
      if (kind !== undefined) return kind;
      current = entry.cause;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Classifies a thrown driver error into a backend fault, keeping the original
 * as `cause`.
 *
 * An already-wrapped fault is returned unchanged, so a call site that wraps
 * twice does not nest. An unrecognised shape returns `undefined`; the caller
 * rethrows the original and it takes the ordinary masked-`500` path, because an
 * unrecognised fault is not proven to be either safe. `PublishTimeoutError` is
 * NOT rewrapped here — it keeps its own name and carries the `504` hint itself
 * (M131a §3.6); the messaging `publish` site checks for it before calling this.
 *
 * @param error - The thrown driver error
 * @param source - The source label for the log (e.g. `queue-plugin: enqueue`)
 * @param context - What the caller knew at dispatch; decides a lost connection
 * @returns The wrapped fault, or `undefined` when the shape is unrecognised
 * @since 0.12.0
 */
export function toBackendFault(
  error: unknown,
  source: string,
  context?: BackendFaultContext,
): BackendFault | undefined {
  if (error instanceof BackendUnavailableError || error instanceof BackendOutcomeUnknownError) {
    return error;
  }
  const kind = classifyChain(error);
  if (kind === 'unavailable' || (kind === 'connection-lost' && context?.unsent === true)) {
    return new BackendUnavailableError(source, { cause: error });
  }
  if (kind !== undefined) return new BackendOutcomeUnknownError(source, { cause: error });
  return undefined;
}
