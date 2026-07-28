/**
 * The ordered list of workspace packages that are published to JSR.
 *
 * This is an EXPLICIT allow-list rather than a scan of the `workspace` array in
 * the root `deno.json`, because the workspace also contains stub packages
 * (`sdk` and the three starters) that export nothing. A workspace-wide
 * `deno publish` would push those empty packages to JSR, where versions are
 * immutable and cannot be withdrawn — only yanked.
 *
 * ORDER IS LOAD-BEARING. JSR rejects a package whose declared dependency
 * version does not yet exist, so a dependency must be published before its
 * dependents. `common` has no in-repo dependency; `kernel` depends on `common`;
 * `runtime` and `testing` depend on both; every plugin depends on `common`
 * (and `openapi-plugin` additionally on `kernel`).
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

  // Tier 4 — plugins. Each depends on `common`; `openapi-plugin` also on `kernel`.
  'packages/audit-plugin',
  'packages/auth-plugin',
  'packages/cache-plugin',
  'packages/config-plugin',
  'packages/cqrs-plugin',
  'packages/database-plugin',
  'packages/decorator-plugin',
  'packages/di-plugin',
  'packages/events-plugin',
  'packages/feature-flags-plugin',
  'packages/health-plugin',
  'packages/http-security-plugin',
  'packages/logger-plugin',
  'packages/mail-plugin',
  'packages/messaging-plugin',
  'packages/metrics-plugin',
  'packages/multi-tenancy-plugin',
  'packages/notification-plugin',
  'packages/openapi-plugin',
  'packages/queue-plugin',
  'packages/react-router-plugin',
  'packages/resilience-plugin',
  'packages/scheduler-plugin',
  'packages/secrets-plugin',
  'packages/sse-plugin',
  'packages/storage-plugin',
  'packages/telemetry-plugin',
  'packages/validation-plugin',
  'packages/websocket-plugin',
  'packages/worker-pool-plugin',

  // Tier 5 — tooling. Depends on `common` and `runtime`.
  'packages/cli',
];

/**
 * Workspace members deliberately excluded from every release.
 *
 * These are Milestone 0 stubs whose `src/index.ts` is `export {}`. They are
 * listed explicitly (rather than merely omitted) so that
 * `scripts/verify-release.ts` can prove the two lists together account for the
 * entire workspace — a new package added to the workspace and forgotten here
 * fails the check instead of silently going unpublished.
 */
export const UNPUBLISHED_PACKAGES: readonly string[] = [
  'packages/sdk',
  'packages/starters/rest-starter',
  'packages/starters/microservice-starter',
  'packages/starters/full-stack-starter',
];
