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

  const err = error as { originalError?: Error; extensions?: Record<string, unknown> };

  // No originalError = request error (parse, validate, coercion)
  if (!err.originalError) {
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
  const { maskInternalErrors, formatError, logger } = options;

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

    if (maskInternalErrors && !isExposable(error)) {
      // Mask internal error
      logger?.error('Internal GraphQL error', err);
      const masked: GraphqlFormattedError = {
        message: 'Internal server error',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      };
      if (err.path) {
        masked.path = err.path;
      }
      maskedErrors.push(masked);
    } else {
      // Expose the error
      const formatted: GraphqlFormattedError = {
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

      if (formatError) {
        const formattedError = formatError(formatted);
        maskedErrors.push(formattedError as GraphqlFormattedError);
      } else {
        maskedErrors.push(formatted);
      }
    }
  }

  const output: { data?: unknown | null; errors?: GraphqlFormattedError[] } = {
    data: result.data,
    errors: maskedErrors,
  };
  return output;
}
