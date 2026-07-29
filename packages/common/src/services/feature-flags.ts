/**
 * Feature flag contract, fulfilled by the FeatureFlagsPlugin under
 * `CAPABILITIES.FEATURE_FLAGS`.
 *
 * @module
 */

/**
 * Evaluation context for targeting rules.
 *
 * @since 0.1.0
 */
export interface FlagContext {
  /** The user the flag is evaluated for. */
  readonly userId?: string;
  /**
   * Additional targeting attributes.
   *
   * The built-in evaluation path accepts these but does not read them — only
   * `userId` participates in allowlist and percentage targeting. They are
   * carried through for a custom provider that implements its own targeting
   * rules.
   */
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Feature flag evaluator. Evaluation is synchronous against the provider's
 * cached state; providers refresh their state out of band.
 *
 * @example
 * ```typescript
 * const flags = ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
 * if (flags.isEnabled('new-dashboard', { userId: user.id })) {
 *   return renderNewDashboard();
 * }
 * ```
 * @since 0.1.0
 */
export interface IFeatureFlags {
  /**
   * Evaluates a flag.
   *
   * @param flag - Flag name
   * @param context - Targeting context
   * @returns `true` when the flag is on for this context; unknown flags
   * evaluate to `false`
   */
  isEnabled(flag: string, context?: FlagContext): boolean;
  /**
   * Evaluates a flag, awaiting the backing provider when it can produce a more
   * accurate answer asynchronously.
   *
   * Optional, and additive: a provider with a purely local snapshot (config,
   * memory, database polling) has nothing to await, so its implementation
   * simply resolves {@linkcode IFeatureFlags.isEnabled}. The method exists for
   * providers whose SDK evaluates asynchronously — LaunchDarkly's server SDK
   * being the motivating case — where the synchronous path must answer from a
   * cached snapshot and therefore returns a configured fallback the first time
   * it sees a given context.
   *
   * Prefer this method wherever a wrong answer on a cold context would matter
   * (billing, entitlement, an irreversible action); prefer
   * {@linkcode IFeatureFlags.isEnabled} on hot paths that cannot await.
   *
   * @example
   * ```typescript
   * const flags = ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS);
   * const on = await flags.isEnabledAsync?.('new-billing', { userId: user.id });
   * ```
   * @param flag - Flag name
   * @param context - Targeting context
   * @returns `true` when the flag is on for this context; unknown flags
   * evaluate to `false`
   * @since 0.2.0
   */
  isEnabledAsync?(flag: string, context?: FlagContext): Promise<boolean>;
}
