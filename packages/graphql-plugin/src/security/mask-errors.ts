/**
 * Error masking — expose internal errors safely.
 *
 * @module
 */

import type { GraphqlFormattedError } from '@hono-enterprise/common';

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
  result: { data?: unknown | null; errors?: unknown[] },
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

    if (maskInternalErrors && !isExposable(error)) {
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
