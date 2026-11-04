/** Shared quota and request-rate refusal body. @module */
import { respondWithError, withHttpStatusHint } from '@setu-ts/common';
import type { HttpStatusHint, IRequestContext } from '@setu-ts/common';

const QUOTA_EXCEEDED_TYPE = 'https://iana.org/assignments/http-problem-types#quota-exceeded';
const QUOTA_DETAIL = 'The quota for this request is spent.';

/** Builds the one 429 initialization used by the limiter, hint and helper. @internal */
export function quotaProblemInit(
  policyName: string,
  detail: string,
  retryAfterSeconds?: number,
): HttpStatusHint {
  return {
    status: 429,
    title: 'Too Many Requests',
    detail,
    problem: {
      type: QUOTA_EXCEEDED_TYPE,
      title: 'Quota Exceeded',
      extensions: {
        'violated-policies': [policyName],
        ...(retryAfterSeconds === undefined ? {} : { 'retry-after': retryAfterSeconds }),
      },
    },
  };
}

/** A spent policy, carrying a value-free 429 status hint. @since 0.12.0 */
export class QuotaExceededError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'QuotaExceededError';
  /** The violated policy name. */
  readonly policyName: string;
  /** Whole seconds until the reserved window resets (at least one). */
  readonly retryAfterSeconds: number;

  /**
   * @param policyName - Violated policy name
   * @param retryAfterSeconds - Seconds until reset
   */
  constructor(policyName: string, retryAfterSeconds: number) {
    super(QUOTA_DETAIL);
    if (typeof policyName !== 'string' || policyName.length === 0) {
      throw new TypeError('Quota policyName must be a non-empty string');
    }
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      throw new TypeError('Quota retryAfterSeconds must be a safe integer of at least 1');
    }
    this.policyName = policyName;
    this.retryAfterSeconds = retryAfterSeconds;
    withHttpStatusHint(this, quotaProblemInit(policyName, QUOTA_DETAIL, retryAfterSeconds));
  }
}

/**
 * Writes a quota refusal in the configured error format, including Retry-After.
 * @param ctx - Request context with the live response writer
 * @param error - The quota refusal
 * @returns Nothing; the response is written in place
 * @since 0.12.0
 */
export function respondQuotaExceeded(ctx: IRequestContext, error: QuotaExceededError): void {
  ctx.response.header('Retry-After', String(error.retryAfterSeconds));
  respondWithError(ctx, quotaProblemInit(error.policyName, QUOTA_DETAIL, error.retryAfterSeconds));
}
