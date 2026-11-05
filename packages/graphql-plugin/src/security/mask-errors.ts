/**
 * Error masking — expose internal errors safely.
 *
 * @module
 */

import type { GraphqlFormattedError } from '@setu-ts/common';
import { fallbackErrorHint, maskUrlUserinfo } from '@setu-ts/common';

/**
 * The GraphQL `extensions.code` for each caller-error status a resolver can
 * throw. The names are Apollo's and `@nestjs/apollo`'s for `400`, `401`, `403`
 * and `422`; `404`, `409` and `429` get their own names rather than Nest's
 * `INTERNAL_SERVER_ERROR`. Any other `4xx` maps to {@linkcode DEFAULT_CALLER_ERROR_CODE}.
 *
 * Internal: not exported from `src/index.ts`. The tests iterate it as data.
 */
export const CALLER_ERROR_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BAD_USER_INPUT',
  429: 'TOO_MANY_REQUESTS',
};

/** The code for a `4xx` status with no row in {@linkcode CALLER_ERROR_CODES}. */
export const DEFAULT_CALLER_ERROR_CODE = 'BAD_REQUEST';

/**
 * Check if an error is exposable to clients.
 *
 * An error is exposable if:
 * - It has no originalError (request error from graphql itself)
 * - It has a code in extensions (explicitly coded error)
 *
 * @param error - The error to check
 * @returns True if the error can be exposed
 */
export function isExposable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as {
    originalError?: Error;
    extensions?: Record<string, unknown>;
    message?: string;
    locations?: Array<{ line: number; column: number }>;
    path?: Array<string | number>;
  };

  // GraphQL validation/execution errors have a message but no originalError
  // These are request errors that should be exposed to the client
  if (typeof err.message === 'string' && !err.originalError) {
    return true;
  }

  // Has a code in extensions = explicitly coded error
  if (err.extensions && typeof err.extensions.code === 'string') {
    return true;
  }

  return false;
}

/**
 * Mask internal errors in a GraphQL result.
 *
 * @param result - The execution result
 * @param options - Masking options
 * @returns The masked result
 */
export function maskErrors(
  result: { data?: unknown | null; errors?: readonly unknown[] },
  options: {
    maskInternalErrors: boolean;
    formatError?: (error: unknown) => unknown;
    logger?: { error(message: string, error?: unknown): void };
  },
): { data?: unknown | null; errors?: GraphqlFormattedError[] } {
  const { maskInternalErrors, logger, formatError } = options;

  if (!result.errors || result.errors.length === 0) {
    return { data: result.data };
  }

  const maskedErrors: GraphqlFormattedError[] = [];

  for (const error of result.errors) {
    const err = error as Error & {
      message: string;
      locations?: Array<{ line: number; column: number }>;
      path?: Array<string | number>;
      extensions?: Record<string, unknown>;
      originalError?: Error;
    };

    let formatted: GraphqlFormattedError;

    // A caller error a resolver threw — a 4xx status hint, which a 4xx
    // `HttpError` from `@setu-ts/exceptions` carries — is shown with a code
    // whatever `maskInternalErrors` says, as `errorHandler` shows it on REST.
    // Only the hint's caller-safe `detail` is shown — for an `HttpError` that
    // is the message it was built with, for any other branded error never its
    // own message. A 5xx hint is not a caller error and stays masked below.
    const exposable = isExposable(error);
    const hint = exposable ? undefined : fallbackErrorHint(err.originalError);

    if (hint !== undefined) {
      formatted = {
        message: maskUrlUserinfo(hint.detail),
        extensions: { code: CALLER_ERROR_CODES[hint.status] ?? DEFAULT_CALLER_ERROR_CODE },
      };
      if (err.locations) {
        formatted.locations = err.locations;
      }
      if (err.path) {
        formatted.path = err.path;
      }
    } else if (maskInternalErrors && !exposable) {
      // Mask internal error
      logger?.error('Internal GraphQL error', err);
      formatted = {
        message: 'Internal server error',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      };
      if (err.path) {
        formatted.path = err.path;
      }
    } else {
      // Expose the error
      formatted = {
        message: err.message,
      };
      if (err.locations) {
        formatted.locations = err.locations;
      }
      if (err.path) {
        formatted.path = err.path;
      }
      if (err.extensions) {
        formatted.extensions = err.extensions;
      }
    }

    // B7: Apply formatError after masking (for both masked and exposed errors)
    if (formatError) {
      const customFormatted = formatError(formatted) as GraphqlFormattedError;
      maskedErrors.push(customFormatted);
    } else {
      maskedErrors.push(formatted);
    }
  }

  const output: { data?: unknown | null; errors?: GraphqlFormattedError[] } = {
    data: result.data,
    errors: maskedErrors,
  };
  return output;
}
