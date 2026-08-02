/**
 * The envelope a job travels in across Cloudflare Queues.
 *
 * A Cloudflare message body is arbitrary JSON carrying neither a job name nor
 * an id, while {@linkcode IQueue.process} dispatches **by name** and
 * {@linkcode IQueue.add} returns an **id**. `producer.send()` resolves to
 * `void`, so the platform hands back no id at all, and `Message.id` exists only
 * at the consumer — using it would make the id `add` returned and the id the
 * processor sees two different values.
 *
 * One envelope carries both, plus the per-message attempt cap that Cloudflare's
 * queue-wide `max_retries` cannot express. It is the same shape decision as the
 * `{ v, e }` cache envelope in `stores/kv-envelope.ts`.
 *
 * @module
 */

/** The envelope version. Bumped only by a breaking wire change. */
const ENVELOPE_VERSION = 1;

/**
 * A job as it crosses the queue.
 *
 * @typeParam T - The job payload type
 * @internal
 */
export interface JobEnvelope<T = unknown> {
  /** Envelope version, for forward compatibility. */
  readonly v: number;
  /** The job name the processor is registered under. */
  readonly name: string;
  /** The id {@linkcode WorkersQueue.add} returned to the enqueuing caller. */
  readonly id: string;
  /** The caller's payload. */
  readonly data: T;
  /** Attempts allowed before the job is dropped, when the caller set one. */
  readonly maxAttempts?: number;
}

/**
 * Builds the envelope for one job.
 *
 * @typeParam T - The job payload type
 * @param name - The job name
 * @param id - The id handed back to the enqueuing caller
 * @param data - The caller's payload
 * @param maxAttempts - Attempt cap, when the caller set one
 * @returns The envelope to send as the message body
 * @internal
 */
export function encodeJobEnvelope<T>(
  name: string,
  id: string,
  data: T,
  maxAttempts?: number,
): JobEnvelope<T> {
  return {
    v: ENVELOPE_VERSION,
    name,
    id,
    data,
    // Never assigned as `undefined`: `exactOptionalPropertyTypes` is on.
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  };
}

/**
 * Reports whether a message body is an envelope this version understands.
 *
 * A body that fails this check is not dropped — `WorkersQueue.dispatch` retries
 * it, because a message the consumer cannot route is a configuration problem
 * (two producers sharing one queue, a version skew mid-deploy) and acking it
 * would discard it permanently and silently.
 *
 * @param body - The message body, as the platform delivered it
 * @returns `true` when the body carries a readable envelope
 * @internal
 */
export function isJobEnvelope(body: unknown): body is JobEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const record = body as Record<string, unknown>;
  return (
    record.v === ENVELOPE_VERSION &&
    typeof record.name === 'string' &&
    typeof record.id === 'string' &&
    (record.maxAttempts === undefined || typeof record.maxAttempts === 'number')
  );
}
