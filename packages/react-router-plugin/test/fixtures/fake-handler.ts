/**
 * Fake `SsrRequestHandler` helpers for tests.
 *
 * @module
 * @since 0.1.0
 */

import type { SsrRequestHandler } from '../../src/interfaces/index.ts';

/**
 * Creates a simple fake RR handler that always returns the given response.
 *
 * @param response - The response to return
 * @returns A fake handler function
 * @since 0.1.0
 */
export function createSimpleFakeHandler(response: Response): SsrRequestHandler {
  return () => Promise.resolve(response);
}
