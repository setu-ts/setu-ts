/** Cache backend outage errors. @module */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * A Redis connection fault, answered as 503 with value-free public detail.
 * The original driver error is retained as cause for operator diagnostics.
 * @since 0.10.0
 */
export class CacheStoreUnavailableError extends Error {
  /** Stable discriminant across realms. */
  override readonly name = 'CacheStoreUnavailableError';

  /** @param cause - The original connection fault, preserved unchanged */
  constructor(cause: unknown) {
    super('The cache is temporarily unavailable.', { cause });
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'The cache is temporarily unavailable.',
    });
  }
}
