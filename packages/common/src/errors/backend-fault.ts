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
 *   details." — refused before sending → 503.
 * - stopped, node-redis: first command `Error` / "Redis connection failed:
 *   connect ECONNREFUSED 127.0.0.1:<port>" (cause.code `ECONNREFUSED`), later
 *   commands `Error` / "Command timed out" — the first is refused before sending
 *   → 503; the second is a command whose answer never came back → 504.
 * - paused, both: `Error` / "Command timed out" — the command was dispatched to
 *   a server that will answer only when unpaused, so it MAY HAVE BEEN applied →
 *   504.
 *
 * Only those measured shapes enter the table; anything unrecognised passes
 * through unchanged (the masked `500`), because an unrecognised fault is not
 * proven to be either safe.
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
 *   const fault = toBackendFault(error, 'queue-plugin: redis adapter');
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
   * The source label the producer named (e.g. `queue-plugin: redis adapter`),
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

/** The two classifications `toBackendFault` can produce. */
type BackendFaultKind = 'unavailable' | 'outcome-unknown';

/**
 * Classifies one object in a thrown error's cause chain.
 *
 * A command-level timeout (`Command timed out`) is outcome-unknown: the command
 * was dispatched and its answer never came back, so it may have been applied.
 * A connection-level failure (the eight net codes, ioredis's offline-queue
 * rejection, or a client that is closed / offline / timed out) is unavailable:
 * the request was refused before it could be applied.
 *
 * @param entry - One object in the cause chain
 * @returns The classification, or `undefined` when the object is unrecognised
 */
function classify(entry: Record<string, unknown>): BackendFaultKind | undefined {
  const name = entry.name;
  const message = typeof entry.message === 'string' ? entry.message : '';
  // 504: a command was sent and the bound expired with no answer.
  if (message === 'Command timed out') return 'outcome-unknown';
  // 503: refused before sending — the connection never reached the backend.
  if (isConnectionFaultCode(entry.code) || isConnectionFaultCode(entry.errno)) return 'unavailable';
  if (name === 'MaxRetriesPerRequestError') return 'unavailable';
  if (
    name === 'Error' &&
    (message === 'Connection is closed.' ||
      message === "Stream isn't writeable and enableOfflineQueue options is false" ||
      message === 'The client is closed' ||
      message === 'The client is offline' ||
      message === 'Socket closed unexpectedly' ||
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
 * @param source - The source label for the log (e.g. `queue-plugin: redis adapter`)
 * @returns The wrapped fault, or `undefined` when the shape is unrecognised
 * @since 0.12.0
 */
export function toBackendFault(error: unknown, source: string): BackendFault | undefined {
  if (error instanceof BackendUnavailableError || error instanceof BackendOutcomeUnknownError) {
    return error;
  }
  const kind = classifyChain(error);
  if (kind === 'unavailable') return new BackendUnavailableError(source, { cause: error });
  if (kind === 'outcome-unknown') return new BackendOutcomeUnknownError(source, { cause: error });
  return undefined;
}
