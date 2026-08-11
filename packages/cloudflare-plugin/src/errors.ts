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
 * A brokered request received no reply within its budget.
 *
 * The Cloudflare counterpart of `messaging-plugin`'s `RequestTimeoutError`.
 * They are deliberately distinct classes rather than one shared identity:
 * AI_GUIDELINES §2.2 forbids a plugin importing another plugin, and `common`
 * carries no error class to promote one into (§2.1 limits it to types,
 * interfaces, constants and pure utilities). Which class an application catches
 * is never ambiguous — `MessagingPlugin` and this package's `messaging` arm
 * both provide `CAPABILITIES.MESSAGING`, so the kernel's duplicate-provider
 * check guarantees exactly one of them is registered.
 *
 * @since 0.2.0
 */
export class CloudflareRequestTimeoutError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'CloudflareRequestTimeoutError';

  /**
   * Builds the error a caller receives when its reply budget elapses.
   *
   * @param topic - The request topic that went unanswered
   * @param timeoutMs - The budget that elapsed
   */
  constructor(topic: string, timeoutMs: number) {
    super(
      `No reply to a request on '${topic}' arrived within ${timeoutMs}ms. Check that a Worker ` +
        "consumes this queue and calls respond() on the same topic, and that the queue's " +
        'consumer sets `max_batch_timeout = 0` — the platform default of 5s alone exhausts ' +
        'the default reply budget.',
    );
  }
}

/**
 * A responder threw, and its failure was relayed to the caller.
 *
 * The Cloudflare counterpart of `messaging-plugin`'s `RemoteHandlerError`; see
 * {@linkcode CloudflareRequestTimeoutError} for why the two are distinct.
 *
 * @since 0.2.0
 */
export class CloudflareRemoteHandlerError extends Error {
  /** Discriminating name for `instanceof`-free checks. */
  override readonly name = 'CloudflareRemoteHandlerError';

  /**
   * Builds the error relaying a remote responder's failure to its caller.
   *
   * @param message - The message the remote responder failed with
   */
  constructor(message: string) {
    super(`The responder failed: ${message}`);
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
   * Builds the error a missing R2 object produces.
   *
   * @param path - The object path that was requested
   */
  constructor(path: string) {
    super(`R2 object '${path}' does not exist.`);
  }
}
