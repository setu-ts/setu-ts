/**
 * Errors the session plugin throws, exported so consumers can branch on them
 * with `instanceof` rather than matching message text.
 *
 * @module
 */

/**
 * Thrown during `register()` when no usable session secret could be resolved,
 * or when the resolved secret is too short.
 *
 * This is deliberately a startup failure rather than a per-request one: a
 * misconfigured secret makes every session unreadable, and discovering that on
 * the first login is worse than discovering it on boot.
 *
 * @example
 * ```typescript
 * try {
 *   await app.start({ port: 3000 });
 * } catch (err) {
 *   if (err instanceof SessionSecretMissingError) {
 *     console.error('Set SESSION_SECRET (min 32 chars)');
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class SessionSecretMissingError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SessionSecretMissingError';

  /**
   * @param message - What was missing and how to supply it
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown by `getSession(ctx)` / `SessionService.from(ctx)` when the session
 * middleware did not run for the request.
 *
 * The usual cause is resolving the session inside a middleware registered at a
 * priority lower than the session middleware's 260, so it runs before the
 * session is loaded.
 *
 * @since 0.2.0
 */
export class SessionMiddlewareMissingError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SessionMiddlewareMissingError';

  constructor() {
    super(
      'No session on this request. The session middleware did not run — ensure SessionPlugin ' +
        'is registered, and that any middleware reading the session runs at a priority above ' +
        "260 (the session middleware's priority).",
    );
  }
}

/**
 * Thrown by the form-CSRF verifier when the submitted token is absent or does
 * not match the session's token.
 *
 * The middleware catches this and answers `403`; it is exported so an
 * application that installs the verifier itself can distinguish a CSRF failure
 * from other rejections.
 *
 * @since 0.2.0
 */
export class CsrfTokenMismatchError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'CsrfTokenMismatchError';

  /**
   * @param reason - Why verification failed, safe to log but not to return to
   *   the client verbatim
   */
  constructor(reason: string) {
    super(`CSRF verification failed: ${reason}`);
  }
}

/**
 * Thrown when a committed session cookie would exceed the configured byte
 * budget, which browsers enforce at roughly 4 KB per cookie.
 *
 * Without this, an oversized cookie is silently dropped by the client and the
 * user appears to be logged out at random — a failure that is very hard to
 * diagnose. Move large payloads to the store strategy instead.
 *
 * @since 0.2.0
 */
export class SessionTooLargeError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'SessionTooLargeError';

  /**
   * @param actual - The serialized cookie size in bytes
   * @param limit - The configured maximum
   */
  constructor(actual: number, limit: number) {
    super(
      `Session cookie is ${actual} bytes, over the ${limit} byte limit. Browsers drop cookies ` +
        'above roughly 4096 bytes, so this session would silently fail to persist. Store less ' +
        "in the session, or switch to the store strategy with `store: 'memory' | 'cache'`.",
    );
  }
}
