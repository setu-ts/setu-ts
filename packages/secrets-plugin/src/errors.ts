/**
 * Errors the secrets plugin throws, exported so consumers can branch on them
 * with `instanceof` rather than matching message text.
 *
 * Before M90f this package had no error vocabulary at all: the one refusal a
 * caller could cause — writing through a read-only provider — rejected with
 * a plain `Error`, reached `errorHandler` as a server fault, and was masked
 * into a `500` that by convention means the opposite of what happened
 * (X20-2). The error is branded with an `HttpStatusHint` from
 * `@setu-ts/common`, so `errorHandler` answers `501 Not Implemented` with a
 * caller-safe sentence instead: the deployment's provider cannot store or
 * rotate secrets, permanently, and no request body can change that.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Thrown when a secret is written through a provider that cannot store.
 *
 * `EnvProvider` is the read-only provider: environment variables are process
 * state, immutable at runtime. `set` is the provider's ONLY write method and
 * rejects with this class, so both public write operations inherit the
 * refusal from one site — `SecretsService.rotate()` delegates to
 * `provider.set()`. It **rejects**, never throws synchronously: a
 * synchronous throw from a method typed `Promise<void>` would bypass any
 * caller using `.catch()`, the M52b/M52c/M70j defect class.
 *
 * The status is `501`, not `403`: nothing is wrong with the caller or its
 * credentials — the deployment's provider cannot perform the operation at
 * all, which is what `501` means.
 *
 * @example
 * ```typescript
 * import { ReadOnlySecretProviderError } from '@setu-ts/secrets-plugin';
 * try {
 *   await secrets.set('database/password', 'next');
 * } catch (err) {
 *   if (err instanceof ReadOnlySecretProviderError) {
 *     // The configured provider is read-only; use a writable provider.
 *   }
 * }
 * ```
 * @since 0.5.0
 */
export class ReadOnlySecretProviderError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'ReadOnlySecretProviderError';

  /** The provider that refused the write (e.g. `'EnvProvider'`). */
  readonly provider: string;

  /**
   * Creates the error. The `message` is the full diagnostic — safe to log,
   * never to serve.
   *
   * @param provider - The name of the read-only provider
   */
  constructor(provider: string) {
    super(`${provider} is read-only; environment secrets cannot be rotated at runtime`);
    this.provider = provider;
    withHttpStatusHint(this, {
      status: 501,
      title: 'Not Implemented',
      detail: `The '${provider}' secrets provider is read-only and cannot store or rotate secrets.`,
    });
  }
}
