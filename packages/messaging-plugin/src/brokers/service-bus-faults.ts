/** Service Bus data-plane outage classification shared by sends and receives. @module */

const OUTAGE_CODES = new Set([
  'ServiceCommunicationProblem',
  'ServiceTimeout',
  'ServiceBusy',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);
const REFUSAL_CODES = new Set([
  'UnauthorizedAccess',
  'MessagingEntityNotFound',
  'MessagingEntityDisabled',
  'MessageSizeExceeded',
  'QuotaExceeded',
]);

/**
 * Identifies a confirmed missing Service Bus entity, using the last aggregate
 * entry just as the outage predicate does, not an earlier failure.
 * @param error - Translated SDK receive or send failure
 * @returns Whether the SDK reports MessagingEntityNotFound
 * @since 0.14.0
 * @internal
 */
export function isServiceBusEntityMissing(error: unknown): boolean {
  const failure: unknown = error instanceof AggregateError ? error.errors.at(-1) : error;
  return (
    failure !== null &&
    typeof failure === 'object' &&
    (failure as { code?: unknown }).code === 'MessagingEntityNotFound'
  );
}

/**
 * Determines whether a Service Bus failure is evidence of a transport outage.
 * @param error - SDK or raw socket failure
 * @returns Whether the data plane could not be reached reliably
 * @since 0.14.0
 */
export function isServiceBusOutage(error: unknown): boolean {
  if (error instanceof AggregateError) {
    const last: unknown = error.errors.at(-1);
    return !(
      last !== null &&
      typeof last === 'object' &&
      REFUSAL_CODES.has(String((last as { code?: unknown }).code))
    );
  }
  if (error === null || typeof error !== 'object') return true;
  const { code, retryable, statusCode } = error as {
    code?: unknown;
    retryable?: unknown;
    statusCode?: unknown;
  };
  if (REFUSAL_CODES.has(String(code))) return false;
  return (
    retryable === true ||
    OUTAGE_CODES.has(String(code)) ||
    (code === undefined && retryable === undefined && typeof statusCode !== 'number')
  );
}

/**
 * Keeps the final retry's diagnostic visible while preserving the full failure.
 * @param error - Original SDK failure
 * @returns The original error or the final aggregate entry with its aggregate cause
 * @since 0.14.0
 */
export function serviceBusPublishCause(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error;
  const last: unknown = error.errors.at(-1);
  return new Error(last instanceof Error ? last.message : String(last ?? error.message), {
    cause: error,
  });
}

/**
 * Resolves the SDK receive concurrency for both construction entry points.
 * @param value - Configured concurrency
 * @returns An integer from 1 through 1000
 * @throws {RangeError} For an invalid concurrency
 * @since 0.14.0
 */
export function resolveServiceBusConcurrency(value: number | undefined): number {
  const concurrency = value ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000)
    throw new RangeError('Service Bus maxConcurrentCalls must be an integer between 1 and 1000');
  return concurrency;
}
