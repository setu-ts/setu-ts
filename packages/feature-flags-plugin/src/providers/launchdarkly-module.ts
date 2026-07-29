/**
 * Injection seam for the LaunchDarkly Node server SDK.
 *
 * The SDK is never a hard dependency (AI_GUIDELINES §12.2): an application
 * either injects an already-built client, injects the module, or lets
 * {@linkcode loadLaunchDarklyModule} import it lazily. The structural facades
 * below are also where the SDK's `any`-typed `EventEmitter.on` is wrapped, so
 * no `any` escapes into the provider (§5.2).
 *
 * @module
 * @since 0.2.0
 */

/**
 * The LaunchDarkly evaluation context.
 *
 * The SDK accepts a rich multi-kind context; the provider only ever builds the
 * single-kind `user` shape, so the facade declares exactly that rather than
 * re-exporting the SDK's own union.
 *
 * @since 0.2.0
 */
export interface LaunchDarklyContext {
  /** Context kind — always `'user'` for the contexts this provider builds. */
  readonly kind: 'user';
  /** The context key; the anonymous key when no `userId` was supplied. */
  readonly key: string;
  /** True when no `userId` was supplied. */
  readonly anonymous?: boolean;
  /** Targeting attributes copied from the `FlagContext`. */
  readonly [attribute: string]: string | number | boolean | undefined;
}

/**
 * The subset of LaunchDarkly's `LDFlagsState` this provider reads.
 *
 * `getFlagValue` is the synchronous read that makes a LaunchDarkly-backed
 * implementation of the synchronous `IFeatureFlags.isEnabled` possible at all:
 * the state object is fetched asynchronously once, then queried synchronously.
 *
 * @since 0.2.0
 */
export interface ILaunchDarklyFlagsState {
  /** False when the snapshot could not be computed (client offline, no context). */
  readonly valid: boolean;
  /**
   * Reads one flag's value from the recorded snapshot.
   *
   * @param key - The flag key
   * @returns The recorded value, or `null` for an unknown flag
   */
  getFlagValue(key: string): unknown;
}

/**
 * The subset of LaunchDarkly's `LDClient` this provider uses.
 *
 * @since 0.2.0
 */
export interface ILaunchDarklyClient {
  /** Whether the client has completed initialization. Synchronous. */
  initialized(): boolean;
  /**
   * Resolves once the client has connected, or rejects on permanent failure.
   *
   * @param options - Initialization wait budget
   * @returns A promise settling on initialization
   */
  waitForInitialization(options?: { readonly timeoutSeconds?: number }): Promise<unknown>;
  /**
   * Evaluates a boolean flag for a context.
   *
   * @param key - The flag key
   * @param context - The evaluation context
   * @param defaultValue - Returned when the flag is absent or non-boolean
   * @returns The evaluated value
   */
  boolVariation(
    key: string,
    context: LaunchDarklyContext,
    defaultValue: boolean,
  ): Promise<boolean>;
  /**
   * Fetches a synchronously-queryable snapshot of every flag for a context.
   *
   * @param context - The evaluation context
   * @returns The snapshot
   */
  allFlagsState(context: LaunchDarklyContext): Promise<ILaunchDarklyFlagsState>;
  /**
   * Registers an event listener. The provider listens for `'update'`, which
   * fires whenever any flag's configuration changes.
   *
   * @param event - The event name
   * @param listener - Invoked when the event fires
   */
  on(event: string, listener: () => void): void;
  /** Shuts the client down and flushes pending events. Synchronous. */
  close(): void;
}

/**
 * The subset of the SDK module surface this provider uses.
 *
 * @since 0.2.0
 */
export interface ILaunchDarklyModule {
  /**
   * Creates a client. Synchronous — it returns immediately and connects in the
   * background, which is why {@linkcode ILaunchDarklyClient.waitForInitialization}
   * exists.
   *
   * @param sdkKey - The LaunchDarkly SDK key
   * @param options - SDK options forwarded verbatim
   * @returns The client
   */
  init(sdkKey: string, options?: Readonly<Record<string, unknown>>): ILaunchDarklyClient;
}

/** Thrown when a supplied module does not look like the LaunchDarkly SDK. */
export class LaunchDarklyModuleError extends Error {
  /**
   * @param message - What was wrong with the module
   */
  constructor(message: string) {
    super(message);
    this.name = 'LaunchDarklyModuleError';
  }
}

/**
 * Narrows an arbitrary module object to {@linkcode ILaunchDarklyModule}.
 *
 * Pure and synchronous, so the provider's construction path is unit-testable
 * with a fake module and never needs the real package installed.
 *
 * @param module - The module to adapt, typically the result of
 * `import('npm:@launchdarkly/node-server-sdk')`
 * @returns The adapted module facade
 * @throws {LaunchDarklyModuleError} When `module` is not an object, or exposes
 * no callable `init`
 * @since 0.2.0
 */
export function adaptLaunchDarklyModule(module: unknown): ILaunchDarklyModule {
  if (typeof module !== 'object' || module === null) {
    throw new LaunchDarklyModuleError(
      'LaunchDarkly module must be an object exposing init(); received ' + typeof module,
    );
  }
  const candidate = module as { readonly init?: unknown };
  if (typeof candidate.init !== 'function') {
    throw new LaunchDarklyModuleError(
      'LaunchDarkly module does not expose a callable init(); ' +
        'expected the @launchdarkly/node-server-sdk module surface',
    );
  }
  return candidate as ILaunchDarklyModule;
}

/**
 * Decides how a load failure is reported.
 *
 * Extracted from {@linkcode loadLaunchDarklyModule}'s `catch` so the branching
 * is unit-testable directly: the `import()` it guards only fails when the
 * package is genuinely absent, which is not a state a test can produce
 * deterministically on a machine where it IS present.
 *
 * Internal seam — not exported from `src/index.ts`.
 *
 * @param error - The thrown value
 * @returns The error to surface: an adaptation failure is passed through
 * unchanged, anything else is wrapped with installation guidance
 * @since 0.2.0
 */
export function toLoadFailure(error: unknown): LaunchDarklyModuleError {
  if (error instanceof LaunchDarklyModuleError) {
    return error;
  }
  return new LaunchDarklyModuleError(
    'Failed to load npm:@launchdarkly/node-server-sdk@^9. Install it to use the ' +
      "'launchdarkly' feature-flags provider, or inject a client through " +
      `options.client. Cause: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Lazily imports the LaunchDarkly Node server SDK.
 *
 * This performs a real `import('npm:@launchdarkly/node-server-sdk@^9')` — the
 * package is resolved by the runtime at call time and is not part of this
 * package's dependency graph. The SDK is Node-oriented (it uses `node:events`
 * and Node HTTP), so it works on Node, Deno, and Bun but not on Cloudflare
 * Workers.
 *
 * @returns The adapted module facade
 * @throws {LaunchDarklyModuleError} When the package is not installed, or when
 * what it resolves to does not expose `init()`
 * @since 0.2.0
 */
export async function loadLaunchDarklyModule(): Promise<ILaunchDarklyModule> {
  try {
    const module = await import('npm:@launchdarkly/node-server-sdk@^9');
    return adaptLaunchDarklyModule(module);
  } catch (error) {
    throw toLoadFailure(error);
  }
}
