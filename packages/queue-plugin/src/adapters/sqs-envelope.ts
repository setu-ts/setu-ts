/** Shared SQS v1 wire codec. Internal; never barrel-exported. */

/** Validated work envelope; headers are validated separately from work. @since 0.14.0 */
export interface ISqsEnvelope<T = unknown> {
  /** Wire version, fixed at one. */

  readonly v: 1;
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly maxAttempts?: number;
  readonly headers?: unknown;
}

/**
 * Encodes work using the same validation as the consumer.
 * @param job - Work identity, payload and optional delivery defaults
 * @returns The v1 JSON body
 * @throws {TypeError} When work is not a valid envelope or cannot be serialized
 * @since 0.14.0
 */
export function encodeSqsEnvelope<T>(job: Omit<ISqsEnvelope<T>, 'v'>): string {
  const body = JSON.stringify({ ...job, v: 1 });
  const decoded = decodeSqsEnvelope(body, job.name);
  if (!decoded.ok) throw new TypeError(`Invalid SQS envelope: ${decoded.reason}`);
  return body;
}

/**
 * Reads raw work or one SNS Notification wrapper. Refusals never include input.
 * @param body - Untrusted SQS body
 * @param polledName - Name owned by the polled queue
 * @returns Validated envelope or a fixed refusal reason; never throws
 * @throws Never
 * @since 0.14.0
 */
export function decodeSqsEnvelope(
  body: string,
  polledName: string,
): { ok: true; envelope: ISqsEnvelope } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
    if (isRecord(value) && value.Type === 'Notification') {
      if (typeof value.Message !== 'string' || typeof value.TopicArn !== 'string') {
        return { ok: false, reason: 'invalid SNS notification' };
      }
      value = JSON.parse(value.Message);
    }
  } catch {
    return { ok: false, reason: 'malformed JSON envelope' };
  }
  if (!isRecord(value)) return { ok: false, reason: 'invalid envelope object' };
  if (value.v !== 1) return { ok: false, reason: 'invalid envelope version' };
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return { ok: false, reason: 'invalid envelope id' };
  }
  if (typeof value.name !== 'string' || !value.name || value.name !== polledName) {
    return { ok: false, reason: 'invalid envelope name' };
  }
  if (value.data === undefined) return { ok: false, reason: 'invalid envelope data' };
  if (
    value.maxAttempts !== undefined &&
    (typeof value.maxAttempts !== 'number' ||
      !Number.isInteger(value.maxAttempts) ||
      value.maxAttempts < 1)
  )
    return { ok: false, reason: 'invalid envelope maxAttempts' };
  return { ok: true, envelope: value as unknown as ISqsEnvelope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
