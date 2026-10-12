/**
 * The explicit dependency-ordered allow-list of packages published to npm.
 * Ordering puts dependencies before dependents so a partial release remains
 * installable. Explicit membership prevents a newly added workspace member
 * from shipping without review; release:verify accounts for every member.
 */
export const PUBLISHED_PACKAGES: readonly string[] = [
  // Tier 1 — no in-repo dependencies.
  'packages/common',

  // Tier 2 — depends on `common`.
  'packages/kernel',

  // Tier 3 — depends on `common` and/or `kernel`.
  'packages/runtime',
  'packages/testing',
  'packages/exceptions',
  'packages/sdk',

  // Tier 4 — plugins. Each depends on `common`; `openapi-plugin` also on `kernel`.
  'packages/audit-plugin',
  'packages/auth-plugin',
  'packages/cache-plugin',
  'packages/cloudflare-plugin',
  'packages/config-plugin',
  'packages/cqrs-plugin',
  'packages/database-plugin',
  'packages/decorator-plugin',
  'packages/di-plugin',
  'packages/diagnostics-plugin',
  'packages/events-plugin',
  'packages/feature-flags-plugin',
  'packages/graphql-plugin',
  'packages/grpc-plugin',
  'packages/health-plugin',
  'packages/http-security-plugin',
  'packages/idempotency-plugin',
  'packages/localization-plugin',
  'packages/logger-plugin',
  'packages/mail-plugin',
  'packages/messaging-plugin',
  'packages/metrics-plugin',
  'packages/multi-tenancy-plugin',
  'packages/notification-plugin',
  'packages/openapi-plugin',
  'packages/queue-plugin',
  'packages/react-router-plugin',
  'packages/realtime-backplane-plugin',
  'packages/resilience-plugin',
  'packages/scheduler-plugin',
  'packages/secrets-plugin',
  'packages/service-discovery-plugin',
  'packages/session-plugin',
  'packages/sse-plugin',
  'packages/static-plugin',
  'packages/storage-plugin',
  'packages/telemetry-plugin',
  'packages/validation-plugin',
  'packages/view-plugin',
  'packages/websocket-plugin',
  'packages/worker-pool-plugin',

  // Tier 5 — tooling. Depends on `common` and `runtime`.
  'packages/cli',
  // Depends on `cli`: `npm create @setu-ts` runs `setu new`.
  'packages/create',

  // Tier 6 — composition libraries (starters). These depend on other starters,
  // so they must be published in order: rest → microservice → full-stack.
  'packages/starters/rest-starter',
  'packages/starters/microservice-starter',
  'packages/starters/full-stack-starter',
];

/**
 * Workspace members deliberately excluded from every release.
 *
 * After M36, all starter packages are real published libraries (Tier 6), so there
 * are no longer any unpublished packages. This constant is kept (not removed)
 * because `scripts/verify-release.ts` imports it and builds a union with
 * `PUBLISHED_PACKAGES` for check 3; an empty array is valid and produces a
 * summary of "0 deliberately excluded".
 */
export const UNPUBLISHED_PACKAGES: readonly string[] = [];

/**
 * One package that must not reach npm yet, and why.
 */
export interface PublicationHold {
  /** The workspace path, as it appears in {@linkcode PUBLISHED_PACKAGES}. */
  readonly packageDir: string;
  /** Why the package is held, and what removes the hold. */
  readonly reason: string;
}

/**
 * Packages that block EVERY release while they are listed here.
 *
 * A hold is enforced at publish time only. `scripts/npm-publish.ts`
 * refuses before publishing anything, `--dry-run` included, so a release
 * rehearsal warns early. `scripts/verify-release.ts` only reports a hold,
 * because CI runs it on every pull request and a failure there would turn
 * every unrelated PR red until the hold is lifted.
 *
 * A held package stays in `PUBLISHED_PACKAGES` deliberately. Moving it to
 * `UNPUBLISHED_PACKAGES` would let a release skip it silently, and the
 * released CLI's `--devtool` scaffolding imports `@setu-ts/diagnostics-plugin`,
 * so its generated projects could not install.
 */
export const PUBLICATION_HOLDS: readonly PublicationHold[] = [];
