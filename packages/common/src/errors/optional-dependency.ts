/**
 * The portable optional-dependency error.
 *
 * Every package that lazily loads a heavy driver does so with a literal bare
 * `import('<pkg>')` inside the `try` block of a same-function `try`/`catch`
 * (AI_GUIDELINES §12.2, as amended by M113d). The guard exists so a bundler
 * that resolves dynamic imports at build time — esbuild inside Wrangler, for
 * a Cloudflare Worker — leaves the unresolvable specifier as a runtime import
 * instead of failing the build. The `catch` must then say something, and
 * ~50 hand-written messages across 19 packages would drift; §11.1 forbids
 * duplicated logic. The class lives in `common` because more than one package
 * must produce it and §2.2 forbids a plugin importing another plugin.
 *
 * It is a pure, zero-dependency error type: a startup or configuration fault
 * raised at `register()` or first use, never inside a request a responder
 * would answer, so unlike `DuplicateKeyError` it carries no HTTP status hint.
 *
 * @module
 */

/**
 * Thrown when an optional, lazily-loaded dependency could not be imported.
 *
 * The original rejection is kept as `cause` for the log; packages that wrap
 * the load in a named error of their own (the gRPC, SAML, GraphQL and
 * feature-flags loaders) pass this class through as the `cause` of theirs.
 *
 * @example
 * ```typescript
 * import { OptionalDependencyUnavailableError } from '@setu-ts/common';
 *
 * try {
 *   const mod = await import('ioredis');
 * } catch (error) {
 *   throw new OptionalDependencyUnavailableError('ioredis', { cause: error });
 * }
 * ```
 *
 * @since 0.10.0
 */
export class OptionalDependencyUnavailableError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'OptionalDependencyUnavailableError';

  /** The bare package name the guarded `import()` could not load. */
  readonly dependency: string;

  /**
   * Builds the error. The `message` names the dependency and states both
   * remedies: install it, or choose an option that does not need it on this
   * runtime.
   *
   * @param dependency - The bare package name the load failed for
   * @param options - The original rejection as `cause`
   */
  constructor(dependency: string, options?: { cause?: unknown }) {
    super(
      `Optional dependency '${dependency}' could not be loaded. Install it in the application, or choose an option that does not need it on this runtime.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.dependency = dependency;
  }
}
