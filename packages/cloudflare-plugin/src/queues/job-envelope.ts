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
  /**
   * Transport headers the caller passed to {@linkcode IQueue.add}, delivered
   * back as {@linkcode IJob.headers}.
   *
   * Additive and OPTIONAL, so the envelope version is NOT bumped: a consumer
   * running older code ignores the field, and a consumer running newer code
   * reads an older message as carrying no channel — which is exactly what
   * absent means on the committed contract. Both directions are safe across a
   * mid-deploy version skew, which is the only reason this could be added
   * without a breaking wire change.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Builds the envelope for one job.
 *
 * @typeParam T - The job payload type
 * @param name - The job name
 * @param id - The id handed back to the enqueuing caller
 * @param data - The caller's payload
 * @param maxAttempts - Attempt cap, when the caller set one
 * @param headers - Transport headers the caller supplied, when any
 * @returns The envelope to send as the message body
 * @internal
 */
export function encodeJobEnvelope<T>(
  name: string,
  id: string,
  data: T,
  maxAttempts?: number,
  headers?: Readonly<Record<string, string>>,
): JobEnvelope<T> {
  return {
    v: ENVELOPE_VERSION,
    name,
    id,
    data,
    // Never assigned as `undefined`: `exactOptionalPropertyTypes` is on, and
    // ABSENT is a meaningful state on `IJob.headers` — it reports that the job
    // carried no channel, which a present-but-undefined property would deny.
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * Narrows an envelope's `headers` to a flat string map, or reports `undefined`
 * when it is absent or malformed.
 *
 * Deliberately NOT folded into {@linkcode isJobEnvelope}: that guard's failure
 * mode is RETRYING the message, so refusing a job because its observability
 * field is malformed would retry it until the queue's `max_retries` discards it
 * — losing the work to protect the record of it. A malformed map is dropped
 * here instead and the job runs untraced, which is the same disposition
 * `queue-plugin`'s SQS adapter reaches. That adapter holds its own copy of this
 * guard because AI_GUIDELINES §2.2 forbids a plugin importing another plugin
 * (the M30b `pemToDer` precedent).
 *
 * @param value - The envelope's raw `headers` member
 * @returns The map when every value is a string, otherwise `undefined`
 * @internal
 */
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
export function readEnvelopeHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [, entry] of entries) {
    if (typeof entry !== 'string') return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

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
