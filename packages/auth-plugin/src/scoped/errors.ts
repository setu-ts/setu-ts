/**
 * The scoped RBAC error a caller can see.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Why sign-in-timing grant resolution failed: a source rejected or threw
 * (`source-failed`), exceeded `sourceTimeoutMs` (`source-timeout`), or
 * answered more than `maxGrantsPerPrincipal` (`grant-limit`).
 *
 * @since 0.9.0
 */
export type GrantResolutionReason = 'source-failed' | 'source-timeout' | 'grant-limit';

/**
 * Rejection of `IAuthSessionService.signIn` under `scopedRbac.timing:
 * 'sign-in'` when the principal's grants could not be resolved — a source
 * failed, timed out or answered more than `maxGrantsPerPrincipal`.
 *
 * Nothing is recorded: the principal is not signed in. It is an OUTAGE, not
 * a refusal of the user, so it carries a `503` status hint (honoured by
 * `errorHandler`) and is deliberately not an `AuthorizationDeniedError`. The
 * message names the fixed reason and the source's configured name only —
 * never the principal, never a source's own error text.
 *
 * @since 0.9.0
 */
export class GrantResolutionError extends Error {
  /** Stable discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'GrantResolutionError';
  /** Why resolution failed (`source-failed`, `source-timeout`, `grant-limit`). */
  readonly reason: GrantResolutionReason;
  /** The failing source's configured name, when one failed. */
  readonly source: string | undefined;

  /**
   * Creates the sign-in rejection.
   *
   * @param reason - Why resolution failed
   * @param source - The failing source's configured name
   */
  constructor(reason: GrantResolutionReason, source?: string) {
    super(
      `auth-plugin: scoped RBAC grants could not be resolved at sign-in (${reason}` +
        `${source === undefined ? '' : `, source ${JSON.stringify(source)}`})`,
    );
    this.reason = reason;
    this.source = source;
    withHttpStatusHint(this, {
      status: 503,
      title: 'Service Unavailable',
      detail: 'Authorization grants could not be resolved',
    });
  }
}
