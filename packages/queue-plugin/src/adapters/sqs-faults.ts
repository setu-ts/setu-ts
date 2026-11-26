import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  deadlineRangeError,
  toBackendFault,
} from '@setu-ts/common';

/**
 * Resolves the whole-call AWS bound shared by SQS and SNS.
 * @param value - Configured milliseconds
 * @returns The validated bound, default 15000; zero disables it
 * @throws {RangeError} For values outside the timer range
 * @since 0.14.0
 */
export function resolveSqsRequestTimeout(value: number | undefined): number {
  const timeout = value ?? 15000;
  const refusal = deadlineRangeError('requestTimeoutMs', timeout);
  if (refusal !== null) throw refusal;
  return timeout;
}

/**
 * Classifies AWS network, server and throttling failures without hiding refusals.
 * @param error - Original SDK failure (including an already classified deadline)
 * @param source - Operation label
 * @returns Classified fault or the unchanged unrecognized failure
 * @since 0.14.0
 */
export function toSqsFault(error: unknown, source: string): unknown {
  const fault = toBackendFault(error, source);
  const value =
    typeof error === 'object' && error !== null
      ? (error as {
          name?: unknown;
          $metadata?: { attempts?: number; httpStatusCode?: number };
          $retryable?: { throttling?: boolean };
        })
      : undefined;
  const retried = (value?.$metadata?.attempts ?? 0) > 1;
  if (fault !== undefined) {
    return fault instanceof BackendUnavailableError && retried
      ? new BackendOutcomeUnknownError(source, { cause: error })
      : fault;
  }
  const status = value?.$metadata?.httpStatusCode;
  if (
    (typeof status === 'number' && status >= 500) ||
    value?.$retryable?.throttling === true ||
    [
      'Throttling',
      'ThrottlingException',
      'TooManyRequestsException',
      'RequestThrottled',
      'RequestThrottledException',
      'ThrottledException',
      'SlowDown',
      'ProvisionedThroughputExceededException',
      'LimitExceededException',
      'RequestLimitExceeded',
      'BandwidthLimitExceeded',
    ].includes(String(value?.name))
  ) {
    return retried
      ? new BackendOutcomeUnknownError(source, { cause: error })
      : new BackendUnavailableError(source, { cause: error });
  }
  return error;
}
