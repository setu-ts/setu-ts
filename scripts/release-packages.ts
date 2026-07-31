/**
 * The ordered list of workspace packages that are published to JSR.
 *
 * This is an EXPLICIT allow-list rather than a scan of the `workspace` array in
 * the root `deno.json` for two reasons. First, ORDER: a scan yields no ordering,
 * and publish order is load-bearing (below). Second, CONTROL: JSR versions are
 * immutable and cannot be withdrawn — only yanked — so a workspace-wide
 * `deno publish` would push anything newly added to the workspace the moment it
 * appeared, including a package not yet meant to ship. Until M36 the list also
 * excluded the three starter stubs, which exported nothing; they are now real
 * composition libraries in Tier 6 and `UNPUBLISHED_PACKAGES` is empty.
 *
 * ORDER IS LOAD-BEARING. JSR rejects a package whose declared dependency
 * version does not yet exist, so a dependency must be published before its
 * dependents. `common` has no in-repo dependency; `kernel` depends on `common`;
 * `runtime`, `testing`, `sdk`, and `exceptions` depend on `common` (only `sdk`
 * is type-level); every plugin depends on `common` (and `openapi-plugin`
 * additionally on `kernel`).
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
  'packages/config-plugin',
  'packages/cqrs-plugin',
  'packages/database-plugin',
  'packages/decorator-plugin',
  'packages/di-plugin',
  'packages/events-plugin',
  'packages/feature-flags-plugin',
  'packages/grpc-plugin',
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
  'packages/realtime-backplane-plugin',
  'packages/resilience-plugin',
  'packages/scheduler-plugin',
  'packages/secrets-plugin',
  'packages/session-plugin',
  'packages/sse-plugin',
  'packages/storage-plugin',
  'packages/telemetry-plugin',
  'packages/validation-plugin',
  'packages/websocket-plugin',
  'packages/worker-pool-plugin',

  // Tier 5 — tooling. Depends on `common` and `runtime`.
  'packages/cli',

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
