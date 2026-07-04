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
  /** Additional targeting attributes. */
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
}
