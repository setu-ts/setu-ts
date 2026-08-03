/**
 * Errors the Cloudflare plugin throws.
 *
 * @module
 */

/**
 * A binding the configuration names is absent from the Worker's `env`, or is
 * present with the wrong shape.
 *
 * A missing binding is a deployment error — a stanza absent from
 * `wrangler.toml`, a name typo, a preview environment that was never given the
 * namespace. Throwing with the requested name and the names that *are* present
 * turns a downstream `undefined is not a function` into a message that says
 * what to fix.
 *
 * @since 0.2.0
 */
export class CloudflareBindingMissingError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'CloudflareBindingMissingError';

  /**
   * @param message - What was requested, and what is available instead
   */
  constructor(message: string) {
    super(message);
  }

  /**
   * Builds the error for a binding that is absent entirely.
   *
   * @param binding - The requested binding name
   * @param available - Every binding name the Worker's `env` does carry
   * @returns The error, ready to throw
   */
  static absent(binding: string, available: readonly string[]): CloudflareBindingMissingError {
    const present = available.length === 0 ? '(none)' : [...available].sort().join(', ');
    return new CloudflareBindingMissingError(
      `Cloudflare binding '${binding}' is not present in the Worker env. ` +
        `Available bindings: ${present}. Add it to wrangler.toml and redeploy.`,
    );
  }

  /**
   * Builds the error for a binding that is present with the wrong shape.
   *
   * @param binding - The requested binding name
   * @param expected - The shape that was expected, for the message
   * @returns The error, ready to throw
   */
  static wrongShape(binding: string, expected: string): CloudflareBindingMissingError {
    return new CloudflareBindingMissingError(
      `Cloudflare binding '${binding}' is present but is not ${expected}. ` +
        'Check that the wrangler.toml stanza declares the binding type this option expects.',
    );
  }
}

/**
 * The requested operation has no counterpart on the Cloudflare binding.
 *
 * Thrown by `R2Storage.getSignedUrl` — the R2 Workers binding exposes no
 * presigned-URL capability at all — and by `KvCacheStore.clear()` when the
 * store has no key prefix, where the sweep would delete keys the store does
 * not own.
 *
 * @since 0.2.0
 */
export class CloudflareUnsupportedError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'CloudflareUnsupportedError';

  /**
   * @param message - What is unsupported, and what to do instead
   */
  constructor(message: string) {
    super(message);
  }
}

/**
 * An R2 object read found nothing.
 *
 * `IStorage.get` is contracted as `Promise<Uint8Array>` with no null arm, so an
 * absent object has to be an error rather than a value. Callers that want a
 * boolean use `exists`.
 *
 * @since 0.2.0
 */
export class CloudflareObjectNotFoundError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'CloudflareObjectNotFoundError';

  /**
   * @param path - The object path that was requested
   */
  constructor(path: string) {
    super(`R2 object '${path}' does not exist.`);
  }
}
